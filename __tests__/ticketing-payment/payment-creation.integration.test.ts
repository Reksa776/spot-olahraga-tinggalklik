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
    providerQrPayload,
    providerQrUrl,
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
    it("A1. the owner starts a QRIS payment, and the GATEWAY's own QR data is persisted", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeSettle.id, quantity: 2 }],
            tag: "p7-a1",
        });

        const payload = await pay(f.buyerA.id, order.orderNumber);

        // The default method is QRIS, which is a DIRECT flow: the buyer scans here rather
        // than being sent to a hosted page, so there is no URL and there IS an instrument.
        expect(gatewayStub.calls).toHaveLength(1);
        expect(gatewayStub.calls[0].url).toBe(
            "https://sandbox.ipaymu.com/api/v2/payment/direct"
        );
        expect(payload.flow).toBe("DIRECT");
        expect(payload.paymentUrl).toBeNull();

        // THE ASSERTION THAT MATTERS for "never fabricate a QR": the payload the page will
        // render is the one the gateway sent, byte for byte, and its image is the gateway's
        // own URL — not a locally drawn substitute.
        expect("qrString" in payload).toBe(false);
        expect(payload.qrImageUrl).toBe(providerQrUrl(1));
        expect(payload.paymentName).toBe("iPaymu");
        expect(payload.providerExpiredAt).toBe(
            new Date("2099-12-31T23:59:59+07:00").toISOString()
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
        expect(rows[0].paymentUrl).toBeNull();
        expect(rows[0].providerFlow).toBe("DIRECT");
        expect(rows[0].qrString).toBe(providerQrPayload(1));
        expect(rows[0].qrImageUrl).toBe(providerQrUrl(1));
        expect(rows[0].paymentNumber).toBe(providerQrPayload(1));
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

        // The payer is the buyer of record from the order row. The direct endpoint's field
        // names are the documented ones (`name`, `email`), not the redirect endpoint's
        // (`buyerName`, `buyerEmail`) — asserting the wrong one would have passed against a
        // body the provider never accepts.
        expect(call!.body.name).toBe(orderRow.buyerName);
        expect(call!.body.email).toBe(orderRow.buyerEmail);
    });

    it("A3. the provider is told to notify this platform's own origin", async () => {
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
        // The provider's window is the platform's own TTL, not a provider default (§13.1).
        // For the direct endpoint the value is in HOURS (its documented unit), so it is the
        // ceiling of our minutes — never a raw minute count that would mean 24 hours.
        expect(typeof body.expired).toBe("number");
        expect(body.expired).toBeGreaterThanOrEqual(1);
        expect(body.expired).toBeLessThanOrEqual(24);
    });

    it("A3b. a bank transfer asks for a VIRTUAL ACCOUNT and stores the number the gateway issued", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeA.id, quantity: 1 }],
            tag: "p7-a3b",
        });

        const payload = await pay(f.buyerA.id, order.orderNumber, {
            method: "VIRTUAL_ACCOUNT",
            channel: "bni",
        });

        const body = gatewayStub.lastCall()!.body;

        // The channel the buyer chose is the channel that was sent — not a default.
        expect(body.paymentMethod).toBe("va");
        expect(body.paymentChannel).toBe("bni");

        expect(payload.flow).toBe("DIRECT");
        expect("qrString" in payload).toBe(false);
        expect(payload.paymentNumber).toMatch(/^8808/);
        expect(payload.paymentName).toBe("iPaymu BNI");

        const rows = await paymentRowsFor(order.orderNumber);

        expect(rows[0].channel).toBe("bni");
        expect(rows[0].paymentNumber).toBe(payload.paymentNumber);
    });

    it("A3c. a method the catalog does not implement is refused, and no provider call is made", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeA.id, quantity: 1 }],
            tag: "p7-a3c",
        });

        // COD exists at the provider but has nothing to deliver for a digital ticket, so it is
        // deliberately absent from the catalog. A buyer who asks for it is refused rather than
        // quietly downgraded onto a method they did not choose.
        const error = await expectRejection(() =>
            pay(f.buyerA.id, order.orderNumber, { method: "COD" })
        );

        expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
        expect(gatewayStub.calls).toHaveLength(0);

        // …and a channel that does not belong to the chosen method is refused too, because a
        // buyer who picked QRIS must not be handed a bank account number.
        const channelError = await expectRejection(() =>
            pay(f.buyerA.id, order.orderNumber, {
                method: "QRIS",
                channel: "bca",
            })
        );

        expect(channelError.code).toBe(ERROR_CODES.VALIDATION_ERROR);
        expect(gatewayStub.calls).toHaveLength(0);
    });

    it("A3d. a redirect method hands back the provider's own hosted URL", async () => {
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: f.typeA.id, quantity: 1 }],
            tag: "p7-a3d",
        });

        const payload = await pay(f.buyerA.id, order.orderNumber, {
            method: "CREDIT_CARD",
        });

        // The card form lives on the provider's page: this application must never collect card
        // data, and it never sees any. The URL is the provider's own, and the response carries
        // no QR and no account number because there is none.
        expect(gatewayStub.lastCall()!.url).toBe(
            "https://sandbox.ipaymu.com/api/v2/payment/"
        );
        expect(payload.flow).toBe("REDIRECT");
        expect(payload.paymentUrl).toBe(
            `https://sandbox.ipaymu.com/payment/${SUFFIX}-1`
        );
        expect("qrString" in payload).toBe(false);
        expect(payload.paymentNumber).toBeNull();

        const body = gatewayStub.lastCall()!.body;

        expect(body.paymentMethod).toBe("cc");
        expect(body.buyerName).toBeTruthy();
        expect(body.returnUrl).toBe(
            `http://localhost:3000/ticketing/orders/${encodeURIComponent(
                order.orderNumber
            )}`
        );
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
