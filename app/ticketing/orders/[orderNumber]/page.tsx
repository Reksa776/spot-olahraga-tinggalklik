import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import ReloadButton from "@/components/errors/ReloadButton";
import ServiceUnavailableState from "@/components/errors/ServiceUnavailableState";
import CancelOrderButton from "@/components/orders/CancelOrderButton";
import PayNowButton from "@/components/orders/PayNowButton";
import RequestRefundButton from "@/components/orders/RequestRefundButton";
import PaymentInstruction from "@/components/ticketing/PaymentInstruction";
import RefreshOrderStatus from "@/components/orders/RefreshOrderStatus";
import ReservationCountdown from "@/components/orders/ReservationCountdown";
import IssueTicketsButton from "@/components/tickets/IssueTicketsButton";
import SiteShell from "@/components/ticketing/SiteShell";
import { loginUrlFor } from "@/lib/auth/redirect";
import { getAuthzScope } from "@/lib/authz";
import { resolvePageFailure } from "@/lib/errors/classify";
import type { OrderPayload } from "@/lib/ticketing/order-payload";
import { getOwnOrder } from "@/lib/ticketing/orders";
import {
    formatEventDateLong,
    formatEventTime,
    formatIdr,
    pluralTickets,
} from "@/lib/ticketing/ui/format";

/**
 * ==========================================
 * PHASE 9 — ORDER CONFIRMATION / PAYMENT
 * ==========================================
 *
 * The page now answers three separate questions in one glance, which is what a buyer actually
 * needs after checkout:
 *
 *   1. **Pesanan** — the order's own status (`PENDING_PAYMENT`, `PAID`, `CANCELLED`, `EXPIRED`).
 *   2. **Pembayaran** — the payment status Phase 7 settles, from the order row.
 *   3. **Tiket** — whether the tickets exist yet, and if not, the one action that creates them.
 *
 * All three are read from the server payload (`order.status`, `order.paymentStatus`,
 * `order.tickets`, `order.canIssueTickets`). No state is invented, and nothing here derives "paid"
 * from a redirect, a query parameter or a browser timer (brief §21/§22).
 *
 * ── WHERE PAYMENT TRUTH COMES FROM ────────────────────────────────────────────────
 * The order row, always. `paymentUrl` is populated only from a live provider session, and the
 * gateway's return lands on this URL with no parameters that mean anything; the buyer presses
 * "Perbarui status", which re-reads the database. A payment is confirmed by the verified provider
 * webhook and by nothing else (design §31.5 rule 3).
 *
 * ── MONEY ─────────────────────────────────────────────────────────────────────────
 * Display only. The value of record is the `Decimal(14,2)` column and the payload carries it as a
 * string (D-61); `Number(...)` appears only inside this formatter and is never written back.
 *
 * ── AUTHORIZATION ─────────────────────────────────────────────────────────────────
 * Unchanged: the page resolves the session itself and `getOwnOrder` applies the ownership
 * predicate, so a missing session redirects to login and another buyer's order is a 404 — never a
 * page that confirms it exists.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Pesanan tiket",
    robots: { index: false, follow: false },
};

/** Buyer-facing label for the order's own `OrderStatus`. */
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

/** Buyer-facing label for the order's `PaymentStatus`. */
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

type Props = { params: Promise<{ orderNumber: string }> };

