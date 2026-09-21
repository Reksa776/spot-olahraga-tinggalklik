import { Prisma } from "@prisma/client";

import { AppError } from "@/lib/api/errors";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import { requireOrganizerAccess } from "@/lib/authz/guards";
import { prisma } from "@/lib/prisma";

import { writeTicketingAudit } from "../audit-log";
import {
    isGatewaySuccessStatus,
    providerMethodMatches,
    queryTransactionStatus,
    type GatewayTransactionStatus,
} from "./gateway";
import { settleVerifiedPayment } from "./settlement";

/**
 * ==========================================
 * OPERATOR PAYMENT RECONCILIATION (Phase 27E)
 * ==========================================
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * A payment can be PAID at the provider while this platform still believes it is unpaid,
 * and the reason is outside our own semantics: the provider notifies by CALLING BACK A URL.
 * Phase 27B proved the failure mode on a real sandbox payment — the notify URL handed to
 * iPaymu was `http://localhost:3000/…`, iPaymu posts server-to-server, so the callback was
 * refused before any HTTP exchange happened. Money moved; no webhook ever arrived; no
 * ledger row, no settlement, no tickets.
 *
 * The webhook stays the ONLY automatic settlement authority. This module adds the one thing
 * the webhook cannot provide: a HUMAN-OPERATED way to ask the provider what it actually did
 * out of band — and then to feed that answer into the SAME settlement transaction the
 * webhook feeds.
 *
 * ── WHAT MAKES THIS SAFE ────────────────────────────────────────────────────────
 *
 * 1. **No client-supplied financial values.** The request body carries nothing at all. The
 *    reference comes from the URL, the tenant from the `Payment` row, the transaction id
 *    from `Payment.providerTransactionId` (written from a provider response at creation),
 *    the amount from the provider's own answer, and the actor from the session. There is
 *    deliberately no `transactionId`, `amount` or `status` input: any of them would let a
 *    caller point the query at another party's transaction or assert a paid state.
 *
 * 2. **No second settlement engine.** A verified verdict is handed to
 *    `settleVerifiedPayment()` unchanged. Its order CAS is still the arbiter, so a webhook
 *    and a reconciliation arriving together produce ONE settlement — the same guarantee
 *    that already protects two webhooks. Nothing here writes `Payment.status`,
 *    `EventOrder.status`, a counter, or a `PaymentTransaction`.
 *
 * 3. **Evidence must be complete and must AGREE.** The provider's answer has to carry a
 *    transaction id, a numeric status and an amount, and then: the id equals the one we
 *    persisted, the environment equals the payment's snapshot, the echoed reference is our
 *    own, the amount equals `Payment.amount` AND `EventOrder.total` exactly, and the method
 *    maps to the method on the row. The first failure BLOCKS with zero writes.
 *
 * 4. **Terminal orders are not decided here.** `D-P19-04` (money arriving on a cancelled or
 *    expired order) is undecided, so reconciliation REFUSES a terminal order instead of
 *    settling it. The webhook keeps its existing late-settlement behaviour — that branch
 *    records something that already happened — but an operator pressing a button would be
 *    making the decision, and it has not been made.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────────
 * No "mark as paid" control. No operator-entered amount or transaction id. No settling from
 * a redirect/return state. No `verifyPaymentStatus`-style guesswork — that client was wrong
 * on endpoint, identifier and success predicate and has been deleted.
 */

/* ==========================================
 * RESULT VOCABULARY
 * ========================================== */

/** Why reconciliation refused to settle. Every one of these means ZERO financial writes. */
export type ReconciliationBlockReason =
    /** No provider transaction id was ever recorded for this payment. */
    | "PROVIDER_TRANSACTION_ID_MISSING"
    /** The payment row is not in a state reconciliation may act on. */
    | "PAYMENT_STATE_INVALID"
    /** The ORDER is cancelled/expired — `D-P19-04`, deliberately undecided. */
    | "TERMINAL_ORDER"
    /** The order became terminal while this request was in flight. */
    | "ORDER_BECAME_TERMINAL"
    /** The order/payment moved for another reason before settlement could commit. */
    | "STATE_CHANGED"
    /** The provider answered about a DIFFERENT transaction. */
    | "TRANSACTION_ID_MISMATCH"
    /** The provider's own reference is not the reference we sent. */
    | "REFERENCE_MISMATCH"
    /** Credentials answered from a different environment than the payment's snapshot. */
    | "ENVIRONMENT_MISMATCH"
    /** The provider describes a different instrument than the payment row. */
    | "METHOD_MISMATCH"
    /** Provider amount ≠ `Payment.amount`, or ≠ `EventOrder.total`. */
    | "AMOUNT_MISMATCH";

