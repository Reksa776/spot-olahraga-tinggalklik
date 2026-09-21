/**
 * ==========================================
 * PHASE 27E — PAYMENT RECONCILIATION (INTEGRATION)
 * ==========================================
 *
 * `reconcilePayment` against the real database, with only the socket stubbed: real
 * `Payment` rows written by the real payment service, real authorization guards, the real
 * settlement transaction, the real inventory CAS and the real audit writer.
 *
 * ── WHAT THIS SUITE EXISTS TO PROVE ──────────────────────────────────────────────
 *
 * 1. A verified provider answer settles the payment EXACTLY ONCE, through
 *    `settleVerifiedPayment`, moving inventory through the canonical primitive.
 * 2. Every incomplete or contradictory answer BLOCKS with ZERO financial writes — amount
 *    mismatch, transaction-id mismatch, wrong reference, wrong environment, wrong
 *    instrument, and a payment with no provider transaction id at all.
 * 3. A terminal order is refused rather than settled (`D-P19-04` is undecided; a button must
 *    not decide it), and a provider that has not reported success is a NO-OP.
 * 4. Two concurrent reconciliations produce ONE settlement and ONE money row — the existing
 *    order CAS is the arbiter, so no new locking was needed.
 *
 * The "zero writes" assertions compare a full snapshot of the financial state (order status
 * and `paidAt`, payment status, `PaymentTransaction` count, inventory counters, reservation
 * states) before and after. The audit row is deliberately NOT part of that snapshot: writing
 * `payment.reconcile` for a REFUSED attempt is the point of the audit trail.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import { createOrderPayment } from "@/lib/ticketing/payment/service";
import {
    reconcilePayment,
    type ReconciliationResult,
} from "@/lib/ticketing/payment/reconciliation";

import {
    createOrder,
    customerScope,
    gatewayStub,
    installGatewayStub,
    nextRequest,
    organizerScope,
    setupFixtures,
    signInAs,
    type Fixtures,
} from "./payment-harness";

jest.setTimeout(180_000);

let f: Fixtures;
let fetchSpy: jest.SpyInstance;

beforeAll(async () => {
    fetchSpy = installGatewayStub();
    f = await setupFixtures();
});

afterAll(async () => {
    fetchSpy.mockRestore();
});

/**
 * Start every test with an empty stub queue.
 *
 * The stub consumes a scripted reply on the NEXT outbound request of any kind, and the
 * payment-creation step is itself an outbound request — so a reply queued by a test that
 * then proved the provider was never called would otherwise be spent by the following
 * test's fixture. Clearing here (never inside a test body) keeps each test's scripting its
 * own business.
 */
beforeEach(() => {
    gatewayStub.queue.length = 0;
});

/** A provider transaction id unique to this suite (never collides across suites). */
let trxSeq = 0;
function nextTrx(tag: string): string {
    trxSeq += 1;
    return `${900000 + trxSeq}-${tag}`;
}

/**
 * The provider's own naming for the instrument on a row.
 *
 * Mirrors what `mapPaymentMethod` understands (`qris` / `va` / `cstore`), so a reply built
 * from a real row passes the instrument check unless the test deliberately breaks it.
 */
function providerMethodFor(method: string): string {
    if (method === "QRIS") return "qris";
    if (method === "E_WALLET") return "cstore";
    return "va";
}

/**
 * A status reply for one payment, shaped exactly like the verified sandbox response.
 *
 * iPaymu echoes our own reference in BOTH `SessionId` and `ReferenceId`, which is what the
 * real Phase 27D response showed — so the default reply does too.
 */
function statusReplyFor(
    payment: Row,
    overrides: Record<string, unknown> = {}
): { status: number; payload: unknown } {
    return {
        status: 200,
        payload: {
            Status: 200,
            Success: true,
            Message: "success",
            Data: {
                TransactionId: payment.providerTransactionId,
                Status: 1,
                StatusDesc: "Berhasil",
                PaidStatus: "paid",
                SubTotal: Number(payment.amount),
                Fee: 0,
                Amount: Number(payment.amount),
                Type: 7,
                SessionId: payment.paymentReference,
                ReferenceId: payment.paymentReference,
                PaymentMethod: providerMethodFor(payment.method),
                PaymentChannel: payment.method === "QRIS" ? "qris" : "BNI",
                ...overrides,
            },
        },
    };
}

type Row = Awaited<ReturnType<typeof loadPayment>>;

