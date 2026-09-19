import { Prisma } from "@prisma/client";

/**
 * ==========================================
 * REFUND PROVIDER SEAM (Phase 10B, decision D-R17)
 * ==========================================
 *
 * Decision **D-R17** required iPaymu's refund capability to be verified against the
 * authoritative API documentation BEFORE any outbound refund work was designed. That
 * verification concluded **UNSUPPORTED**: the iPaymu API v2 exposes Payment (COD +
 * callback), Balance, Transaction-history, IP/domain validation and Area endpoints — and
 * no refund endpoint of any kind.
 *
 * This module exists because a refund cannot be executed without a provider, and the
 * honest answer is that the configured provider cannot execute one. So:
 *
 *   * the default adapter returns `{ ok: false, reason: "UNSUPPORTED" }` for every
 *     request — it never fabricates a refund reference, never reports a success that did
 *     not happen, and never invents a provider API;
 *   * the seam is a small, injectable interface so a future provider (or a test) can
 *     supply a real implementation without touching the refund lifecycle in
 *     `lib/ticketing/refunds/service.ts`;
 *   * the service stores `FAILED` with `failureReason = "PROVIDER_UNSUPPORTED"` for the
 *     default, which is exactly what an operator should see: the request is valid, the
 *     money has NOT moved, and the rail does not exist yet.
 *
 * WHY NOT FAKE IT
 * ---------------
 * Brief §25 and the Phase 10B policy both forbid fabricating a refund success. A
 * `REFUNDED` row written without money moving would corrupt `EventOrder.refundedAmount`,
 * the PIC fee ledger and the quota counters all at once, and would be indistinguishable
 * from a real refund in every later reconciliation. The unsupported path is therefore a
 * first-class, truthful outcome.
 *
 * ── PHASE 18B (D-P17-04 = B): THIS SEAM IS NO LONGER CALLED BY PRODUCTION ─────────
 * The product owner closed the rail question by choosing a MANUAL BANK TRANSFER, so the
 * refund service does not call a provider at all any more: an operator claims the refund
 * (`APPROVED → PROCESSING`), makes the transfer, and records the evidence
 * (`PROCESSING → REFUNDED`). `executeRefund` therefore returns `PROCESSING` instead of
 * `UNSUPPORTED`-then-`FAILED`, and `reason: "UNSUPPORTED"` below is now a capability
 * STATEMENT rather than a runtime outcome.
 *
 * The interface and the unsupported default are kept deliberately: they are the record of
 * why the rail is manual (an audited provider surface with no refund endpoint), and they are
 * the extension point a future automated provider would implement. Nothing in the actor-facing
 * service imports them, so re-wiring an automated rail is a deliberate change, never an
 * accident.
 *
 * WHY A FAILED PROVIDER CALL DOES NOT MARK THE REFUND `REJECTED`
 * -------------------------------------------------------------
 * `REJECTED` is a human decision (D-R07/D-R02: staff decline the request). A provider that
 * cannot execute is an infrastructure condition, not a judgement on the request, so the
 * service records `FAILED` (which is what D-R07's `PROCESSING → FAILED` edge is for) and
 * the request can be retried once a rail exists.
 */

/** Why a provider call did not produce a confirmed refund. */
export type RefundProviderFailureReason =
    /** The configured provider has no refund capability (iPaymu today — D-R17). */
    | "UNSUPPORTED"
    /** The provider understood the request and declined it. */
    | "DECLINED"
    /** The provider was unreachable or returned a malformed response. */
    | "PROVIDER_ERROR"
    /** The request itself is invalid for the provider (amount/currency/state). */
    | "INVALID_REQUEST";

export type RefundProviderRequest = {
    /** This platform's refund number, for the provider's reference/idempotency. */
    refundNumber: string;
    /** The ticketing order number (the `EVT-…` namespace). */
    orderNumber: string;
    /** The provider that processed the original payment (design D-17). */
    provider: string;
    /** The provider's id for the original charge, when one was recorded. */
    providerTransactionId: string | null;
    providerSessionId: string | null;
    /** A fixed 2-decimal string, derived from the database — never a number. */
    amount: string;
    currency: string;
    /** The buyer's or operator's stated reason, when one exists. */
    reason: string | null;
};

export type RefundProviderResult =
    | {
          ok: true;
          /**
           * The provider's own refund reference. D-R12 requires it to be persisted when it
           * is returned; `null` is allowed because a provider may confirm without one.
           */
          providerRef: string | null;
          /**
           * The amount the provider confirms it refunded, as a 2-decimal string, when it
           * states one. The service NEVER trusts this over its own stored items: a provider
           * that confirms a different amount is a mismatch to record, not a number to apply.
           */
          confirmedAmount: string | null;
      }
    | { ok: false; reason: RefundProviderFailureReason; detail?: string };

export interface RefundProvider {
    /** The provider namespace, matching `Payment.provider` (e.g. `"ipaymu"`). */
    readonly name: string;
    refund(request: RefundProviderRequest): Promise<RefundProviderResult>;
}

/**
 * The truthful default: the configured provider has no refund endpoint.
 *
 * This is not a stub awaiting implementation — it is the result of the D-R17 verification.
 * If iPaymu ever publishes a refund API, an adapter is written to this interface and
 * selected by `getRefundProvider`, and the entire lifecycle in
 * `lib/ticketing/refunds/service.ts` starts working unchanged.
 */
class UnsupportedRefundProvider implements RefundProvider {
    readonly name: string;

    constructor(name: string) {
        this.name = name;
    }

    async refund(): Promise<RefundProviderResult> {
        return {
            ok: false,
            reason: "UNSUPPORTED",
            detail: `${this.name} exposes no refund endpoint (decision D-R17).`,
        };
    }
}

let activeProvider: RefundProvider | null = null;

/**
 * The adapter the refund service must call.
 *
 * Defaults to the unsupported adapter named after the payment provider (D-17). Tests
 * inject a deterministic adapter through `setRefundProvider`, which is also the extension
 * point a future real adapter uses.
 */
export function getRefundProvider(): RefundProvider {
    return activeProvider ?? new UnsupportedRefundProvider("ipaymu");
}

/**
 * Install a refund adapter.
 *
 * Intended for tests AND for a future provider rollout; it is deliberately not exported
 * from any API route, so a request can never choose its own provider.
 */
export function setRefundProvider(provider: RefundProvider): void {
    activeProvider = provider;
}

/** Restore the default. Test-teardown helper; safe to call at any time. */
export function resetRefundProvider(): void {
    activeProvider = null;
}

/**
 * Validate a provider-confirmed amount against the amount this platform asked to refund.
 *
 * Pure, float-free (D-61) and used by the confirmed-settlement path: a confirmed amount
 * that disagrees with the stored `RefundItem` total is a `MISMATCH`, never a new amount.
 */
export function confirmedAmountVerdict(
    confirmed: string | null,
    expected: Prisma.Decimal | string
): "MATCH" | "ABSENT" | "MISMATCH" | "UNPARSEABLE" {
    if (confirmed === null) {
        return "ABSENT";
    }

    try {
        return new Prisma.Decimal(confirmed).equals(new Prisma.Decimal(expected))
            ? "MATCH"
            : "MISMATCH";
    } catch {
        return "UNPARSEABLE";
    }
}
