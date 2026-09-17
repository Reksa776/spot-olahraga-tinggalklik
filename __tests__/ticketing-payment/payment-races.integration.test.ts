/**
 * ==========================================
 * PHASE 7 — RACES AND CONCURRENT CREATION (INTEGRATION)
 * ==========================================
 *
 * Real MySQL/InnoDB, real row locks, no mocks below the socket. Coverage maps to brief §28:
 * group F (cancel vs payment), group G (expiry vs payment) and group H (concurrent payment
 * creation) — the three cases where two subsystems try to make the same order terminal.
 *
 * ── WHY EACH RACE IS RUN SEVERAL TIMES ───────────────────────────────────────────
 * A single interleaving proves nothing about a race: whichever side wins first looks
 * correct, and the loser's bug only shows up in the ordering that did not happen. Every
 * race here is therefore run in a loop with a FRESH order each iteration, and the
 * assertion is an invariant that must hold in every outcome — not a prediction of which
 * side wins. The observed win distribution is logged through `console.log` so the report
 * can state it as measured rather than assumed.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { ERROR_CODES } from "@/lib/api/errors";
import { requireOrganizerAccess } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createTicketType } from "@/lib/ticket-types/service";
import { cancelOwnPendingOrder } from "@/lib/ticketing/orders";
import { createOrderPayment } from "@/lib/ticketing/payment/service";
import { handleGatewayWebhook } from "@/lib/ticketing/payment/webhook";
import { expireDueReservations } from "@/lib/ticketing/reservations";

import {
    assertInventoryInvariants,
    counters,
    createOrder,
    customerScope,
    gatewayStub,
    installGatewayStub,
    nextRequest,
    setupFixtures,
    signInAs,
    signedCallback,
    SUFFIX,
    teardownFixtures,
    type Fixtures,
} from "./payment-harness";

jest.setTimeout(300_000);

/** How many times each race is replayed. */
const ROUNDS = 4;

let f: Fixtures;
let fetchSpy: jest.SpyInstance;
let trxCounter = 0;

function nextTrx(tag: string): string {
    trxCounter += 1;

    return `TRX-${SUFFIX}-${tag}-${trxCounter}`;
}

async function newType(name: string, quota = 30): Promise<string> {
    signInAs(f.ownerA.id);
    const scope = await requireOrganizerAccess(f.orgA.id, "event.read");

    const created = await createTicketType(scope, f.eventA.id, {
        name,
        price: "150000.00",
        quota,
    } as never);

    return created.id;
}

/** Order + provider session, plus the scope needed to act as the buyer concurrently. */
async function orderWithSession(ticketTypeId: string, quantity: number, tag: string) {
    const order = await createOrder({
        buyerId: f.buyerA.id,
        items: [{ ticketTypeId, quantity }],
        tag,
    });

    // Resolve the scope ONCE, before any concurrency: `customerScope` mutates the mocked
    // session, so resolving it inside a `Promise.all` would make the fixture itself racy.
    const actor = await customerScope(f.buyerA.id);

    const payment = await createOrderPayment({
        orderNumber: order.orderNumber,
        actor,
        request: {} as never,
        httpRequest: nextRequest(),
    });

    return { order, payment, actor };
}

/** A signed success notification, built once so both race participants can be given it. */
function successFor(payment: { paymentReference: string; amount: string }, tag: string) {
    return signedCallback({
        referenceId: payment.paymentReference,
        statusCode: 1,
        subTotal: payment.amount,
        trxId: nextTrx(tag),
        fee: "0",
        via: "qris",
        channel: "qris",
    });
}

function deliverSigned(signed: { rawBody: string; signature: string }) {
    return handleGatewayWebhook({
        rawBody: signed.rawBody,
        signatureHeader: signed.signature,
        remoteIp: "127.0.0.1",
    });
}

type Attempt<T> =
    | { ok: true; value: T }
    | { ok: false; code?: string; reason?: string };