export default async function OrderPage({ params }: Props) {
    const { orderNumber } = await params;

    const selfPath = `/ticketing/orders/${orderNumber}`;

    const scope = await getAuthzScope();

    if (!scope) {
        redirect(loginUrlFor(selfPath));
    }

    /*
     * ── ONE CATCH, FOUR OUTCOMES (Phase: global error handling) ──────────────────
     *
     * This used to be `getOwnOrder(...).catch(() => null)` followed by `notFound()`, which
     * reported EVERY failure as "this order does not exist" — a database outage, a timeout and
     * a genuine 404 were indistinguishable, and the retry the buyer needed was never offered.
     *
     * The failure is now classified once (`resolvePageFailure`) and mapped to the response it
     * actually deserves:
     *
     *   not-found   → 404. The order is not this buyer's (the ownership predicate ran first,
     *                 so a foreign order never gets here as anything else) or does not exist.
     *   denied      → ALSO 404, and deliberately. This page's privacy contract is
     *                 indistinguishability (design §7.4, brief §14): a 403 would confirm that
     *                 the order exists. That is the ONE place in this phase where an
     *                 authorization failure is intentionally rendered as not-found, and it is
     *                 stated here rather than hidden in the classifier.
     *   sign-in     → back to login, carrying where the buyer was (the callbackUrl the form
     *                 actually reads).
     *   unavailable → a RETRYABLE error state inside the page. A database that cannot be
     *                 reached must never look like a missing order.
     *
     * Anything else is re-thrown and reaches `app/ticketing/error.tsx`, which offers a retry
     * rather than pretending the order is gone.
     */
    let order: OrderPayload;

    try {
        order = await getOwnOrder(orderNumber, scope);
    } catch (error) {
        const failure = resolvePageFailure(error);

        if (failure.action === "not-found") {
            notFound();
        }

        if (failure.action === "denied") {
            // See the note above: 404 by design on this surface.
            notFound();
        }

        if (failure.action === "sign-in") {
            redirect(loginUrlFor(selfPath));
        }

        if (failure.action === "unavailable") {
            return (
                <SiteShell>
                    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
                        <ServiceUnavailableState reference={failure.classification.code}>
                            <ReloadButton />
                            <Link
                                href="/ticketing/tickets"
                                className="rounded-xl px-4 py-2.5 text-sm font-semibold text-ink-600 transition hover:text-ink-900"
                            >
                                Lihat tiket saya
                            </Link>
                        </ServiceUnavailableState>
                    </div>
                </SiteShell>
            );
        }

        // Unexpected: an application bug belongs in the log, not dressed up as a 404.
        throw error;
    }

    const orderStatus = ORDER_STATUS[order.status] ?? {
        label: order.status,
        className: "bg-ink-100 text-ink-600 ring-ink-200",
    };
    const paymentStatus = PAYMENT_STATUS[order.paymentStatus] ?? {
        label: order.paymentStatus,
        className: "bg-ink-100 text-ink-600 ring-ink-200",
    };

    const isPending = order.status === "PENDING_PAYMENT";

    /**
     * Whether the server would accept a refund request from this page.
     *
     * Advisory only, derived from the payload's own ticket statuses — the refund service
     * re-derives every rule (payment state, window, per-ticket claims) and refuses on its own.
     * The full request is offered only while EVERY ticket is still ISSUED, so this button can
     * never send a set the policy would reject for a checked-in ticket.
     */
    const isPaid =
        order.paymentStatus === "PAID" ||
        order.paymentStatus === "PARTIALLY_REFUNDED";
    const canRequestRefund =
        isPaid &&
        order.tickets.length > 0 &&
        order.tickets.every((ticket) => ticket.status === "ISSUED");

    // Names for held reservations come from the order's own lines, matched on ticket type id — the
    // reservation carries no name, and the payload deliberately exposes no ticket-type internals.
    const itemsById = new Map(
        order.items.map((item) => [item.ticketTypeId ?? "", item])
    );

    return (
        <SiteShell>
            <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:py-12">
                <Link
                    href="/events"
                    className="inline-flex items-center gap-2 text-sm font-semibold text-ink-500 transition hover:text-ink-900"
                >
                    <span aria-hidden>←</span> Semua event
                </Link>

                <div className="mt-4 overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-sm">
                    {/* ── Header ────────────────────────────────────────────── */}
                    <header className="border-b border-ink-100 bg-ink-50/60 px-5 py-5 sm:px-6">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                                <h1 className="text-lg font-extrabold tracking-tight text-ink-900">
                                    Pesanan tiket
                                </h1>
                                <p className="mt-1 font-mono text-sm text-ink-600">
                                    {order.orderNumber}
                                </p>
                                <p className="mt-0.5 text-xs text-ink-400">
                                    Dibuat{" "}
                                    {formatEventDateLong(order.createdAt)} ·{" "}
                                    {formatEventTime(order.createdAt)} WIB
                                </p>
                            </div>

                            <span
                                className={`rounded-full px-3 py-1 text-xs font-bold ring-1 ring-inset ${orderStatus.className}`}
                            >
                                {orderStatus.label}
                            </span>
                        </div>

                        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                            <StatusCell
                                term="Pesanan"
                                entry={orderStatus}
                            />
                            <StatusCell
                                term="Pembayaran"
                                entry={paymentStatus}
                            />
                            <StatusCell
                                term="Tiket"
                                entry={fulfilmentStatus(order)}
                            />
                        </dl>

                        {isPending && order.expiresAt ? (
                            <div className="mt-4">
                                <ReservationCountdown expiresAt={order.expiresAt} />
                            </div>
                        ) : null}
                    </header>

                    <div className="px-5 py-5 sm:px-6">
                        {/* ── Event ─────────────────────────────────────────── */}
                        <section>
                            <h2 className="text-base font-extrabold text-ink-900">
                                {order.event.title}
                            </h2>
                            <dl className="mt-2 space-y-1.5 text-sm text-ink-500">
                                <div className="flex items-center gap-2">
                                    <dt className="sr-only">Jadwal</dt>
                                    <dd>
                                        {formatEventDateLong(order.event.startAt)}{" "}
                                        · {formatEventTime(order.event.startAt)} WIB
                                    </dd>
                                </div>
                                {order.event.venueName ? (
                                    <div className="flex items-center gap-2">
                                        <dt className="sr-only">Lokasi</dt>
                                        <dd>{order.event.venueName}</dd>
                                    </div>
                                ) : null}
                            </dl>

                            <Link
                                href={`/e/${order.event.slug}`}
                                className="mt-2 inline-block text-sm font-semibold text-brand-700 hover:text-brand-800"
                            >
                                Lihat halaman event →
                            </Link>
                        </section>

                        {/* ── Lines ─────────────────────────────────────────── */}
                        <section className="mt-7">
                            <h2 className="text-xs font-bold tracking-wider text-ink-400 uppercase">
                                Rincian tiket
                            </h2>

                            <ul className="mt-3 divide-y divide-ink-100 border-y border-ink-100">
                                {order.items.map((item, index) => (
                                    <li
                                        key={`${item.ticketTypeId ?? "removed"}-${index}`}
                                        className="flex items-center justify-between gap-4 py-3"
                                    >
                                        <div className="min-w-0">
                                            <p className="text-sm font-bold text-ink-900">
                                                {item.name}
                                            </p>
                                            <p className="mt-0.5 text-xs text-ink-500">
                                                {formatIdr(Number(item.unitPrice))}{" "}
                                                × {item.quantity}
                                            </p>
                                        </div>
                                        <p className="shrink-0 text-sm font-bold text-ink-900">
                                            {formatIdr(Number(item.subtotal))}
                                        </p>
                                    </li>
                                ))}
                            </ul>

                            <dl className="mt-4 space-y-1.5 text-sm">
                                <Row
                                    term="Subtotal"
                                    value={formatIdr(Number(order.totals.subtotal))}
                                />

                                {/* Zero-fee rows are omitted rather than shown as "Rp0": the
                                    platform fee and PIC fee are unresolved decisions (D-22),
                                    so the baseline is zero and a zero row is noise. */}
                                {Number(order.totals.discount) !== 0 ? (
                                    <Row
                                        term="Diskon"
                                        value={`− ${formatIdr(
                                            Math.abs(Number(order.totals.discount))
                                        )}`}
                                    />
                                ) : null}
                                {Number(order.totals.platformFee) !== 0 ? (
                                    <Row
                                        term="Biaya layanan"
                                        value={formatIdr(
                                            Number(order.totals.platformFee)
                                        )}
                                    />
                                ) : null}

                                <div className="flex items-center justify-between border-t border-ink-100 pt-2.5 text-base font-extrabold text-ink-900">
                                    <dt>Total</dt>
                                    <dd>{formatIdr(Number(order.totals.total))}</dd>
                                </div>
                            </dl>
                        </section>

                        {/* ── Held quota (pending only) ──────────────────────── */}
                        {isPending && order.reservations.length > 0 ? (
                            <section className="mt-6 rounded-2xl bg-ink-50 p-4">
                                <h2 className="text-xs font-bold tracking-wider text-ink-500 uppercase">
                                    Tiket yang ditahan
                                </h2>
                                <ul className="mt-2 space-y-1 text-sm text-ink-700">
                                    {order.reservations.map((reservation) => (
                                        <li key={reservation.ticketTypeId}>
                                            {itemsById.get(reservation.ticketTypeId)
                                                ?.name ?? "Tiket"}{" "}
                                            × {reservation.quantity}
                                        </li>
                                    ))}
                                </ul>
                                <p className="mt-2 text-xs leading-relaxed text-ink-500">
                                    Tiket ditahan sampai batas waktu pembayaran.
                                    Setelah waktu habis, tiket dilepas kembali
                                    secara otomatis.
                                </p>
                            </section>
                        ) : null}

                        {/* ── Awaiting payment ──────────────────────────────── */}
                        {isPending && order.paymentStatus !== "PAID" ? (
                            <section className="mt-7 border-t border-ink-100 pt-6">
                                {/*
                                 * A live instruction is shown INSTEAD of the method picker: the
                                 * buyer has already chosen, the gateway has already issued the
                                 * QR/account number, and asking again would invite a second
                                 * parallel attempt for one order. `paymentInstruction` is null
                                 * unless the newest attempt is still PENDING, so a paid or
                                 * expired attempt renders nothing here.
                                 */}
                                {order.paymentInstruction ? (
                                    <PaymentInstruction
                                        instruction={order.paymentInstruction}
                                        amount={order.totals.total}
                                        orderNumber={order.orderNumber}
                                    />
                                ) : order.canPay ? (
                                    <PayNowButton
                                        orderNumber={order.orderNumber}
                                        paymentUrl={order.paymentUrl}
                                    />
                                ) : (
                                    <p className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">
                                        Waktu pembayaran untuk pesanan ini sudah
                                        lewat, sehingga pembayaran baru tidak dapat
                                        dimulai. Perbarui status untuk melihat
                                        keadaan terakhir.
                                    </p>
                                )}

                                <div className="mt-4 flex flex-wrap items-center gap-3">
                                    <RefreshOrderStatus />
                                    {order.canCancel ? (
                                        <CancelOrderButton
                                            orderNumber={order.orderNumber}
                                        />
                                    ) : null}
                                </div>
                            </section>
                        ) : null}

                        {/* ── Paid: fulfilment ──────────────────────────────── */}
                        {isPaid ? (
                            <section className="mt-7 border-t border-ink-100 pt-6">
                                <p className="text-sm font-bold text-emerald-800">
                                    Pembayaran sudah diterima
                                    {order.paidAt
                                        ? ` pada ${formatEventDateLong(
                                              order.paidAt
                                          )} · ${formatEventTime(order.paidAt)} WIB`
                                        : ""}
                                    .
                                </p>

                                {order.tickets.length > 0 ? (
                                    <div className="mt-4 rounded-2xl bg-ink-50 p-4">
                                        <h2 className="text-xs font-bold tracking-wider text-ink-500 uppercase">
                                            {pluralTickets(order.tickets.length)}{" "}
                                            siap dipakai
                                        </h2>
                                        <ul className="mt-2.5 space-y-2">
                                            {order.tickets.map((ticket) => (
                                                <li
                                                    key={ticket.ticketCode}
                                                    className="flex items-center justify-between gap-3"
                                                >
                                                    <span className="font-mono text-sm text-ink-800">
                                                        {ticket.ticketCode}
                                                    </span>
                                                    <Link
                                                        href={`/ticketing/tickets/${ticket.ticketCode}`}
                                                        className="text-xs font-bold text-brand-700 hover:underline"
                                                    >
                                                        Lihat tiket
                                                    </Link>
                                                </li>
                                            ))}
                                        </ul>

                                        <Link
                                            href={order.walletUrl}
                                            className="mt-4 inline-block rounded-xl bg-brand-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                                        >
                                            Buka tiket saya
                                        </Link>
                                    </div>
                                ) : order.canIssueTickets ? (
                                    <div className="mt-4">
                                        <IssueTicketsButton
                                            orderNumber={order.orderNumber}
                                            /* Server-derived, display only — the issuance
                                               service computes the real count from the
                                               order's own lines. */
                                            ticketCount={order.items.reduce(
                                                (total, item) =>
                                                    total + item.quantity,
                                                0
                                            )}
                                        />
                                    </div>
                                ) : (
                                    <p className="mt-3 rounded-2xl bg-amber-50 p-4 text-sm leading-relaxed text-amber-800">
                                        Pesanan ini sedang ditinjau operator,
                                        sehingga tiket belum dapat diterbitkan.
                                        Tim kami akan menghubungi Anda melalui
                                        kontak pada pesanan ini.
                                    </p>
                                )}

                                {/* ── Refund (Phase 10B) ───────────────────── */}
                                <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-ink-100 pt-4">
                                    {canRequestRefund ? (
                                        <RequestRefundButton
                                            orderNumber={order.orderNumber}
                                        />
                                    ) : null}

                                    <Link
                                        href="/ticketing/refunds"
                                        className="text-sm font-semibold text-ink-500 transition hover:text-ink-900"
                                    >
                                        Lihat pengajuan refund
                                    </Link>
                                </div>
                            </section>
                        ) : null}

                        {/* ── Terminal states ───────────────────────────────── */}
                        {order.status === "CANCELLED" ? (
                            <p className="mt-6 border-t border-ink-100 pt-5 text-sm leading-relaxed text-ink-600">
                                Pesanan ini sudah dibatalkan dan tiket yang ditahan
                                sudah dilepas kembali ke penjualan.
                            </p>
                        ) : null}

                        {order.status === "EXPIRED" ? (
                            <p className="mt-6 border-t border-ink-100 pt-5 text-sm leading-relaxed text-ink-600">
                                Batas waktu pembayaran terlewat, sehingga pesanan
                                ini kedaluwarsa dan tiketnya dilepas kembali ke
                                penjualan.
                            </p>
                        ) : null}
                    </div>
                </div>

                <p className="mt-5 text-xs leading-relaxed text-ink-500">
                    Simpan nomor pesanan ini. Butuh bantuan?{" "}
                    <Link
                        href="/kontak"
                        className="font-semibold text-brand-700 hover:underline"
                    >
                        Hubungi kami
                    </Link>
                    .
                </p>
            </div>
        </SiteShell>
    );
}