/** The `Payment` row plus the fields the assertions need. */
async function loadPayment(orderNumber: string) {
    const payment = await prisma.payment.findFirstOrThrow({
        where: { order: { orderNumber } },
        select: {
            id: true,
            paymentReference: true,
            providerTransactionId: true,
            providerEnvironment: true,
            method: true,
            channel: true,
            amount: true,
            status: true,
            orderId: true,
            order: { select: { orderNumber: true, status: true, total: true } },
        },
    });

    return payment;
}

/** An order with a live provider session, exactly as the buyer's page creates one. */
async function orderWithSession(
    ticketTypeId: string,
    tag: string,
    quantity = 2
) {
    const order = await createOrder({
        buyerId: f.buyerA.id,
        items: [{ ticketTypeId, quantity }],
        tag,
    });

    signInAs(f.buyerA.id);
    await createOrderPayment({
        orderNumber: order.orderNumber,
        actor: await customerScope(f.buyerA.id),
        request: {} as never,
        httpRequest: nextRequest(),
    });

    const payment = await loadPayment(order.orderNumber);

    // The payment service must have captured the provider's transaction id: without it
    // reconciliation cannot address the query at all (asserted directly in its own test).
    expect(payment.providerTransactionId).not.toBeNull();

    return { order, payment };
}

/**
 * Everything a settlement may move.
 *
 * `paymentTransaction.count()` and the inventory counters are read from the tables rather
 * than from a service's own report, so a "blocked" test cannot pass because a service said
 * it did nothing.
 */
async function financialSnapshot(orderId: string) {
    const order = await prisma.eventOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: {
            status: true,
            paymentStatus: true,
            paidAt: true,
            fulfilmentBlockedAt: true,
        },
    });

    const payment = await prisma.payment.findFirstOrThrow({
        where: { orderId },
        select: { status: true },
    });

    const transactions = await prisma.paymentTransaction.count({
        where: { orderId },
    });

    const reservations = await prisma.ticketReservation.findMany({
        where: { orderId },
        select: { status: true, quantity: true },
        orderBy: { status: "asc" },
    });

    const counters = await prisma.ticketReservation.findMany({
        where: { orderId },
        select: { ticketTypeId: true },
        distinct: ["ticketTypeId"],
    });

    const types = await prisma.ticketType.findMany({
        where: { id: { in: counters.map((row) => row.ticketTypeId) } },
        select: { sold: true, reserved: true },
    });

    return {
        orderStatus: order.status,
        orderPaymentStatus: order.paymentStatus,
        paidAt: order.paidAt?.toISOString() ?? null,
        fulfilmentBlockedAt: order.fulfilmentBlockedAt?.toISOString() ?? null,
        paymentStatus: payment.status,
        transactions,
        reservations: reservations.map((row) => `${row.status}:${row.quantity}`),
        inventory: types.map((row) => `${row.sold}/${row.reserved}`),
    };
}

/** The organizer scope that owns the fixture events. */
async function ownerScope() {
    return organizerScope(f.orgA.id, f.ownerA.id);
}

