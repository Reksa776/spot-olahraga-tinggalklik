/**
 * ==========================================
 * PHASE 27F — LOCAL SANDBOX CALLBACK REPLAY (INTEGRATION)
 * ==========================================
 *
 * Proves the LOCAL, no-tunnel sandbox workflow end to end: take the callback request that
 * iPaymu Sandbox's "Tes Notify" generates, POST it verbatim to the real local webhook, and
 * watch the REAL verification → amount → reference → settlement chain run.
 *
 * ── WHY THIS SUITE EXISTS ────────────────────────────────────────────────────────
 * The reported bug was "the sandbox dashboard says paid, the order still says Menunggu
 * Pembayaran". The cause is not in this codebase — iPaymu's callback server cannot open a
 * connection to `http://localhost:3000`, so the delivery never arrives (Phase 27B: zero ledger
 * rows for the paid transaction). The remedy is to replay the provider's own request at the
 * local endpoint, and the thing that needs proving is that a REAL-SHAPE provider payload
 * survives verification and settles — not merely that a three-field fixture does.
 *
 * ── WHAT IS REAL ─────────────────────────────────────────────────────────────────
 * Everything except the outbound socket: the route handler, the raw-body read, the HMAC check
 * over the exact bytes, `normalizeCallbackBody` against the captured 26-field payload, the
 * `WebhookEvent` ledger, the amount comparison, and the whole settlement transaction. The only
 * stub is `global.fetch`, which this suite barely needs (it exists so an order can be given a
 * provider session to settle against).
 *
 * ── WHAT IT DOES *NOT* DO ────────────────────────────────────────────────────────
 * There is no bypass anywhere: no unsigned path, no localhost exemption, no amount shortcut, no
 * direct `SET PAID`. A delivery only settles if the signature verifies against the configured
 * VA, the reference resolves to our own `Payment`, and the amount matches the order total. The
 * negative tests below assert exactly that.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { NextRequest } from "next/server";

import { requireOrganizerAccess } from "@/lib/authz";
import { computeCanonicalJson, computeWebhookSignature } from "@/lib/payment/ipaymu";
import { prisma } from "@/lib/prisma";
import { createTicketType } from "@/lib/ticket-types/service";
import { createOrderPayment } from "@/lib/ticketing/payment/service";
import { handleGatewayWebhook } from "@/lib/ticketing/payment/webhook";

import { POST as webhookRoute } from "@/app/api/ticketing/payment/webhook/route";

import {
    counters,
    createOrder,
    customerScope,
    gatewayStub,
    installGatewayStub,
    merchantVa,
    nextRequest,
    setupFixtures,
    signInAs,
    SUFFIX,
    teardownFixtures,
    type Fixtures,
} from "./payment-harness";
import {
    SANDBOX_CALLBACK,
    SANDBOX_CALLBACK_FIELDS,
    buildSandboxCallback,
} from "./sandbox-callback-fixture";

jest.setTimeout(180_000);

/** The captured payload's amount, so a real order can be made to match it exactly. */
const CAPTURED_AMOUNT = "15000.00";

const WEBHOOK_URL = "http://localhost:3000/api/ticketing/payment/webhook";

let f: Fixtures;
let fetchSpy: jest.SpyInstance;

/**
 * Sign a captured field set exactly as the provider does.
 *
 * The same two helpers the verifier uses, and the same VA the verifier holds — so the fixture
 * proves the real path rather than a parallel implementation of it. The raw body is
 * form-urlencoded, which is what iPaymu actually posts.
 */
function signCaptured(fields: Record<string, string>): {
    rawBody: string;
    signature: string;
} {
    const rawBody = new URLSearchParams(fields).toString();
    const signature = computeWebhookSignature(
        computeCanonicalJson(fields),
        merchantVa()
    );

    return { rawBody, signature };
}

/** POST a signed request through the REAL route, the way the provider would. */
async function replayThroughRoute(signed: {
    rawBody: string;
    signature: string;
}) {
    const request = new NextRequest(new URL(WEBHOOK_URL), {
        method: "POST",
        headers: {
            // iPaymu posts form-urlencoded and carries the HMAC in `X-Signature`.
            "content-type": "application/x-www-form-urlencoded",
            "x-signature": signed.signature,
        },
        body: signed.rawBody,
    });

    return webhookRoute(request);
}