/** Why we could not obtain usable evidence, or could not complete settlement. Retryable. */
export type ReconciliationErrorReason =
    | "NOT_CONFIGURED"
    | "TRANSPORT_ERROR"
    | "HTTP_ERROR"
    | "NOT_SUCCESS_ENVELOPE"
    | "MALFORMED"
    | "SETTLEMENT_CONTENTION"
    | "SETTLEMENT_INTEGRITY";

/** What the provider said. Safe to show an operator: no secret, no PII. */
export type ReconciliationProviderEvidence = {
    transactionId: string;
    status: number;
    statusDescription: string | null;
    /** Whole rupiah, exactly as the provider reported it. */
    amount: number;
    environment: string;
    /** Provider HTTP status. Diagnostics only. */
    httpStatus: number;
};

type ReconciliationBase = {
    paymentReference: string;
    orderNumber: string;
    /** Safe Indonesian sentence the operator UI renders verbatim. */
    message: string;
    /** Present whenever the provider actually answered. */
    provider: ReconciliationProviderEvidence | null;
};

export type ReconciliationResult =
    | (ReconciliationBase & {
          result: "RECONCILED";
          settlement: {
              seatsSold: number;
              reservationsConverted: number;
              anomalies: string[];
          };
      })
    | (ReconciliationBase & { result: "ALREADY_SETTLED" })
    | (ReconciliationBase & { result: "PENDING_PROVIDER" })
    | (ReconciliationBase & {
          result: "BLOCKED";
          reason: ReconciliationBlockReason;
      })
    | (ReconciliationBase & {
          result: "PROVIDER_ERROR";
          reason: ReconciliationErrorReason;
      });

const MESSAGES = {
    RECONCILED: "Pembayaran berhasil diverifikasi dan diselesaikan.",
    ALREADY_SETTLED: "Pembayaran sudah diselesaikan.",
    PENDING_PROVIDER: "Provider belum menyatakan pembayaran berhasil.",
    BLOCKED_EVIDENCE:
        "Verifikasi belum dapat dilakukan karena bukti provider tidak lengkap.",
    BLOCKED_MISMATCH:
        "Bukti dari provider tidak cocok dengan data pembayaran ini. Tidak ada perubahan yang dilakukan.",
    BLOCKED_STATE: "Status pembayaran saat ini tidak dapat direkonsiliasi.",
    BLOCKED_TERMINAL:
        "Pesanan sudah dibatalkan atau kedaluwarsa, sehingga tidak diselesaikan otomatis. Pembayaran yang masuk perlu ditangani secara manual.",
    PROVIDER_ERROR: "Provider tidak dapat dihubungi. Silakan coba lagi.",
} as const;

/** Reasons whose operator-facing sentence is the generic "evidence does not match" one. */
const MISMATCH_REASONS: ReadonlySet<ReconciliationBlockReason> = new Set([
    "TRANSACTION_ID_MISMATCH",
    "REFERENCE_MISMATCH",
    "ENVIRONMENT_MISMATCH",
    "METHOD_MISMATCH",
    "AMOUNT_MISMATCH",
]);

function blockedMessage(reason: ReconciliationBlockReason): string {
    if (reason === "PROVIDER_TRANSACTION_ID_MISSING") {
        return MESSAGES.BLOCKED_EVIDENCE;
    }

    if (reason === "TERMINAL_ORDER" || reason === "ORDER_BECAME_TERMINAL") {
        return MESSAGES.BLOCKED_TERMINAL;
    }

    return MISMATCH_REASONS.has(reason)
        ? MESSAGES.BLOCKED_MISMATCH
        : MESSAGES.BLOCKED_STATE;
}

/**
 * `PaymentStatus` values reconciliation may act on.
 *
 * `UNPAID` is included because the row is briefly in that state while the provider
 * instruction is being written; it can never reach a settlement anyway (the transaction-id
 * check stops it) but classifying it as an invalid state would report the wrong reason.
 * Every terminal value is deliberately absent and is classified explicitly below, so a
 * `FAILED` / `EXPIRED` / `REFUNDED` row can never be quietly reconciled.
 */
const RECONCILABLE_PAYMENT_STATUSES: readonly string[] = ["PENDING", "UNPAID"];

/** Order statuses reconciliation refuses, because settling them is decision `D-P19-04`. */
const TERMINAL_ORDER_STATUSES: readonly string[] = ["CANCELLED", "EXPIRED"];