describe("reconcilePayment — a verified provider answer settles", () => {
    test("settles through the existing engine, once, with inventory converted", async () => {
        const { order, payment } = await orderWithSession(
            f.typeSettle.id,
            "rec-happy"
        );

        const before = await financialSnapshot(order.orderId);
        expect(before.orderStatus).toBe("PENDING_PAYMENT");

        gatewayStub.replyNext(statusReplyFor(payment));

        const result = await reconcilePayment(await ownerScope(), payment.paymentReference);

        expect(result.result).toBe("RECONCILED");
        if (result.result !== "RECONCILED") return;

        expect(result.message).toBe(
            "Pembayaran berhasil diverifikasi dan diselesaikan."
        );
        expect(result.settlement.seatsSold).toBe(2);
        expect(result.settlement.anomalies).toEqual([]);

        // ── The provider evidence is reported back verbatim ────────────────────
        expect(result.provider).toEqual({
            transactionId: payment.providerTransactionId,
            status: 1,
            statusDescription: "Berhasil",
            amount: Number(payment.amount),
            environment: "sandbox",
            httpStatus: 200,
        });

        // ── The DATABASE agrees, and moved exactly once ────────────────────────
        const after = await financialSnapshot(order.orderId);

        expect(after.orderStatus).toBe("PAID");
        expect(after.orderPaymentStatus).toBe("PAID");
        expect(after.paidAt).not.toBeNull();
        expect(after.paymentStatus).toBe("PAID");
        expect(after.transactions).toBe(1);
        expect(after.reservations).toEqual(["CONVERTED:2"]);
        expect(after.inventory).not.toEqual(before.inventory);

        // ── Nothing downstream and irreversible happened here ──────────────────
        // Ticket ISSUANCE is a separate buyer-triggered step; reconciliation must not
        // shortcut it.
        expect(
            await prisma.ticket.count({
                where: { order: { orderNumber: order.orderNumber } },
            })
        ).toBe(0);

        // ── The operator's action is on the audit trail, attributed to them ────
        const audit = await prisma.adminAuditLog.findFirst({
            where: {
                action: "payment.reconcile",
                entityRef: payment.id,
            },
            orderBy: { createdAt: "desc" },
        });

        expect(audit).not.toBeNull();
        expect(audit?.actorUserId).toBe(f.ownerA.id);
        expect(audit?.organizerId).toBe(f.orgA.id);
        expect(audit?.entityType).toBe("Payment");
        expect(audit?.actorType).toBe("USER");
        // The evidence, not the payload: no signature, no API key, no buyer PII.
        expect(JSON.stringify(audit?.afterState)).toContain(
            String(payment.providerTransactionId)
        );
        expect(JSON.stringify(audit?.afterState)).not.toMatch(/buyer|email|phone/i);
    });

    test("a second reconciliation is an idempotent no-op, not a second settlement", async () => {
        const { order, payment } = await orderWithSession(
            f.typeRace.id,
            "rec-twice"
        );

        gatewayStub.replyNext(statusReplyFor(payment));
        const first = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );
        expect(first.result).toBe("RECONCILED");

        // The provider is not consulted again: the state check comes first.
        const callsBefore = gatewayStub.calls.length;
        const second = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );

        expect(second.result).toBe("ALREADY_SETTLED");
        expect(second.message).toBe("Pembayaran sudah diselesaikan.");
        expect(gatewayStub.calls.length).toBe(callsBefore);

        const after = await financialSnapshot(order.orderId);
        expect(after.transactions).toBe(1);
        expect(after.orderStatus).toBe("PAID");
    });
});

