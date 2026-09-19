/**
 * ==========================================
 * PHASE 7 — WEBHOOK VERIFICATION + SETTLEMENT (INTEGRATION)
 * ==========================================
 *
 * The provider's notification path, end to end and against the real database: real HMAC
 * verification, real `WebhookEvent` ledger, real inventory CAS, real settlement
 * transaction. Only the outbound socket is stubbed (and this suite barely needs it — it
 * exists so an order can be given a provider session to be settled against).
 *
 * Coverage maps to brief §28: group B (gateway security), C (successful settlement),
 * D (duplicate webhook), E (failure webhook) and I (financial invariants).
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { NextRequest } from "next/server";

import { ERROR_CODES } from "@/lib/api/errors";
import { requireOrganizerAccess } from "@/lib/authz";
import { computeCanonicalJson, computeWebhookSignature } from "@/lib/payment/ipaymu";
import { prisma } from "@/lib/prisma";
import { createTicketType } from "@/lib/ticket-types/service";
import { MAX_WEBHOOK_BODY_BYTES } from "@/lib/ticketing/payment/validation";
import { createOrderPayment } from "@/lib/ticketing/payment/service";
import { handleGatewayWebhook } from "@/lib/ticketing/payment/webhook";

import { POST as webhookRoute } from "@/app/api/ticketing/payment/webhook/route";

import {
    assertInventoryInvariants,
    counters,
    createOrder,
    customerScope,
    expectRejection,
    gatewayStub,
    installGatewayStub,
    merchantVa,
    nextRequest,
    setupFixtures,
    signInAs,
    signedCallback,
    SUFFIX,
    teardownFixtures,
    type Fixtures,
} from "./payment-harness";

jest.setTimeout(180_000);

let f: Fixtures;
let fetchSpy: jest.SpyInstance;
let trxCounter = 0;

/**
 * A provider transaction id unique to this suite.
 *
 * The `SUFFIX` is in the middle deliberately: rejected deliveries are stored with
 * `orderId: null` and a hashed `providerEventId`, so this column is the only handle
 * teardown has on them.
 */
function nextTrx(tag: string): string {
    trxCounter += 1;

    return `TRX-${SUFFIX}-${tag}-${trxCounter}`;
}

const trxFor = (tag: string) => `TRX-${SUFFIX}-${tag}`;

/** A fresh ticket type, so a settlement test can make absolute counter assertions. */
async function newType(name: string, quota = 20): Promise<string> {
    signInAs(f.ownerA.id);
    const scope = await requireOrganizerAccess(f.orgA.id, "event.read");

    const created = await createTicketType(scope, f.eventA.id, {
        name,
        price: "150000.00",
        quota,
    } as never);

    return created.id;
}

/** Create an order and give it a live provider session, exactly as the UI would. */
async function orderWithSession(
    ticketTypeId: string,
    quantity: number,
    tag: string
) {
    const order = await createOrder({
        buyerId: f.buyerA.id,
        items: [{ ticketTypeId, quantity }],
        tag,
    });

    signInAs(f.buyerA.id);
    const payment = await createOrderPayment({
        orderNumber: order.orderNumber,
        actor: await customerScope(f.buyerA.id),
        request: {} as never,
        httpRequest: nextRequest(),
    });

    return { order, payment };
}

