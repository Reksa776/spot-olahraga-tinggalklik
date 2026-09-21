"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/dashboard/ui/button";
import {
    redirectToLoginForExpiredSession,
    UNAUTHORIZED_CODE,
} from "@/lib/auth/client-session";

import { apiFetch, ClientApiError } from "./api";

/**
 * ==========================================
 * "VERIFIKASI STATUS PEMBAYARAN" (Phase 27E)
 * ==========================================
 *
 * The operator-facing half of reconciliation. It sends NOTHING: the path names the payment
 * and the server resolves everything else (tenant from the payment row, transaction id
 * from `Payment.providerTransactionId`, actor from the session, amount from the provider).
 * There is no transaction-id field, no amount field and no status selector, because the
 * server accepts none of them — this control can only ASK, never assert.
 *
 * ── WHAT THE FOUR ANSWERS MEAN TO AN OPERATOR ───────────────────────────────────
 *
 *   RECONCILED        the provider confirmed the payment and it is now settled here
 *   ALREADY_SETTLED   nothing to do — a webhook (or another operator) got there first
 *   PENDING_PROVIDER  the provider says the payment has not succeeded yet
 *   BLOCKED           the evidence was incomplete or does not match this payment; the
 *                     server changed nothing and said why
 *
 * A provider outage arrives as HTTP 503 / `PROVIDER_UNAVAILABLE`, so it reads as
 * "Provider tidak dapat dihubungi. Silakan coba lagi." rather than as one of the answers
 * above — a distinction that matters, because only the outage is worth retrying.
 *
 * ── WHY A 401 IS NOT A FAILED VERIFICATION ──────────────────────────────────────
 * An expired session is a SESSION state (Phase 24). It is checked before the generic error
 * branch, sends the operator to `/login` with this page as the return path, and never
 * claims anything about the payment — the same rule the buyer-side action buttons follow.
 *
 * ── WHY THE PAGE REFRESHES ──────────────────────────────────────────────────────
 * When something actually changed (or was already changed), the row's server-rendered
 * status is stale, so `router.refresh()` re-reads it. That is the ONLY client-side state
 * this control mutates: nothing here computes a payment status.
 */

/** The subset of the API result this control reads. */
type ReconcileResult = {
    result: "RECONCILED" | "ALREADY_SETTLED" | "PENDING_PROVIDER" | "BLOCKED";
    message: string;
    reason?: string;
};

type Props = {
    paymentReference: string;
    /** `false` renders an explanation instead of a button — see below. */
    hasProviderTransactionId: boolean;
};

/** The in-flight affordance every dashboard async button shares. */
function Spinner() {
    return (
        <span
            aria-hidden
            className="size-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current"
        />
    );
}

export default function ReconcilePaymentButton({
    paymentReference,
    hasProviderTransactionId,
}: Props) {
    const router = useRouter();

    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<ReconcileResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    /**
     * No button when the provider never gave us a transaction id.
     *
     * That is not a permission problem and not something the operator can fix, so an
     * inapplicable control is replaced by the reason: the status query is ADDRESSED by
     * that id, and without it there is nothing to ask about. (Rows created before Phase
     * 27E — including the real sandbox payment from Phase 27B — are exactly this case, and
     * the API answers the same thing with `PROVIDER_TRANSACTION_ID_MISSING`.)
     */
    if (!hasProviderTransactionId) {
        return (
            <span
                className="text-xs text-muted-foreground"
                title="Provider tidak mengembalikan ID transaksi saat pembayaran dibuat, sehingga status tidak dapat ditanyakan ke provider."
            >
                ID transaksi provider tidak tersedia
            </span>
        );
    }

    async function verify() {
        setBusy(true);
        setResult(null);
        setError(null);

        try {
            const data = await apiFetch<ReconcileResult>(
                `/api/organizer/payments/${encodeURIComponent(
                    paymentReference
                )}/reconcile`,
                { method: "POST" }
            );

            setResult(data);

            if (data.result === "RECONCILED" || data.result === "ALREADY_SETTLED") {
                router.refresh();
            }
        } catch (caught) {
            if (caught instanceof ClientApiError) {
                /*
                 * Branch on the CODE, not on a remembered HTTP status: `apiFetch`
                 * deliberately throws a `ClientApiError` carrying the envelope's `code`,
                 * and `UNAUTHORIZED` is the one code that means "your session ended". The
                 * proxy writes it for a 401, so this cannot be confused with a refusal
                 * (403), a business state (409) or a provider outage (PROVIDER_UNAVAILABLE).
                 */
                if (caught.code === UNAUTHORIZED_CODE) {
                    redirectToLoginForExpiredSession();
                    return;
                }

                setError(caught.message);
            } else {
                setError("Terjadi kesalahan.");
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col gap-1.5">
            <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={verify}
                title="Menanyakan status transaksi ini langsung ke provider dan menyelesaikannya hanya jika provider menyatakan pembayaran berhasil."
            >
                {busy ? <Spinner /> : null}
                {busy ? "Memverifikasi…" : "Verifikasi status"}
            </Button>

            {result ? (
                <span
                    className={
                        result.result === "RECONCILED"
                            ? "text-xs font-medium text-emerald-600 dark:text-emerald-400"
                            : result.result === "ALREADY_SETTLED"
                              ? "text-xs text-muted-foreground"
                              : "text-xs text-amber-600 dark:text-amber-400"
                    }
                >
                    {result.message}
                </span>
            ) : null}

            {error ? (
                <span className="text-xs text-destructive">{error}</span>
            ) : null}
        </div>
    );
}