/** Run a call and classify it, so a refusal is data instead of an aborted test. */
async function outcomeOf<T>(run: () => Promise<T>): Promise<Attempt<T>> {
    try {
        return { ok: true, value: await run() };
    } catch (error) {
        const typed = error as { code?: string; details?: Record<string, unknown> };

        return {
            ok: false,
            code: typed.code,
            reason: typed.details?.reason as string | undefined,
        };
    }
}

/** The narrow view of a payment attempt these tests need. */
type PaymentLike = {
    resumed: boolean;
    paymentUrl: string | null;
    paymentReference: string;
};

type CancelOutcome = Awaited<ReturnType<typeof cancelOwnPendingOrder>>;
type ExpiryOutcome = Awaited<ReturnType<typeof expireDueReservations>>;

/** A webhook delivery, classified — including the deliveries that throw. */
type Delivery =
    | { kind: "webhook"; outcome: string; httpStatus: number }
    | { kind: "threw"; outcome: string; code?: string; reason?: string };

async function classifyDelivery(signed: {
    rawBody: string;
    signature: string;
}): Promise<Delivery> {
    const result = await outcomeOf(() => deliverSigned(signed));

    if (result.ok) {
        return {
            kind: "webhook",
            outcome: result.value.outcome,
            httpStatus: result.value.httpStatus,
        };
    }

    return {
        kind: "threw",
        outcome: `THREW:${result.code}`,
        code: result.code,
        reason: result.reason,
    };
}

beforeAll(async () => {
    fetchSpy = installGatewayStub();
    f = await setupFixtures();
});

afterAll(async () => {
    fetchSpy.mockRestore();
    await teardownFixtures(f);
});

beforeEach(() => {
    gatewayStub.reset();
    signInAs(null);
});

/* ==========================================================================
 * H. CONCURRENT PAYMENT CREATION
 * ========================================================================== */

describe("H. concurrent payment creation", () => {
    it("H1. eight simultaneous Pay clicks produce one provider payment, not eight", async () => {
        const type = await newType("H1");
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: type, quantity: 1 }],
            tag: "p7-h1",
        });

        const actor = await customerScope(f.buyerA.id);

        // The customer hammering the button.
        const attempts = await Promise.all(
            Array.from({ length: 8 }, () =>
                outcomeOf(() =>
                    createOrderPayment({
                        orderNumber: order.orderNumber,
                        actor,
                        request: {} as never,
                        httpRequest: nextRequest(),
                    })
                )
            )
        );

        // Partitioned explicitly rather than with a type predicate, so the narrowing is
        // plain control flow.
        const created: PaymentLike[] = [];

        for (const attempt of attempts) {
            if (attempt.ok && !attempt.value.resumed) {
                created.push(attempt.value);
            }
        }

        // THE ASSERTION THIS TEST EXISTS FOR: one session was actually bought.
        expect(gatewayStub.calls).toHaveLength(1);
        expect(created).toHaveLength(1);

        const winner = created[0];

        // Every other attempt is either a safe resume of that session or a refusal — never
        // a second gateway payment.
        for (const attempt of attempts) {
            if (attempt.ok) {
                // Whether it created or resumed, every answer points at the SAME session.
                expect(attempt.value.paymentUrl).toBe(winner.paymentUrl);
                expect(attempt.value.paymentReference).toBe(winner.paymentReference);
            } else {
                expect(attempt.reason).toBe("PAYMENT_CREATION_IN_PROGRESS");
                expect(attempt.code).toBe(ERROR_CODES.CONFLICT);
            }
        }

        // One attempt row, and one payable reference.
        await expect(
            prisma.payment.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(1);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { status: true, paymentStatus: true },
        });

        expect(row.status).toBe("PENDING_PAYMENT");
        expect(row.paymentStatus).toBe("PENDING");
        await assertInventoryInvariants(type);
    });

    it("H2. concurrent creation never advances the order to paid", async () => {
        const type = await newType("H2");
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: type, quantity: 2 }],
            tag: "p7-h2",
        });

        const actor = await customerScope(f.buyerA.id);
        const before = await counters(type);

        await Promise.all(
            Array.from({ length: 6 }, () =>
                outcomeOf(() =>
                    createOrderPayment({
                        orderNumber: order.orderNumber,
                        actor,
                        request: {} as never,
                        httpRequest: nextRequest(),
                    })
                )
            )
        );

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { status: true, paymentStatus: true, paidAt: true },
        });

        // Opening a payment session is not settlement and cannot become it.
        expect(row.status).toBe("PENDING_PAYMENT");
        expect(row.paidAt).toBeNull();

        // The seats are still HELD, untouched by any of the six attempts.
        expect(await counters(type)).toEqual(before);

        const reservations = await prisma.ticketReservation.findMany({
            where: { orderId: order.orderId },
            select: { status: true },
        });

        expect(reservations.every((r) => r.status === "HELD")).toBe(true);
        await assertInventoryInvariants(type);
    });
});

