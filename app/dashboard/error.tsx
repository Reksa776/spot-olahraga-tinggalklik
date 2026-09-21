"use client";

import ErrorBoundaryFallback from "@/components/errors/ErrorBoundaryFallback";

/**
 * ==========================================
 * DASHBOARD ERROR BOUNDARY
 * ==========================================
 *
 * Scoped to `/dashboard/**`. It exists as a SEPARATE boundary for one reason: the dashboard
 * is a composition of many independent panels, and an unhandled failure in any one of them
 * must not hand the operator the back-office chrome of a broken route. This boundary keeps
 * the failure inside the dashboard's own visual language (it carries the
 * `data-dashboard-shell` marker, so `globals.css` keeps the marketing footer suppressed) and
 * offers the retry.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────
 * It does not attempt to render the dashboard's navigation. The menu is derived from the
 * actor's capabilities, which were resolved by the layout that just failed; inventing a
 * fallback menu would mean guessing at authority in the one place that must never guess.
 *
 * Per-widget isolation is a page-level concern and is handled there: the expensive panels
 * (revenue, PIC fees, reports) catch their own failures and render an inline error, so a
 * single unavailable number does not blank the whole overview.
 */
export default function DashboardError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <ErrorBoundaryFallback
            dashboard
            standalone
            error={error}
            reset={reset}
            title="Dashboard tidak dapat dimuat"
            description={
                <p>
                    Terjadi kendala saat memuat data dashboard. Data Anda tetap aman dan tidak
                    ada perubahan yang tercatat. Coba muat ulang — bila tetap gagal, sertakan
                    kode referensi di bawah saat menghubungi tim kami.
                </p>
            }
            homeHref="/dashboard"
            homeLabel="Kembali ke dashboard"
        />
    );
}