/* ==========================================
 * THE SERVICE
 * ========================================== */

const RECONCILIATION_SELECT = {
    id: true,
    organizerId: true,
    provider: true,
    providerEnvironment: true,
    providerTransactionId: true,
    externalSessionId: true,
    paymentReference: true,
    method: true,
    channel: true,
    amount: true,
    status: true,
    order: {
        select: {
            id: true,
            orderNumber: true,
            status: true,
            paymentStatus: true,
            total: true,
        },
    },
} satisfies Prisma.PaymentSelect;

type ReconciliationPayment = Prisma.PaymentGetPayload<{
    select: typeof RECONCILIATION_SELECT;
}>;

/**
 * Verify one payment against the provider and settle it if, and only if, the provider's own
 * answer proves it was paid.
 *
 * @param scope The authenticated actor (from `requireAuth()` at the route boundary).
 * @param paymentReference The reference from the URL — the ONLY caller-supplied value.
 * @param options.request Used for `ipAddress` / `userAgent` on the audit row.
 *
 * @throws AppError NOT_FOUND when the reference is unknown. A payment in another tenant is
 *         refused by the authorization layer, which answers 404 for a cross-tenant
 *         identifier rather than confirming it exists (design §7.4) — so "unknown
 *         reference" and "wrong tenant" are indistinguishable to the caller.
 */
export async function reconcilePayment(
    scope: AuthzScope,
    paymentReference: string,
    options: { request?: Request } = {}
): Promise<ReconciliationResult> {
    const payment = await prisma.payment.findUnique({
        where: { paymentReference },
        select: RECONCILIATION_SELECT,
    });

    if (!payment) {
        throw AppError.notFound("Pembayaran tidak ditemukan.");
    }

    // ── Tenant authorization, resolved from the RECORD, never from the request ────
    // The capability the design assigns to reconciliation, enforced where every other
    // organizer route enforces it, so a cross-tenant identifier is denied exactly as it is
    // elsewhere rather than by a second, possibly weaker policy.
    await requireOrganizerAccess(payment.organizerId, PERMISSIONS.PAYMENT_RECONCILE);

    const result = await decideReconciliation(payment);

    /*
     * The audit write happens for EVERY verdict, including — especially — "no" and "cannot
     * tell". The operator's ASK is the auditable event; a reconciliation that silently did
     * nothing is exactly what an incident review needs to see. Durability follows the
     * existing logger (`writeTicketingAudit` is fire-and-forget, matching every other
     * ticketing action); the money movement this may trigger is separately recorded by the
     * settlement engine's own append-only `PaymentTransaction`.
     */
    await writeTicketingAudit({
        action: "payment.reconcile",
        actor: scope,
        actorOrganizerId: payment.organizerId,
        organizerId: payment.organizerId,
        entityType: "Payment",
        entityRef: payment.id,
        description: auditDescription(result),
        afterState: auditState(payment, result),
        request: options.request,
    });

    return result;
}

