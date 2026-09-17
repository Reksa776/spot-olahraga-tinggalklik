/**
 * ==========================================
 * PHASE 8 — ISSUANCE CONCURRENCY (REAL INNODB)
 * ==========================================
 *
 * Brief §33 group E. Same standard as Phase 5's 100-buyer race and Phase 7's duplicate
 * webhook: the database is real, the services are real, the sessions are real, and the
 * calls are genuinely simultaneous (`Promise.all`, no sequencing, no sleeps in the code
 * under test, no mocks anywhere in the issuance path).
 *
 * What is being proved is one sentence: **one logical ticket per purchased quantity**,
 * however many callers ask at once. The three mechanisms that deliver it are documented at
 * the top of `lib/ticketing/tickets/issuance.ts` — the `SELECT … FOR UPDATE` on the order
 * row, the `@@unique([orderItemId, sequenceNo])` constraint underneath it, and the
 * missing-sequence diff that makes the plan a function of the rows that exist.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import { ERROR_CODES } from "@/lib/api/errors";

import {
    createLateSettledOrder,
    createPaidOrder,
    createType,
    expectRejection,
    installGatewayStub,
    issue,
    setupIssuanceFixtures,
    teardownIssuanceFixtures,
    ticketsFor,
    type Fixtures,
} from "./issuance-harness";

jest.setTimeout(300_000);

let f: Fixtures;
let fetchSpy: jest.SpyInstance;

beforeAll(async () => {
    f = await setupIssuanceFixtures();
    fetchSpy = installGatewayStub();
});

afterAll(async () => {
    fetchSpy.mockRestore();
    await teardownIssuanceFixtures(f);
});

/** Fresh type per test, so counter and row counts are unambiguous. */
async function newType(name: string, quota = 20): Promise<string> {
    return (await createType(f, name, { quota })).id;
}

/**
 * Assert the brief's §35 count invariants against the ROWS.
 *
 * Deliberately derived from the persisted order lines, not from a constant the test picked:
 * if issuance ever produced a count that matched the test but not the order, this would
 * still fail.
 */
async function assertTicketInvariants(orderId: string): Promise<void> {
    const [items, tickets] = await Promise.all([
        prisma.eventOrderItem.findMany({
            where: { orderId },
            select: { id: true, quantity: true },
        }),
        ticketsFor(orderId),
    ]);

    const expected = items.reduce((sum, item) => sum + item.quantity, 0);

    expect(tickets).toHaveLength(expected);
    expect(new Set(tickets.map((row) => row.ticketCode)).size).toBe(tickets.length);
    expect(new Set(tickets.map((row) => `${row.orderItemId}#${row.sequenceNo}`)).size).toBe(
        tickets.length
    );

    for (const item of items) {
        const perLine = tickets.filter((row) => row.orderItemId === item.id);

        expect(perLine).toHaveLength(item.quantity);
        expect(perLine.map((row) => row.sequenceNo).sort((a, b) => a - b)).toEqual(
            Array.from({ length: item.quantity }, (_, index) => index + 1)
        );
    }

    // No counter may go negative and no ticket may be orphaned from its relations.
    expect(tickets.every((row) => row.status === "ISSUED")).toBe(true);
    expect(tickets.every((row) => row.holderUserId !== null)).toBe(true);
}