describe("reconcilePayment — evidence that does not match blocks, with zero writes", () => {
    test("amount mismatch", async () => {
        const { order, payment } = await orderWithSession(
            f.typeA.id,
            "rec-amount"
        );

        const before = await financialSnapshot(order.orderId);

        gatewayStub.replyNext(
            statusReplyFor(payment, { Amount: 14000, SubTotal: 14000 })
        );

        const result = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );

        expect(result).toEqual(
            expect.objectContaining({
                result: "BLOCKED",
                reason: "AMOUNT_MISMATCH",
            })
        );
        expect(await financialSnapshot(order.orderId)).toEqual(before);
    });

    test("transaction id mismatch", async () => {
        const { order, payment } = await orderWithSession(
            f.typeA.id,
            "rec-trx"
        );

        const before = await financialSnapshot(order.orderId);

        gatewayStub.replyNext(
            statusReplyFor(payment, { TransactionId: nextTrx("someone-else") })
        );

        const result = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );

        expect(result).toEqual(
            expect.objectContaining({
                result: "BLOCKED",
                reason: "TRANSACTION_ID_MISMATCH",
            })
        );
        expect(await financialSnapshot(order.orderId)).toEqual(before);
    });

    test("reference mismatch", async () => {
        const { order, payment } = await orderWithSession(
            f.typeA.id,
            "rec-ref"
        );

        const before = await financialSnapshot(order.orderId);

        gatewayStub.replyNext(
            statusReplyFor(payment, {
                SessionId: "EVT-not-ours",
                ReferenceId: "EVT-not-ours",
            })
        );

        const result = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );

        expect(result).toEqual(
            expect.objectContaining({
                result: "BLOCKED",
                reason: "REFERENCE_MISMATCH",
            })
        );
        expect(await financialSnapshot(order.orderId)).toEqual(before);
    });

    test("environment mismatch (credentials answering for another environment)", async () => {
        const { order, payment } = await orderWithSession(
            f.typeA.id,
            "rec-env"
        );

        const before = await financialSnapshot(order.orderId);

        // Simulates a row whose snapshot says PRODUCTION while sandbox credentials answered.
        // The snapshot is what the service compares against, so this is the exact condition
        // the check exists for.
        await prisma.payment.update({
            where: { id: payment.id },
            data: { providerEnvironment: "PRODUCTION" },
        });

        gatewayStub.replyNext(statusReplyFor(payment));

        const result = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );

        expect(result).toEqual(
            expect.objectContaining({
                result: "BLOCKED",
                reason: "ENVIRONMENT_MISMATCH",
            })
        );

        // Restore the snapshot so the row keeps describing the environment it was created
        // in (`providerEnvironment` is not part of the financial snapshot either way).
        await prisma.payment.update({
            where: { id: payment.id },
            data: { providerEnvironment: payment.providerEnvironment },
        });

        expect(await financialSnapshot(order.orderId)).toEqual(before);
    });

    test("instrument mismatch", async () => {
        const { order, payment } = await orderWithSession(
            f.typeA.id,
            "rec-method"
        );

        const before = await financialSnapshot(order.orderId);

        /*
         * An instrument that maps to a DIFFERENT method than the row's, whichever instrument
         * the fixture ended up with — this check is about identity, not about QRIS.
         *
         * The CHANNEL has to contradict too, and that is not incidental: `mapPaymentMethod`
         * treats `channel === "qris"` as QRIS on its own, so pairing `"va"` with a `"qris"`
         * channel would (correctly) still describe a QRIS payment. Both fields are therefore
         * overridden together, which is also what the provider sends.
         */
        gatewayStub.replyNext(
            statusReplyFor(payment, {
                PaymentMethod: payment.method === "QRIS" ? "va" : "qris",
                PaymentChannel: payment.method === "QRIS" ? "BNI" : "QRIS",
            })
        );

        const result = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );

        expect(result).toEqual(
            expect.objectContaining({
                result: "BLOCKED",
                reason: "METHOD_MISMATCH",
            })
        );
        expect(await financialSnapshot(order.orderId)).toEqual(before);
    });

    test("no provider transaction id: BLOCKED, and the provider is never called", async () => {
        const { order, payment } = await orderWithSession(
            f.typeA.id,
            "rec-noid"
        );

        /*
         * The Phase 27B/27C case: a payment created before this column existed has no
         * provider transaction id, and the status query CANNOT be addressed for it. The
         * server refuses rather than accepting an operator-supplied id.
         */
        await prisma.payment.update({
            where: { id: payment.id },
            data: { providerTransactionId: null },
        });

        const before = await financialSnapshot(order.orderId);
        const callsBefore = gatewayStub.calls.length;

        const result = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );

        expect(result).toEqual(
            expect.objectContaining({
                result: "BLOCKED",
                reason: "PROVIDER_TRANSACTION_ID_MISSING",
                provider: null,
            })
        );
        expect(gatewayStub.calls.length).toBe(callsBefore);
        expect(await financialSnapshot(order.orderId)).toEqual(before);
    });

    test("a terminal order is refused, and the provider is never called", async () => {
        const { order, payment } = await orderWithSession(
            f.typeA.id,
            "rec-terminal"
        );

        await prisma.eventOrder.update({
            where: { id: order.orderId },
            data: { status: "CANCELLED" },
        });

        const before = await financialSnapshot(order.orderId);
        const callsBefore = gatewayStub.calls.length;

        // Deliberately NO scripted provider reply: the assertion below is that the provider
        // is never reached, and queueing one would both weaken that proof and leak the reply
        // into the next test's fixture.
        const result = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );

        // D-P19-04 (money on a terminal order) is UNDECIDED. The webhook's late-settlement
        // branch still records a payment that already happened; an operator's button must
        // not settle it, so reconciliation stops here.
        expect(result).toEqual(
            expect.objectContaining({
                result: "BLOCKED",
                reason: "TERMINAL_ORDER",
            })
        );
        expect(gatewayStub.calls.length).toBe(callsBefore);
        expect(await financialSnapshot(order.orderId)).toEqual(before);
    });
});