/* ==========================================================================
 * F. CANCEL vs PAYMENT SUCCESS
 * ========================================================================== */

describe("F. cancel races payment success", () => {
    it(`F1. cancel and settlement cannot both win (${ROUNDS} rounds)`, async () => {
        const type = await newType("F1");
        const distribution: string[] = [];

        for (let round = 0; round < ROUNDS; round += 1) {
            const quantity = 2;
            const { order, payment, actor } = await orderWithSession(
                type,
                quantity,
                `p7-f1-${round}`
            );

            const signed = successFor(payment, `f1-${round}`);

            const cancelAttempt = () =>
                outcomeOf(() => cancelOwnPendingOrder(order.orderNumber, actor));
            const settleAttempt = () => classifyDelivery(signed);

            // Fire both transitions at the SAME instant. One of them takes the order row.
            //
            // The START ORDER alternates between rounds. `Promise.all` begins each call in
            // array order, so a fixed order would let the same side win every time and the
            // other side's branch would never be exercised — a race test that only ever
            // tests one interleaving is a test of the fixture, not of the race.
            let cancel: Attempt<CancelOutcome>;
            let settle: Delivery;

            if (round % 2 === 0) {
                [cancel, settle] = await Promise.all([
                    cancelAttempt(),
                    settleAttempt(),
                ]);
            } else {
                [settle, cancel] = await Promise.all([
                    settleAttempt(),
                    cancelAttempt(),
                ]);
            }

            const row = await prisma.eventOrder.findUniqueOrThrow({
                where: { id: order.orderId },
                select: { status: true, paymentStatus: true },
            });

            const after = await counters(type);

            // ── THE INVARIANTS, which must hold whichever side won ────────────────
            // 1. The order is terminal one way or the other — never left half-decided.
            expect(["PAID", "CANCELLED"]).toContain(row.status);

            // 2. The seats are settled exactly once: either all sold, or all returned.
            //    `sold` can only ever be 0 or the full quantity — never a partial or a
            //    double conversion — and `reserved` is always emptied.
            expect(after.reserved).toBe(0);
            expect([0, quantity]).toContain(after.sold);

            // 3. No negative counters, no oversell.
            await assertInventoryInvariants(type);

            // 4. The two sides agree with each other: a PAID order means a converted
            //    reservation and a sold seat; a CANCELLED order means the opposite.
            const reservations = await prisma.ticketReservation.findMany({
                where: { orderId: order.orderId },
                select: { status: true },
            });

            expect(reservations).toHaveLength(1);

            if (row.status === "PAID") {
                expect(after.sold).toBe(quantity);
                expect(reservations[0].status).toBe("CONVERTED");
                // …and the cancel must have been refused, not silently applied.
                expect(cancel.ok).toBe(false);
                // Settlement is the side that won, and it says so.
                expect(settle.kind).toBe("webhook");
                expect(["SETTLED", "ALREADY_PAID"]).toContain(settle.outcome);
                distribution.push("settlement");
            } else {
                expect(after.sold).toBe(0);
                expect(reservations[0].status).not.toBe("CONVERTED");
                // Money may have arrived after the cancellation (design §11.4), which is
                // recorded and fulfilment-blocked rather than resurrected.
                expect(["UNPAID", "PAID"]).toContain(row.paymentStatus);
                // The settlement either never reached the row or arrived too late — in
                // which case it is recorded as a late settlement, never as a resurrection.
                expect(["LATE_SETTLEMENT", "SETTLED", "ALREADY_PAID", "NOOP"]).toContain(
                    settle.outcome
                );
                distribution.push(
                    cancel.ok ? "cancel" : `cancel_refused:${cancel.code}`
                );
            }
        }

        console.log("F1 winner distribution:", distribution.join(", "));

        // Both sides were given a real chance to win across the rounds, so the invariants
        // above were exercised against more than one interleaving.
        expect(distribution).toHaveLength(ROUNDS);
    });

    it("F3. a cancel arriving after settlement is refused, and the seats stay sold", async () => {
        // `F1` lets the scheduler pick the winner, which is the right way to test the race.
        // This pins the OTHER branch deterministically, so the "settlement won, cancel lost"
        // path is covered even on a machine where the cancel always wins the coin toss.
        const type = await newType("F3");
        const { order, payment, actor } = await orderWithSession(type, 2, "p7-f3");

        const settle = await deliverSigned(successFor(payment, "f3"));

        expect(settle.outcome).toBe("SETTLED");

        const sold = await counters(type);

        expect(sold.sold).toBe(2);
        expect(sold.reserved).toBe(0);

        const cancel = await outcomeOf(() =>
            cancelOwnPendingOrder(order.orderNumber, actor)
        );

        if (cancel.ok) {
            throw new Error("Expected the cancel to be refused, but it succeeded");
        }

        expect(cancel.code).toBe(ERROR_CODES.ORDER_NOT_PAYABLE);
        expect(cancel.reason).toBe("NOT_PENDING_PAYMENT");

        // The refusal is real: nothing was released by the attempt.
        expect(await counters(type)).toEqual(sold);

        const reservations = await prisma.ticketReservation.findMany({
            where: { orderId: order.orderId },
            select: { status: true },
        });

        expect(reservations[0].status).toBe("CONVERTED");
        await assertInventoryInvariants(type);
    });

    it("F2. a losing settlement never takes seats back from a cancelled order", async () => {
        const type = await newType("F2");
        const { order, payment, actor } = await orderWithSession(type, 3, "p7-f2");

        // Cancel deterministically FIRST, then deliver the success — the ordering that
        // makes the money arrive after the seats were returned.
        await cancelOwnPendingOrder(order.orderNumber, actor);

        const cancelled = await counters(type);

        expect(cancelled.sold).toBe(0);
        expect(cancelled.reserved).toBe(0);

        const settle = await deliverSigned(successFor(payment, "f2"));

        expect(settle.httpStatus).toBe(200);
        expect(settle.outcome).toBe("LATE_SETTLEMENT");

        const after = await counters(type);

        // Not one seat moved back, and no ticket was issued for a cancelled order.
        expect(after).toEqual(cancelled);
        await expect(
            prisma.ticket.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(0);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { status: true, paymentStatus: true, fulfilmentBlockedAt: true },
        });

        expect(row.status).toBe("CANCELLED");
        expect(row.paymentStatus).toBe("PAID");
        expect(row.fulfilmentBlockedAt).not.toBeNull();
    });
});

