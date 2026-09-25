import SiteShell from "@/components/ticketing/SiteShell";

/**
 * ==========================================
 * "PESANAN SAYA" — LOADING STATE
 * ==========================================
 *
 * The fallback Next.js streams while `app/ticketing/orders/page.tsx` is still awaiting its
 * (dynamic, per-visitor) read. Before this, a slow database left the buyer on the previous
 * page with no signal that anything was happening, because the order list is
 * `force-dynamic`: there is no static shell to paint first.
 *
 * ── WHY A SKELETON AND NOT A SPINNER ─────────────────────────────────────────────
 * The list's shape is known — a stack of cards, each with a header row and a body — so the
 * placeholder mirrors it, and the page does not visibly jump when the real rows arrive. Every
 * value is a grey bar; nothing here guesses a count, an order number, a status or an amount.
 * That matters: a skeleton that renders plausible data is a skeleton that can be mistaken for
 * data, and on this surface "plausible data" means a payment status.
 *
 * It is purely presentational. It reads no session, performs no query and decides nothing —
 * so it cannot become a second source of truth, and it renders identically for a buyer with
 * fifty orders and one with none.
 *
 * ── WHY IT IS THE FIRST `loading.tsx` IN THE TREE ────────────────────────────────
 * The sibling buyer pages (`/ticketing/tickets`, `/ticketing/refunds`, the order detail) are
 * also dynamic and carry no loading file. This one needs one: it is the only new surface in
 * this vertical, the mission requires an explicit loading state for it, and it reuses the
 * existing `SiteShell` and `ink`/`brand` tokens rather than introducing a second visual
 * system. The pattern is deliberately additive and adopted nowhere else.
 */
export default function MyOrdersLoading() {
    return (
        <SiteShell>
            <div
                role="status"
                aria-live="polite"
                className="border-b border-ink-100 bg-ink-50/50"
            >
                <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:py-10">
                    <div className="h-8 w-48 animate-pulse rounded-lg bg-ink-200/70" />
                    <div className="mt-3 h-4 w-full max-w-xl animate-pulse rounded bg-ink-200/60" />
                    <span className="sr-only">Memuat pesanan Anda…</span>
                </div>
            </div>

            <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
                <ul className="space-y-4">
                    {[0, 1, 2].map((key) => (
                        <li
                            key={key}
                            className="overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-sm"
                        >
                            <div className="flex items-start justify-between gap-3 border-b border-ink-100 bg-ink-50/60 px-5 py-4">
                                <div className="min-w-0">
                                    <div className="h-4 w-40 animate-pulse rounded bg-ink-200/70" />
                                    <div className="mt-2 h-3 w-32 animate-pulse rounded bg-ink-200/50" />
                                </div>
                                <div className="h-6 w-24 animate-pulse rounded-full bg-ink-200/60" />
                            </div>

                            <div className="px-5 py-4">
                                <div className="h-5 w-2/3 animate-pulse rounded bg-ink-200/70" />
                                <div className="mt-3 h-3 w-1/2 animate-pulse rounded bg-ink-200/50" />
                                <div className="mt-4 h-5 w-full max-w-sm animate-pulse rounded-full bg-ink-200/40" />
                            </div>
                        </li>
                    ))}
                </ul>
            </div>
        </SiteShell>
    );
}