/**
 * The fulfilment leg, in the buyer's words.
 *
 * Three real states, derived from the payload and nothing else: tickets exist, tickets can be
 * created from this page, or the order is held by the operator (Phase 7's late-settlement flag,
 * which the UI must never "repair").
 */
function fulfilmentStatus(order: OrderPayload): {
    label: string;
    className: string;
} {
    if (order.tickets.length > 0) {
        return {
            label: `Terbit (${order.tickets.length})`,
            className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
        };
    }

    if (order.paymentStatus === "PAID" && order.canIssueTickets) {
        return {
            label: "Siap diterbitkan",
            className: "bg-sky-50 text-sky-700 ring-sky-200",
        };
    }

    if (order.paymentStatus === "PAID") {
        return {
            label: "Ditahan operator",
            className: "bg-rose-50 text-rose-700 ring-rose-200",
        };
    }

    return {
        label: "Menunggu pembayaran",
        className: "bg-ink-100 text-ink-600 ring-ink-200",
    };
}

function StatusCell({
    term,
    entry,
}: {
    term: string;
    entry: { label: string; className: string };
}) {
    return (
        <div className="rounded-xl border border-ink-100 bg-white px-3 py-2">
            <dt className="text-[0.65rem] font-bold tracking-wider text-ink-400 uppercase">
                {term}
            </dt>
            <dd
                className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[0.7rem] font-bold ring-1 ring-inset ${entry.className}`}
            >
                {entry.label}
            </dd>
        </div>
    );
}

function Row({ term, value }: { term: string; value: string }) {
    return (
        <div className="flex items-center justify-between">
            <dt className="text-ink-500">{term}</dt>
            <dd className="font-semibold text-ink-900">{value}</dd>
        </div>
    );
}
