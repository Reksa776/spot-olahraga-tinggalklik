import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import EmptyState from "@/components/ticketing/EmptyState";
import SiteShell from "@/components/ticketing/SiteShell";
import { getAuthzScope } from "@/lib/authz";
import { listRefunds } from "@/lib/ticketing/refunds/service";
import type { RefundPayload } from "@/lib/ticketing/refunds/payload";
import {
    formatEventDateShort,
    formatEventTime,
    formatIdr,
} from "@/lib/ticketing/ui/format";

/**
 * ==========================================
 * MY REFUNDS (Phase 10B)
 * ==========================================
 *
 * The buyer's view of the refunds they have requested. It reads through `listRefunds` with no
 * `organizerId`, which means the query's own predicate is `requestedByUserId = session.user.id`
 * and the `order.read.own` capability is re-applied — so this page cannot be widened by a URL
 * parameter, and another buyer's refund is simply not in the set.
 *
 * "Request a refund" lives on the order page, where the buyer can see the tickets they are
 * refunding; this page exists so the STATUS of a request (pending review, approved, refunded,
 * rejected) stays visible after the buyer leaves that order.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Refund saya",
    robots: { index: false, follow: false },
};

const LIST_LIMIT = 50;

/** Buyer-facing label + colour for a `RefundStatus`. */
const STATUS: Record<string, { label: string; className: string }> = {
    PENDING: {
        label: "Menunggu tinjauan",
        className: "bg-amber-50 text-amber-700 ring-amber-200",
    },
    APPROVED: {
        label: "Disetujui",
        className: "bg-sky-50 text-sky-700 ring-sky-200",
    },
    PROCESSING: {
        label: "Sedang diproses",
        className: "bg-sky-50 text-sky-700 ring-sky-200",
    },
    REFUNDED: {
        label: "Dana dikembalikan",
        className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    },
    REJECTED: {
        label: "Ditolak",
        className: "bg-ink-100 text-ink-600 ring-ink-200",
    },
    FAILED: {
        label: "Gagal",
        className: "bg-rose-50 text-rose-700 ring-rose-200",
    },
};

type SearchParams = { page?: string };

export default async function MyRefundsPage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>;
}) {
    const params = await searchParams;
    const page = params.page ? Math.max(1, Number(params.page) || 1) : 1;

    const scope = await getAuthzScope();

    if (!scope) {
        redirect(
            `/login?next=${encodeURIComponent(
                page > 1 ? `/ticketing/refunds?page=${page}` : "/ticketing/refunds"
            )}`
        );
    }

    // A refusal (no order read capability) renders as an empty list rather than an error: the
    // buyer learns nothing about what exists, which is the fail-closed behaviour.
    const result = await listRefunds(scope, {
        page,
        limit: LIST_LIMIT,
    }).catch(() => null);

    const items = result?.items ?? [];
    const total = result?.total ?? 0;
    const totalPages = Math.ceil(total / LIST_LIMIT);

    return (
        <SiteShell>
            <div className="border-b border-ink-100 bg-ink-50/50">
                <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:py-10">
                    <h1 className="text-2xl font-extrabold tracking-tight text-ink-900 sm:text-3xl">
                        Refund saya
                    </h1>
                    <p className="mt-2 max-w-2xl text-sm text-ink-500">
                        Status pengajuan pengembalian dana untuk tiket yang
                        Anda beli.
                    </p>
                </div>
            </div>

            <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
                {items.length === 0 ? (
                    <EmptyState
                        kind="ticket"
                        title="Belum ada pengajuan refund"
                        description="Pengajuan refund dibuat dari halaman pesanan tiket Anda."
                        action={{ href: "/ticketing/tickets", label: "Lihat tiket saya" }}
                        secondaryAction={{ href: "/events", label: "Cari event" }}
                    />
                ) : (
                    <ul className="divide-y divide-ink-100 border-y border-ink-100">
                        {items.map((refund) => (
                            <li key={refund.refundId} className="py-4">
                                <RefundRow refund={refund} />
                            </li>
                        ))}
                    </ul>
                )}

                {totalPages > 1 ? (
                    <nav
                        aria-label="Halaman"
                        className="mt-6 flex items-center justify-between text-sm"
                    >
                        {page > 1 ? (
                            <Link
                                href={page - 1 > 1 ? `/ticketing/refunds?page=${page - 1}` : "/ticketing/refunds"}
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
                                href={`/ticketing/refunds?page=${page + 1}`}
                                className="font-semibold text-brand-700 hover:underline"
                            >
                                Berikutnya →
                            </Link>
                        ) : (
                            <span />
                        )}
                    </nav>
                ) : null}
            </div>
        </SiteShell>
    );
}

function RefundRow({ refund }: { refund: RefundPayload }) {
    const entry = STATUS[refund.status] ?? {
        label: refund.status,
        className: "bg-ink-100 text-ink-600 ring-ink-200",
    };

    const settled = refund.status === "REFUNDED";
    const amount = settled ? refund.confirmedAmount : refund.requestedAmount;

    return (
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-ink-900">
                        {refund.refundNumber ?? `#${refund.refundId}`}
                    </span>
                    <span
                        className={`rounded-full px-2.5 py-0.5 text-[0.7rem] font-bold ring-1 ring-inset ${entry.className}`}
                    >
                        {entry.label}
                    </span>
                </div>

                <p className="mt-1 text-xs text-ink-500">
                    Pesanan{" "}
                    <Link
                        href={`/ticketing/orders/${refund.orderNumber}`}
                        className="font-semibold text-brand-700 hover:underline"
                    >
                        {refund.orderNumber}
                    </Link>{" "}
                    · {refund.items.length} tiket · diajukan{" "}
                    {formatEventDateShort(refund.createdAt)} ·{" "}
                    {formatEventTime(refund.createdAt)} WIB
                </p>

                {refund.failureReason ? (
                    <p className="mt-1 text-xs leading-relaxed text-rose-700">
                        {refund.failureReason}
                    </p>
                ) : null}
            </div>

            <p className="shrink-0 text-sm font-bold text-ink-900">
                {formatIdr(Number(amount))}
            </p>
        </div>
    );
}