/** The verdict engine. Pure with respect to input — the only side effect is settlement. */
async function decideReconciliation(
    payment: ReconciliationPayment
): Promise<ReconciliationResult> {
    const base = {
        paymentReference: payment.paymentReference,
        orderNumber: payment.order.orderNumber,
    };

    const withoutEvidence = (
        result: "BLOCKED",
        reason: ReconciliationBlockReason
    ): ReconciliationResult => ({
        ...base,
        result,
        reason,
        message: blockedMessage(reason),
        provider: null,
    });

    // ── 1. Already settled? Idempotent no-op, before the provider is even called ───
    if (payment.status === "PAID" || payment.order.paymentStatus === "PAID") {
        return {
            ...base,
            result: "ALREADY_SETTLED",
            message: MESSAGES.ALREADY_SETTLED,
            provider: null,
        };
    }

    // ── 2. Is there anything here to reconcile? ───────────────────────────────────
    if (!RECONCILABLE_PAYMENT_STATUSES.includes(payment.status)) {
        return withoutEvidence("BLOCKED", "PAYMENT_STATE_INVALID");
    }

    // ── 3. `D-P19-04` IS NOT DECIDED BY A BUTTON ──────────────────────────────────
    if (TERMINAL_ORDER_STATUSES.includes(payment.order.status)) {
        return withoutEvidence("BLOCKED", "TERMINAL_ORDER");
    }

    if (payment.order.status !== "PENDING_PAYMENT") {
        return withoutEvidence("BLOCKED", "STATE_CHANGED");
    }

    // ── 4. The transaction id comes from OUR ROW, never from the caller ───────────
    if (!payment.providerTransactionId) {
        return withoutEvidence("BLOCKED", "PROVIDER_TRANSACTION_ID_MISSING");
    }

    // ── 5. Ask the provider ──────────────────────────────────────────────────────
    const query = await queryTransactionStatus(payment.providerTransactionId);

    if (!query.ok) {
        return {
            ...base,
            result: "PROVIDER_ERROR",
            reason: query.reason,
            message: MESSAGES.PROVIDER_ERROR,
            provider: null,
        };
    }

    const status: GatewayTransactionStatus = query.status;
    const evidence: ReconciliationProviderEvidence = {
        transactionId: status.transactionId,
        status: status.status,
        statusDescription: status.statusDescription ?? null,
        amount: status.amount,
        environment: status.environment,
        httpStatus: status.httpStatus,
    };

    const withEvidence = { ...base, provider: evidence };

    const refused = (
        reason: ReconciliationBlockReason
    ): ReconciliationResult => ({
        ...withEvidence,
        result: "BLOCKED",
        reason,
        message: blockedMessage(reason),
    });

    // ── 6. Identity: the answer must be about the transaction we asked about ──────
    // Both sides are strings by now (`TransactionId` arrives as a JSON number and is
    // normalised at the seam), so this is equality, not coercion.
    if (status.transactionId !== payment.providerTransactionId) {
        return refused("TRANSACTION_ID_MISMATCH");
    }

    // ── 7. Environment: the credentials that answered must be the payment's ───────
    if (
        status.environment.toLowerCase() !==
        payment.providerEnvironment.toLowerCase()
    ) {
        return refused("ENVIRONMENT_MISMATCH");
    }

    // ── 8. Reference corroboration (when the provider echoes one) ─────────────────
    // Weak evidence on its own — the id above is the identity — but a response whose own
    // reference disagrees with the reference we sent is contradictory, so it blocks.
    const echoedReferences = [status.referenceId, status.sessionId].filter(
        (value): value is string => typeof value === "string" && value !== ""
    );

    if (
        echoedReferences.length > 0 &&
        !echoedReferences.includes(payment.paymentReference)
    ) {
        return refused("REFERENCE_MISMATCH");
    }

    // ── 9. Instrument: a different method is a different payment ─────────────────
    if (
        !providerMethodMatches(
            status.paymentMethod,
            status.paymentChannel,
            payment.method
        )
    ) {
        return refused("METHOD_MISMATCH");
    }

    // ── 10. AMOUNT — the money gate, exact on both sides ─────────────────────────
    // Compared as decimals, never floats: `new Prisma.Decimal("15000")` equals
    // `Decimal("15000.00")`, so the provider's integer and our persisted scale agree
    // without a rounding rule. Against BOTH the payment row and the order total, because
    // `EventOrder.total` is what settlement treats as the money authority — a provider
    // amount matching one but not the other means those two rows disagree with each other,
    // and then nothing may move.
    const providerAmount = new Prisma.Decimal(status.amount);

    if (
        !providerAmount.equals(payment.amount) ||
        !providerAmount.equals(payment.order.total)
    ) {
        return refused("AMOUNT_MISMATCH");
    }

    // ── 11. Success predicate — the provider's own rule, taken from the seam ──────
    // Not `Success: true`, not `PaidStatus: "paid"`: the numeric status. A non-success
    // answer is a NO-OP — no settlement, no local status change, and the order stays
    // payable under its own reservation clock. We deliberately do not invent a local
    // "failed" transition from a code table that was never verified.
    if (!isGatewaySuccessStatus(status.status)) {
        return {
            ...withEvidence,
            result: "PENDING_PROVIDER",
            message: MESSAGES.PENDING_PROVIDER,
        };
    }

    // ── 12. Settle through the ONE existing engine ───────────────────────────────
    const outcome = await settleVerifiedPayment({
        orderId: payment.order.id,
        paymentId: payment.id,
        provider: payment.provider,
        providerTransactionId: status.transactionId,
        providerSessionId: status.sessionId ?? payment.externalSessionId,
        amountReported: new Prisma.Decimal(status.amount).toFixed(2),
        providerFeeReported: status.fee === undefined ? null : String(status.fee),
        statusCode: String(status.status),
        channel: status.paymentChannel ?? payment.channel,
        eventType: "payment.reconcile",
        now: new Date(),
    });

    switch (outcome.outcome) {
        case "SETTLED":
            return {
                ...withEvidence,
                result: "RECONCILED",
                message: MESSAGES.RECONCILED,
                settlement: {
                    seatsSold: outcome.seatsSold,
                    reservationsConverted: outcome.reservationsConverted,
                    anomalies: outcome.anomalies,
                },
            };

        case "ALREADY_PAID":
            // A concurrent settlement won — a webhook, or another operator. One money
            // event; this caller is simply late, which is reported as such, not as failure.
            return {
                ...withEvidence,
                result: "ALREADY_SETTLED",
                message: MESSAGES.ALREADY_SETTLED,
            };

        case "LATE_SETTLEMENT":
            // The order went terminal between step 3 and here. The engine's existing
            // late-settlement branch recorded the money (paymentStatus PAID, no tickets);
            // this module reports that rather than repeating it.
            return refused("ORDER_BECAME_TERMINAL");

        case "ORDER_FAILED":
        case "NOT_APPLICABLE":
            return refused("STATE_CHANGED");

        case "RETRY_LATER":
            return {
                ...withEvidence,
                result: "PROVIDER_ERROR",
                reason:
                    outcome.reason === "CONTENTION_EXHAUSTED"
                        ? "SETTLEMENT_CONTENTION"
                        : "SETTLEMENT_INTEGRITY",
                message: MESSAGES.PROVIDER_ERROR,
            };

        default: {
            /*
             * Exhaustiveness. A new `SettlementOutcome` member must be classified here
             * rather than falling through to a success-looking result — the compiler
             * fails on this line until someone decides what the new state means.
             */
            const unclassified: never = outcome;
            void unclassified;

            return refused("STATE_CHANGED");
        }
    }
}