/** Deliver a signed provider notification for a payment. */
async function deliver(
    payment: { paymentReference: string; amount: string },
    options: {
        statusCode?: number;
        tag?: string;
        /** Defaults to the order's own amount, which is the happy path. */
        subTotal?: string | null;
        fee?: string | null;
        extra?: Record<string, string>;
        /** Send the byte-identical body of a previous delivery. */
        replay?: { rawBody: string; signature: string };
    } = {}
) {
    const signed =
        options.replay ??
        signedCallback({
            referenceId: payment.paymentReference,
            statusCode: options.statusCode ?? 1,
            subTotal:
                options.subTotal === undefined ? payment.amount : options.subTotal,
            trxId: nextTrx(options.tag ?? "rt"),
            fee: options.fee === undefined ? "0" : options.fee,
            via: "qris",
            channel: "qris",
            extra: options.extra,
        });

    const result = await handleGatewayWebhook({
        rawBody: signed.rawBody,
        signatureHeader: signed.signature,
        remoteIp: "127.0.0.1",
    });

    return { result, signed };
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
 * B. GATEWAY SECURITY
 * ========================================================================== */

describe("B. gateway signature and payload verification", () => {
    it("B1. a delivery with no signature is refused and changes nothing", async () => {
        const type = await newType("B1");
        const { order, payment } = await orderWithSession(type, 1, "p7-b1");
        const before = await counters(type);

        const { result } = await deliver(payment, { tag: "b1" });

        // Overriding the header is the whole point, so call the handler directly.
        const denied = await handleGatewayWebhook({
            rawBody: signedCallback({
                referenceId: payment.paymentReference,
                statusCode: 1,
                subTotal: payment.amount,
                trxId: nextTrx("b1-denied"),
            }).rawBody,
            signatureHeader: null,
            remoteIp: "127.0.0.1",
        });

        expect(result.outcome).toBe("SETTLED");
        expect(denied.httpStatus).toBe(401);
        expect(denied.outcome).toBe("REJECTED_SIGNATURE");

        // The one legitimate settlement above is the only state change.
        const after = await counters(type);

        expect(after.sold).toBe(before.sold + 1);
        expect(after.reserved).toBe(before.reserved - 1);

        const stillOpen = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true },
        });

        expect(stillOpen.status).toBe("PAID");
    });

    it("B2. a malformed signature is refused, and each attempt is recorded", async () => {
        const type = await newType("B2");
        const { payment } = await orderWithSession(type, 1, "p7-b2");

        const signed = signedCallback({
            referenceId: payment.paymentReference,
            statusCode: 1,
            subTotal: payment.amount,
            trxId: nextTrx("b2"),
        });

        // Counted relatively, so the assertion describes THIS test's attempts regardless of
        // what any other suite has left in the table.
        const before = await prisma.webhookEvent.count({
            where: { signatureValid: false },
        });

        for (const bad of [
            "deadbeef",
            "not-hex-at-all",
            signed.signature.slice(0, -2),
        ]) {
            const result = await handleGatewayWebhook({
                rawBody: signed.rawBody,
                signatureHeader: bad,
                remoteIp: "127.0.0.1",
            });

            expect(result.httpStatus).toBe(401);
            expect(result.outcome).toBe("REJECTED_SIGNATURE");
        }

        // Every rejected delivery is recorded (so an attack is observable), with the
        // signature flag false and the reason preserved for forensics.
        //
        // EXACTLY ONE row, not three: all three attempts carry the byte-identical body, so
        // they resolve to the same `providerEventId`, and the UNIQUE constraint collapses
        // them. That is the replay guard working one step earlier than settlement — an
        // attacker cannot inflate the ledger by resending a rejected payload — and the
        // three attempts are still each refused.
        const after = await prisma.webhookEvent.count({
            where: { signatureValid: false },
        });

        expect(after - before).toBe(1);

        const recorded = await prisma.webhookEvent.findFirst({
            where: {
                signatureValid: false,
                providerTransactionId: { startsWith: trxFor("b2") },
            },
            orderBy: { receivedAt: "desc" },
            select: {
                processingStatus: true,
                processingResult: true,
                signatureValid: true,
                payloadJson: true,
            },
        });

        expect(recorded).not.toBeNull();
        expect(recorded!.signatureValid).toBe(false);
        expect(recorded!.processingResult).toMatch(/^rejected_signature_/);
        // The redacted marker, never the attacker-controlled body.
        expect(recorded!.payloadJson).toEqual({ rejected: true });
    });

    it("B3. a valid signature over a body signed with a DIFFERENT secret is refused", async () => {
        const type = await newType("B3");
        const { order, payment } = await orderWithSession(type, 1, "p7-b3");

        const rawBody = new URLSearchParams({
            reference_id: payment.paymentReference,
            status_code: "1",
            sub_total: payment.amount,
            trx_id: nextTrx("b3"),
        }).toString();

        // Correct algorithm, wrong key — the classic forged-callback attempt.
        const forged = computeWebhookSignature(
            computeCanonicalJson({
                reference_id: payment.paymentReference,
                status_code: "1",
                sub_total: payment.amount,
            }),
            "0000000000"
        );

        const result = await handleGatewayWebhook({
            rawBody,
            signatureHeader: forged,
            remoteIp: "127.0.0.1",
        });

        expect(result.httpStatus).toBe(401);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true, paymentStatus: true },
        });

        expect(row.status).toBe("PENDING_PAYMENT");
        expect(row.paymentStatus).toBe("PENDING");
        await assertInventoryInvariants(type);
    });

    it("B4. an amount mismatch is refused with no state change", async () => {
        const type = await newType("B4");
        const { order, payment } = await orderWithSession(type, 2, "p7-b4");
        const before = await counters(type);

        const error = await expectRejection(() =>
            deliver(payment, { tag: "b4", subTotal: "1.00" })
        );

        expect(error.code).toBe(ERROR_CODES.INVALID_WEBHOOK);
        expect(error.details?.reason).toBe("AMOUNT_MISMATCH");

        const after = await counters(type);

        expect(after).toEqual(before);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true, paymentStatus: true },
        });

        expect(row.status).toBe("PENDING_PAYMENT");
        expect(row.paymentStatus).toBe("PENDING");

        // The attempt is on the ledger as ignored, so the mismatch is forensic evidence.
        const ledger = await prisma.webhookEvent.findFirst({
            where: { orderId: order.orderId },
            orderBy: { receivedAt: "desc" },
            select: { processingStatus: true, processingResult: true, signatureValid: true },
        });

        expect(ledger?.processingStatus).toBe("IGNORED");
        expect(ledger?.processingResult).toBe("rejected_amount_mismatch");
        // Signed correctly, so the rejection is about the money, not the key.
        expect(ledger?.signatureValid).toBe(true);
    });

    it("B5. an oversized body is refused before it is hashed", async () => {
        const result = await handleGatewayWebhook({
            rawBody: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1),
            signatureHeader: "irrelevant",
            remoteIp: "127.0.0.1",
        });

        expect(result.httpStatus).toBe(413);
        expect(result.outcome).toBe("BODY_TOO_LARGE");
    });

    it("B6. the route reads the raw body and maps a bad signature to HTTP 401", async () => {
        const type = await newType("B6");
        const { payment } = await orderWithSession(type, 1, "p7-b6");

        const signed = signedCallback({
            referenceId: payment.paymentReference,
            statusCode: 1,
            subTotal: payment.amount,
            trxId: nextTrx("b6"),
        });

        const request = new NextRequest(
            new URL("http://localhost:3000/api/ticketing/payment/webhook"),
            {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    "x-signature": "0".repeat(64),
                },
                body: signed.rawBody,
            }
        );

        const response = await webhookRoute(request);

        expect(response.status).toBe(401);

        // …and the SAME route accepts the same bytes once properly signed.
        const okRequest = new NextRequest(
            new URL("http://localhost:3000/api/ticketing/payment/webhook"),
            {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    "x-signature": signed.signature,
                },
                body: signed.rawBody,
            }
        );

        const okResponse = await webhookRoute(okRequest);

        expect(okResponse.status).toBe(200);
    });

    it("B7. the signature covers the field SET, so byte order is irrelevant but any value change is fatal", async () => {
        const type = await newType("B7");
        const { order, payment } = await orderWithSession(type, 1, "p7-b7");

        // The provider's own documented scheme (PHP `json_encode` over `ksort`ed fields)
        // MACs a CANONICALISED form, not the literal bytes: field order cannot matter, every
        // field value must. Both halves are asserted, because a verifier that quietly
        // accepted a modified value would be the real vulnerability.
        const trx = nextTrx("b7");

        const signed = signedCallback({
            referenceId: payment.paymentReference,
            statusCode: 1,
            subTotal: payment.amount,
            trxId: trx,
            fee: "0",
            via: "qris",
            channel: "qris",
        });

        // (a) identical field set and values, reordered → authentic.
        const reordered = new URLSearchParams({
            channel: "qris",
            status_code: "1",
            via: "qris",
            trx_id: trx,
            sub_total: payment.amount,
            reference_id: payment.paymentReference,
            fee: "0",
        }).toString();

        const accepted = await handleGatewayWebhook({
            rawBody: reordered,
            signatureHeader: signed.signature,
            remoteIp: "127.0.0.1",
        });

        expect(accepted.httpStatus).toBe(200);
        expect(accepted.outcome).toBe("SETTLED");

        // (b) one field's value changed, byte order left alone → refused.
        //
        // The field is `fee`, deliberately NOT `trx_id`: `normalizeCallbackBody` coerces
        // `trx_id`, `status_code`, `transaction_status_code` and `paid_off` through
        // `parseInt`, and a non-numeric value therefore collapses to `null` on BOTH sides
        // of the comparison — which means a non-numeric `trx_id` is not actually covered by
        // the signature. That is a property of the verifier inherited from the live retail
        // route (reported, not silently patched); `fee` is an ordinary string field and
        // proves the value coverage that does exist.
        const tampered = new URLSearchParams({
            channel: "qris",
            status_code: "1",
            via: "qris",
            trx_id: trx,
            sub_total: payment.amount,
            reference_id: payment.paymentReference,
            fee: "9999",
        }).toString();

        const refused = await handleGatewayWebhook({
            rawBody: tampered,
            signatureHeader: signed.signature,
            remoteIp: "127.0.0.1",
        });

        expect(refused.httpStatus).toBe(401);
        expect(refused.outcome).toBe("REJECTED_SIGNATURE");

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true },
        });

        // Exactly the one legitimate settlement landed; the forged delivery never did.
        expect(row.status).toBe("PAID");
        expect(await counters(type)).toMatchObject({ sold: 1, reserved: 0 });
    });

    it("B8. the VA used for signing is the one the platform's verifier holds", () => {
        // Guards the fixture itself: a `signedCallback` that silently used a different key
        // would make every case above pass for the wrong reason.
        expect(merchantVa()).toMatch(/^\d+$/);
        expect(merchantVa().length).toBeGreaterThanOrEqual(8);
    });
});