/** A ticket type at the captured amount, so the callback's `sub_total` matches for real. */
async function newCapturedType(name: string, quota = 20): Promise<string> {
    signInAs(f.ownerA.id);
    const scope = await requireOrganizerAccess(f.orgA.id, "event.read");

    const created = await createTicketType(scope, f.eventA.id, {
        name,
        price: CAPTURED_AMOUNT,
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

/** A unique, teardown-findable transaction id, since ignored deliveries carry no order id. */
const trx = (tag: string) => `233592-${SUFFIX}-${tag}`;

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

describe("local sandbox callback replay", () => {
    it("R1. the fixture still carries the provider's full field set", () => {
        // A guard on the fixture itself: if a field is ever dropped, the replay below stops
        // covering the normalizer branch it exercises and would pass for the wrong reason.
        expect(Object.keys(SANDBOX_CALLBACK).sort()).toEqual(
            [...SANDBOX_CALLBACK_FIELDS].sort()
        );

        // The type-bearing fields the normalizer special-cases must be present, and numeric.
        for (const key of [
            "trx_id",
            "status_code",
            "transaction_status_code",
            "paid_off",
        ]) {
            expect(SANDBOX_CALLBACK[key]).toMatch(/^\d+$/);
        }

        expect(SANDBOX_CALLBACK.is_escrow).toBe("false");
        expect(SANDBOX_CALLBACK.additional_info).toBe("[]");
        // A slash-bearing value, which is what exercises the slash-escape step.
        expect(SANDBOX_CALLBACK.url).toContain("/");
    });

    it("R2. a captured-shape callback with a valid signature settles through the real route", async () => {
        const type = await newCapturedType("R2");
        const { order, payment } = await orderWithSession(type, 1, "p27f-r2");

        expect(order.total).toBe(CAPTURED_AMOUNT);

        const fields = buildSandboxCallback({
            reference_id: payment.paymentReference,
            sid: payment.paymentReference,
            trx_id: trx("r2"),
        });

        // The captured `sub_total` is the order's own total, so nothing is overridden to make
        // the comparison pass — this is the replay working on the payload as captured.
        expect(fields.sub_total).toBe("15000");

        const response = await replayThroughRoute(signCaptured(fields));

        expect(response.status).toBe(200);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: {
                status: true,
                paymentStatus: true,
                paidAt: true,
                fulfilmentBlockedAt: true,
            },
        });

        expect(row.status).toBe("PAID");
        expect(row.paymentStatus).toBe("PAID");
        expect(row.paidAt).not.toBeNull();
        expect(row.fulfilmentBlockedAt).toBeNull();

        await expect(
            prisma.payment.count({ where: { orderId: order.orderId, status: "PAID" } })
        ).resolves.toBe(1);

        // Exactly one settlement transaction, carrying the provider's transaction id.
        const transactions = await prisma.paymentTransaction.findMany({
            where: { orderId: order.orderId },
            select: { providerTransactionId: true, type: true },
        });

        expect(transactions).toHaveLength(1);
        expect(transactions[0].providerTransactionId).toBe(trx("r2"));
        expect(transactions[0].type).toBe("PAYMENT");

        const reservations = await prisma.ticketReservation.findMany({
            where: { orderId: order.orderId },
            select: { status: true },
        });

        expect(reservations).toHaveLength(1);
        expect(reservations[0].status).toBe("CONVERTED");

        // The webhook NEVER issues tickets: issuance stays buyer-triggered.
        await expect(
            prisma.ticket.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(0);

        // The delivery is on the ledger, signature-valid and processed, with the redacted
        // summary only — the raw provider payload is never stored.
        const ledger = await prisma.webhookEvent.findFirstOrThrow({
            where: { orderId: order.orderId, providerTransactionId: trx("r2") },
            select: { processingStatus: true, signatureValid: true, payloadJson: true },
        });

        expect(ledger.processingStatus).toBe("PROCESSED");
        expect(ledger.signatureValid).toBe(true);
        expect(JSON.stringify(ledger.payloadJson)).not.toContain(
            SANDBOX_CALLBACK.buyer_email
        );
    });

    it("R3. replaying the identical request is idempotent — one settlement, not two", async () => {
        const type = await newCapturedType("R3");
        const { order, payment } = await orderWithSession(type, 1, "p27f-r3");

        const signed = signCaptured(
            buildSandboxCallback({
                reference_id: payment.paymentReference,
                sid: payment.paymentReference,
                trx_id: trx("r3"),
            })
        );

        const first = await replayThroughRoute(signed);

        expect(first.status).toBe(200);

        const afterFirst = await counters(type);

        // The SAME bytes, exactly what a retrying provider or a second manual replay sends.
        const second = await replayThroughRoute(signed);

        expect(second.status).toBe(200);

        const afterSecond = await counters(type);

        expect(afterSecond).toEqual(afterFirst);
        expect(afterSecond.sold).toBe(1);
        expect(afterSecond.reserved).toBe(0);

        await expect(
            prisma.paymentTransaction.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(1);
        await expect(
            prisma.ticketReservation.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(1);
    });

    it("R4. an amount mismatch is refused with no state change", async () => {
        const type = await newCapturedType("R4");
        const { order, payment } = await orderWithSession(type, 1, "p27f-r4");
        const before = await counters(type);

        // The captured shape, but a tampered amount. The signature still verifies (it is
        // re-signed), so the ONLY thing that can refuse this is the amount check.
        const signed = signCaptured(
            buildSandboxCallback({
                reference_id: payment.paymentReference,
                sid: payment.paymentReference,
                trx_id: trx("r4"),
                sub_total: "1",
            })
        );

        const response = await replayThroughRoute(signed);

        expect(response.status).toBe(400);
        expect(await counters(type)).toEqual(before);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true, paymentStatus: true },
        });

        expect(row.status).toBe("PENDING_PAYMENT");
        expect(row.paymentStatus).toBe("PENDING");

        const ledger = await prisma.webhookEvent.findFirstOrThrow({
            where: { orderId: order.orderId },
            orderBy: { receivedAt: "desc" },
            select: { processingStatus: true, processingResult: true },
        });

        expect(ledger.processingStatus).toBe("IGNORED");
        expect(ledger.processingResult).toBe("rejected_amount_mismatch");
    });

    it("R5. a callback for a reference we do not own is acknowledged and never settles", async () => {
        const type = await newCapturedType("R5");
        const { order } = await orderWithSession(type, 1, "p27f-r5");

        const signed = signCaptured(
            buildSandboxCallback({
                reference_id: `EVT-0000000000000-unknown-${SUFFIX}`,
                sid: `EVT-0000000000000-unknown-${SUFFIX}`,
                trx_id: trx("r5"),
            })
        );

        const response = await replayThroughRoute(signed);

        // 200 so the provider does not retry a callback that is not ours to process.
        expect(response.status).toBe(200);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true, paymentStatus: true },
        });

        expect(row.status).toBe("PENDING_PAYMENT");
        expect(row.paymentStatus).toBe("PENDING");
        await expect(
            prisma.paymentTransaction.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(0);
    });

    it("R6. a captured payload with the optional fields omitted still verifies and settles", async () => {
        // The provider's field set is not fully guaranteed. `additional_info` and `is_escrow`
        // are the two the normalizer defaults, so their ABSENCE must not break verification.
        const type = await newCapturedType("R6");
        const { order, payment } = await orderWithSession(type, 1, "p27f-r6");

        const signed = signCaptured(
            buildSandboxCallback({
                reference_id: payment.paymentReference,
                sid: payment.paymentReference,
                trx_id: trx("r6"),
                additional_info: null,
                is_escrow: null,
            })
        );

        const response = await replayThroughRoute(signed);

        expect(response.status).toBe(200);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true },
        });

        expect(row.status).toBe("PAID");
    });

    it("R7. an unsigned replay of the captured payload is refused at the handler seam", async () => {
        // The no-bypass assertion: the replayed payload is refused when it carries no
        // signature. There is no localhost or development exemption anywhere in the chain, so
        // the convenience of replaying a captured request never weakens the trust boundary.
        const type = await newCapturedType("R7");
        const { order, payment } = await orderWithSession(type, 1, "p27f-r7");

        const fields = buildSandboxCallback({
            reference_id: payment.paymentReference,
            sid: payment.paymentReference,
            trx_id: trx("r7"),
        });

        const unsigned = await handleGatewayWebhook({
            rawBody: new URLSearchParams(fields).toString(),
            signatureHeader: null,
            remoteIp: "127.0.0.1",
        });

        expect(unsigned.httpStatus).toBe(401);
        expect(unsigned.outcome).toBe("REJECTED_SIGNATURE");

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: order.orderNumber },
            select: { status: true },
        });

        expect(row.status).toBe("PENDING_PAYMENT");
    });
});