function auditDescription(result: ReconciliationResult): string {
    switch (result.result) {
        case "RECONCILED":
            return "Rekonsiliasi pembayaran: provider terverifikasi dan settlement dijalankan.";
        case "ALREADY_SETTLED":
            return "Rekonsiliasi pembayaran: pembayaran sudah diselesaikan.";
        case "PENDING_PROVIDER":
            return "Rekonsiliasi pembayaran: provider belum menyatakan pembayaran berhasil.";
        case "BLOCKED":
            return `Rekonsiliasi pembayaran ditolak: ${result.reason}.`;
        case "PROVIDER_ERROR":
            return `Rekonsiliasi pembayaran gagal: ${result.reason}.`;
    }
}

/**
 * The audit payload.
 *
 * Spread conditionally so `undefined` never becomes a JSON key, and restricted to
 * non-sensitive facts: the provider's transaction id, numeric status and reported amount
 * are the evidence being adjudicated. No signature, no API key, no session id, no
 * buyer name/email/phone, no raw response body. `writeTicketingAudit` applies its own
 * forbidden-key filter on top.
 */
function auditState(
    payment: ReconciliationPayment,
    result: ReconciliationResult
): Record<string, unknown> {
    return {
        orderNumber: payment.order.orderNumber,
        paymentReference: payment.paymentReference,
        orderStatus: payment.order.status,
        paymentStatus: payment.status,
        localAmount: new Prisma.Decimal(payment.amount).toFixed(2),
        orderTotal: new Prisma.Decimal(payment.order.total).toFixed(2),
        result: result.result,
        ...("reason" in result ? { reason: result.reason } : {}),
        ...(result.provider
            ? {
                  providerTransactionId: result.provider.transactionId,
                  providerStatus: result.provider.status,
                  providerAmount: new Prisma.Decimal(
                      result.provider.amount
                  ).toFixed(2),
              }
            : {}),
        ...(result.result === "RECONCILED"
            ? {
                  seatsSold: result.settlement.seatsSold,
                  reservationsConverted: result.settlement.reservationsConverted,
                  anomalies: result.settlement.anomalies,
              }
            : {}),
    };
}

/**
 * ── THE SCHEDULED SWEEP IS DELIBERATELY NOT BUILT ────────────────────────────────
 * `PAYMENT_RECONCILE` is an ORGANIZER authority, and an unattended job has no organizer
 * scope to act under: it would need a SYSTEM actor, and its own decision about what a
 * matching amount authorizes with no human in the loop. Phase 26's scheduler gate is also
 * still closed (no cron installed), so a job that depended on the tick would be
 * undeployable today. Recorded as a remaining gap rather than shipped as an action with no
 * owner. The operator's entry point today is the per-row action on the existing payments
 * table (`app/dashboard/payments/page.tsx`), which already searches by reference.
 */
