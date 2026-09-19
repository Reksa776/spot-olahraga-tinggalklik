import { Prisma } from "@prisma/client";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";

import { writeTicketingAudit } from "../audit-log";
import { moneyString } from "../order-payload";
import {
    readCallback,
    verifyCallbackSignature,
    type GatewayCallback,
} from "./gateway";
import {
    buildProviderEventId,
    isTicketingReference,
    sha256,
} from "./reference";
import {
    failVerifiedPayment,
    settlementFailureOutcome,
    settleVerifiedPayment,
    type SettlementOutcome,
} from "./settlement";
import { MAX_WEBHOOK_BODY_BYTES } from "./validation";

/**
 * ==========================================
 * TICKETING PAYMENT WEBHOOK (design §31)
 * ==========================================
 *
 * The ONLY settlement trigger on the platform. Design §31.5 rule 3:
 *
 *   "The webhook is the **only** trigger for settlement and issuance. The browser redirect
 *    and the polling endpoint never mutate state."
 *
 * §31.3 fixes the ordering, and the ordering is the security property:
 *
 *   1. read the raw body (the signature covers exact bytes)
 *   2. verify the signature        → invalid  ⇒ record, return 401
 *   3. verify the amount           → mismatch ⇒ record, return 400
 *   4. INSERT the WebhookEvent     → unique violation ⇒ replay ⇒ 200 no-op
 *   5. classify the status         → unknown  ⇒ record, return 200, never mutate
 *   6. settle (one transaction)
 *   7. mark the ledger row
 *   8. return 200 (500 only for a genuine server error, so the provider retries)
 *
 * Insert-first is deliberate (§31.3): "a replay storm costs one failed insert per delivery
 * instead of a full settlement transaction, and it leaves evidence even for requests that
 * are rejected".
 *
 * ── THE REPLAY GUARD IS A DATABASE CONSTRAINT, NOT A CHECK (design §30.3) ────────
 * `WebhookEvent.providerEventId` is `@unique`. Checking "have I seen this?" and then
 * inserting is a time-of-check/time-of-use race in which two simultaneous deliveries both
 * read "not seen" and both settle; the design is explicit that the unique constraint is the
 * only correct arbiter. So the duplicate path is the `P2002` path, and it is treated as an
 * expected outcome rather than an error.
 *
 * ── ONE INTERPRETATION OF "REJECTED ROWS ARE RE-PROCESSABLE" ─────────────────────
 * A delivery can be rejected before any state change (bad signature, bad amount) and the
 * ledger row is written so the attempt is observable — §31.3 requires that, and §31.4's
 * table says a forged signature must be "visible in `/api/admin/webhooks` so an attack is
 * observable".
 *
 * That creates one hazard worth naming: the replay key is derived from data in the payload,
 * and for an UNVERIFIED payload that data is attacker-chosen. An attacker who sends a forged
 * delivery carrying a *real* future transaction id could therefore occupy the unique key and
 * make the provider's genuine delivery look like a duplicate — silently skipping settlement.
 *
 * The rule below closes that: **only a `PROCESSED` row blocks a later verified delivery.**
 * A row that was rejected or failed changed nothing, so a subsequent verified delivery with
 * the same key is processed and the row is advanced (design §31.2 permits "one forward-only
 * mutation" on the row), rather than being discarded as a duplicate. Key-squatting therefore
 * has no effect, and the observability the design wants is preserved.
 *
 * ── WHAT THIS HANDLER DELIBERATELY DOES NOT DO ───────────────────────────────────
 *   * No ticket issuance / QR — Phase 8 (design §40.11).
 *   * No PIC attribution, fee ledger or fee snapshot — Phase 9.
 *   * No refund AUTHORISATION and, since Phase 18B, no refund CONFIRMATION either. The
 *     production refund rail is a manual bank transfer (D-P17-04 = B), so no provider can
 *     be the authority on a refund: a refund is never created from an inbound notification,
 *     and it is never settled by one. A refund-shaped delivery is recorded in the ledger
 *     and acknowledged (`REFUND_MANUAL_RAIL`); the refund's own lifecycle is untouched by
 *     anything a provider can unilaterally trigger. The branch previously resolved a refund
 *     by `(order, PROCESSING)` + amount, which Phase 18A forbade — removing the rail removed
 *     the need for that guess rather than replacing it with a better one.
 *   * No notifications / WhatsApp / email — Phase 8/11.
 *   * No provider `verifyPaymentStatus` call. A server-side status poll is not a settlement
 *     trigger in §31.3's flow, and design §31.5 rule 3 makes the verified notification the
 *     authority; adding a second trigger would create a second path to `PAID`.
 */