describe("reconcilePayment — provider answers that are not a settlement", () => {
    test("a non-success status is a no-op", async () => {
        const { order, payment } = await orderWithSession(
            f.typeA.id,
            "rec-pending"
        );

        const before = await financialSnapshot(order.orderId);

        gatewayStub.replyNext(
            statusReplyFor(payment, { Status: 4, PaidStatus: "pending" })
        );

        const result = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );

        expect(result.result).toBe("PENDING_PROVIDER");
        expect(result.message).toBe(
            "Provider belum menyatakan pembayaran berhasil."
        );
        expect(await financialSnapshot(order.orderId)).toEqual(before);
    });

    test("a transport failure is a PROVIDER_ERROR, and writes nothing", async () => {
        const { order, payment } = await orderWithSession(
            f.typeA.id,
            "rec-transport"
        );

        const before = await financialSnapshot(order.orderId);

        gatewayStub.queue.push(() => {
            throw new Error("ECONNREFUSED");
        });

        const result = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );

        expect(result).toEqual(
            expect.objectContaining({
                result: "PROVIDER_ERROR",
                reason: "TRANSPORT_ERROR",
                message: "Provider tidak dapat dihubungi. Silakan coba lagi.",
            })
        );
        expect(await financialSnapshot(order.orderId)).toEqual(before);

        // ...and the attempt is still audited, so an outage is visible.
        expect(
            await prisma.adminAuditLog.count({
                where: { action: "payment.reconcile", entityRef: payment.id },
            })
        ).toBeGreaterThanOrEqual(1);
    });

    test("a provider 5xx is a PROVIDER_ERROR, and writes nothing", async () => {
        const { order, payment } = await orderWithSession(
            f.typeA.id,
            "rec-5xx"
        );

        const before = await financialSnapshot(order.orderId);

        gatewayStub.replyNext({ status: 503, payload: { Status: 503 } });

        const result = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );

        expect(result).toEqual(
            expect.objectContaining({
                result: "PROVIDER_ERROR",
                reason: "HTTP_ERROR",
            })
        );
        expect(await financialSnapshot(order.orderId)).toEqual(before);
    });
});

describe("reconcilePayment — concurrency and authorization", () => {
    test("two simultaneous reconciliations produce ONE settlement", async () => {
        const { order, payment } = await orderWithSession(
            f.typeExpire.id,
            "rec-race",
            /* quantity */ 3
        );

        // Both requests may reach the provider; the queue serves both.
        gatewayStub.replyNext(statusReplyFor(payment));
        gatewayStub.replyNext(statusReplyFor(payment));

        const scope = await ownerScope();

        const [a, b] = await Promise.all([
            reconcilePayment(scope, payment.paymentReference),
            reconcilePayment(scope, payment.paymentReference),
        ]);

        const results = [a.result, b.result].sort();
        expect(results).toEqual(["ALREADY_SETTLED", "RECONCILED"]);

        // ── One money event, one inventory conversion, one paid order ──────────
        const after = await financialSnapshot(order.orderId);

        expect(after.transactions).toBe(1);
        expect(after.orderStatus).toBe("PAID");
        expect(after.reservations).toEqual(["CONVERTED:3"]);
        expect(
            await prisma.ticketReservation.count({
                where: { orderId: order.orderId, status: "CONVERTED" },
            })
        ).toBe(1);
    });

    test("an unknown reference is NOT_FOUND", async () => {
        const callsBefore = gatewayStub.calls.length;

        await expect(
            reconcilePayment(await ownerScope(), "EVT-does-not-exist")
        ).rejects.toMatchObject({ code: "NOT_FOUND" });

        // Nothing was asked of the provider.
        expect(gatewayStub.calls.length).toBe(callsBefore);
    });

    test("another tenant's payment is refused, and nothing moves", async () => {
        const { order, payment } = await orderWithSession(
            f.typeA.id,
            "rec-cross-tenant"
        );

        const before = await financialSnapshot(order.orderId);
        const callsBefore = gatewayStub.calls.length;

        gatewayStub.replyNext(statusReplyFor(payment));

        // ownerB holds no membership in orgA, and `ORGANIZER_SPANNING_PLATFORM_ROLES` is
        // empty, so no platform role reaches another tenant either.
        await expect(
            reconcilePayment(
                await organizerScope(f.orgB.id, f.ownerB.id),
                payment.paymentReference
            )
        ).rejects.toMatchObject({ code: "ORGANIZER_ACCESS_DENIED" });

        expect(gatewayStub.calls.length).toBe(callsBefore);
        expect(await financialSnapshot(order.orderId)).toEqual(before);
    });
});

describe("the result vocabulary", () => {
    test("every verdict is one of the five documented categories", async () => {
        const { payment } = await orderWithSession(f.typeA.id, "rec-vocab");

        gatewayStub.replyNext(statusReplyFor(payment));

        const result: ReconciliationResult = await reconcilePayment(
            await ownerScope(),
            payment.paymentReference
        );

        expect([
            "RECONCILED",
            "ALREADY_SETTLED",
            "PENDING_PROVIDER",
            "BLOCKED",
            "PROVIDER_ERROR",
        ]).toContain(result.result);

        // No verdict ever exposes a secret or a raw provider payload.
        const serialised = JSON.stringify(result);

        expect(serialised).not.toMatch(/signature|apiKey|api_key|secret/i);
    });
});
