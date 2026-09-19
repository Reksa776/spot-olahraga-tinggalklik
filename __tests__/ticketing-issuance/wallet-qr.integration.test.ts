/**
 * ==========================================
 * PHASE 16 — WALLET / QR (INTEGRATION)
 * ==========================================
 *
 * Executes the REAL wallet read side (`getOwnTicket`, `listOwnTickets`) against the REAL
 * MariaDB, on tickets produced by the real chain: checkout → payment → HMAC settlement →
 * issuance. Only `@/auth` and the provider SOCKET are substituted, so every ownership and
 * admission decision below is made by production code.
 *
 * WHAT PHASE 16 ADDED, AND WHAT THIS SUITE THEREFORE PROVES
 * --------------------------------------------------------
 * The QR verdict (`admission.scannable`) used to be a function of the TICKET's status alone, so
 * an `ISSUED` ticket for an event that had been cancelled, archived, or completed and past its
 * grace window still told the buyer to show it at the door — while `checkInTicket` would have
 * refused it with `EVENT_NOT_OPEN`. Phase 16 makes the verdict event-aware by re-using the ONE
 * canonical predicate (`isEventCheckInOpen`, Phase 15) instead of inventing a second one.
 *
 * The three properties only a real database can demonstrate:
 *
 *   1. the event half is decided from the ROW the gate would read (status, `cancelledAt`,
 *      `archivedAt`, `endAt`), not from a client hint;
 *   2. the boundary is exact — the window closes at `endAt + 30 minutes`, inclusive, which is
 *      asserted by passing the clock in rather than by racing it;
 *   3. a ticket whose QR is withheld is STILL fully readable by its owner (the ticket stays
 *      accessible; only the false affordance goes away).
 *
 * Time states are ARRANGED with direct writes (the service refuses a past `startAt`, and Phase
 * 15's transitions are already covered by its own suite); the business transitions that could
 * produce them — cancel, archive, complete — are the real services below wherever the service
 * allows the call.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { archiveEvent, cancelEvent, createEvent, publishEvent } from "@/lib/events/service";
import { prisma } from "@/lib/prisma";
import { createTicketType } from "@/lib/ticket-types/service";
import { getOwnTicket, listOwnTickets } from "@/lib/ticketing/tickets/service";
import { CHECK_IN_GRACE_MS } from "@/lib/events/lifecycle";

import {
    createPaidOrder,
    customerScope,
    expectRejection,
    installGatewayStub,
    issue,
    nextRequest,
    organizerScope,
    setupIssuanceFixtures,
    teardownIssuanceFixtures,
    ticketsFor,
    type Fixtures,
    type Rejection,
} from "../ticketing-issuance/issuance-harness";
import { FUTURE, FUTURE_END, SUFFIX } from "../ticketing-payment/payment-harness";

jest.setTimeout(120_000);

let f: Fixtures;
let fetchSpy: jest.SpyInstance;

/** Every event this suite creates, so the teardown can drop them children-first. */
const createdEvents: string[] = [];

const MINUTE = 60_000;

type Scenario = {
    /** The ticket's code, and its sequence within its order. */
    ticketCode: string;
    ticketId: string;
    orderNumber: string;
    orderId: string;
};

/**
 * A dedicated published event with one paid, issued ticket.
 *
 * ORDER MATTERS: the ticket is bought and issued while the event is legitimately ON SALE (a
 * future `startAt`, published), and only then are `startAt`/`endAt`/`status` arranged into the
 * scenario's time state. Buying after the dates moved would be refused by the real sales window
 * (`SALES_NOT_OPEN`) — correctly, and for a reason that has nothing to do with what is being
 * tested here. Nothing about the ticket is fabricated: it still comes from the real
 * buy → settle → issue chain.
 */