/** The provider's namespace. Extensible per §31.2, and one provider exists today (D-17). */
const PROVIDER = "ipaymu";

export type WebhookResult = {
    httpStatus: number;
    message: string;
    /** Internal marker for tests; never returned to the provider verbatim. */
    outcome: string;
};

/** Fields recorded on every ledger row, including rejected ones. */
type LedgerInput = {
    providerEventId: string;
    providerTransactionId: string | null;
    eventType: string;
    statusCode: string | null;
    amountReported: string | null;
    payloadHash: string;
    signatureValid: boolean;
    orderId: string | null;
    paymentId: string | null;
    remoteIp: string | null;
};

/**
 * The redacted payload snapshot (§31.2: "**Redacted** snapshot (no PII beyond what is
 * needed, no secrets)").
 *
 * Only the fields needed to reconstruct *what the provider claimed about the money* are
 * kept. Buyer identifiers are dropped, the signature never appears, and no credential is
 * copied — the raw body is represented by its SHA-256 instead.
 */
function redactedPayload(callback: GatewayCallback): Prisma.InputJsonObject {
    return {
        referenceId: callback.referenceId,
        providerSessionId: callback.providerSessionId,
        providerTransactionId: callback.providerTransactionId,
        statusCode: callback.statusCode,
        verdict: callback.verdict,
        eventType: callback.eventType,
        amountReported: callback.amountReported,
        providerFeeReported: callback.providerFeeReported,
        channel: callback.channel,
    };
}

/**
 * Does this ledger row block a later verified delivery?
 *
 * Only a row that actually changed state does. See the module header for why a rejected or
 * failed row must not be able to lock out the genuine delivery.
 */
function blocksReprocessing(status: string): boolean {
    return status === "PROCESSED";
}

/**
 * Advance a ledger row, but never away from a terminal state.
 *
 * The guard (`processingStatus: { not: "PROCESSED" }`) is what makes the forward-only
 * mutation safe under concurrency: two simultaneous deliveries of the same event cannot
 * both progress the row, so only one can reach `PROCESSED`.
 */
async function advanceLedgerRow(
    id: string,
    data: {
        processingStatus: "PROCESSED" | "IGNORED" | "FAILED";
        processingResult: string | null;
        errorMessage?: string | null;
        orderId?: string | null;
        paymentId?: string | null;
    }
): Promise<boolean> {
    const updated = await prisma.webhookEvent.updateMany({
        where: { id, processingStatus: { not: "PROCESSED" } },
        data: {
            processingStatus: data.processingStatus,
            processingResult: data.processingResult,
            errorMessage: data.errorMessage ?? null,
            processedAt: new Date(),
            ...(data.orderId !== undefined ? { orderId: data.orderId } : {}),
            ...(data.paymentId !== undefined ? { paymentId: data.paymentId } : {}),
        },
    });

    return updated.count === 1;
}

/**
 * Insert the ledger row, or report that this event was already settled.
 *
 * Returns the row id when this caller owns the delivery, or `null` when a `PROCESSED` row
 * already exists for the key (the replay path).
 */
async function claimLedgerRow(
    input: LedgerInput,
    payloadJson: Prisma.InputJsonObject
): Promise<string | null> {
    try {
        const row = await prisma.webhookEvent.create({
            data: {
                provider: PROVIDER,
                providerEventId: input.providerEventId,
                providerTransactionId: input.providerTransactionId,
                eventType: input.eventType,
                statusCode: input.statusCode,
                amountReported:
                    input.amountReported === null
                        ? null
                        : new Prisma.Decimal(input.amountReported),
                payloadHash: input.payloadHash,
                payloadJson,
                signatureValid: input.signatureValid,
                orderId: input.orderId,
                paymentId: input.paymentId,
                processingStatus: "RECEIVED",
                remoteIp: input.remoteIp,
            },
            select: { id: true },
        });

        return row.id;
    } catch (error) {
        if (!isUniqueViolation(error)) {
            throw error;
        }

        const existing = await prisma.webhookEvent.findUnique({
            where: { providerEventId: input.providerEventId },
            select: { id: true, processingStatus: true },
        });

        if (!existing) {
            // The winner's row vanished between the failed insert and this read (only
            // possible if something deleted it, which nothing does). Treating it as a
            // duplicate would be wrong, so surface it.
            throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
                message: "Ledger webhook tidak konsisten.",
            });
        }

        if (blocksReprocessing(existing.processingStatus)) {
            return null;
        }

        // A rejected or failed attempt with this key. It changed nothing, so this verified
        // delivery is allowed to proceed on the existing row (see the module header).
        return existing.id;
    }
}

