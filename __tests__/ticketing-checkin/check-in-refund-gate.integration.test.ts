/**
 * ==========================================
 * PHASE 15 — THE OPEN-REFUND GATE (D-28 / P14-D15), INTEGRATION
 * ==========================================
 *
 * Phase 13 left D-28 open: what happens when a ticket with an OPEN refund request is
 * presented at the door. Phase 14 closed it (P14-D15 — an open refund in `PENDING`,
 * `APPROVED` or `PROCESSING` blocks admission with `CheckInResult.REFUND_PENDING` and HTTP
 * 409), and this suite executes the REAL gate against the REAL MariaDB on tickets produced
 * by the real chain: checkout → payment → HMAC settlement → issuance.
 *
 * WHAT ONLY A REAL DATABASE CAN PROVE
 * -----------------------------------
 * Two properties here are ordering properties, not return values:
 *
 *   1. every blocking status in the matrix actually refuses with the recorded result
 *      `REFUND_PENDING` (a mock would only assert the SQL text, not that MariaDB ran it);
 *   2. a concurrent `check-in` and `requestRefund` on the SAME ticket produce exactly one
 *      winner — the `SELECT … FOR UPDATE` both writers take on the ticket row is what
 *      decides it, and neither side's in-memory check participates.
 *
 * `REJECTED` and `FAILED` are arranged by a direct status write where the service path to
 * them is a provider-dependent one (the same convention the Phase 10B webhook suite already
 * uses for `PROCESSING`); `PENDING` and `APPROVED` are reached through the real services.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import { checkInTicket } from "@/lib/ticketing/checkin/service";
import {
    approveRefund,
    rejectRefund,
    requestRefund,
} from "@/lib/ticketing/refunds/service";

import {
    createPaidOrder,
    customerScope,
    expectRejection,
    installGatewayStub,
    issue,
    nextRequest,
    organizerScope,
    setupIssuanceFixtures,
    signInAs,
    teardownIssuanceFixtures,
    ticketsFor,
    type Fixtures,
    type Rejection,
} from "../ticketing-issuance/issuance-harness";
import { SUFFIX } from "../ticketing-payment/payment-harness";

jest.setTimeout(120000);

let f: Fixtures;
let fetchSpy: jest.SpyInstance;

let staff: { id: string };

/** The pooled, real, paid orders the individual tests draw their tickets from. */
let pool: {
    id: string;
    ticketCode: string;
    orderNumber: string;
    orderId: string;
}[] = [];

/** Hand out one pooled ticket. Each ticket is used by exactly one test. */
function nextTicket() {
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

/** Admit a ticket as the assigned gate member (the session is the mocked `auth()`). */
function admit(eventId: string, code: string) {
    signInAs(staff.id);

    return checkInTicket({
        eventId,
        input: { code } as never,
        request: nextRequest("/api/organizer/events/" + eventId + "/check-in"),
    });
}

/** Open a real refund claim for one ticket of one order, as its buyer. */
async function requestAsBuyer(orderNumber: string, ticketIds: string[]) {
    const buyer = await customerScope(f.buyerA.id);

    return requestRefund(
        { orderNumber, ticketIds },
        buyer,
        nextRequest("/api/ticketing/refunds")
    );
}

/** Put a real claim into a status only the provider can otherwise produce. */
async function forceStatus(refundId: number, status: "PROCESSING" | "FAILED") {
    await prisma.refund.update({
        where: { id: refundId },
        data: {
            status,
            processedByUserId: f.ownerA.id,
            processedAt: new Date(),
        },
    });
}

function ticketRow(ticketId: string) {
    return prisma.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        select: { status: true, checkedInAt: true, refundedAt: true },
    });
}