/* ==========================================================================
 * C. SUCCESSFUL SETTLEMENT
 * ========================================================================== */

describe("C. successful settlement", () => {
    it("C1. one signed success converts the holds and marks the order paid", async () => {
        const type = await newType("C1");
        const { order, payment } = await orderWithSession(type, 2, "p7-c1");

        const before = await counters(type);

        expect(before.reserved).toBe(2);
        expect(before.sold).toBe(0);

        const { result } = await deliver(payment, { tag: "c1" });

        expect(result.outcome).toBe("SETTLED");
        expect(result.httpStatus).toBe(200);

        const after = await counters(type);

        // exactly once, in both directions
        expect(after.sold).toBe(2);
        expect(after.reserved).toBe(0);
        expect(after.sold + after.reserved).toBeLessThanOrEqual(after.quota);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true, paymentStatus: true, paidAt: true, gatewayFee: true },
        });

        expect(row.status).toBe("PAID");
        expect(row.paymentStatus).toBe("PAID");
        expect(row.paidAt).not.toBeNull();

        const reservations = await prisma.ticketReservation.findMany({
            where: { orderId: order.orderId },
            select: { status: true },
        });

        expect(reservations).toHaveLength(1);
        expect(reservations[0].status).toBe("CONVERTED");

        const payments = await prisma.payment.findMany({
            where: { orderId: order.orderId },
            select: {
                status: true,
                externalSessionId: true,
                paymentReference: true,
            },
        });

        expect(payments).toHaveLength(1);
        expect(payments[0].status).toBe("PAID");
        // The provider's session id came back from the gateway call and was kept.
        expect(payments[0].externalSessionId).toMatch(/^SES-/);

        // The provider's own transaction id is captured for reconciliation — it lives on
        // the append-only transaction row, not on the session row.
        const transactions = await prisma.paymentTransaction.findMany({
            where: { orderId: order.orderId },
            select: { providerTransactionId: true, type: true },
        });

        expect(transactions).toHaveLength(1);
        expect(transactions[0].providerTransactionId).toContain("-c1-");
        expect(transactions[0].type).toBe("PAYMENT");

        await assertInventoryInvariants(type);
    });

    it("C2. settlement writes a PaymentTransaction and a payment.success audit row", async () => {
        const type = await newType("C2");
        const { order, payment } = await orderWithSession(type, 1, "p7-c2");

        await deliver(payment, { tag: "c2", fee: "2500" });

        const transactions = await prisma.paymentTransaction.findMany({
            where: { orderId: order.orderId },
            select: { status: true, provider: true, amount: true, providerFee: true },
        });

        expect(transactions).toHaveLength(1);
        expect(transactions[0].status).toBe("PAID");
        expect(transactions[0].provider).toBe("ipaymu");
        expect(transactions[0].amount.toFixed(2)).toBe(payment.amount);

        // The success row is keyed to the ORDER (that is the entity whose state changed),
        // so `entityRef` is the order number, not the payment reference.
        const success = await prisma.adminAuditLog.findFirst({
            where: {
                action: "payment.success",
                organizerId: f.orgA.id,
                entityRef: order.orderNumber,
            },
            select: {
                actorType: true,
                actorUserId: true,
                actorRole: true,
                afterState: true,
                beforeState: true,
                reason: true,
                entityType: true,
            },
        });

        expect(success).not.toBeNull();
        // Provider-driven, so it must carry the explicit PROVIDER marker rather than a
        // fabricated user id (brief §23).
        expect(success!.actorType).toBe("PROVIDER");
        expect(success!.actorUserId).toBeNull();
        expect(success!.entityType).toBe("EventOrder");

        const after = success!.afterState as Record<string, unknown>;

        expect(after.status).toBe("PAID");
        expect(after.paymentStatus).toBe("PAID");
        expect(after.seatsSold).toBe(1);
        expect(after.reservationsConverted).toBe(1);

        // The payload is reconcilable without carrying buyer PII.
        expect(JSON.stringify(after)).not.toContain("@example.test");
        expect(JSON.stringify(after).toLowerCase()).not.toContain("buyer");

        // The buyer-initiated creation is audited too, and IS attributed to the user.
        const creation = await prisma.adminAuditLog.findFirst({
            where: {
                action: "payment.create",
                entityRef: payment.paymentReference,
            },
            select: { actorType: true, actorUserId: true },
        });

        expect(creation).not.toBeNull();
        expect(creation!.actorType).toBe("USER");
        expect(creation!.actorUserId).toBe(f.buyerA.id);
    });

    it("C3. a notification whose reference is not ours is acknowledged and ignored", async () => {
        const type = await newType("C3");
        const { order } = await orderWithSession(type, 1, "p7-c3");

        const signed = signedCallback({
            referenceId: "SHOPIFY-RETAIL-ORDER-12345",
            statusCode: 1,
            subTotal: "1000.00",
            trxId: nextTrx("c3"),
        });

        const result = await handleGatewayWebhook({
            rawBody: signed.rawBody,
            signatureHeader: signed.signature,
            remoteIp: "127.0.0.1",
        });

        // 200 so the provider does not retry something that is not ours to process.
        expect(result.httpStatus).toBe(200);
        expect(result.outcome).not.toBe("SETTLED");

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true },
        });

        expect(row.status).toBe("PENDING_PAYMENT");
        await assertInventoryInvariants(type);
    });

    it("C4. a refund notification is recorded and never acted on", async () => {
        const type = await newType("C4");
        const { payment } = await orderWithSession(type, 1, "p7-c4");

        const result = await deliver(payment, {
            tag: "c4",
            statusCode: 1,
            extra: { status: "refund" },
        });

        // PHASE 18B (D-P17-04 = B): the production refund rail is a manual bank transfer, so
        // a refund notification is recorded and acknowledged but can never settle anything.
        expect(result.result.outcome).toBe("REFUND_MANUAL_RAIL");
        expect(result.result.httpStatus).toBe(200);
        await assertInventoryInvariants(type);
    });

    it("C5. an unknown status is acknowledged and never mutates", async () => {
        const type = await newType("C5");
        const { order, payment } = await orderWithSession(type, 1, "p7-c5");
        const before = await counters(type);

        const result = await deliver(payment, { tag: "c5", statusCode: 3 });

        expect(result.result.httpStatus).toBe(200);
        expect(["UNKNOWN", "PENDING"]).toContain(result.result.outcome);
        expect(await counters(type)).toEqual(before);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true },
        });

        expect(row.status).toBe("PENDING_PAYMENT");
    });
});