function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2002"
    );
}

/**
 * Resolve the ticketing order a verified notification refers to.
 *
 * The lookup is by the UNIQUE `Payment.paymentReference` that we ourselves sent as the
 * provider's `referenceId` (design §13.2), not by parsing an order number out of the
 * payload. Consequences that matter:
 *
 *   * A retail order can never be settled from here. Retail references are `PAY-…` and are
 *     never `Payment.paymentReference` values, so the lookup simply finds nothing — which is
 *     design §35.7's "the two order models cannot cross-settle" control, enforced by
 *     construction rather than by a naming convention.
 *   * An unknown reference is an `IGNORED` row and a 200, never a 500: a non-ticketing
 *     callback must not make the provider retry forever.
 *
 * The `EVT-` check is a second, belt-and-braces guard on the resolved order, so that even a
 * mis-registered payment row cannot settle outside the ticketing namespace.
 */
async function resolveTicketingTarget(referenceId: string | null): Promise<
    | {
          ok: true;
          paymentId: string;
          orderId: string;
          orderNumber: string;
          organizerId: string;
          total: Prisma.Decimal;
      }
    | { ok: false; reason: string }
> {
    if (!referenceId) {
        return { ok: false, reason: "REFERENCE_MISSING" };
    }

    const payment = await prisma.payment.findUnique({
        where: { paymentReference: referenceId },
        select: {
            id: true,
            orderId: true,
            order: {
                select: {
                    id: true,
                    orderNumber: true,
                    organizerId: true,
                    total: true,
                },
            },
        },
    });

    if (!payment) {
        return { ok: false, reason: "REFERENCE_UNKNOWN" };
    }

    if (!isTicketingReference(payment.order.orderNumber)) {
        return { ok: false, reason: "NOT_TICKETING_NAMESPACE" };
    }

    return {
        ok: true,
        paymentId: payment.id,
        orderId: payment.order.id,
        orderNumber: payment.order.orderNumber,
        organizerId: payment.order.organizerId,
        total: payment.order.total,
    };
}

/**
 * Compare the provider's reported amount against the authoritative order total.
 *
 * Two behaviors are preserved from the live handler on purpose:
 *
 *   1. **`sub_total` is preferred over `amount`** (design §13.0's table: "Amount
 *      verification (prefers `sub_total` over `amount`) | Yes — retargeted to
 *      `EventOrder.total`"). §31.6 item 5 warns that a retarget which drops this
 *      "will fail intermittently", because `amount`/`total` may include a provider fee
 *      that the order total legitimately does not.
 *   2. **An absent amount is not treated as a mismatch.** The live handler only compares
 *      when the field is present, and §31.6 records that the provider's field set is not
 *      sandbox-verified. Rejecting an amount-less notification would risk discarding every
 *      legitimate settlement on an unverified assumption.
 *
 * The comparison itself is upgraded from the legacy `Number(...) !== expected` to a
 * `Prisma.Decimal` equality, so it is float-free: brief §16 bans the
 * `Decimal → Number → arithmetic` round trip for money, and this is a money comparison.
 *
 * The safety that makes absence tolerable is that the signature is cryptographically
 * verified FIRST and the reference must resolve to OUR OWN `Payment` row — so this check is
 * corroboration against provider error, not the primary control. Flagged as a residual
 * verification item in the report.
 */
function amountVerdict(
    callback: GatewayCallback,
    orderTotal: Prisma.Decimal
): "MATCH" | "ABSENT" | "MISMATCH" {
    if (callback.amountReported === null) {
        return "ABSENT";
    }

    try {
        return new Prisma.Decimal(callback.amountReported).equals(orderTotal)
            ? "MATCH"
            : "MISMATCH";
    } catch {
        return "MISMATCH";
    }
}

