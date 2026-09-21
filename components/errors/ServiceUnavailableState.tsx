import type { ReactNode } from "react";

import ErrorState from "./ErrorState";

/**
 * ==========================================
 * SERVICE UNAVAILABLE / TRANSIENT FAILURE
 * ==========================================
 *
 * The screen for a failure that is nobody's fault and is worth retrying: the database is
 * unreachable, a query timed out, the payment provider is down.
 *
 * ── WHY IT IS DISTINCT FROM A 404 ───────────────────────────────────────────────
 * This is the component that exists because of the Phase 23A class of bug. A transient
 * failure rendered as "not found" tells a buyer their paid order has vanished, tells the
 * operator nothing about the outage, and offers no way to try again. Here the user is told
 * the truth — the data could not be LOADED, it is not gone — and is given a retry.
 *
 * ── THE PAYMENT CASE ────────────────────────────────────────────────────────────
 * The `payment` variant exists because a provider failure needs one extra sentence: the
 * order is NOT paid, and a refresh will not make it paid. Payment truth comes from the
 * verified webhook and from nothing else (§31.5 rule 3), so the copy must never imply the
 * redirect settled anything.
 */
export function ServiceUnavailableState({
    variant = "generic",
    reference,
    children,
}: {
    /** `generic` = data could not be loaded; `payment` = the provider leg failed. */
    variant?: "generic" | "payment";
    reference?: string;
    /** Client actions, such as a `RetryButton` bound to the boundary's `reset`. */
    children?: ReactNode;
}) {
    if (variant === "payment") {
        return (
            <ErrorState
                tone="warning"
                title="Layanan pembayaran sedang tidak tersedia"
                reference={reference}
                description={
                    <p>
                        Pesanan Anda <strong>belum dianggap lunas</strong>. Silakan coba lagi
                        beberapa saat lagi atau muat ulang halaman ini untuk melihat status
                        terakhir dari pesanan Anda.
                    </p>
                }
            >
                {children}
            </ErrorState>
        );
    }

    return (
        <ErrorState
            tone="warning"
            title="Terjadi gangguan sementara"
            reference={reference}
            description={
                <p>
                    Data sedang tidak dapat dimuat. Silakan coba lagi sebentar lagi — tidak
                    ada data Anda yang hilang.
                </p>
            }
        >
            {children}
        </ErrorState>
    );
}

export default ServiceUnavailableState;
