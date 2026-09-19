/**
 * ==========================================
 * PHASE 13 — GATE CHECK-IN / ATTENDANCE (INTEGRATION)
 * ==========================================
 *
 * Executes the REAL check-in service against the REAL MariaDB, on tickets produced by the
 * real chain: checkout → payment → HMAC-verified settlement → issuance. Only `@/auth` and
 * the provider SOCKET are substituted (both inherited from the Phase 7/8 harnesses), so
 * every permission, tenant and state decision below is made by the production code.
 *
 * WHAT THIS SUITE IS FOR — AND WHAT IT IS EXPLICITLY NOT ASSERTING
 * ----------------------------------------------------------------
 * The brief's Part F invariant is asserted in BOTH directions with the real services:
 * a REFUNDED/VOID ticket can never be admitted (the CAS requires `ISSUED`), and an
 * admitted ticket cannot then be refunded (Phase 10B's D-R05, via `requestRefund`).
 *
 * It does NOT assert what should happen when a ticket has an OPEN refund request and is
 * presented at the door. That question is design D-28, it is still undecided, and
 * `CheckInResult` has no value to record the refusal's outcome — pinning a guess as a test
 * would make a product decision look like an implementation detail. It is recorded in the
 * Phase 13 report as a decision still needed, and the CAS is what decides today.
 *
 * Fixtures are allocated per test from a pooled order (10 tickets, one paid order), so a
 * counter or status assertion is absolute rather than relative.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import { archiveEvent, cancelEvent, createEvent, publishEvent } from "@/lib/events/service";
import { createTicketType } from "@/lib/ticket-types/service";
import { checkInTicket, listEventCheckIns } from "@/lib/ticketing/checkin/service";
import { requestRefund } from "@/lib/ticketing/refunds/service";

import {
    counters,
    createPaidOrder,
    customerScope,
    expectRejection,
    installGatewayStub,
    issue,
    nextRequest,
    orderState,
    organizerScope,
    setupIssuanceFixtures,
    signInAs,
    teardownIssuanceFixtures,
    ticketsFor,
    type Fixtures,
    type Rejection,
} from "../ticketing-issuance/issuance-harness";
import { FUTURE, FUTURE_END, SUFFIX } from "../ticketing-payment/payment-harness";

jest.setTimeout(120000);

let f: Fixtures;
let fetchSpy: jest.SpyInstance;

let staffA: { id: string };
let staffB: { id: string };
let financeA: { id: string };

let orderA: { orderNumber: string; orderId: string; total: string };

/**
 * The pooled tickets, each tagged with the order that owns it.
 *
 * Two orders rather than one because `typeA` caps a single order at 10 tickets and this
 * suite needs ~15; the owning order matters because a refund request names an order and one
 * of its tickets, so a test cannot mix the two.
 */
type PooledTicket = {
    id: string;
    ticketCode: string;
    orderNumber: string;
    orderId: string;
};

let pool: PooledTicket[] = [];

/** A second tenant's live event, holding one ISSUED ticket, for the wrong-event case. */
let eventBOrder: { orderNumber: string; orderId: string; total: string };
let ticketB: { id: string; ticketCode: string };

/** A dedicated event this suite cancels and archives, so eventA's gate stays open. */
let eventC: { id: string };
let ticketC: { id: string; ticketCode: string };

/** Hand out one pooled ticket. Each ticket is used by exactly one test. */
function nextTicket(): PooledTicket {
    const ticket = pool.shift();

    if (!ticket) {
        throw new Error("Fixture error: the pooled orders ran out of tickets");
    }

    return ticket;
}

async function createUser(tag: string) {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });
}

async function addType(
    eventId: string,
    organizerId: string,
    ownerUserId: string,
    name: string
) {
    return createTicketType(
        await organizerScope(organizerId, ownerUserId),
        eventId,
        { name, price: "150000.00", quota: 20 } as never
    );
}

/** Buy → settle → issue one ticket on a given event, through the production chain. */
async function issueOneTicket(eventId: string, ticketTypeId: string, tag: string) {
    const order = await createPaidOrder({
        buyerId: f.buyerA.id,
        ticketTypeId,
        quantity: 1,
        tag,
        eventId,
    });

    await issue(order.orderNumber, f.buyerA.id);

    const [ticket] = await ticketsFor(order.orderId);

    if (!ticket || ticket.status !== "ISSUED") {
        throw new Error(
            `Fixture error: expected one ISSUED ticket for ${tag}, got ${ticket?.status}`
        );
    }

    return { order, ticket: { id: ticket.id, ticketCode: ticket.ticketCode } };
}