async function scenario(options: {
    tag: string;
    startAt: Date;
    endAt: Date | null;
    status?: "PUBLISHED" | "ONGOING" | "COMPLETED";
    quantity?: number;
}): Promise<Scenario> {
    const owner = await organizerScope(f.orgA.id, f.ownerA.id);

    const event = await createEvent(owner, f.orgA.id, {
        title: `${options.tag} ${SUFFIX}`,
        sportId: f.sportId,
        startAt: FUTURE,
        // PHASE 20B (D-P19-05 = A): `publishEvent` refuses an event with no `endAt`. The
        // scenario's own `endAt` is arranged two steps below, after the purchase, so this is
        // purely the value that makes the event publishable in the first place.
        endAt: FUTURE_END,
    } as never);

    createdEvents.push(event.id);

    const type = await createTicketType(owner, event.id, {
        name: `Reguler ${options.tag}`,
        price: "150000.00",
        quota: 20,
    } as never);

    await publishEvent(owner, event.id);

    // Sold while the event is still on sale, exactly as a real buyer would have bought it.
    const order = await createPaidOrder({
        buyerId: f.buyerA.id,
        ticketTypeId: type.id,
        quantity: options.quantity ?? 1,
        tag: `p16-${options.tag}`,
        eventId: event.id,
    });

    await issue(order.orderNumber, f.buyerA.id);

    // Now arrange the time state the wallet must reason about.
    await prisma.event.update({
        where: { id: event.id },
        data: {
            startAt: options.startAt,
            endAt: options.endAt,
            ...(options.status ? { status: options.status } : {}),
        },
    });

    // A venue with the two public location fields, so the payload's venue projection is
    // exercised with real data rather than nulls.
    const venue = await prisma.venue.create({
        data: {
            organizerId: f.orgA.id,
            name: `GOR ${options.tag} ${SUFFIX}`,
            city: "Bandung",
            address: "Jl. Jakarta No. 1",
        },
        select: { id: true },
    });

    await prisma.event.update({
        where: { id: event.id },
        data: { venueId: venue.id },
    });

    const [ticket] = await ticketsFor(order.orderId);

    if (!ticket) {
        throw new Error(`Fixture error: no ticket issued for ${options.tag}`);
    }

    return {
        ticketCode: ticket.ticketCode,
        ticketId: ticket.id,
        orderNumber: order.orderNumber,
        orderId: order.orderId,
    };
}

async function buyerScope() {
    return customerScope(f.buyerA.id);
}

beforeAll(async () => {
    f = await setupIssuanceFixtures();
    fetchSpy = installGatewayStub();
});