/**
 * Handle one provider delivery.
 *
 * Deliberately takes the raw body and the signature header rather than a `NextRequest`:
 * the whole ordering and every branch is then testable without standing up Next.js, which
 * is what lets the replay, rejection and race cases be covered as real integration tests
 * against the database.
 */
export async function handleGatewayWebhook(params: {
    rawBody: string;
    signatureHeader: string | null;
    remoteIp: string | null;
}): Promise<WebhookResult> {
    const { rawBody, signatureHeader, remoteIp } = params;

    // ── 1. Bound the body before doing any work on it ────────────────────────────
    // This endpoint is the one ticketing surface an anonymous caller may post to.
    if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
        return {
            httpStatus: 413,
            message: "Payload terlalu besar.",
            outcome: "BODY_TOO_LARGE",
        };
    }

    // ── 2. Signature, fail-closed (design §31.5 rules 1 and 2) ───────────────────
    const verification = verifyCallbackSignature(rawBody, signatureHeader);

    if (!verification.ok) {
        // Record the delivery so an attack is observable (§31.4), then refuse. The key is
        // derived from the UNVERIFIED payload, which is safe because only a PROCESSED row
        // blocks a later verified delivery (see the module header).
        await recordRejectedDelivery({
            rawBody,
            remoteIp,
            signatureValid: false,
            processingResult: `rejected_signature_${verification.reason.toLowerCase()}`,
        });

        if (
            verification.reason === "MISSING_SIGNATURE" ||
            verification.reason === "INVALID_SIGNATURE"
        ) {
            return {
                httpStatus: 401,
                message: "Signature tidak valid.",
                outcome: "REJECTED_SIGNATURE",
            };
        }

        // A server that cannot verify anything must fail loudly rather than pretend the
        // delivery was refused on its merits (§31.5 rule 2: "missing configuration ... ⇒
        // 401/500, never a fall-through to processing").
        return {
            httpStatus: 500,
            message: "Konfigurasi pembayaran tidak lengkap.",
            outcome: "NOT_CONFIGURED",
        };
    }

    // ── 3. Interpret the verified notification ───────────────────────────────────
    const callback = readCallback(rawBody);
    const payloadHash = sha256(rawBody);
    const providerEventId = buildProviderEventId({
        provider: PROVIDER,
        providerTransactionId: callback.providerTransactionId,
        eventType: callback.eventType,
        rawBody,
    });

    const target = await resolveTicketingTarget(callback.referenceId);

    if (!target.ok) {
        // Recorded with the reason, acknowledged with 200 so the provider does not retry a
        // callback that is not ours to process.
        const ledgerId = await claimLedgerRow(
            {
                providerEventId,
                providerTransactionId: callback.providerTransactionId,
                eventType: callback.eventType,
                statusCode: callback.statusCode,
                amountReported: callback.amountReported,
                payloadHash,
                signatureValid: true,
                orderId: null,
                paymentId: null,
                remoteIp,
            },
            redactedPayload(callback)
        );

        if (ledgerId !== null) {
            await advanceLedgerRow(ledgerId, {
                processingStatus: "IGNORED",
                processingResult: `ignored_${target.reason.toLowerCase()}`,
            });
        }

        return {
            httpStatus: 200,
            message: "Notifikasi diabaikan.",
            outcome: target.reason,
        };
    }

    // ── 4. Amount (design §13.3 step 3) ──────────────────────────────────────────
    // A refund callback legitimately reports less than the order total (a partial refund),
    // so the order-total comparison only applies to payment notifications. The refund's own
    // amount is validated against the in-flight refund by `confirmInboundRefund`, which is
    // the only amount that is meaningful for a refund (D-R09).
    const verdict = callback.isRefund
        ? "MATCH"
        : amountVerdict(callback, target.total);

    if (verdict === "MISMATCH") {
        const ledgerId = await claimLedgerRow(
            {
                providerEventId,
                providerTransactionId: callback.providerTransactionId,
                eventType: callback.eventType,
                statusCode: callback.statusCode,
                amountReported: callback.amountReported,
                payloadHash,
                signatureValid: true,
                orderId: target.orderId,
                paymentId: target.paymentId,
                remoteIp,
            },
            redactedPayload(callback)
        );

        if (ledgerId !== null) {
            await advanceLedgerRow(ledgerId, {
                processingStatus: "IGNORED",
                processingResult: "rejected_amount_mismatch",
            });
        }

        // 400 with NO state change, exactly as §31.3 step 3 requires.
        throw new AppError(ERROR_CODES.INVALID_WEBHOOK, {
            message: "Jumlah pembayaran tidak sesuai.",
            details: { reason: "AMOUNT_MISMATCH", orderNumber: target.orderNumber },
        });
    }

    // ── 5. Claim the ledger row (replay guard) ───────────────────────────────────
    const payloadJson = redactedPayload(callback);

    const ledgerId = await claimLedgerRow(
        {
            providerEventId,
            providerTransactionId: callback.providerTransactionId,
            eventType: callback.eventType,
            statusCode: callback.statusCode,
            amountReported: callback.amountReported,
            payloadHash,
            signatureValid: true,
            orderId: target.orderId,
            paymentId: target.paymentId,
            remoteIp,
        },
        payloadJson
    );

    if (ledgerId === null) {
        // Already settled. §31.3: "unique violation ⇒ IGNORED_DUPLICATE ⇒ return 200 (no
        // mutation)". Nothing is written and nothing is mutated.
        return {
            httpStatus: 200,
            message: "Notifikasi sudah diproses sebelumnya.",
            outcome: "DUPLICATE",
        };
    }

    // ── 6. Classify and act (design §31.3 step 5) ────────────────────────────────
    if (callback.isRefund) {
        return applyRefundOutcome(ledgerId);
    }

    if (callback.verdict === "UNKNOWN") {
        // Acknowledged and never mutating. Design §31.5 rule 6: "Unknown statuses are
        // acknowledged and never mutate."
        await advanceLedgerRow(ledgerId, {
            processingStatus: "IGNORED",
            processingResult: "ignored_unknown_status",
        });

        return {
            httpStatus: 200,
            message: "Status tidak dikenali; tidak ada perubahan.",
            outcome: "UNKNOWN",
        };
    }

    if (callback.verdict === "PENDING") {
        // Informational. The `UNPAID → PENDING` transition belongs to the session-creation
        // path (design §13.4), which has already recorded it; a pending notification must
        // not mutate anything, so it is acknowledged and recorded only.
        await advanceLedgerRow(ledgerId, {
            processingStatus: "IGNORED",
            processingResult: "ignored_pending_acknowledged",
        });

        return {
            httpStatus: 200,
            message: "Pembayaran masih menunggu.",
            outcome: "PENDING",
        };
    }

    // ── 7. Settlement (design §13.3 steps 4-6) ───────────────────────────────────
    const settlement: SettlementOutcome =
        callback.verdict === "FAILED"
            ? await failVerifiedPayment({
                  orderId: target.orderId,
                  paymentId: target.paymentId,
                  orderNumber: target.orderNumber,
                  organizerId: target.organizerId,
                  providerFeeReported: callback.providerFeeReported,
                  statusCode: callback.statusCode,
                  channel: callback.channel,
                  eventType: callback.eventType,
              })
            : await settleOutcomeSafe(target, callback);

    return applySettlementOutcome(ledgerId, settlement, callback);
}

