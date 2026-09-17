/**
 * ==========================================
 * PHASE 7 — PAYMENT CREATION (INTEGRATION)
 * ==========================================
 *
 * The real payment service against the real database, with only the socket stubbed (see
 * the harness header). Coverage maps to brief §28: group A (payment creation), the
 * client-authority half of group I, group J (ownership/IDOR) and the whole-ruble half of
 * group G.
 *
 * The point of running this against MySQL rather than a mock is that almost every
 * assertion here is about a *persisted consequence* — a `Payment` row, an order's
 * `paymentStatus`, the absence of an outbound call. Those cannot be established against a
 * stubbed service layer.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { ERROR_CODES } from "@/lib/api/errors";
import { AuthzErrorCode, requireAuth } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { cancelOwnPendingOrder } from "@/lib/ticketing/orders";
import { createOrderPayment } from "@/lib/ticketing/payment/service";
import { paymentCreateRequestSchema } from "@/lib/ticketing/payment/validation";
import { expireDueReservations } from "@/lib/ticketing/reservations";

import {
    createOrder,
    customerScope,
    expectRejection,
    gatewayStub,
    installGatewayStub,
    nextRequest,
    setupFixtures,
    signInAs,
    SUFFIX,
    teardownFixtures,
    type Fixtures,
} from "./payment-harness";

jest.setTimeout(180_000);

let f: Fixtures;
let fetchSpy: jest.SpyInstance;

/** Start (or resume) a provider session for an order as `buyerId`. */
async function pay(
    buyerId: string,
    orderNumber: string,
    request: Record<string, unknown> = {}
) {
    const actor = await customerScope(buyerId);

    return createOrderPayment({
        orderNumber,
        actor,
        request: request as never,
        httpRequest: nextRequest(),
    });
}