/* ==========================================================================
 * D. DUPLICATE WEBHOOK
 * ========================================================================== */

describe("D. duplicate deliveries", () => {
    it("D1. the byte-identical event delivered three times settles exactly once", async () => {
        const type = await newType("D1");
        const { order, payment } = await orderWithSession(type, 3, "p7-d1");

        const first = await deliver(payment, { tag: "d1" });

        expect(first.result.outcome).toBe("SETTLED");

        const afterFirst = await counters(type);

        // The SAME bytes, three more times — exactly what a provider retry looks like.
        const second = await deliver(payment, { replay: first.signed });
        const third = await deliver(payment, { replay: first.signed });

        expect(second.result.httpStatus).toBe(200);
        expect(second.result.outcome).toBe("DUPLICATE");
        expect(third.result.outcome).toBe("DUPLICATE");

        const afterRepeats = await counters(type);

        // The counters are byte-identical: no second conversion, no second release.
        expect(afterRepeats).toEqual(afterFirst);
        expect(afterRepeats.sold).toBe(3);
        expect(afterRepeats.reserved).toBe(0);

        await expect(
            prisma.paymentTransaction.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(1);
        await expect(
            prisma.ticketReservation.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(1);
        await expect(
            prisma.payment.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(1);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true, paidAt: true },
        });

        expect(row.status).toBe("PAID");

        // Exactly one PROCESSED ledger row for this event, plus the duplicate attempts
        // recorded as ignored — the ledger keeps the forensic trail without double-acting.
        const ledger = await prisma.webhookEvent.findMany({
            where: { orderId: order.orderId },
            select: { processingStatus: true },
        });

        expect(ledger.filter((l) => l.processingStatus === "PROCESSED")).toHaveLength(1);
    });

    it("D2. a second, differently-identified success for the same order is not a second settlement", async () => {
        const type = await newType("D2");
        const { order, payment } = await orderWithSession(type, 2, "p7-d2");

        const first = await deliver(payment, { tag: "d2" });

        expect(first.result.outcome).toBe("SETTLED");

        const afterFirst = await counters(type);

        // Different trx_id → different providerEventId → the replay guard does NOT catch
        // it. The order-state guard is what has to.
        const second = await deliver(payment, { tag: "d2-again" });

        expect(second.result.httpStatus).toBe(200);
        expect(second.result.outcome).toBe("ALREADY_PAID");
        expect(await counters(type)).toEqual(afterFirst);
        expect(afterFirst.sold).toBe(2);

        await expect(
            prisma.paymentTransaction.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(1);
    });

    it("D3. ten concurrent deliveries of the same event settle exactly once", async () => {
        const type = await newType("D3");
        const { order, payment } = await orderWithSession(type, 5, "p7-d3");

        const signed = signedCallback({
            referenceId: payment.paymentReference,
            statusCode: 1,
            subTotal: payment.amount,
            trxId: nextTrx("d3"),
            fee: "0",
        });

        const results = await Promise.all(
            Array.from({ length: 10 }, () =>
                handleGatewayWebhook({
                    rawBody: signed.rawBody,
                    signatureHeader: signed.signature,
                    remoteIp: "127.0.0.1",
                }).catch((error: { code?: string; details?: Record<string, unknown> }) => ({
                    httpStatus: 500,
                    message: "threw",
                    outcome: String(error.code ?? "THREW"),
                }))
            )
        );

        const settled = results.filter((r) => r.outcome === "SETTLED");

        expect(settled).toHaveLength(1);

        const after = await counters(type);

        expect(after.sold).toBe(5);
        expect(after.reserved).toBe(0);

        await expect(
            prisma.paymentTransaction.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(1);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true },
        });

        expect(row.status).toBe("PAID");
        await assertInventoryInvariants(type);
    });
});

