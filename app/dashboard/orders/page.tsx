import type { OrderStatus, PaymentStatus } from "@prisma/client";

import { FilterBar } from "@/components/dashboard/filters/FilterBar";
import { buildFilterField } from "@/components/dashboard/filters/filter-types";
import {
    DataTable,
    EmptyBlock,
    LinkPagination,
    PageHeader,
    StatusBadge,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from "@/lib/dashboard/filter-options";
import {
    ORDER_STATUS_FILTERS,
    PAYMENT_STATUS_FILTERS,
    listDashboardOrders,
} from "@/lib/dashboard/orders";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * Orders.
 *
 * Read-only, scoped to the organizers the actor may read orders in. No control on this page
 * can change an order's status or amount — the design forbids admin control of money, and
 * the order lifecycle is driven by checkout, payment and the verified webhook.
 *
 * ── ONE STATUS FILTER: THE GATEWAY PAYMENT STATE ───────────────────────────────
 * `Status pembayaran` is the ONE status filter this page offers, as a row of visible pills, plus a
 * search box:
 *
 *   paymentStatus   `EventOrder.paymentStatus` — the GATEWAY column, a lifecycle of its own. A late
 *                   settlement leaves a TERMINAL order status (`CANCELLED`/`EXPIRED`) while the
 *                   payment is `PAID`, which is why the "Tiket terjual" tile links here with
 *                   `paymentStatus=PAID` and never with `status=PAID`;
 *   q               the free-text search the read model already implemented (order number, buyer
 *                   name, buyer email).
 *
 * Two order-status concepts deliberately NO LONGER have a control here, because a two-status-model
 * choice on one list is what made this page ambiguous:
 *
 *   status          the ORDER lifecycle. The pill row is gone; a validated `?status=` is still
 *                   HONOURED, because the overview's "Menunggu bayar" tile deep-links to
 *                   `/dashboard/orders?status=PENDING_PAYMENT` and that drill-down must keep
 *                   working. It is stated in the bar's `hint` when it is in force, so the table
 *                   never narrows invisibly — but it is not a choosable filter any more;
 *   review=1        the operator worklist. The control, the `?review=1` link and the page's
 *                   parameter are gone. The read-model capability is UNCHANGED (`needsReview` is
 *                   still what the reconciliation read path uses; see `lib/dashboard/orders.ts`),
 *                   so nothing in the backend lost a predicate to make this legible.
 *
 * `status` and `paymentStatus` remain SIBLING `where` keys in the read model, so when a deep link
 * carries a status it is AND-ed with the payment filter — one narrows the other, it never replaces
 * it.
 */

export const dynamic = "force-dynamic";

/** Browser tab title. The brand suffix is composed by the root layout's `title.template`. */
export const metadata = { title: "Orders" };

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

const STATUS_TONE: Record<string, Tone> = {
    PENDING_PAYMENT: "pending",
    PAID: "success",
    CANCELLED: "neutral",
    EXPIRED: "warn",
    REFUNDED: "info",
    PARTIALLY_REFUNDED: "info",
};

const PAYMENT_TONE: Record<string, Tone> = {
    UNPAID: "pending",
    PENDING: "pending",
    PAID: "success",
    FAILED: "error",
    EXPIRED: "warn",
    REFUNDED: "info",
    PARTIALLY_REFUNDED: "info",
};

/*
 * Both vocabularies come from the read model, which is where the two lifecycles are defined, so the
 * page cannot validate against a list that has drifted from the predicates it feeds.
 */
const VALID_STATUSES = ORDER_STATUS_FILTERS;
const VALID_PAYMENT_STATUSES = PAYMENT_STATUS_FILTERS;

/** The order lifecycle, validated. Only a deep link ever supplies one. */
function parseStatus(value: string | undefined): OrderStatus | null {
    return value && (VALID_STATUSES as readonly string[]).includes(value)
        ? (value as OrderStatus)
        : null;
}

function parsePaymentStatus(
    value: string | string[] | undefined
): PaymentStatus | null {
    const raw = Array.isArray(value) ? value[0] : value;

    return raw && (VALID_PAYMENT_STATUSES as readonly string[]).includes(raw)
        ? (raw as PaymentStatus)
        : null;
}

export default async function DashboardOrdersPage({
    searchParams,
}: {
    searchParams: Promise<{
        status?: string | string[];
        paymentStatus?: string | string[];
        page?: string;
        q?: string;
    }>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    /*
     * A deep-linked order status, validated against `OrderStatus` before it reaches Prisma. It has no
     * control any more, but it is still forwarded: the "Menunggu bayar" tile's drill-down depends on
     * it, and dropping it would make that tile open a list of every order.
     */
    const status = parseStatus(Array.isArray(params.status) ? params.status[0] : params.status);
    const paymentStatus = parsePaymentStatus(params.paymentStatus);
    const page = params.page ? Number(params.page) : 1;

    const result = await listDashboardOrders(scope, {
        status,
        paymentStatus,
        q: params.q ?? null,
        page,
        limit: 20,
    });

    /* The ONE filter field this page owns. */
    const paymentStatusField = buildFilterField({
        name: "paymentStatus",
        label: "Status pembayaran",
        allLabel: "Semua pembayaran",
        values: paymentStatus ? [paymentStatus] : [],
        members: VALID_PAYMENT_STATUSES,
        labels: PAYMENT_STATUS_LABELS,
    });

    /*
     * The deep link, stated rather than offered: the order status a KPI carried in, and the link
     * that clears it. Deliberately NOT a pill row — there is nothing here to choose from, and the
     * "status pesanan" filter is not part of this page's filter surface.
     */
    const deepLinkHint = status
        ? `Menampilkan pesanan dengan status pesanan ${ORDER_STATUS_LABELS[status] ?? status} (dari kartu dashboard). `
        : null;

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Pesanan"
                description="Pesanan tiket dari event yang bisa kamu akses. Total diambil dari snapshot harga saat pemesanan, bukan dari harga tiket saat ini."
            />

            <FilterBar
                basePath="/dashboard/orders"
                /*
                 * `status` rides along so a deep-linked drill-down survives a payment-filter change
                 * and pagination — the read model ANDs the two.
                 */
                current={{
                    status: status ?? undefined,
                    paymentStatus: paymentStatus ?? undefined,
                    q: params.q,
                }}
                fields={[paymentStatusField]}
                search={{
                    label: "Cari pesanan",
                    placeholder: "Nomor pesanan, pembeli, atau email",
                    value: params.q,
                }}
                hint={
                    deepLinkHint ? (
                        <>
                            {deepLinkHint}
                            <TextLink href="/dashboard/orders">
                                Tampilkan semua pesanan
                            </TextLink>
                        </>
                    ) : (
                        "Status pembayaran adalah kolom gateway (paymentStatus), terpisah dari status pesanan."
                    )
                }
            />

            <DataTable
                minWidth={1060}
                empty={
                    <EmptyBlock
                        title={
                            status
                                ? `Tidak ada pesanan berstatus ${ORDER_STATUS_LABELS[status] ?? status}`
                                : "Belum ada pesanan"
                        }
                        description={
                            status
                                ? "Tidak ada pesanan dengan status pesanan itu pada event yang bisa kamu akses."
                                : "Pesanan akan muncul di sini setelah pembeli menyelesaikan checkout."
                        }
                    />
                }
                columns={[
                    { header: "Pesanan" },
                    { header: "Pembeli" },
                    { header: "Event" },
                    { header: "Tiket", align: "right" },
                    { header: "Total", align: "right" },
                    { header: "Status" },
                    { header: "Pembayaran" },
                    /*
                     * The read-only operational signal, kept: a late settlement and a paid order with
                     * no tickets are exactly the states an operator must be able to SEE (see
                     * `lib/dashboard/orders.ts`). The header no longer repeats the removed worklist
                     * filter's name, so the column reads as information rather than as the ghost of a
                     * filter that is gone.
                     */
                    { header: "Perhatian" },
                    { header: "Dibuat" },
                ]}
                rows={result.items.map((order) => ({
                    key: order.id,
                    cells: [
                        <TextLink
                            key="number"
                            href={`/dashboard/orders/${order.orderNumber}`}
                        >
                            <span className="font-mono text-xs">
                                {order.orderNumber}
                            </span>
                        </TextLink>,
                        <div className="flex flex-col" key="buyer">
                            <span className="text-sm font-semibold">
                                {order.buyerName}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {order.buyerEmail ?? order.buyerPhone ?? "—"}
                            </span>
                        </div>,
                        <span className="text-sm" key="event">
                            {order.event.title}
                        </span>,
                        <span className="text-sm tabular-nums" key="tickets">
                            {order._count.tickets}
                        </span>,
                        <span className="text-sm font-semibold tabular-nums" key="total">
                            {formatIdr(Number(order.total))}
                        </span>,
                        <StatusBadge
                            key="status"
                            tone={STATUS_TONE[order.status] ?? "neutral"}
                        >
                            {order.status}
                        </StatusBadge>,
                        <StatusBadge
                            key="payment"
                            tone={PAYMENT_TONE[order.paymentStatus] ?? "neutral"}
                        >
                            {order.paymentStatus}
                        </StatusBadge>,
                        <div className="flex flex-col gap-1" key="attention">
                            {order.fulfilmentBlockedAt !== null ? (
                                <StatusBadge tone="error">
                                    Pembayaran terlambat
                                </StatusBadge>
                            ) : null}
                            {order.status === "PAID" &&
                            order._count.tickets === 0 ? (
                                <StatusBadge tone="warn">
                                    Tiket belum terbit
                                </StatusBadge>
                            ) : null}
                            {order.fulfilmentBlockedAt === null &&
                            !(
                                order.status === "PAID" &&
                                order._count.tickets === 0
                            ) ? (
                                <span className="text-xs text-muted-foreground">
                                    —
                                </span>
                            ) : null}
                        </div>,
                        <span
                            key="created"
                            className="text-xs text-muted-foreground"
                        >
                            {DATE_FORMAT.format(order.createdAt)}
                        </span>,
                    ],
                }))}
                footer={
                    <LinkPagination
                        page={page}
                        totalPages={result.pagination.totalPages}
                        basePath="/dashboard/orders"
                        query={{
                            status: status ?? undefined,
                            paymentStatus: paymentStatus ?? undefined,
                            q: params.q,
                        }}
                        label="Halaman"
                    />
                }
            />
        </div>
    );
}