afterAll(async () => {
    // Children first, for each event this suite created.
    for (const eventId of createdEvents) {
        const orderIds = (
            await prisma.eventOrder.findMany({
                where: { eventId },
                select: { id: true },
            })
        ).map((row) => row.id);

        await prisma.checkIn.deleteMany({ where: { eventId } });
        await prisma.refund.deleteMany({ where: { eventOrderId: { in: orderIds } } });
        // BEFORE the orders: the ledger's `orderId` is `SetNull`, so a row deleted after its
        // order is orphaned — and its `providerEventId` (built from the harness's per-process
        // `TRX-P8-settle-N` counter) would then collide with the next process's first
        // settlement, turning a fixture into a silent DUPLICATE. The Phase 7/8 suites clean
        // their own ledger rows for exactly this reason.
        await prisma.webhookEvent.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.ticketReservation.deleteMany({ where: { eventId } });
        // Tickets BEFORE order items: `Ticket.orderItemId` is `Restrict`.
        await prisma.ticket.deleteMany({ where: { eventId } });
        await prisma.eventOrderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.eventOrder.deleteMany({ where: { eventId } });
        await prisma.ticketType.deleteMany({ where: { eventId } });

        const event = await prisma.event.findUnique({
            where: { id: eventId },
            select: { venueId: true },
        });

        await prisma.event.delete({ where: { id: eventId } });

        if (event?.venueId) {
            await prisma.venue.delete({ where: { id: event.venueId } });
        }
    }

    await teardownIssuanceFixtures(f);

    fetchSpy.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// The event half of the QR verdict
// ─────────────────────────────────────────────────────────────────────────────

describe("P16-A. a live event keeps the QR live", () => {
    test("an ISSUED ticket for a running event is scannable, with the locked payload", async () => {
        const now = new Date();
        const s = await scenario({
            tag: "live",
            startAt: new Date(now.getTime() - 30 * MINUTE),
            endAt: new Date(now.getTime() + 30 * MINUTE),
            status: "ONGOING",
        });

        const detail = await getOwnTicket(s.ticketCode, await buyerScope());

        expect(detail.admission).toEqual({ scannable: true, reason: null });
        expect(detail.qr.payload).toBe(`TICKET:${s.ticketCode}`);
        expect(detail.status).toBe("ISSUED");
    });

    test("the window is inclusive at exactly endAt + 30 minutes, and closed one millisecond later", async () => {
        const endAt = new Date("2026-09-19T10:00:00.000Z");
        const s = await scenario({
            tag: "boundary",
            startAt: new Date(endAt.getTime() - 60 * MINUTE),
            endAt,
            status: "ONGOING",
        });

        const scope = await buyerScope();

        const atBoundary = await getOwnTicket(
            s.ticketCode,
            scope,
            new Date(endAt.getTime() + CHECK_IN_GRACE_MS)
        );
        const justAfter = await getOwnTicket(
            s.ticketCode,
            scope,
            new Date(endAt.getTime() + CHECK_IN_GRACE_MS + 1)
        );

        expect(atBoundary.admission).toEqual({ scannable: true, reason: null });
        expect(justAfter.admission).toEqual({
            scannable: false,
            reason: "EVENT_NOT_OPEN",
        });
    });
});

describe("P16-B. a finished, cancelled or archived event does not offer a door", () => {
    test("a completed event past its grace window withholds the QR", async () => {
        const now = new Date();
        const s = await scenario({
            tag: "completed",
            startAt: new Date(now.getTime() - 4 * 60 * MINUTE),
            endAt: new Date(now.getTime() - 60 * MINUTE),
            status: "COMPLETED",
        });

        const detail = await getOwnTicket(s.ticketCode, await buyerScope());

        expect(detail.admission).toEqual({
            scannable: false,
            reason: "EVENT_NOT_OPEN",
        });
        // Withheld — not revoked. The buyer keeps the record of what they hold.
        expect(detail.status).toBe("ISSUED");
        expect(detail.ticketCode).toBe(s.ticketCode);
        expect(detail.qr.payload).toBe(`TICKET:${s.ticketCode}`);
    });

    test("a cancelled event withholds the QR, through the real cancel service", async () => {
        const now = new Date();
        const s = await scenario({
            tag: "cancelled",
            startAt: new Date(now.getTime() + 60 * MINUTE),
            endAt: new Date(now.getTime() + 3 * 60 * MINUTE),
        });

        const owner = await organizerScope(f.orgA.id, f.ownerA.id);
        const eventId = createdEvents[createdEvents.length - 1];

        await cancelEvent(owner, eventId, { reason: null }, nextRequest());

        const detail = await getOwnTicket(s.ticketCode, await buyerScope());

        expect(detail.admission.reason).toBe("EVENT_NOT_OPEN");

        // Cancellation does not void tickets (Phase 12), so the row is still ISSUED...
        expect(detail.status).toBe("ISSUED");
        // ...and the ticket is still reachable by its owner.
        const wallet = await listOwnTickets(
            { upcoming: false, limit: 50 },
            await buyerScope()
        );
        expect(wallet.items.map((item) => item.ticketCode)).toContain(s.ticketCode);
    });

    test("an archived event withholds the QR, through the real archive service", async () => {
        const now = new Date();
        const s = await scenario({
            tag: "archived",
            startAt: new Date(now.getTime() + 60 * MINUTE),
            endAt: new Date(now.getTime() + 3 * 60 * MINUTE),
        });

        const owner = await organizerScope(f.orgA.id, f.ownerA.id);
        const eventId = createdEvents[createdEvents.length - 1];

        await archiveEvent(owner, eventId);

        const detail = await getOwnTicket(s.ticketCode, await buyerScope());

        expect(detail.status).toBe("ISSUED");
        expect(detail.admission.reason).toBe("EVENT_NOT_OPEN");
    });

    test("the ticket's own status outranks the event's when both would refuse", async () => {
        const now = new Date();
        const s = await scenario({
            tag: "precedence",
            startAt: new Date(now.getTime() - 4 * 60 * MINUTE),
            endAt: new Date(now.getTime() - 60 * MINUTE),
            status: "COMPLETED",
        });

        await prisma.ticket.update({
            where: { id: s.ticketId },
            data: { status: "REFUNDED", refundedAt: new Date() },
        });

        const detail = await getOwnTicket(s.ticketCode, await buyerScope());

        // "Your money came back" is the fact the buyer needs most; the shuttered door is not
        // the more important sentence.
        expect(detail.admission).toEqual({
            scannable: false,
            reason: "TICKET_REFUNDED",
        });
    });

    test("a checked-in ticket on an open event reports the admission, not the window", async () => {
        const now = new Date();
        const s = await scenario({
            tag: "checkedin",
            startAt: new Date(now.getTime() - 30 * MINUTE),
            endAt: new Date(now.getTime() + 30 * MINUTE),
            status: "ONGOING",
        });

        await prisma.ticket.update({
            where: { id: s.ticketId },
            data: { status: "CHECKED_IN", checkedInAt: new Date() },
        });

        const detail = await getOwnTicket(s.ticketCode, await buyerScope());

        expect(detail.admission).toEqual({
            scannable: false,
            reason: "ALREADY_CHECKED_IN",
        });
        expect(detail.checkedInAt).not.toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Presentation facts and addressability
// ─────────────────────────────────────────────────────────────────────────────

describe("P16-C. the payload carries public venue facts and no secret", () => {
    test("exposes the venue city and street address", async () => {
        const now = new Date();
        const s = await scenario({
            tag: "venue",
            startAt: new Date(now.getTime() + 60 * MINUTE),
            endAt: new Date(now.getTime() + 3 * 60 * MINUTE),
        });

        const detail = await getOwnTicket(s.ticketCode, await buyerScope());

        expect(detail.event.venueCity).toBe("Bandung");
        expect(detail.event.venueAddress).toBe("Jl. Jakarta No. 1");
        expect(detail.event.venueName).toContain("GOR venue");
    });

    test("still returns no token, no hash and no URL anywhere in the detail", async () => {
        const now = new Date();
        const s = await scenario({
            tag: "secrets",
            startAt: new Date(now.getTime() + 60 * MINUTE),
            endAt: new Date(now.getTime() + 3 * 60 * MINUTE),
        });

        const detail = await getOwnTicket(s.ticketCode, await buyerScope());
        const serialized = JSON.stringify(detail);

        for (const forbidden of ["qrToken", "qrTokenHash", "http://", "https://"]) {
            expect(serialized).not.toContain(forbidden);
        }

        const stored = await prisma.ticket.findUniqueOrThrow({
            where: { id: s.ticketId },
            select: { qrTokenHash: true },
        });

        expect(stored.qrTokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(serialized).not.toContain(stored.qrTokenHash);
    });

    test("the wallet list carries the venue facts but still no QR at all", async () => {
        const now = new Date();
        const s = await scenario({
            tag: "listshape",
            startAt: new Date(now.getTime() + 60 * MINUTE),
            endAt: new Date(now.getTime() + 3 * 60 * MINUTE),
        });

        const wallet = await listOwnTickets({ upcoming: false, limit: 50 }, await buyerScope());
        const item = wallet.items.find((row) => row.ticketCode === s.ticketCode);

        expect(item).toBeDefined();
        expect(item?.event.venueCity).toBe("Bandung");
        expect(item && "qr" in item).toBe(false);
        expect(JSON.stringify(item)).not.toContain("TICKET:");
    });
});

describe("P16-D. every ticket from one order stays individually addressable", () => {
    test("two tickets of one order are distinct rows, distinct codes, each readable alone", async () => {
        const now = new Date();
        const s = await scenario({
            tag: "multi",
            startAt: new Date(now.getTime() + 60 * MINUTE),
            endAt: new Date(now.getTime() + 3 * 60 * MINUTE),
            quantity: 2,
        });

        const rows = await ticketsFor(s.orderId);
        expect(rows).toHaveLength(2);

        const codes = rows.map((row) => row.ticketCode);
        expect(new Set(codes).size).toBe(2);
        expect(codes).toContain(s.ticketCode);

        for (const code of codes) {
            const detail = await getOwnTicket(code, await buyerScope());

            expect(detail.orderNumber).toBe(s.orderNumber);
            expect(detail.qr.payload).toBe(`TICKET:${code}`);
        }

        // Both rows are in the wallet, and they are the two real tickets rather than one row
        // repeated.
        const wallet = await listOwnTickets({ upcoming: false, limit: 50 }, await buyerScope());
        const mine = wallet.items.filter((item) => item.orderNumber === s.orderNumber);

        expect(mine.map((item) => item.ticketCode).sort()).toEqual(codes.slice().sort());
        expect(mine.map((item) => item.sequenceNo).sort()).toEqual([1, 2]);
    });

    test("another buyer cannot read the ticket, by code or by guessing", async () => {
        const now = new Date();
        const s = await scenario({
            tag: "crossuser",
            startAt: new Date(now.getTime() + 60 * MINUTE),
            endAt: new Date(now.getTime() + 3 * MINUTE * 60),
        });

        const stranger = await customerScope(f.buyerB.id);

        const rejection = (await expectRejection(() =>
            getOwnTicket(s.ticketCode, stranger)
        )) as Rejection;

        // 404, never 403: a refusal that distinguished "not yours" from "does not exist" would
        // confirm that the code is real.
        expect(rejection.code).toBe("NOT_FOUND");
        expect(rejection.httpStatus).toBe(404);

        const wallet = await listOwnTickets({ upcoming: false, limit: 50 }, stranger);
        expect(wallet.items.map((item) => item.ticketCode)).not.toContain(s.ticketCode);
    });
});