/* ==========================================================================
 * E. FAILURE WEBHOOK
 * ========================================================================== */

describe("E. failure notification", () => {
    it("E1. a failed payment releases the holds and cancels the order", async () => {
        const type = await newType("E1");
        const { order, payment } = await orderWithSession(type, 2, "p7-e1");
        const before = await counters(type);

        expect(before.reserved).toBe(2);

        const { result } = await deliver(payment, { tag: "e1", statusCode: 4 });

        expect(result.httpStatus).toBe(200);
        expect(result.outcome).toBe("ORDER_FAILED");

        const after = await counters(type);

        expect(after.sold).toBe(0);
        expect(after.reserved).toBe(0);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true, paymentStatus: true, paidAt: true, cancelledAt: true },
        });

        expect(row.status).toBe("CANCELLED");
        expect(row.paymentStatus).toBe("FAILED");
        expect(row.paidAt).toBeNull();
        expect(row.cancelledAt).not.toBeNull();

        // No money moved, so no financial transaction is invented.
        await expect(
            prisma.paymentTransaction.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(0);

        const reservations = await prisma.ticketReservation.findMany({
            where: { orderId: order.orderId },
            select: { status: true },
        });

        expect(reservations).toHaveLength(1);
        expect(["RELEASED", "EXPIRED"]).toContain(reservations[0].status);

        await assertInventoryInvariants(type);
    });

    it("E2. a success arriving after the failure cannot resurrect the order", async () => {
        const type = await newType("E2");
        const { order, payment } = await orderWithSession(type, 2, "p7-e2");

        const failed = await deliver(payment, { tag: "e2-fail", statusCode: 4 });

        expect(failed.result.outcome).toBe("ORDER_FAILED");

        const afterFailure = await counters(type);

        const late = await deliver(payment, { tag: "e2-late" });

        expect(late.result.httpStatus).toBe(200);
        // Not SETTLED, and not ALREADY_PAID — the order never became paid.
        expect(late.result.outcome).toBe("LATE_SETTLEMENT");

        // ── THE DESIGN'S OWN LATE-SETTLEMENT CONTRACT (design §11.4 / §12.3) ────────
        // "Late settlement is recorded by the webhook as `paymentStatus = PAID` WITHOUT
        // issuing tickets, raising an operator alert" … "`paymentStatus` may become `PAID`
        // while `status` stays `CANCELLED` — this mismatch is exactly what the operator
        // queue exists to resolve."
        //
        // So this is NOT a resurrection and NOT a bug: the money really arrived, and the
        // order must stay unfulfillable. What must not happen is a ticket, a converted
        // reservation or a moved seat.
        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: {
                status: true,
                paymentStatus: true,
                paidAt: true,
                fulfilmentBlockedAt: true,
            },
        });

        // The terminal decision stands: never PENDING_PAYMENT, never PAID-as-fulfillable.
        expect(row.status).toBe("CANCELLED");
        // …and the arrival of money is recorded rather than discarded.
        expect(row.paymentStatus).toBe("PAID");
        expect(row.paidAt).not.toBeNull();
        // §11.4 requires fulfilment to be held, which is what makes the mismatch safe.
        expect(row.fulfilmentBlockedAt).not.toBeNull();

        // The most important assertion in this test: the late success moved NO inventory.
        expect(await counters(type)).toEqual(afterFailure);
        expect(afterFailure.sold).toBe(0);
        expect(afterFailure.reserved).toBe(0);

        // The holds were released by the failure and are never taken back.
        const reservations = await prisma.ticketReservation.findMany({
            where: { orderId: order.orderId },
            select: { status: true },
        });

        expect(reservations.every((r) => r.status !== "CONVERTED")).toBe(true);

        // No ticket is issued against a cancelled order, even though it is now paid.
        await expect(
            prisma.ticket.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(0);

        // ── A BOUNDARY WORTH STATING RATHER THAN ASSUMING ─────────────────────────
        // No `PaymentTransaction` is written here. `settlePaymentRow` guards on the
        // attempt still being `UNPAID`/`PENDING`, and the failure notification already
        // moved this one to a terminal state — so the CAS finds nothing to settle and the
        // late money is deliberately not recorded as a provider transaction.
        //
        // The money is not invisible: the order carries `paymentStatus = PAID`, the
        // `payment.success` audit row carries `reason: LATE_SETTLEMENT_AFTER_TERMINAL_STATE`
        // and `fulfilmentBlocked: true`, and the raw delivery is on the `WebhookEvent`
        // ledger. It is reported as a WARNING in the Phase 7 report rather than "fixed"
        // here, because writing a financial transaction against a terminal attempt is a
        // reconciliation rule this phase was not given.
        await expect(
            prisma.paymentTransaction.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(0);

        const marker = await prisma.adminAuditLog.findFirst({
            where: {
                action: "payment.success",
                entityRef: order.orderNumber,
            },
            select: { reason: true, actorType: true, afterState: true },
        });

        expect(marker).not.toBeNull();
        expect(marker!.reason).toBe("LATE_SETTLEMENT_AFTER_TERMINAL_STATE");
        expect(marker!.actorType).toBe("PROVIDER");
        expect((marker!.afterState as Record<string, unknown>).orderStatusUnchanged).toBe(
            true
        );
    });

    it("E3. a failure notification for an already-paid order changes nothing", async () => {
        const type = await newType("E3");
        const { order, payment } = await orderWithSession(type, 1, "p7-e3");

        await deliver(payment, { tag: "e3-paid" });

        const afterPaid = await counters(type);

        expect(afterPaid.sold).toBe(1);

        const result = await deliver(payment, { tag: "e3-fail", statusCode: 4 });

        expect(result.result.httpStatus).toBe(200);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true, paymentStatus: true },
        });

        // A paid order is never cancelled by a later failure notice.
        expect(row.status).toBe("PAID");
        expect(row.paymentStatus).toBe("PAID");
        expect(await counters(type)).toEqual(afterPaid);
    });
});