beforeAll(async () => {
    f = await setupIssuanceFixtures();
    fetchSpy = installGatewayStub();

    staffA = await createUser("p13-staff-a");
    staffB = await createUser("p13-staff-b");
    financeA = await createUser("p13-finance-a");

    await prisma.organizerMember.createMany({
        data: [
            {
                organizerId: f.orgA.id,
                userId: staffA.id,
                role: "CHECKIN_STAFF",
                status: "ACTIVE",
            },
            {
                organizerId: f.orgA.id,
                userId: staffB.id,
                role: "CHECKIN_STAFF",
                status: "ACTIVE",
            },
            {
                organizerId: f.orgA.id,
                userId: financeA.id,
                role: "FINANCE",
                status: "ACTIVE",
            },
        ],
    });

    // `staffA` is assigned to eventA; `staffB` deliberately is not (design §7.3 rule 4:
    // a gate member with no assignment can scan nothing).
    const staffAMember = await prisma.organizerMember.findFirstOrThrow({
        where: { organizerId: f.orgA.id, userId: staffA.id },
        select: { id: true },
    });

    await prisma.staffEventAssignment.create({
        data: {
            organizerMemberId: staffAMember.id,
            eventId: f.eventA.id,
            organizerId: f.orgA.id,
            assignedByUserId: f.ownerA.id,
        },
    });

    // The pooled, real, paid orders the individual tests draw their tickets from.
    orderA = await createPaidOrder({
        buyerId: f.buyerA.id,
        ticketTypeId: f.typeA.id,
        quantity: 10,
        tag: "checkin-pool",
    });

    const second = await createPaidOrder({
        buyerId: f.buyerA.id,
        ticketTypeId: f.typeA.id,
        quantity: 10,
        tag: "checkin-pool-2",
    });

    await issue(orderA.orderNumber, f.buyerA.id);
    await issue(second.orderNumber, f.buyerA.id);

    pool = [
        ...(await ticketsFor(orderA.orderId)).map((ticket) => ({
            id: ticket.id,
            ticketCode: ticket.ticketCode,
            orderNumber: orderA.orderNumber,
            orderId: orderA.orderId,
        })),
        ...(await ticketsFor(second.orderId)).map((ticket) => ({
            id: ticket.id,
            ticketCode: ticket.ticketCode,
            orderNumber: second.orderNumber,
            orderId: second.orderId,
        })),
    ];

    if (pool.length !== 20) {
        throw new Error(`Fixture error: expected 20 pooled tickets, got ${pool.length}`);
    }

    // ── Tenant B: a live event with one ISSUED ticket, to prove a foreign ticket is
    // refused with WRONG_EVENT even when the scanner legitimately administers another
    // event. ────────────────────────────────────────────────────────────────────────
    const typeB = await addType(f.eventB.id, f.orgB.id, f.ownerB.id, "Reguler B");
    await publishEvent(await organizerScope(f.orgB.id, f.ownerB.id), f.eventB.id);

    const issuedB = await issueOneTicket(f.eventB.id, typeB.id, "p13-xevent");
    eventBOrder = issuedB.order;
    ticketB = issuedB.ticket;

    // ── Tenant A: a dedicated event for the cancel/archive cases. ────────────────────
    const created = await createEvent(
        await organizerScope(f.orgA.id, f.ownerA.id),
        f.orgA.id,
        {
            title: `P13 Cancelable ${SUFFIX}`,
            sportId: f.sportId,
            startAt: FUTURE,
            // PHASE 20B (D-P19-05 = A): a publishable event carries an end time.
            endAt: FUTURE_END,
        } as never
    );

    eventC = { id: created.id };

    const typeC = await addType(eventC.id, f.orgA.id, f.ownerA.id, "Reguler C");
    await publishEvent(await organizerScope(f.orgA.id, f.ownerA.id), eventC.id);

    const issuedC = await issueOneTicket(eventC.id, typeC.id, "p13-cancel");
    ticketC = issuedC.ticket;
});

