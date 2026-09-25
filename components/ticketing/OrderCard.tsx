import Link from "next/link";

import type {
    OrderFulfilment,
    OrderSummaryPayload,
} from "@/lib/ticketing/order-payload";
import {
    formatEventDateShort,
    formatEventTime,
    formatIdr,
    formatVenue,
} from "@/lib/ticketing/ui/format";

/**
 * ==========================================
 * ONE ORDER IN "PESANAN SAYA" (Phase 20B)
 * ==========================================
 *
 * The card for the customer order list, extracted into a component for the same reason
 * `TicketCard` is one: it is a PURE function of `OrderSummaryPayload`, so it can be rendered
 * as HTML in a test without a database, a session or a browser — and the rendering assertions
 * can be semantic (a link's destination, a badge's meaning, the absence of a credential)
 * rather than cosmetic.
 *
 * ── WHAT IT RENDERS, AND NOTHING ELSE ───────────────────────────────────────────
 * Every value below is a field of the projection the server already authorised and scoped to
 * the session user (`ORDER_SUMMARY_SELECT` → `buildOrderSummary`). The component fetches
 * nothing, joins nothing and derives nothing except display labels, so it cannot become a
 * second source of truth about a payment, a ticket or a refund.
 *
 * ── WHAT IT CANNOT SHOW ─────────────────────────────────────────────────────────
 * The payload it consumes has no `ticketCode`, no QR payload, no payment instruction and no
 * evidence key — those are absent from the type, so a future edit here cannot leak one. The
 * card LINKS to the order's own detail page; it never embeds a scannable credential.
 *
 * The whole card is one link and it contains no nested interactive element, so there is
 * exactly one tab stop per order and no ambiguity about what a click does.
 */

/** Buyer-facing label + colour for the order's own `OrderStatus`. */
const ORDER_STATUS: Record<string, { label: string; className: string }> = {
    PENDING_PAYMENT: {
        label: "Menunggu pembayaran",
        className: "bg-amber-50 text-amber-700 ring-amber-200",
    },
    PAID: {
        label: "Sudah dibayar",
        className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    },
    CANCELLED: {
        label: "Dibatalkan",
        className: "bg-ink-100 text-ink-600 ring-ink-200",
    },
    EXPIRED: {
        label: "Kedaluwarsa",
        className: "bg-rose-50 text-rose-700 ring-rose-200",
    },
    REFUNDED: {
        label: "Dana dikembalikan",
        className: "bg-violet-50 text-violet-700 ring-violet-200",
    },
    PARTIALLY_REFUNDED: {
        label: "Dana dikembalikan sebagian",
        className: "bg-violet-50 text-violet-700 ring-violet-200",
    },
};

/** Buyer-facing label + colour for the order's `PaymentStatus`. */
const PAYMENT_STATUS: Record<string, { label: string; className: string }> = {
    UNPAID: {
        label: "Belum dibayar",
        className: "bg-amber-50 text-amber-700 ring-amber-200",
    },
    PENDING: {
        label: "Menunggu konfirmasi",
        className: "bg-sky-50 text-sky-700 ring-sky-200",
    },
    PAID: {
        label: "Lunas",
        className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    },
    FAILED: {
        label: "Gagal",
        className: "bg-rose-50 text-rose-700 ring-rose-200",
    },
    EXPIRED: {
        label: "Kedaluwarsa",
        className: "bg-rose-50 text-rose-700 ring-rose-200",
    },
    REFUNDED: {
        label: "Dana dikembalikan",
        className: "bg-violet-50 text-violet-700 ring-violet-200",
    },
    PARTIALLY_REFUNDED: {
        label: "Dana dikembalikan sebagian",
        className: "bg-violet-50 text-violet-700 ring-violet-200",
    },
};

/**
 * The fulfilment leg, in the buyer's words — one label per `OrderFulfilment` state.
 *
 * The STATE comes from the server (`orderFulfilment`, shared with the order detail page); only
 * the copy lives here. That split is what keeps the list and the detail from ever disagreeing
 * about whether a paid order's tickets exist.
 */
const FULFILMENT: Record<OrderFulfilment, { label: string; className: string }> = {
    ISSUED: {
        label: "Tiket terbit",
        className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    },
    READY: {
        label: "Siap diterbitkan",
        className: "bg-sky-50 text-sky-700 ring-sky-200",
    },
    HELD: {
        label: "Ditahan operator",
        className: "bg-rose-50 text-rose-700 ring-rose-200",
    },
    AWAITING_PAYMENT: {
        label: "Menunggu pembayaran",
        className: "bg-ink-100 text-ink-600 ring-ink-200",
    },
};