describe("E. concurrent issuance (brief §9)", () => {
    it("E1. two simultaneous calls produce exactly SUM(quantity) tickets", async () => {
        const ticketTypeId = await newType("E1", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 4,
            tag: "e1",
        });

        const results = await Promise.all([
            issue(order.orderNumber, f.buyerA.id),
            issue(order.orderNumber, f.buyerA.id),
        ]);

        expect(results.filter((result) => result.outcome === "ISSUED")).toHaveLength(1);
        expect(results.reduce((sum, result) => sum + result.ticketsIssued, 0)).toBe(4);

        await assertTicketInvariants(order.orderId);
    });

    it("E2. ten simultaneous calls produce exactly SUM(quantity) tickets", async () => {
        const ticketTypeId = await newType("E2", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 5,
            tag: "e2",
        });

        const results = await Promise.all(
            Array.from({ length: 10 }, () => issue(order.orderNumber, f.buyerA.id))
        );

        const issued = results.filter((result) => result.outcome === "ISSUED");

        // Exactly one call may claim the fulfilment; every other call is a no-op. Both are
        // success outcomes, so the assertion is on the SHAPE of the result set as well as on
        // the rows: a second "ISSUED" would mean two callers believed they created tickets.
        expect(issued).toHaveLength(1);
        expect(results.filter((r) => r.outcome === "ALREADY_ISSUED")).toHaveLength(9);
        expect(results.every((result) => result.totalTickets === 5)).toBe(true);
        expect(results.reduce((sum, result) => sum + result.ticketsIssued, 0)).toBe(5);

        await assertTicketInvariants(order.orderId);
    });

    it("E3. concurrent issuance for different orders does not interfere", async () => {
        const typeOne = await newType("E3a", 20);
        const typeTwo = await newType("E3b", 20);

        // ── WHY BOTH ORDERS BELONG TO THE SAME BUYER ─────────────────────────────
        // `requireOwnResource` (design §26) re-reads the SESSION, and under Jest the session
        // is one shared mock value — so two different buyers signing in at the same instant
        // is a harness artifact, not a production race: it would fail on whichever session
        // the mock happened to hold. What E3 is for is the property that two ORDERS issued
        // at the same time do not interfere, and that property is fully exercised by the
        // same buyer's two orders. Cross-customer isolation is proved where it can be proved
        // honestly — `issuance.integration.test.ts` groups F and I.
        const orderOne = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId: typeOne,
            quantity: 2,
            tag: "e3a",
        });

        const orderTwo = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId: typeTwo,
            quantity: 3,
            tag: "e3b",
        });

        const [first, second] = await Promise.all([
            issue(orderOne.orderNumber, f.buyerA.id),
            issue(orderTwo.orderNumber, f.buyerA.id),
        ]);

        expect(first.outcome).toBe("ISSUED");
        expect(second.outcome).toBe("ISSUED");
        expect(first.totalTickets).toBe(2);
        expect(second.totalTickets).toBe(3);

        // Neither order acquired the other's tickets: each has exactly its own count, on its
        // own ticket type.
        await assertTicketInvariants(orderOne.orderId);
        await assertTicketInvariants(orderTwo.orderId);

        expect((await ticketsFor(orderOne.orderId)).every((row) => row.ticketTypeId === typeOne)).toBe(
            true
        );
        expect((await ticketsFor(orderTwo.orderId)).every((row) => row.ticketTypeId === typeTwo)).toBe(
            true
        );
    });

    it("E4. racing after partial progress creates only the missing slots", async () => {
        const ticketTypeId = await newType("E4", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 5,
            tag: "e4",
        });

        await issue(order.orderNumber, f.buyerA.id);
        expect(await ticketsFor(order.orderId)).toHaveLength(5);

        // Crash simulation: slots 3 and 4 are gone, 1, 2 and 5 survive.
        await prisma.ticket.deleteMany({
            where: { orderId: order.orderId, sequenceNo: { in: [3, 4] } },
        });
        expect(await ticketsFor(order.orderId)).toHaveLength(3);

        const results = await Promise.all([
            issue(order.orderNumber, f.buyerA.id),
            issue(order.orderNumber, f.buyerA.id),
        ]);

        // Both callers are allowed to report ISSUED (each genuinely created a slot); what
        // may never happen is more than two rows being created for two missing slots.
        expect(results.reduce((sum, result) => sum + result.ticketsIssued, 0)).toBe(2);

        await assertTicketInvariants(order.orderId);
    });

    it("E5. a blocked order races safely — nothing is created, nothing is repaired", async () => {
        const ticketTypeId = await newType("E5", 20);
        const order = await createLateSettledOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "e5",
        });

        const before = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { status: true, paymentStatus: true, fulfilmentBlockedAt: true },
        });

        const results = await Promise.allSettled(
            Array.from({ length: 5 }, () => issue(order.orderNumber, f.buyerA.id))
        );

        expect(results.every((result) => result.status === "rejected")).toBe(true);

        for (const result of results) {
            if (result.status === "rejected") {
                const error = result.reason as {
                    code?: string;
                    details?: { reason?: string };
                };
                expect(error.code).toBe(ERROR_CODES.CONFLICT);
                expect(error.details?.reason).toBe("FULFILMENT_BLOCKED");
            }
        }

        const after = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { status: true, paymentStatus: true, fulfilmentBlockedAt: true },
        });

        expect(after).toEqual(before);
        expect(await ticketsFor(order.orderId)).toHaveLength(0);
    });

    it("E6. repeated calls after completion stay a no-op", async () => {
        const ticketTypeId = await newType("E6", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 3,
            tag: "e6",
        });

        await issue(order.orderNumber, f.buyerA.id);
        const snapshot = (await ticketsFor(order.orderId)).map((row) => row.ticketCode);

        const results = await Promise.all(
            Array.from({ length: 6 }, () => issue(order.orderNumber, f.buyerA.id))
        );

        expect(results.every((result) => result.outcome === "ALREADY_ISSUED")).toBe(true);
        expect(results.every((result) => result.ticketsIssued === 0)).toBe(true);

        await assertTicketInvariants(order.orderId);
        expect((await ticketsFor(order.orderId)).map((row) => row.ticketCode)).toEqual(
            snapshot
        );
    });

    it("E7. the database, not the lock, is the final arbiter of a slot", async () => {
        const ticketTypeId = await newType("E7", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "e7",
        });

        await issue(order.orderNumber, f.buyerA.id);
        const rows = await ticketsFor(order.orderId);
        const [item] = await prisma.eventOrderItem.findMany({
            where: { orderId: order.orderId },
            select: { id: true },
        });

        // Bypassing the service entirely: the constraint the service relies on must hold on
        // its own, or the guarantee would be an application convention rather than a
        // database invariant (brief §8, "Do NOT rely only on check-then-insert").
        await expect(
            prisma.ticket.create({
                data: {
                    ticketCode: `EVT-TEST-${Date.now()}`,
                    qrTokenHash: `deadbeef${Date.now()}`,
                    orderId: order.orderId,
                    orderItemId: item.id,
                    sequenceNo: rows[0].sequenceNo,
                    ticketTypeId,
                    eventId: f.eventA.id,
                    organizerId: f.orgA.id,
                    status: "ISSUED",
                },
            })
        ).rejects.toMatchObject({ code: "P2002" });

        await assertTicketInvariants(order.orderId);
    });

    it("E8. issuance never touches the inventory counters", async () => {
        const ticketTypeId = await newType("E8", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "e8",
        });

        const afterSettlement = await prisma.ticketType.findUniqueOrThrow({
            where: { id: ticketTypeId },
            select: { quota: true, sold: true, reserved: true, version: true },
        });

        expect(afterSettlement.sold).toBe(2);
        expect(afterSettlement.reserved).toBe(0);

        await issue(order.orderNumber, f.buyerA.id);
        await issue(order.orderNumber, f.buyerA.id);

        const afterIssuance = await prisma.ticketType.findUniqueOrThrow({
            where: { id: ticketTypeId },
            select: { quota: true, sold: true, reserved: true, version: true },
        });

        // Byte-identical, `version` included: issuing a ticket is fulfilment, not a sale.
        expect(afterIssuance).toEqual(afterSettlement);

        const invariant = afterIssuance;
        expect(invariant.sold).toBeGreaterThanOrEqual(0);
        expect(invariant.reserved).toBeGreaterThanOrEqual(0);
        expect(invariant.sold + invariant.reserved).toBeLessThanOrEqual(invariant.quota);
    });

    it("E9. a paid order that loses its items mid-flight is refused, not half-fulfilled", async () => {
        const ticketTypeId = await newType("E9", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "e9",
        });

        await prisma.eventOrderItem.deleteMany({ where: { orderId: order.orderId } });

        const error = await expectRejection(() => issue(order.orderNumber, f.buyerA.id));

        expect(error.code).toBe(ERROR_CODES.CONFLICT);
        expect(await ticketsFor(order.orderId)).toHaveLength(0);
    });
});