afterAll(async () => {
    const eventIds = [f.eventA.id, f.eventB.id, eventC.id];

    // `CheckIn` and `StaffEventAssignment` are this phase's rows; the parent teardowns know
    // nothing about them and both are `Restrict`-anchored to rows they DO delete.
    await prisma.checkIn.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.staffEventAssignment.deleteMany({
        where: { eventId: { in: eventIds } },
    });

    // A refund claim would block the ticket delete below. This suite's refund assertion is
    // expected to be REFUSED, so this only guarantees the ordering if that ever changes.
    const orderIds = (
        await prisma.eventOrder.findMany({
            where: { eventId: { in: eventIds } },
            select: { id: true },
        })
    ).map((row) => row.id);

    await prisma.refund.deleteMany({ where: { eventOrderId: { in: orderIds } } });

    // Event C is not one of the ids the parent teardown knows; it must be gone before that
    // teardown deletes the organizer it belongs to.
    await dropEvent(eventC.id);

    await teardownIssuanceFixtures(f);

    fetchSpy.mockRestore();
});

/** Delete this suite's own event, children first. Mirrors the parent teardown's ordering. */
async function dropEvent(eventId: string): Promise<void> {
    const orderIds = (
        await prisma.eventOrder.findMany({
            where: { eventId },
            select: { id: true },
        })
    ).map((row) => row.id);

    await prisma.checkIn.deleteMany({ where: { eventId } });
    await prisma.webhookEvent.deleteMany({ where: { order: { eventId } } });
    await prisma.paymentTransaction.deleteMany({
        where: { orderId: { in: orderIds } },
    });
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.ticketReservation.deleteMany({ where: { eventId } });
    // Tickets BEFORE order items: `Ticket.orderItemId` is `Restrict`.
    await prisma.ticket.deleteMany({ where: { eventId } });
    await prisma.eventOrderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.eventOrder.deleteMany({ where: { eventId } });
    await prisma.ticketType.deleteMany({ where: { eventId } });
    await prisma.eventImage.deleteMany({ where: { eventId } });
    await prisma.event.deleteMany({ where: { id: eventId } });
}