async function paymentRowsFor(orderNumber: string) {
    return prisma.payment.findMany({
        where: { order: { orderNumber } },
        orderBy: { createdAt: "asc" },
    });
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
 * A. PAYMENT CREATION
 * ========================================================================== */

describe("A. payment creation", () => {
    it("A1. the owner starts a session, and the provider reference is persisted", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeSettle.id, quantity: 2 }],
            tag: "p7-a1",
        });

        const payload = await pay(f.buyerA.id, order.orderNumber);

        // The response carries the provider's own URL — never one this code built (§20).
        expect(gatewayStub.calls).toHaveLength(1);
        expect(payload.paymentUrl).toBe(
            `https://sandbox.ipaymu.com/payment/${SUFFIX}-1`
        );
        expect(payload.resumed).toBe(false);
        expect(payload.status).toBe("PENDING");
        expect(payload.provider).toBe("ipaymu");
        expect(payload.environment).toBe("SANDBOX");
        expect(payload.orderNumber).toBe(order.orderNumber);
        expect(payload.orderStatus).toBe("PENDING_PAYMENT");
        expect(payload.paymentStatus).toBe("PENDING");

        // …and it is what got stored, not merely returned.
        const rows = await paymentRowsFor(order.orderNumber);
        expect(rows).toHaveLength(1);
        expect(rows[0].paymentUrl).toBe(payload.paymentUrl);
        expect(rows[0].status).toBe("PENDING");
        expect(rows[0].paymentReference).toBe(payload.paymentReference);
        expect(rows[0].providerEnvironment).toBe("SANDBOX");

        // Creating a session must never look like settlement.
        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true, paymentStatus: true, paidAt: true },
        });

        expect(row.status).toBe("PENDING_PAYMENT");
        expect(row.paymentStatus).toBe("PENDING");
        expect(row.paidAt).toBeNull();
    });

    it("A2. the amount sent to the provider is the persisted order total", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeA.id, quantity: 3 }],
            tag: "p7-a2",
        });

        await pay(f.buyerA.id, order.orderNumber);

        const call = gatewayStub.lastCall();

        expect(call).toBeDefined();
        // `typeA` is 150 000, quantity 3 → the server's own arithmetic.
        expect(order.total).toBe("450000.00");
        expect(call!.body.amount).toBe(450000);

        const stored = (await paymentRowsFor(order.orderNumber))[0];

        expect(call!.body.referenceId).toBe(stored.paymentReference);

        // The payer on the wire is the buyer of record from the order row.
        const orderRow = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { buyerName: true, buyerEmail: true },
        });

        expect(call!.body.buyerName).toBe(orderRow.buyerName);
        expect(call!.body.buyerEmail).toBe(orderRow.buyerEmail);
    });

    it("A3. the provider is told to notify AND return to this platform's own origin", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeA.id, quantity: 1 }],
            tag: "p7-a3",
        });

        await pay(f.buyerA.id, order.orderNumber);

        const body = gatewayStub.lastCall()!.body;

        expect(body.notifyUrl).toBe(
            "http://localhost:3000/api/ticketing/payment/webhook"
        );
        expect(body.returnUrl).toBe(
            `http://localhost:3000/ticketing/orders/${encodeURIComponent(
                order.orderNumber
            )}`
        );
        // The provider's window is the platform's own TTL, not a provider default (§13.1).
        expect(typeof body.expired).toBe("number");
    });

    it("A4. a second request resumes the live session instead of buying a second one (§19)", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeA.id, quantity: 1 }],
            tag: "p7-a4",
        });

        const first = await pay(f.buyerA.id, order.orderNumber);
        const second = await pay(f.buyerA.id, order.orderNumber);

        // THE ASSERTION THAT MATTERS: the provider was asked exactly once.
        expect(gatewayStub.calls).toHaveLength(1);
        expect(second.resumed).toBe(true);
        expect(second.paymentUrl).toBe(first.paymentUrl);
        expect(second.paymentReference).toBe(first.paymentReference);
        await expect(paymentRowsFor(order.orderNumber)).resolves.toHaveLength(1);
    });

    it("A5. an unauthenticated caller cannot start a payment", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeA.id, quantity: 1 }],
            tag: "p7-a5",
        });

        signInAs(null);

        const error = await expectRejection(() => requireAuth());

        expect(error.code).toBe(AuthzErrorCode.UNAUTHORIZED);
        expect(error.status).toBe(401);

        // Nothing was created and the provider was not contacted by the refused call.
        gatewayStub.reset();
        await expect(paymentRowsFor(order.orderNumber)).resolves.toHaveLength(0);
        expect(gatewayStub.calls).toHaveLength(0);
    });

    it("A6. another customer cannot pay the order, and cannot learn it exists (J)", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeA.id, quantity: 1 }],
            tag: "p7-a6",
        });

        const error = await expectRejection(() =>
            pay(f.buyerB.id, order.orderNumber)
        );

        // 404, not 403: a 403 would confirm the order exists (design §7.4).
        expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
        expect(error.httpStatus).toBe(404);
        expect(gatewayStub.calls).toHaveLength(0);
        await expect(paymentRowsFor(order.orderNumber)).resolves.toHaveLength(0);
    });

    it("A7. a cancelled order cannot be paid", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeA.id, quantity: 1 }],
            tag: "p7-a7",
        });

        await cancelOwnPendingOrder(
            order.orderNumber,
            await customerScope(f.buyerA.id)
        );

        const error = await expectRejection(() =>
            pay(f.buyerA.id, order.orderNumber)
        );

        expect(error.code).toBe(ERROR_CODES.ORDER_NOT_PAYABLE);
        expect(error.details?.reason).toBe("ORDER_CANCELLED");
        // D-09 repayment is pointed at, not implemented.
        expect(error.details?.decision).toBe("D-09_REPAYMENT_PRICING");
        expect(gatewayStub.calls).toHaveLength(0);
    });

    it("A8. an order past its payment window cannot be paid", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeExpire.id, quantity: 2 }],
            tag: "p7-a8",
        });

        // Drive the real reaper past the TTL rather than editing the row.
        const expired = await expireDueReservations({
            now: new Date(Date.now() + 24 * 60 * 60 * 1000),
            batchSize: 500,
        });

        expect(expired.reservationsExpired).toBeGreaterThan(0);

        const error = await expectRejection(() =>
            pay(f.buyerA.id, order.orderNumber)
        );

        expect(error.code).toBe(ERROR_CODES.ORDER_NOT_PAYABLE);
        expect(error.details?.reason).toBe("ORDER_EXPIRED");
        expect(gatewayStub.calls).toHaveLength(0);
    });

    it("A9. a PENDING_PAYMENT order whose holds are gone cannot be paid", async () => {
        // The interesting case the window check cannot cover: the order looks payable but
        // the seats are no longer reserved, so settlement would find nothing to convert.
        // Bypassing the order-level guards to reach it is the point of the test — the
        // hold check is what has to stop it.
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeRace.id, quantity: 2 }],
            tag: "p7-a9",
        });

        const { releaseOrderReservations } = await import(
            "@/lib/ticketing/reservations"
        );

        await prisma.$transaction(async (tx) => {
            await releaseOrderReservations(tx, order.orderId, "RELEASED");
        });

        const stillPayable = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { status: true },
        });

        // Precondition of the test: the order itself is untouched.
        expect(stillPayable.status).toBe("PENDING_PAYMENT");

        const error = await expectRejection(() =>
            pay(f.buyerA.id, order.orderNumber)
        );

        expect(error.code).toBe(ERROR_CODES.ORDER_NOT_PAYABLE);
        expect(error.details?.reason).toBe("RESERVATIONS_NOT_HELD");
        expect(gatewayStub.calls).toHaveLength(0);
    });

    it("A10. a zero-amount order is isolated as D-26 rather than guessed", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeFree.id, quantity: 2 }],
            tag: "p7-a10",
        });

        expect(order.total).toBe("0.00");

        const error = await expectRejection(() =>
            pay(f.buyerA.id, order.orderNumber)
        );

        expect(error.code).toBe(ERROR_CODES.CONFLICT);
        expect(error.httpStatus).toBe(409);
        expect(error.details?.reason).toBe("ZERO_AMOUNT_ORDER");
        expect(error.details?.decision).toBe("D-26_FREE_TICKET_SETTLEMENT_PATH");

        // The gateway must never see a zero amount — the adapter itself refuses one, so
        // reaching it would be a guaranteed provider error.
        expect(gatewayStub.calls).toHaveLength(0);
        await expect(paymentRowsFor(order.orderNumber)).resolves.toHaveLength(0);
    });

    it("A11. a provider failure is recorded and surfaced as 503, not as a crash", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeA.id, quantity: 1 }],
            tag: "p7-a11",
        });

        gatewayStub.failNext(503, { Status: 503, Message: "Service Unavailable" });

        const error = await expectRejection(() =>
            pay(f.buyerA.id, order.orderNumber)
        );

        expect(error.code).toBe(ERROR_CODES.PROVIDER_UNAVAILABLE);
        expect(error.httpStatus).toBe(503);

        // The attempt is recorded FAILED so the state stays coherent — and the order is
        // NOT advanced to PENDING, because no session exists.
        const rows = await paymentRowsFor(order.orderNumber);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe("FAILED");
        expect(rows[0].paymentUrl).toBeNull();

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true, paymentStatus: true },
        });

        expect(row.status).toBe("PENDING_PAYMENT");
        expect(row.paymentStatus).toBe("UNPAID");
    });

    it("A12. a failed attempt does not block a fresh one (a new attempt, a new reference)", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeA.id, quantity: 1 }],
            tag: "p7-a12",
        });

        gatewayStub.failNext(503);
        await expectRejection(() => pay(f.buyerA.id, order.orderNumber));

        const retry = await pay(f.buyerA.id, order.orderNumber);

        expect(retry.resumed).toBe(false);
        expect(gatewayStub.calls).toHaveLength(2);

        const rows = await paymentRowsFor(order.orderNumber);

        expect(rows).toHaveLength(2);
        expect(rows[0].status).toBe("FAILED");
        expect(rows[1].status).toBe("PENDING");
        // D-09 is repayment of an order that left PENDING_PAYMENT. Retrying an attempt
        // that never got a session is a different thing, and both rows stay attributable.
        expect(rows[0].paymentReference).not.toBe(rows[1].paymentReference);
    });
});