/**
 * Record a refund-shaped notification and never act on it (Phase 18B, D-P17-04 = B).
 *
 * ── WHY NOTHING IS SETTLED FROM HERE ─────────────────────────────────────────────
 * The production refund rail is a MANUAL BANK TRANSFER. There is no outbound refund for a
 * provider to acknowledge, so a refund callback carries no authoritative fact about our
 * money — and the one thing this branch used to do (resolve the in-flight refund by
 * `(orderId, amount)` and settle it) is exactly the identification Phase 18A forbade.
 *
 * The delivery is still recorded, because an unexpected refund notification is evidence
 * somebody must be able to see, and it is still acknowledged with 200 so the provider does
 * not retry a callback that can never be actioned. The security boundary in front of this
 * branch is untouched: the body bound, the timing-safe signature verification and the
 * replay ledger all still run before it (see `handleGatewayWebhook`).
 *
 * Refund state can therefore only be advanced by an authenticated operator through
 * `executeRefund` / `settleRefund` / `failRefund`.
 */
async function applyRefundOutcome(ledgerId: string): Promise<WebhookResult> {
    await advanceLedgerRow(ledgerId, {
        processingStatus: "IGNORED",
        processingResult: "ignored_refund_rail_is_manual",
        errorMessage:
            "refund notifications cannot settle a refund: the production rail is a manual bank transfer",
    });

    return {
        httpStatus: 200,
        message: "Notifikasi refund dicatat; refund diproses manual oleh operator.",
        outcome: "REFUND_MANUAL_RAIL",
    };
}