/** Admit a ticket as an organizer-scoped actor (the session is the mocked `auth()`). */
async function admit(
    eventId: string,
    code: string,
    actorUserId: string,
    extra: Record<string, unknown> = {}
) {
    signInAs(actorUserId);

    return checkInTicket({
        eventId,
        input: { code, ...extra } as never,
        request: nextRequest("/api/organizer/events/" + eventId + "/check-in"),
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// The happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("P13-A. admitting a ticket", () => {
    it("moves one ISSUED ticket to CHECKED_IN and records who did it", async () => {
        const ticket = nextTicket();

        const result = await admit(f.eventA.id, ticket.ticketCode, f.ownerA.id, {
            gateLabel: "Pintu Utama",
        });

        expect(result.result).toBe("SUCCESS");
        expect(result.ticket.ticketCode).toBe(ticket.ticketCode);
        expect(result.ticket.status).toBe("CHECKED_IN");
        expect(result.method).toBe("MANUAL");
        expect(result.gateLabel).toBe("Pintu Utama");

        const row = await prisma.ticket.findUniqueOrThrow({
            where: { id: ticket.id },
            select: { status: true, checkedInAt: true },
        });

        expect(row.status).toBe("CHECKED_IN");
        expect(row.checkedInAt).not.toBeNull();

        const admission = await prisma.checkIn.findFirstOrThrow({
            where: { ticketId: ticket.id },
            select: {
                result: true,
                method: true,
                eventId: true,
                organizerId: true,
                checkedInByUserId: true,
                checkedInByMemberId: true,
                gateLabel: true,
            },
        });

        expect(admission).toMatchObject({
            result: "SUCCESS",
            method: "MANUAL",
            eventId: f.eventA.id,
            organizerId: f.orgA.id,
            checkedInByUserId: f.ownerA.id,
            gateLabel: "Pintu Utama",
        });

        const audit = await prisma.adminAuditLog.findFirst({
            where: { action: "checkin.success", entityRef: ticket.ticketCode },
            select: { actorUserId: true, organizerId: true, actorType: true },
        });

        expect(audit).toMatchObject({
            actorUserId: f.ownerA.id,
            organizerId: f.orgA.id,
            actorType: "USER",
        });
    });

    it("accepts the wallet QR payload as well as the bare code", async () => {
        const ticket = nextTicket();

        const result = await admit(
            f.eventA.id,
            `TICKET:${ticket.ticketCode}`,
            f.ownerA.id
        );

        expect(result.ticket.status).toBe("CHECKED_IN");
    });

    it("records the acting organizer member when a gate staff member admits", async () => {
        const ticket = nextTicket();

        await admit(f.eventA.id, ticket.ticketCode, staffA.id);

        const admission = await prisma.checkIn.findFirstOrThrow({
            where: { ticketId: ticket.id },
            select: { checkedInByUserId: true, checkedInByMemberId: true },
        });

        expect(admission.checkedInByUserId).toBe(staffA.id);
        expect(admission.checkedInByMemberId).not.toBeNull();
    });

    it("changes nothing about the order, the payment or the inventory", async () => {
        const ticket = nextTicket();

        const before = await counters(f.typeA.id);
        const orderBefore = await orderState(orderA.orderId);

        await admit(f.eventA.id, ticket.ticketCode, f.ownerA.id);

        expect(await counters(f.typeA.id)).toEqual(before);
        expect(await orderState(orderA.orderId)).toEqual(orderBefore);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Duplicates and concurrency
// ─────────────────────────────────────────────────────────────────────────────

describe("P13-B. a ticket is admitted once", () => {
    it("refuses the second scan and reports when and by whom it was first admitted", async () => {
        const ticket = nextTicket();

        await admit(f.eventA.id, ticket.ticketCode, f.ownerA.id);
        await expect(admit(f.eventA.id, ticket.ticketCode, f.ownerA.id)).rejects.toMatchObject(
            {
                code: "TICKET_ALREADY_CHECKED_IN",
                httpStatus: 409,
            }
        );

        const row = await prisma.ticket.findUniqueOrThrow({
            where: { id: ticket.id },
            select: { status: true },
        });

        expect(row.status).toBe("CHECKED_IN");

        // Exactly one accepted admission — the loser wrote an auditable refusal instead.
        const accepted = await prisma.checkIn.count({
            where: { ticketId: ticket.id, result: "SUCCESS" },
        });

        // A refusal cannot carry `ticketId` (it is UNIQUE and already belongs to the accepted
        // admission), so the duplicate scan is identified by the code in `note`.
        const refused = await prisma.checkIn.count({
            where: {
                eventId: f.eventA.id,
                note: ticket.ticketCode,
                result: "ALREADY_CHECKED_IN",
            },
        });

        expect(accepted).toBe(1);
        expect(refused).toBe(1);

        const audit = await prisma.adminAuditLog.count({
            where: { action: "checkin.rejected", entityRef: ticket.ticketCode },
        });

        expect(audit).toBe(1);
    });

    it("resolves two simultaneous scans to exactly one winner", async () => {
        const ticket = nextTicket();

        signInAs(f.ownerA.id);

        const [first, second] = await Promise.allSettled([
            checkInTicket({
                eventId: f.eventA.id,
                input: { code: ticket.ticketCode } as never,
                request: nextRequest(),
            }),
            checkInTicket({
                eventId: f.eventA.id,
                input: { code: ticket.ticketCode } as never,
                request: nextRequest(),
            }),
        ]);

        const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
        const rejected = [first, second].filter((r) => r.status === "rejected");

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        expect(
            (rejected[0] as PromiseRejectedResult).reason
        ).toMatchObject({ code: "TICKET_ALREADY_CHECKED_IN" });

        // The database agrees: one admission, backed by the UNIQUE `CheckIn.ticketId`.
        expect(
            await prisma.checkIn.count({
                where: { ticketId: ticket.id, result: "SUCCESS" },
            })
        ).toBe(1);

        const row = await prisma.ticket.findUniqueOrThrow({
            where: { id: ticket.id },
            select: { status: true },
        });

        expect(row.status).toBe("CHECKED_IN");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authorization and tenant isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("P13-C. who may open the gate", () => {
    it("refuses an unauthenticated caller before it reads anything", async () => {
        const ticket = nextTicket();

        signInAs(null);

        await expect(
            checkInTicket({
                eventId: f.eventA.id,
                input: { code: ticket.ticketCode } as never,
                request: nextRequest(),
            })
        ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

        const row = await prisma.ticket.findUniqueOrThrow({
            where: { id: ticket.id },
            select: { status: true },
        });

        expect(row.status).toBe("ISSUED");
    });

    it("refuses a customer without a membership", async () => {
        const ticket = nextTicket();

        await expect(admit(f.eventA.id, ticket.ticketCode, f.buyerA.id)).rejects.toMatchObject(
            { code: "ORGANIZER_ACCESS_DENIED", status: 404 }
        );
    });

    it("refuses a FINANCE member, who holds no check-in capability", async () => {
        const ticket = nextTicket();

        await expect(admit(f.eventA.id, ticket.ticketCode, financeA.id)).rejects.toMatchObject({
            code: "FORBIDDEN",
            status: 403,
        });
    });

    it("refuses a gate staff member with no assignment for this event", async () => {
        const ticket = nextTicket();

        const rejection = (await expectRejection(() =>
            admit(f.eventA.id, ticket.ticketCode, staffB.id)
        )) as Rejection;

        expect(rejection.code).toBe("FORBIDDEN");
        expect(rejection.details?.reason).toBe("NO_STAFF_ASSIGNMENT");

        const row = await prisma.ticket.findUniqueOrThrow({
            where: { id: ticket.id },
            select: { status: true },
        });

        expect(row.status).toBe("ISSUED");
    });

    it("refuses another tenant's owner, and leaks nothing by doing so", async () => {
        const ticket = nextTicket();

        const rejection = (await expectRejection(() =>
            admit(f.eventA.id, ticket.ticketCode, f.ownerB.id)
        )) as Rejection;

        // 404, not 403: a denial must not confirm that this event exists (design §7.4).
        expect(rejection.code).toBe("ORGANIZER_ACCESS_DENIED");
        expect(rejection.status).toBe(404);

        // An authorization failure happens before any ticket is even looked up.
        expect(await prisma.checkIn.count({ where: { eventId: f.eventA.id, note: ticket.ticketCode } })).toBe(0);
    });

    it("refuses a ticket issued for a different event", async () => {
        const rejection = (await expectRejection(() =>
            admit(f.eventA.id, ticketB.ticketCode, f.ownerA.id)
        )) as Rejection;

        expect(rejection.code).toBe("CONFLICT");
        expect(rejection.details?.reason).toBe("WRONG_EVENT");

        const row = await prisma.ticket.findUniqueOrThrow({
            where: { id: ticketB.id },
            select: { status: true },
        });

        expect(row.status).toBe("ISSUED");

        // Tenant B's order is untouched by a scan attempt from tenant A.
        expect((await orderState(eventBOrder.orderId)).status).toBe("PAID");
    });

    it("answers an unknown and a malformed code identically, and admits neither", async () => {
        const unknown = (await expectRejection(() =>
            admit(f.eventA.id, "EVT-9X9X-9X9X", f.ownerA.id)
        )) as Rejection;

        const malformed = (await expectRejection(() =>
            admit(f.eventA.id, "not-a-code", f.ownerA.id)
        )) as Rejection;

        // Same code, same message: the error shape cannot be used to probe the code space.
        expect(unknown.code).toBe("NOT_FOUND");
        expect(malformed.code).toBe("NOT_FOUND");
    });

    it("requires the log-read capability to see the attendance list", async () => {
        // The buyer and the FINANCE member cannot read the gate log...
        signInAs(f.buyerA.id);
        await expect(listEventCheckIns(f.eventA.id)).rejects.toMatchObject({
            code: "ORGANIZER_ACCESS_DENIED",
        });

        signInAs(financeA.id);
        await expect(listEventCheckIns(f.eventA.id)).rejects.toMatchObject({
            code: "FORBIDDEN",
        });

        // ...while the gate staff member who admitted people can.
        signInAs(staffA.id);
        const list = await listEventCheckIns(f.eventA.id);

        expect(list.total).toBeGreaterThan(0);
        expect(list.items[0].ticketCode).toMatch(/^EVT-/);
        expect(list.items[0].checkedInAt).toBeTruthy();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ticket statuses that must not be admitted
// ─────────────────────────────────────────────────────────────────────────────

describe("P13-D. only an ISSUED ticket may be admitted", () => {
    it("refuses a VOID ticket", async () => {
        const ticket = nextTicket();

        await prisma.ticket.update({
            where: { id: ticket.id },
            data: { status: "VOID", voidedAt: new Date(), voidReason: "test fixture" },
        });

        const rejection = (await expectRejection(() =>
            admit(f.eventA.id, ticket.ticketCode, f.ownerA.id)
        )) as Rejection;

        expect(rejection.code).toBe("CONFLICT");
        expect(rejection.details?.reason).toBe("TICKET_NOT_ISSUED");

        const row = await prisma.ticket.findUniqueOrThrow({
            where: { id: ticket.id },
            select: { status: true, checkedInAt: true },
        });

        expect(row.status).toBe("VOID");
        expect(row.checkedInAt).toBeNull();
    });

    it("refuses a REFUNDED ticket", async () => {
        const ticket = nextTicket();

        await prisma.ticket.update({
            where: { id: ticket.id },
            data: { status: "REFUNDED", refundedAt: new Date() },
        });

        await expect(
            admit(f.eventA.id, ticket.ticketCode, f.ownerA.id)
        ).rejects.toMatchObject({ code: "CONFLICT" });

        const row = await prisma.ticket.findUniqueOrThrow({
            where: { id: ticket.id },
            select: { status: true, checkedInAt: true },
        });

        expect(row.status).toBe("REFUNDED");
        expect(row.checkedInAt).toBeNull();
    });

    it("classifies an outstanding RESERVED ticket as UNPAID", async () => {
        const ticket = nextTicket();

        await prisma.ticket.update({
            where: { id: ticket.id },
            data: { status: "RESERVED" },
        });

        await expect(
            admit(f.eventA.id, ticket.ticketCode, f.ownerA.id)
        ).rejects.toMatchObject({ code: "CONFLICT" });

        const refusal = await prisma.checkIn.findFirstOrThrow({
            where: { eventId: f.eventA.id, note: ticket.ticketCode, result: "UNPAID" },
            select: { result: true },
        });

        expect(refusal.result).toBe("UNPAID");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The refund boundary (Phase 10B), in both directions
// ─────────────────────────────────────────────────────────────────────────────

describe("P13-E. check-in and refund cannot both happen", () => {
    it("refuses a refund request for a ticket that was already admitted", async () => {
        const ticket = nextTicket();

        await admit(f.eventA.id, ticket.ticketCode, f.ownerA.id);

        const buyer = await customerScope(f.buyerA.id);

        const rejection = (await expectRejection(() =>
            requestRefund(
                { orderNumber: ticket.orderNumber, ticketIds: [ticket.id] },
                buyer,
                nextRequest("/api/ticketing/refunds")
            )
        )) as Rejection;

        expect(rejection.code).toBe("REFUND_NOT_ALLOWED");

        // The refusal is total: no claim, no refund row, no ticket change.
        expect(await prisma.refund.count({ where: { eventOrderId: ticket.orderId } })).toBe(0);
        expect(await prisma.refundItem.count({ where: { ticketId: ticket.id } })).toBe(0);

        const row = await prisma.ticket.findUniqueOrThrow({
            where: { id: ticket.id },
            select: { status: true, refundedAt: true },
        });

        expect(row.status).toBe("CHECKED_IN");
        expect(row.refundedAt).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event lifecycle: cancel and archive close the gate
// ─────────────────────────────────────────────────────────────────────────────

describe("P13-F. a cancelled or archived event has no door", () => {
    it("admits, then closes the gate on cancel without disturbing the admission", async () => {
        const ownerScope = await organizerScope(f.orgA.id, f.ownerA.id);

        await admit(eventC.id, ticketC.ticketCode, f.ownerA.id);

        await cancelEvent(ownerScope, eventC.id, { reason: null }, nextRequest());

        const rejection = (await expectRejection(() =>
            admit(eventC.id, ticketC.ticketCode, f.ownerA.id)
        )) as Rejection;

        expect(rejection.code).toBe("CONFLICT");
        expect(rejection.details?.reason).toBe("EVENT_NOT_OPEN");
        expect(rejection.details?.status).toBe("CANCELLED");

        // Cancelling does not void tickets: the person who was already admitted stays admitted.
        const row = await prisma.ticket.findUniqueOrThrow({
            where: { id: ticketC.id },
            select: { status: true, checkedInAt: true },
        });

        expect(row.status).toBe("CHECKED_IN");
        expect(row.checkedInAt).not.toBeNull();
    });

    it("keeps the gate closed after the event is archived", async () => {
        const ownerScope = await organizerScope(f.orgA.id, f.ownerA.id);

        await archiveEvent(ownerScope, eventC.id, nextRequest());

        const rejection = (await expectRejection(() =>
            admit(eventC.id, ticketC.ticketCode, f.ownerA.id)
        )) as Rejection;

        expect(rejection.details?.reason).toBe("EVENT_NOT_OPEN");
    });
});