/** Buyer-facing label + colour for a `RefundStatus` (the vocabulary `/ticketing/refunds` uses). */
const REFUND_STATUS: Record<string, { label: string; className: string }> = {
    PENDING: {
        label: "Refund ditinjau",
        className: "bg-amber-50 text-amber-700 ring-amber-200",
    },
    APPROVED: {
        label: "Refund disetujui",
        className: "bg-sky-50 text-sky-700 ring-sky-200",
    },
    PROCESSING: {
        label: "Refund diproses",
        className: "bg-sky-50 text-sky-700 ring-sky-200",
    },
    REFUNDED: {
        label: "Dana dikembalikan",
        className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    },
    REJECTED: {
        label: "Refund ditolak",
        className: "bg-ink-100 text-ink-600 ring-ink-200",
    },
    FAILED: {
        label: "Refund gagal",
        className: "bg-rose-50 text-rose-700 ring-rose-200",
    },
};

export default function OrderCard({ order }: { order: OrderSummaryPayload }) {
    const orderStatus = ORDER_STATUS[order.status] ?? {
        label: order.status,
        className: "bg-ink-100 text-ink-600 ring-ink-200",
    };
    const paymentStatus = PAYMENT_STATUS[order.paymentStatus] ?? {
        label: order.paymentStatus,
        className: "bg-ink-100 text-ink-600 ring-ink-200",
    };
    const fulfilment = FULFILMENT[order.fulfilment];
    const refundStatus = order.refundStatus
        ? (REFUND_STATUS[order.refundStatus] ?? {
              label: order.refundStatus,
              className: "bg-ink-100 text-ink-600 ring-ink-200",
          })
        : null;

    return (
        <Link
            href={order.orderUrl}
            className="block overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-sm transition hover:border-ink-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 bg-ink-50/60 px-5 py-4">
                <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold text-ink-900">
                        {order.orderNumber}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-400">
                        Dibuat {formatEventDateShort(order.createdAt)} ·{" "}
                        {formatEventTime(order.createdAt)} WIB
                    </p>
                </div>

                <span
                    className={`rounded-full px-3 py-1 text-[0.7rem] font-bold ring-1 ring-inset ${orderStatus.className}`}
                >
                    {orderStatus.label}
                </span>
            </div>

            <div className="px-5 py-4">
                <h2 className="line-clamp-2 text-sm font-bold text-ink-900 sm:text-base">
                    {order.eventTitle}
                </h2>

                <dl className="mt-1.5 space-y-1 text-xs text-ink-500">
                    <div className="flex items-center gap-2">
                        <dt className="sr-only">Jadwal</dt>
                        <dd>
                            {formatEventDateShort(order.startAt)} ·{" "}
                            {formatEventTime(order.startAt)} WIB
                        </dd>
                    </div>
                    <div className="flex items-center gap-2">
                        <dt className="sr-only">Lokasi</dt>
                        <dd className="truncate">
                            {formatVenue(order.venueName, null)}
                        </dd>
                    </div>
                    {order.ticketSummary ? (
                        <div className="flex items-center gap-2">
                            <dt className="sr-only">Tiket</dt>
                            <dd className="truncate">{order.ticketSummary}</dd>
                        </div>
                    ) : null}
                </dl>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Badge entry={paymentStatus} term="Pembayaran" />
                    <Badge entry={fulfilment} term="Tiket" />
                    {refundStatus ? (
                        <Badge entry={refundStatus} term="Refund" />
                    ) : null}
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-3">
                    <span className="text-sm font-bold text-ink-900">
                        {formatIdr(Number(order.total))}
                    </span>
                    <span className="text-xs font-bold text-brand-700">
                        Lihat pesanan →
                    </span>
                </div>
            </div>
        </Link>
    );
}

/**
 * A labelled status chip.
 *
 * The term is rendered as visible text rather than as `sr-only`, because "Lunas" alone is
 * ambiguous in a list that also carries an order status and a refund status — the buyer should
 * not have to infer which of the three a badge belongs to.
 */
function Badge({
    term,
    entry,
}: {
    term: string;
    entry: { label: string; className: string };
}) {
    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[0.7rem] font-bold ring-1 ring-inset ${entry.className}`}
        >
            <span className="font-semibold opacity-70">{term}</span>
            {entry.label}
        </span>
    );
}