/**
 * Run the settlement and convert an integrity failure into an outcome.
 *
 * The transaction itself rolls back on any throw, so the only thing left to do is describe
 * what happened.
 */
async function settleOutcomeSafe(
    target: {
        paymentId: string;
        orderId: string;
        orderNumber: string;
        organizerId: string;
    },
    callback: GatewayCallback
): Promise<SettlementOutcome> {
    try {
        return await settleVerifiedPayment({
            orderId: target.orderId,
            paymentId: target.paymentId,
            provider: PROVIDER,
            providerTransactionId: callback.providerTransactionId,
            providerSessionId: callback.providerSessionId,
            amountReported: callback.amountReported,
            providerFeeReported: callback.providerFeeReported,
            statusCode: callback.statusCode,
            channel: callback.channel,
            eventType: callback.eventType,
        });
    } catch (error) {
        return settlementFailureOutcome({
            error,
            orderNumber: target.orderNumber,
            organizerId: target.organizerId,
        });
    }
}

/** Turn a settlement outcome into the ledger row's final state and the HTTP answer. */
async function applySettlementOutcome(
    ledgerId: string,
    settlement: SettlementOutcome,
    callback: GatewayCallback
): Promise<WebhookResult> {
    switch (settlement.outcome) {
        case "SETTLED":
            await advanceLedgerRow(ledgerId, {
                processingStatus: "PROCESSED",
                processingResult:
                    settlement.anomalies.length > 0
                        ? "settled_with_inventory_anomaly"
                        : "settled",
                errorMessage:
                    settlement.anomalies.length > 0
                        ? settlement.anomalies.join("; ")
                        : null,
            });

            return {
                httpStatus: 200,
                message:
                    settlement.anomalies.length > 0
                        ? "Pembayaran diterima; rekonsiliasi kursi perlu diperiksa."
                        : "Pembayaran berhasil diselesaikan.",
                outcome: "SETTLED",
            };

        case "ALREADY_PAID":
            // A different provider event for an order that is already settled. §31.4:
            // "Order CAS rejects (affectedRows = 0) because the order is already PAID; the
            // row records a settlement attempt that changed nothing."
            await advanceLedgerRow(ledgerId, {
                processingStatus: "IGNORED",
                processingResult: "ignored_order_already_paid",
            });

            return {
                httpStatus: 200,
                message: "Pesanan sudah dibayar; tidak ada perubahan.",
                outcome: "ALREADY_PAID",
            };

        case "ORDER_FAILED":
            // Design §13.4: the provider reported a failure, the seats were released and the
            // order was cancelled. PROCESSED because state genuinely changed and the event
            // must not be replayed.
            await advanceLedgerRow(ledgerId, {
                processingStatus: "PROCESSED",
                processingResult: "payment_failed_order_cancelled",
            });

            return {
                httpStatus: 200,
                message: "Pembayaran gagal; pesanan dibatalkan.",
                outcome: "ORDER_FAILED",
            };

        case "LATE_SETTLEMENT":
            // Money received for a terminal order. Recorded, fulfilment blocked, and — the
            // part that matters for the invariants — NO inventory moved.
            await advanceLedgerRow(ledgerId, {
                processingStatus: "PROCESSED",
                processingResult: "late_settlement_operator_alert",
                errorMessage: `verified payment for a ${settlement.orderStatus} order; no ticket issued`,
            });

            return {
                httpStatus: 200,
                message: "Pembayaran diterima setelah pesanan final; perlu tindak lanjut.",
                outcome: "LATE_SETTLEMENT",
            };

        case "NOT_APPLICABLE":
            await advanceLedgerRow(ledgerId, {
                processingStatus: "IGNORED",
                processingResult: "ignored_order_not_payable",
            });

            return {
                httpStatus: 200,
                message: "Pesanan tidak dalam status yang dapat dibayar.",
                outcome: "NOT_APPLICABLE",
            };

        case "RETRY_LATER":
            await advanceLedgerRow(ledgerId, {
                processingStatus: "FAILED",
                processingResult: `failed_${settlement.reason.toLowerCase()}`,
                errorMessage: settlement.detail ?? null,
            });

            // 500 so the provider retries. The row is FAILED rather than PROCESSED, so a
            // later delivery with the same key is re-processable rather than treated as a
            // duplicate — which is what makes the retry able to succeed once the underlying
            // problem is gone.
            return {
                httpStatus: 500,
                message: "Gagal memproses pembayaran.",
                outcome: settlement.reason,
            };

        default:
            return {
                httpStatus: 200,
                message: `Status ${callback.verdict} diterima.`,
                outcome: "NOOP",
            };
    }
}

