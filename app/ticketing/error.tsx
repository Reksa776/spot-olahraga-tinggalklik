"use client";

import ErrorBoundaryFallback from "@/components/errors/ErrorBoundaryFallback";

/**
 * ==========================================
 * TICKETING ERROR BOUNDARY
 * ==========================================
 *
 * Scoped to `/ticketing/**` — the buyer's order, wallet, ticket and refund pages.
 *
 * ── WHY A SEPARATE BOUNDARY FROM THE ROOT ONE ───────────────────────────────────
 * Two reasons, both about the buyer.
 *
 *   1. **Copy.** An operator reading "Dashboard tidak dapat dimuat" is fine; a buyer looking
 *      at their paid order is not. This boundary says what a buyer needs to hear — the
 *      page could not be loaded, the order is not affected — and points at the catalog as
 *      the way out.
 *   2. **Blast radius.** The ticketing pages each re-derive authority from the database on
 *      the server. A failure in the wallet must not be able to affect a public catalog page,
 *      and vice versa, which is exactly what route-level boundaries are for.
 *
 * ── WHAT IT CANNOT FIX, ON PURPOSE ──────────────────────────────────────────────
 * It does not render `SiteShell` (server-only: its header reads the session), and it does
 * not touch payment state. Nothing on this screen can mark an order paid, retry a provider
 * call or change a booking — it is a message and a retry, which is the whole of what an
 * error boundary is allowed to do.
 */
export default function TicketingError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <div className="flex min-h-screen w-full flex-col items-center justify-center bg-white px-4 py-16 antialiased">
            <ErrorBoundaryFallback
                error={error}
                reset={reset}
                title="Halaman tiket tidak dapat dimuat"
                description={
                    <p>
                        Kami tidak dapat memuat halaman ini.{" "}
                        <strong>Status pesanan dan pembayaran Anda tidak berubah.</strong>{" "}
                        Silakan coba lagi; bila masih gagal, buka menu Tiket saya atau
                        hubungi kami dengan kode referensi di bawah.
                    </p>
                }
                homeHref="/events"
                homeLabel="Lihat katalog event"
            />
        </div>
    );
}