beforeAll(async () => {
    f = await setupIssuanceFixtures();
    fetchSpy = installGatewayStub();

    staff = await createUser("p15-gate-staff");

    await prisma.organizerMember.create({
        data: {
            organizerId: f.orgA.id,
            userId: staff.id,
            role: "CHECKIN_STAFF",
            status: "ACTIVE",
        },
    });

    const member = await prisma.organizerMember.findFirstOrThrow({
        where: { organizerId: f.orgA.id, userId: staff.id },
        select: { id: true },
    });

    await prisma.staffEventAssignment.create({
        data: {
            organizerMemberId: member.id,
            eventId: f.eventA.id,
            organizerId: f.orgA.id,
            assignedByUserId: f.ownerA.id,
        },
    });

    const first = await createPaidOrder({
        buyerId: f.buyerA.id,
        ticketTypeId: f.typeA.id,
        quantity: 10,
        tag: "p15-refund-gate",
    });

    const second = await createPaidOrder({
        buyerId: f.buyerA.id,
        ticketTypeId: f.typeA.id,
        quantity: 10,
        tag: "p15-refund-gate-2",
    });

    await issue(first.orderNumber, f.buyerA.id);
    await issue(second.orderNumber, f.buyerA.id);

    pool = [
        ...(await ticketsFor(first.orderId)).map((ticket) => ({
            id: ticket.id,
            ticketCode: ticket.ticketCode,
            orderNumber: first.orderNumber,
            orderId: first.orderId,
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
});

afterAll(async () => {
    const eventIds = [f.eventA.id];
    const orderIds = pool.map((ticket) => ticket.orderId);

    await prisma.checkIn.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.staffEventAssignment.deleteMany({
        where: { eventId: { in: eventIds } },
    });

    // A claim left open would block the ticket delete below.
    await prisma.refund.deleteMany({
        where: { eventOrderId: { in: orderIds } },
    });

    await teardownIssuanceFixtures(f);

    fetchSpy.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// The blocking matrix
// ─────────────────────────────────────────────────────────────────────────────

describe("P15-A. an open refund closes the door (P14-D15)", () => {
    it("refuses an ISSUED ticket whose refund is PENDING, and records the refusal", async () => {
        const ticket = nextTicket();

        const requested = await requestAsBuyer(ticket.orderNumber, [ticket.id]);
        expect(requested.status).toBe("PENDING");

        const rejection = (await expectRejection(() =>
            admit(f.eventA.id, ticket.ticketCode)
        )) as Rejection;

        expect(rejection.code).toBe("CONFLICT");
        expect(rejection.httpStatus).toBe(409);
        expect(rejection.details?.reason).toBe("REFUND_PENDING");

        // The refusal is evidence, not a side effect: the ticket did not move.
        const row = await ticketRow(ticket.id);
        expect(row.status).toBe("ISSUED");
        expect(row.checkedInAt).toBeNull();

        // A rejected attempt cannot carry `ticketId` (it is UNIQUE and belongs to the single
        // accepted admission), so the attempt is traced by the presented code in `note`.
        const refusal = await prisma.checkIn.findFirstOrThrow({
            where: { eventId: f.eventA.id, note: ticket.ticketCode },
            select: { result: true, method: true },
        });
        expect(refusal.result).toBe("REFUND_PENDING");
        expect(refusal.method).toBe("MANUAL");
    });

    it("refuses an APPROVED refund too — approval does not release the claim", async () => {
        const ticket = nextTicket();

        const requested = await requestAsBuyer(ticket.orderNumber, [ticket.id]);
        const owner = await organizerScope(f.orgA.id, f.ownerA.id);

        // `approveRefund` refuses a self-approval, so the buyer requests and the owner approves.
        await approveRefund(requested.refundId, owner, {}, nextRequest());

        const rejection = (await expectRejection(() =>
            admit(f.eventA.id, ticket.ticketCode)
        )) as Rejection;

        expect(rejection.code).toBe("CONFLICT");
        expect(rejection.details?.reason).toBe("REFUND_PENDING");

        expect((await ticketRow(ticket.id)).status).toBe("ISSUED");
    });

    it("refuses a PROCESSING refund, which is the state the money is actually in flight", async () => {
        const ticket = nextTicket();

        const requested = await requestAsBuyer(ticket.orderNumber, [ticket.id]);
        await forceStatus(requested.refundId, "PROCESSING");

        const rejection = (await expectRejection(() =>
            admit(f.eventA.id, ticket.ticketCode)
        )) as Rejection;

        expect(rejection.details?.reason).toBe("REFUND_PENDING");

        const refusal = await prisma.checkIn.findFirstOrThrow({
            where: { eventId: f.eventA.id, note: ticket.ticketCode },
            select: { result: true },
        });
        expect(refusal.result).toBe("REFUND_PENDING");
    });

    it("admits again once the claim is REJECTED — rejection released the seats", async () => {
        const ticket = nextTicket();

        const requested = await requestAsBuyer(ticket.orderNumber, [ticket.id]);
        const owner = await organizerScope(f.orgA.id, f.ownerA.id);

        await rejectRefund(
            requested.refundId,
            owner,
            { reason: "P15: released for admission" },
            nextRequest()
        );

        const result = await admit(f.eventA.id, ticket.ticketCode);

        expect(result.result).toBe("SUCCESS");
        expect(result.ticket.ticketCode).toBe(ticket.ticketCode);
        expect((await ticketRow(ticket.id)).status).toBe("CHECKED_IN");
    });

    it("admits after a FAILED refund, which is terminal and claimless", async () => {
        const ticket = nextTicket();

        const requested = await requestAsBuyer(ticket.orderNumber, [ticket.id]);
        await forceStatus(requested.refundId, "FAILED");

        await admit(f.eventA.id, ticket.ticketCode);

        expect((await ticketRow(ticket.id)).status).toBe("CHECKED_IN");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The invariant, in both directions
// ─────────────────────────────────────────────────────────────────────────────

describe("P15-B. a ticket cannot be both refund-claimed and admitted", () => {
    it("refuses the REFUNDED end state at the door (the CAS, not the guard)", async () => {
        const ticket = nextTicket();

        await prisma.ticket.update({
            where: { id: ticket.id },
            data: { status: "REFUNDED", refundedAt: new Date() },
        });

        const rejection = (await expectRejection(() =>
            admit(f.eventA.id, ticket.ticketCode)
        )) as Rejection;

        // The guard does not fire for a settled refund — `REFUNDED` is not an open claim —
        // so the admission CAS is what refuses, and it names the ticket's real status.
        expect(rejection.code).toBe("CONFLICT");
        expect(rejection.details?.reason).toBe("TICKET_NOT_ISSUED");
        expect(rejection.details?.status).toBe("REFUNDED");
        expect((await ticketRow(ticket.id)).checkedInAt).toBeNull();

        const refusal = await prisma.checkIn.findFirstOrThrow({
            where: { eventId: f.eventA.id, note: ticket.ticketCode },
            select: { result: true },
        });
        expect(refusal.result).toBe("INVALID_TICKET");
    });

    it("refuses a refund request for an admitted ticket (Phase 10B's D-R05)", async () => {
        const ticket = nextTicket();

        await admit(f.eventA.id, ticket.ticketCode);

        const rejection = (await expectRejection(() =>
            requestAsBuyer(ticket.orderNumber, [ticket.id])
        )) as Rejection;

        expect(rejection.code).toBe("REFUND_NOT_ALLOWED");
        expect(await prisma.refundItem.count({ where: { ticketId: ticket.id } })).toBe(0);
    });

    it("lets exactly one of a concurrent check-in and refund request own the ticket", async () => {
        const ticket = nextTicket();

        // The buyer's scope is resolved BEFORE the race: `customerScope` also re-signs the
        // mocked session in, and a second sign-in landing mid-flight would swap the gate
        // actor out from under `checkInTicket`. The refund path takes its authority from the
        // scope object passed in, so only the gate reads the session — and it reads it as
        // the assigned gate member.
        const buyer = await customerScope(f.buyerA.id);

        const [gate, refund] = await Promise.allSettled([
            admit(f.eventA.id, ticket.ticketCode),
            requestRefund(
                { orderNumber: ticket.orderNumber, ticketIds: [ticket.id] },
                buyer,
                nextRequest("/api/ticketing/refunds")
            ),
        ]);

        const gateWon = gate.status === "fulfilled";
        const refundWon = refund.status === "fulfilled";

        // Exactly one: never both, and never neither.
        expect(gateWon).not.toBe(refundWon);

        const row = await ticketRow(ticket.id);
        const claims = await prisma.refundItem.count({ where: { ticketId: ticket.id } });

        if (gateWon) {
            // Check-in owned the row first: the refund request must have been refused
            // outright, and no claim may exist behind an admission.
            expect(row.status).toBe("CHECKED_IN");
            expect(claims).toBe(0);
            expect(refund.status).toBe("rejected");
        } else {
            // A refund claim owned the row first: the gate must have refused with
            // REFUND_PENDING, never merely failed on state.
            expect(row.status).toBe("ISSUED");
            expect(row.checkedInAt).toBeNull();
            expect(claims).toBe(1);
            expect(gate.status).toBe("rejected");

            if (gate.status === "rejected") {
                expect((gate.reason as { details?: { reason?: string } }).details?.reason).toBe(
                    "REFUND_PENDING"
                );
            }
        }
    });

    it("holds the same invariant when the refund request is launched first", async () => {
        const ticket = nextTicket();
        const buyer = await customerScope(f.buyerA.id);

        const [refund, gate] = await Promise.allSettled([
            requestRefund(
                { orderNumber: ticket.orderNumber, ticketIds: [ticket.id] },
                buyer,
                nextRequest("/api/ticketing/refunds")
            ),
            admit(f.eventA.id, ticket.ticketCode),
        ]);

        expect(gate.status === "fulfilled").not.toBe(refund.status === "fulfilled");

        const row = await ticketRow(ticket.id);
        const claims = await prisma.refundItem.count({ where: { ticketId: ticket.id } });

        if (claims === 1) {
            // The claim exists, so the gate must not have admitted anybody.
            expect(row.status).toBe("ISSUED");
            expect(row.checkedInAt).toBeNull();
            expect(gate.status).toBe("rejected");
        } else {
            // No claim exists, so admission is the only valid outcome.
            expect(row.status).toBe("CHECKED_IN");
            expect(refund.status).toBe("rejected");
            expect(gate.status).toBe("fulfilled");
        }
    });
});