/**
 * Record a delivery whose signature failed verification.
 *
 * The row's `signatureValid` is `false`, which is what the verifiable-everything policy
 * requires for an attack to be visible (design §31.4). Nothing is resolved and nothing is
 * mutated — and because only a `PROCESSED` row blocks a later verified delivery, this row
 * cannot be used to lock out the genuine event.
 */
async function recordRejectedDelivery(params: {
    rawBody: string;
    remoteIp: string | null;
    signatureValid: boolean;
    processingResult: string;
}): Promise<void> {
    // The payload is unverified, so it is only parsed for the two fields that make the row
    // identifiable. Nothing from it is trusted, and nothing is acted upon.
    const params2 = new URLSearchParams(params.rawBody);
    const transactionId = params2.get("trx_id");
    const eventType = "unknown";

    const providerEventId = buildProviderEventId({
        provider: PROVIDER,
        providerTransactionId: transactionId,
        eventType,
        rawBody: params.rawBody,
    });

    let ledgerId: string | null = null;

    try {
        ledgerId = await claimLedgerRow(
            {
                providerEventId,
                providerTransactionId: transactionId,
                eventType,
                statusCode: params2.get("status_code"),
                amountReported: null,
                payloadHash: sha256(params.rawBody),
                signatureValid: params.signatureValid,
                orderId: null,
                paymentId: null,
                remoteIp: params.remoteIp,
            },
            // Never the raw body: it is attacker-controlled and may contain anything.
            { rejected: true }
        );
    } catch (error) {
        // The ledger must not turn a rejection into a 500 that invites a retry storm.
        console.error("TICKETING_WEBHOOK_LEDGER_ERROR:", error);
        return;
    }

    if (ledgerId !== null) {
        await advanceLedgerRow(ledgerId, {
            processingStatus: "IGNORED",
            processingResult: params.processingResult,
        });
    }
}

/**
 * The buyer-facing truth about a payment, for the polling read surface.
 *
 * Design §26.7's polling endpoint is "**Display-only**: it reports `paymentStatus` and never
 * changes it, and it is explicitly documented as not being an issuance trigger (the webhook
 * is). If it ever returned 'paid' derived from anything other than the order row, it would
 * become a forgery vector."
 *
 * This function therefore reads the ORDER's own columns and nothing else. It cannot be
 * influenced by a query parameter or a browser redirect (brief §22), and it exposes no
 * provider internals.
 */
export async function readPaymentState(orderId: string): Promise<{
    orderStatus: string;
    paymentStatus: string;
    paidAt: string | null;
    amount: string;
    currency: string;
    paymentUrl: string | null;
    paymentReference: string | null;
    method: string | null;
    channel: string | null;
    expiresAt: string | null;
}> {
    const order = await prisma.eventOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: {
            status: true,
            paymentStatus: true,
            paidAt: true,
            total: true,
            currency: true,
            expiresAt: true,
            payments: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                    status: true,
                    paymentUrl: true,
                    paymentReference: true,
                    method: true,
                    channel: true,
                    expiresAt: true,
                },
            },
        },
    });

    const payment = order.payments[0] ?? null;

    return {
        orderStatus: order.status,
        paymentStatus: order.paymentStatus,
        paidAt: order.paidAt?.toISOString() ?? null,
        amount: moneyString(order.total),
        currency: order.currency,
        // Only a session that can actually be paid is advertised (brief §20).
        paymentUrl:
            payment && payment.status === "PENDING" ? payment.paymentUrl : null,
        paymentReference: payment?.paymentReference ?? null,
        method: payment?.method ?? null,
        channel: payment?.channel ?? null,
        expiresAt: (payment?.expiresAt ?? order.expiresAt)?.toISOString() ?? null,
    };
}

/** Exported for the static guards: the settlement trigger must stay webhook-only. */
export const __internals = {
    redactedPayload,
    blocksReprocessing,
    amountVerdict,
    resolveTicketingTarget,
    writeTicketingAudit,
};