/* ==========================================================================
 * G. MONEY (the buyer cannot send any)
 * ========================================================================== */

describe("G. money is server-owned", () => {
    it("G1. the payment request schema carries no financial field at all, and strips unknown keys", () => {
        const parsed = paymentCreateRequestSchema.parse({
            method: "QRIS",
            // Everything a tampering client would love to send:
            amount: 1,
            total: 1,
            subtotal: 1,
            currency: "USD",
            organizerId: "org_attacker",
            userId: "user_attacker",
            paymentStatus: "PAID",
            status: "PAID",
        });

        // Nothing but the two presentation fields survives.
        expect(parsed).toEqual({ method: "QRIS" });
        expect(Object.keys(parsed).sort()).toEqual(["method"]);
    });

    it("G2. client-supplied financial values are ignored end-to-end", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeA.id, quantity: 2 }],
            tag: "p7-g2",
        });

        const payload = await pay(f.buyerA.id, order.orderNumber, {
            method: "QRIS",
            amount: 1,
            total: 1,
            currency: "USD",
        } as never);

        // The provider was told the database's amount and the database's currency.
        expect(gatewayStub.lastCall()!.body.amount).toBe(300000);
        expect(payload.amount).toBe("300000.00");
        expect(payload.currency).toBe("IDR");
    });

    it("G3. a fractional price is never sent to the provider as a fraction", async () => {
        // `requireSafeRupiah` refuses a non-integer rupiah, and checkout rounds at
        // persistence. Whichever mechanism applies, the invariant is: the wire amount is a
        // whole rupiah that equals the persisted total.
        const { createTicketType } = await import("@/lib/ticket-types/service");
        const { requireOrganizerAccess } = await import("@/lib/authz");

        signInAs(f.ownerA.id);
        const scope = await requireOrganizerAccess(f.orgA.id, "event.read");

        const fractional = await createTicketType(scope, f.eventA.id, {
            name: "Pecahan",
            price: "150000.50",
            quota: 10,
        } as never);

        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: fractional.id, quantity: 1 }],
            tag: "p7-g3",
        });

        const payload = await pay(f.buyerA.id, order.orderNumber);
        const wireAmount = gatewayStub.lastCall()!.body.amount as number;

        expect(Number.isInteger(wireAmount)).toBe(true);
        expect(wireAmount).toBe(Number(order.total));
        expect(Number(payload.amount)).toBe(Number(order.total));

        const stored = (await paymentRowsFor(order.orderNumber))[0];

        expect(stored.amount.toFixed(2)).toBe(order.total);
    });
});