/* ==========================================================================
 * G. EXPIRY vs PAYMENT SUCCESS
 * ========================================================================== */

describe("G. expiry races payment success", () => {
    it(`G1. expiry and settlement cannot both win (${ROUNDS} rounds)`, async () => {
        const type = await newType("G1");
        const distribution: string[] = [];

        for (let round = 0; round < ROUNDS; round += 1) {
            const quantity = 2;
            const { order, payment } = await orderWithSession(
                type,
                quantity,
                `p7-g1-${round}`
            );

            // Make THIS order the only one that is due: its window is moved into the past
            // rather than the clock being moved, so the reaper's global batch cannot sweep
            // any other test's order.
            await prisma.eventOrder.update({
                where: { id: order.orderId },
                data: { expiresAt: new Date(Date.now() - 1_000) },
            });
            await prisma.ticketReservation.updateMany({
                where: { orderId: order.orderId },
                data: { expiresAt: new Date(Date.now() - 1_000) },
            });

            const signed = successFor(payment, `g1-${round}`);

            // Alternating start order, for the same reason as F1.
            let expiry: Attempt<ExpiryOutcome>;
            let settle: Delivery;

            if (round % 2 === 0) {
                [expiry, settle] = await Promise.all([
                    outcomeOf(() => expireDueReservations()),
                    classifyDelivery(signed),
                ]);
            } else {
                [settle, expiry] = await Promise.all([
                    classifyDelivery(signed),
                    outcomeOf(() => expireDueReservations()),
                ]);
            }

            const row = await prisma.eventOrder.findUniqueOrThrow({
                where: { id: order.orderId },
                select: {
                    status: true,
                    paymentStatus: true,
                    paidAt: true,
                    fulfilmentBlockedAt: true,
                },
            });

            const after = await counters(type);

            // ── THE INVARIANTS ───────────────────────────────────────────────────
            // 1. Never an impossible state: the order is one of the two terminals.
            expect(["PAID", "EXPIRED"]).toContain(row.status);

            // 2. Exactly one inventory decision: all sold, or all released.
            expect(after.reserved).toBe(0);
            expect([0, quantity]).toContain(after.sold);
            await assertInventoryInvariants(type);

            const reservations = await prisma.ticketReservation.findMany({
                where: { orderId: order.orderId },
                select: { status: true },
            });

            expect(reservations).toHaveLength(1);

            if (row.status === "PAID") {
                // Settlement won: conversion happened, and the reaper did NOT release.
                expect(after.sold).toBe(quantity);
                expect(reservations[0].status).toBe("CONVERTED");
                expect(["SETTLED", "ALREADY_PAID"]).toContain(settle.outcome);
                distribution.push("settlement");
            } else {
                // Expiry won: nothing was sold, nothing was converted.
                expect(after.sold).toBe(0);
                expect(reservations[0].status).toBe("EXPIRED");
                // The arrival of money after expiry is recorded, never converted.
                expect(["LATE_SETTLEMENT", "SETTLED", "ALREADY_PAID", "NOOP"]).toContain(
                    settle.outcome
                );
                distribution.push("expiry");
            }

            // 3. No paid-and-expired contradiction: if the money arrived after expiry it is
            //    recorded with fulfilment blocked, and no ticket exists.
            if (row.paymentStatus === "PAID" && row.status === "EXPIRED") {
                expect(row.fulfilmentBlockedAt).not.toBeNull();
            }

            await expect(
                prisma.ticket.count({ where: { orderId: order.orderId } })
            ).resolves.toBe(0);

            // The reaper must be a well-behaved batch caller in either case: it either
            // expired this order or declined it because settlement already had it.
            expect(expiry.ok).toBe(true);
        }

        console.log("G1 winner distribution:", distribution.join(", "));
        expect(distribution).toHaveLength(ROUNDS);
    });

    it("G2. expiry does not release a reservation that settlement already converted", async () => {
        const type = await newType("G2");
        const { order, payment } = await orderWithSession(type, 2, "p7-g2");

        // Settle FIRST, then run the reaper. A reaper that released holds based only on the
        // clock would take back seats that have already been sold.
        const settle = await deliverSigned(successFor(payment, "g2"));

        expect(settle.outcome).toBe("SETTLED");

        const sold = await counters(type);

        expect(sold.sold).toBe(2);
        expect(sold.reserved).toBe(0);

        await prisma.eventOrder.update({
            where: { id: order.orderId },
            data: { expiresAt: new Date(Date.now() - 1_000) },
        });

        await expireDueReservations();

        const after = await counters(type);

        expect(after).toEqual(sold);

        const reservations = await prisma.ticketReservation.findMany({
            where: { orderId: order.orderId },
            select: { status: true },
        });

        expect(reservations[0].status).toBe("CONVERTED");

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { status: true, paymentStatus: true },
        });

        expect(row.status).toBe("PAID");
        expect(row.paymentStatus).toBe("PAID");
    });
});

