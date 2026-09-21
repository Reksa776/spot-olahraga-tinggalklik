import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import ReloadButton from "@/components/errors/ReloadButton";
import ServiceUnavailableState from "@/components/errors/ServiceUnavailableState";
import EmptyState from "@/components/ticketing/EmptyState";
import SiteShell from "@/components/ticketing/SiteShell";
import TicketCard from "@/components/ticketing/TicketCard";
import { loginUrlFor } from "@/lib/auth/redirect";
import { getAuthzScope } from "@/lib/authz";
import { resolvePageFailure } from "@/lib/errors/classify";
import { listOwnTickets } from "@/lib/ticketing/tickets/service";
import {
    WALLET_VIEWS,
    parseWalletView,
    splitWalletByTime,
    type WalletView,
} from "@/lib/ticketing/ui/wallet";

/**
 * ==========================================
 * PHASE 9 — MY TICKETS / TICKET WALLET
 * ==========================================
 *
 * Design §26.5's wallet. The security model is unchanged from Phase 8 and is not duplicated here:
 * this page reads through `listOwnTickets`, whose query carries `holderUserId = session.user.id`
 * and which re-applies the `ticket.read.own` permission. There is no path parameter, no query
 * parameter and no client state that can widen that.
 *
 * ── THE THREE VIEWS ─────────────────────────────────────────────────────────────
 * `?view=upcoming|all|past`, defaulting to `upcoming`. Two of them map onto the server's own mode
 * (`upcoming` and "no date filter"); the third is a presentation slice of the already-authorised
 * list, computed by `splitWalletByTime` against `event.startAt` — the same boundary the server uses,
 * so the two cannot disagree. See `lib/ticketing/ui/wallet.ts` for why that is not a second filter.
 *
 * ── WHY THE QR IS NOT HERE ──────────────────────────────────────────────────────
 * Design §26.5: "The QR token is not returned by the list endpoint — only by the single-ticket
 * endpoint, so a list response cached or logged anywhere cannot leak scannable credentials." Each
 * card therefore links to the e-ticket instead of embedding a code.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Tiket saya",
    robots: { index: false, follow: false },
};

/** The list cap. The wallet is a personal collection, not an unbounded scroll. */
const WALLET_LIMIT = 50;

type SearchParams = { view?: string };

export default async function TicketWalletPage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>;
}) {
    const params = await searchParams;
    const view = parseWalletView(params.view);

    const scope = await getAuthzScope();

    const selfPath = `/ticketing/tickets${view === "upcoming" ? "" : `?view=${view}`}`;

    if (!scope) {
        redirect(loginUrlFor(selfPath));
    }

    /*
     * A REFUSAL IS NOT A FAILURE, and the two are now told apart.
     *
     * `catch(() => null)` used to collapse them: a buyer with no `ticket.read.own` and a buyer
     * whose database call just timed out both got "Belum ada tiket" — an empty state rendered
     * over an outage, which the brief forbids explicitly ("do NOT render an empty state when the
     * API failed") and which hides the outage from the operator too.
     *
     *   denied    → an empty wallet. Fail-closed and deliberate: the buyer learns nothing about
     *               what exists (brief §16).
     *   sign-in   → login, preserving where they were.
     *   unavailable → a retry state. Never an empty list.
     *   anything else → the ticketing error boundary.
     *
     * `upcoming: false` is the server's "no date filter" mode, used for both `all` and `past` —
     * the `past` slice is then taken here from the rows the server already authorised.
     */
    let wallet: Awaited<ReturnType<typeof listOwnTickets>> | null = null;

    try {
        wallet = await listOwnTickets(
            view === "upcoming"
                ? { upcoming: true, limit: WALLET_LIMIT }
                : { upcoming: false, limit: WALLET_LIMIT },
            scope
        );
    } catch (error) {
        const failure = resolvePageFailure(error);

        if (failure.action === "unavailable") {
            return (
                <SiteShell>
                    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
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

    const items = wallet?.items ?? [];

    // `past` is the only derived view; `upcoming` and `all` are exactly what the server returned,
    // in the server's own order (soonest event first, then stable by code).
    const visible = view === "past" ? splitWalletByTime(items).past : items;

    return (
        <SiteShell>
            <div className="border-b border-ink-100 bg-ink-50/50">
                <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
                    <h1 className="text-2xl font-extrabold tracking-tight text-ink-900 sm:text-3xl">
                        Tiket saya
                    </h1>
                    <p className="mt-2 max-w-2xl text-sm text-ink-500">
                        Semua e-tiket Anda ada di sini. Buka satu tiket untuk
                        menampilkan QR-nya di pintu masuk.
                    </p>

                    <WalletTabs view={view} />
                </div>
            </div>

            <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
                {visible.length === 0 ? (
                    <EmptyState
                        kind="ticket"
                        title={emptyTitle(view)}
                        description={emptyDescription(view)}
                        action={{ href: "/events", label: "Cari event" }}
                        secondaryAction={{ href: "/", label: "Kembali ke beranda" }}
                    />
                ) : (
                    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        {visible.map((ticket) => (
                            <li key={ticket.ticketCode}>
                                <TicketCard item={ticket} />
                            </li>
                        ))}
                    </ul>
                )}

                {wallet && wallet.pagination.total > items.length ? (
                    <p className="mt-6 text-center text-xs text-ink-500">
                        Menampilkan {items.length} dari {wallet.pagination.total}{" "}
                        tiket. Buka salah satu pesanan untuk melihat sisanya.
                    </p>
                ) : null}
            </div>
        </SiteShell>
    );
}

function WalletTabs({ view }: { view: WalletView }) {
    return (
        <nav
            aria-label="Filter tiket"
            className="mt-5 flex flex-wrap items-center gap-2"
        >
            {WALLET_VIEWS.map((entry) => {
                const active = entry.value === view;

                return (
                    <Link
                        key={entry.value}
                        href={
                            entry.value === "upcoming"
                                ? "/ticketing/tickets"
                                : `/ticketing/tickets?view=${entry.value}`
                        }
                        aria-current={active ? "page" : undefined}
                        className={`rounded-full border px-4 py-2 text-xs font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                            active
                                ? "border-ink-900 bg-ink-900 text-white"
                                : "border-ink-200 bg-white text-ink-700 hover:border-ink-900 hover:text-ink-900"
                        }`}
                    >
                        {entry.label}
                    </Link>
                );
            })}
        </nav>
    );
}

function emptyTitle(view: WalletView): string {
    if (view === "past") {
        return "Belum ada tiket yang sudah lewat";
    }

    if (view === "all") {
        return "Belum ada tiket";
    }

    return "Belum ada tiket untuk event mendatang";
}

function emptyDescription(view: WalletView): string {
    if (view === "past") {
        return "Tiket dari event yang sudah berlangsung akan muncul di sini.";
    }

    if (view === "all") {
        return "Tiket muncul di sini setelah pembayaran pesanan terverifikasi dan tiket diterbitkan.";
    }

    return "Tiket muncul di sini setelah pembayaran terverifikasi dan tiket diterbitkan. Lihat tab Semua untuk riwayat lengkap.";
}