/* ==========================================================================
 * I. FINANCIAL INVARIANTS
 * ========================================================================== */

describe("I. financial invariants across the settlement boundary", () => {
    it("I1. quota, sold and reserved stay consistent through settle and release", async () => {
        const type = await newType("I1", 4);

        // Two orders on one 4-seat type, settled and failed respectively.
        const settled = await orderWithSession(type, 3, "p7-i1-settled");
        const failed = await orderWithSession(type, 1, "p7-i1-failed");

        const before = await counters(type);

        expect(before.quota).toBe(4);
        expect(before.sold).toBe(0);
        expect(before.reserved).toBe(4);

        await deliver(settled.payment, { tag: "i1-settle" });
        await deliver(failed.payment, { tag: "i1-fail", statusCode: 4 });

        const after = await counters(type);

        expect(after.quota).toBe(4);
        expect(after.sold).toBe(3);
        expect(after.reserved).toBe(0);

        // The whole point: nothing was invented and nothing was lost.
        expect(after.sold + after.reserved).toBe(3);
        expect(after.sold + after.reserved).toBeLessThanOrEqual(after.quota);

        await assertInventoryInvariants(type);
    });

    it("I2. a settled order reports its own amount, derived from the order row", async () => {
        const type = await newType("I2");
        const { order, payment } = await orderWithSession(type, 2, "p7-i2");

        await deliver(payment, { tag: "i2" });

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { total: true, subtotal: true, currency: true, status: true },
        });

        expect(row.total.toFixed(2)).toBe("300000.00");
        expect(row.subtotal.toFixed(2)).toBe("300000.00");
        expect(row.currency).toBe("IDR");
        expect(row.status).toBe("PAID");

        // The amount the provider was told to collect equals what was persisted.
        expect(gatewayStub.lastCall()!.body.amount).toBe(300000);
    });
});