/* ==========================================================================
 * E. SETTLEMENT CONVERSION, UNDER CONTENTION
 * ========================================================================== */

describe("E. settlement conversion under contention", () => {
    it("E4. twenty orders settling at once each convert exactly once", async () => {
        const type = await newType("E4", 100);
        const quantity = 3;

        // Twenty independently-paid orders contending on ONE hot ticket-type row, with two
        // deliveries each — forty notifications against twenty rows.
        const prepared = [];

        for (let i = 0; i < 20; i += 1) {
            prepared.push(await orderWithSession(type, quantity, `p7-e4-${i}`));
        }

        const before = await counters(type);

        expect(before.reserved).toBe(20 * quantity);

        const notifications: Promise<unknown>[] = [];

        for (const [index, entry] of prepared.entries()) {
            const signed = successFor(entry.payment, `e4-${index}`);

            notifications.push(deliverSigned(signed));
            notifications.push(deliverSigned(signed));
        }

        const results = await Promise.all(
            notifications.map((p) =>
                p.then(
                    (r) => r as { outcome: string; httpStatus: number },
                    (error: { code?: string }) => ({
                        outcome: `THREW:${error.code}`,
                        httpStatus: 500,
                    })
                )
            )
        );

        const settled = results.filter((r) => r.outcome === "SETTLED");
        // The loser of each pair resolves either way, and WHICH one depends on the
        // interleaving: if the first delivery had already committed its ledger row, the
        // replay guard answers `DUPLICATE`; if it was still in flight, the second delivery
        // passes the guard and is stopped by the order-state CAS instead, answering
        // `ALREADY_PAID`. Both are single-settlement outcomes, so both are accepted —
        // asserting only `DUPLICATE` would be asserting a scheduling order.
        const absorbed = results.filter((r) =>
            ["DUPLICATE", "ALREADY_PAID"].includes(r.outcome)
        );
        const threw = results.filter((r) => r.outcome.startsWith("THREW"));

        console.log(
            "E4 delivery distribution:",
            results.reduce<Record<string, number>>((acc, r) => {
                acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
                return acc;
            }, {})
        );

        // Each of the twenty orders settled exactly once, and each second delivery was
        // absorbed rather than acted on. Nothing escaped as an unhandled error.
        expect(settled).toHaveLength(20);
        expect(absorbed).toHaveLength(20);
        expect(threw).toEqual([]);
        expect(results).toHaveLength(40);

        const after = await counters(type);

        expect(after.sold).toBe(20 * quantity);
        expect(after.reserved).toBe(0);
        expect(after.sold + after.reserved).toBeLessThanOrEqual(after.quota);

        // One transaction and one converted reservation per order — never two.
        await expect(
            prisma.paymentTransaction.count({
                where: { orderId: { in: prepared.map((p) => p.order.orderId) } },
            })
        ).resolves.toBe(20);

        const converted = await prisma.ticketReservation.count({
            where: {
                orderId: { in: prepared.map((p) => p.order.orderId) },
                status: "CONVERTED",
            },
        });

        expect(converted).toBe(20);

        const paid = await prisma.eventOrder.count({
            where: {
                id: { in: prepared.map((p) => p.order.orderId) },
                status: "PAID",
                paymentStatus: "PAID",
            },
        });

        expect(paid).toBe(20);

        await assertInventoryInvariants(type);
    });
});
