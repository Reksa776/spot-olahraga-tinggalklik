import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import ReloadButton from "@/components/errors/ReloadButton";
import ServiceUnavailableState from "@/components/errors/ServiceUnavailableState";
import EmptyState from "@/components/ticketing/EmptyState";
import OrderCard from "@/components/ticketing/OrderCard";
import SiteShell from "@/components/ticketing/SiteShell";
import Reveal, { revealDelay } from "@/components/ui/Reveal";
import { loginUrlFor } from "@/lib/auth/redirect";
import { getAuthzScope } from "@/lib/authz";
import { resolvePageFailure } from "@/lib/errors/classify";
import { listOwnOrders } from "@/lib/ticketing/orders";

/**
 * ==========================================
 * CUSTOMER "PESANAN SAYA" — ORDER LIST
 * ==========================================
 *
 * Design §26.1's `GET /api/orders` as a page. It exists because every other buyer surface here
 * starts from something the buyer already has: the wallet starts from a ticket, the e-ticket
 * starts from a code, the refund list starts from a request, and the order DETAIL starts from an
 * order number the buyer is expected to have kept. There was no surface for the question a buyer
 * asks first — "what have I bought?" — so an order whose confirmation was lost was reachable only
 * by re-reading that confirmation.
 *
 * ── AUTHORIZATION IS THE SERVICE'S, NOT THIS PAGE'S ──────────────────────────────
 * The page resolves the session and hands it to `listOwnOrders`, whose query carries
 * `userId: actor.userId` and which re-applies the `order.read.own` capability. There is no path
 * parameter, no query parameter and no client state that can widen that: a foreign order was never
 * in the result set, so it cannot be rendered here by accident. That is the same two-layer contract
 * `getOwnOrder` keeps, and it is deliberately NOT re-implemented as a filter in this file — a page
 * that narrowed a list it had already been given would be a page that could be edited into
 * widening it.
 *
 * ── WHAT IS DELIBERATELY NOT ON THIS PAGE ────────────────────────────────────────
 * No QR, no `ticketCode`, no payment instruction, no storage key, no audit data. The list
 * projection (`ORDER_SUMMARY_SELECT`) does not even select the payment columns, so a later edit
 * here cannot leak an instruction the builder never received. The QR contract is unchanged and
 * still returns a scannable credential from exactly one place
 * (`/ticketing/tickets/[ticketCode]`); this page links to a ticket, it never embeds one.
 *
 * The card itself is `components/ticketing/OrderCard.tsx` — a pure function of the payload, so its
 * rendering is asserted directly in the test suite rather than through this page.
 *
 * ── STATES ───────────────────────────────────────────────────────────────────────
 * Unauthenticated → login, preserving where the buyer was. Refused → an empty list (fail-closed;
 * the buyer learns nothing about what exists). Outage → a RETRYABLE state, because "you have no
 * orders" rendered during a database outage is the false empty state the brief forbids. Empty →
 * an empty state with a way to the catalog.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Pesanan saya",
    robots: { index: false, follow: false },
};

/**
 * The page size.
 *
 * Mirrors the service's default; the service enforces §26.1's own ceiling of 50, so raising this
 * constant alone cannot lift the cap.
 */
const PAGE_LIMIT = 20;

type SearchParams = { page?: string };

export default async function MyOrdersPage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>;
}) {
    const params = await searchParams;
    const page = params.page ? Math.max(1, Number(params.page) || 1) : 1;

    const selfPath = page > 1 ? `/ticketing/orders?page=${page}` : "/ticketing/orders";

    const scope = await getAuthzScope();

    if (!scope) {
        redirect(loginUrlFor(selfPath));
    }

    /*
     * The same refusal-versus-failure split the wallet and the refund list keep, for the same
     * reason: `.catch(() => null)` used to collapse the two, and an outage rendered as "you have no
     * orders" both lies to the buyer and hides the incident from the operator.
     *
     *   denied      → an empty list. Fail-closed, and the buyer learns nothing.
     *   sign-in     → login, preserving the page they were on.
     *   unavailable → a retry state. Never an empty list.
     *   anything else → the ticketing error boundary.
     */
    let result: Awaited<ReturnType<typeof listOwnOrders>> | null = null;

    try {
        result = await listOwnOrders({ page, limit: PAGE_LIMIT }, scope);
    } catch (error) {
        const failure = resolvePageFailure(error);

        if (failure.action === "unavailable") {
            return (
                <SiteShell>
                    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
                        <ServiceUnavailableState reference={failure.classification.code}>
                            <ReloadButton />
                        </ServiceUnavailableState>
                    </div>
                </SiteShell>
            );
        }

        if (failure.action === "sign-in") {
            redirect(loginUrlFor(selfPath));
        }

        if (failure.action !== "denied") {
            throw error;
        }
    }

    const items = result?.items ?? [];
    const total = result?.total ?? 0;
    const totalPages = Math.ceil(total / PAGE_LIMIT);

    return (
        <SiteShell>
            <div className="border-b border-ink-100 bg-ink-50/50">
                <Reveal className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:py-10">
                    <h1 className="text-2xl font-extrabold tracking-tight text-ink-900 sm:text-3xl">
                        Pesanan saya
                    </h1>
                    <p className="mt-2 max-w-2xl text-sm text-ink-500">
                        Semua pesanan tiket yang Anda buat, beserta status
                        pembayaran, tiket, dan pengembalian dananya.
                    </p>
                </Reveal>
            </div>

            <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
                {items.length === 0 ? (
                    // One entrance for the whole empty state.
                    <Reveal delay={120}>
                        <EmptyState
                            kind="ticket"
                            title="Belum ada pesanan"
                            description="Pesanan muncul di sini setelah Anda menyelesaikan checkout, sebelum maupun sesudah pembayaran dikonfirmasi."
                            action={{ href: "/events", label: "Cari event" }}
                            secondaryAction={{ href: "/", label: "Kembali ke beranda" }}
                        />
                    </Reveal>
                ) : (
                    <ul className="space-y-4">
                        {items.map((order, index) => (
                            <Reveal
                                as="li"
                                key={order.orderNumber}
                                delay={revealDelay(index, 120)}
                            >
                                <OrderCard order={order} />
                            </Reveal>
                        ))}
                    </ul>
                )}

                {totalPages > 1 ? (
                    <Reveal
                        as="nav"
                        scroll
                        aria-label="Halaman"
                        className="mt-6 flex items-center justify-between text-sm"
                    >
                        {page > 1 ? (
                            <Link
                                href={
                                    page - 1 > 1
                                        ? `/ticketing/orders?page=${page - 1}`
                                        : "/ticketing/orders"
                                }
                                className="font-semibold text-brand-700 hover:underline"
                            >
                                ← Sebelumnya
                            </Link>
                        ) : (
                            <span />
                        )}

                        <span className="text-xs text-ink-500">
                            Halaman {page} dari {totalPages}
                        </span>

                        {page < totalPages ? (
                            <Link
                                href={`/ticketing/orders?page=${page + 1}`}
                                className="font-semibold text-brand-700 hover:underline"
                            >
                                Berikutnya →
                            </Link>
                        ) : (
                            <span />
                        )}
                    </Reveal>
                ) : null}
            </div>
        </SiteShell>
    );
}
