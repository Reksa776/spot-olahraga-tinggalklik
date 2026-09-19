import type { OrderStatus } from "@prisma/client";

import {
    DataTable,
    EmptyBlock,
    LinkPagination,
    PageHeader,
    StatusBadge,
    TableToolbar,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { listDashboardOrders } from "@/lib/dashboard/orders";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * Orders.
 *
 * Read-only, scoped to the organizers the actor may read orders in. No control on this page
 * can change an order's status or amount — the design forbids admin control of money, and
 * the order lifecycle is driven by checkout, payment and the verified webhook.
 */

export const dynamic = "force-dynamic";

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

const VALID_STATUSES: OrderStatus[] = [
    "PENDING_PAYMENT",
    "PAID",
    "CANCELLED",
    "EXPIRED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
];

function parseStatus(value: string | undefined): OrderStatus | null {
    return value && (VALID_STATUSES as string[]).includes(value)
        ? (value as OrderStatus)
        : null;
}

export default async function DashboardOrdersPage({
    searchParams,
}: {
    searchParams: Promise<{
        status?: string;
        page?: string;
        q?: string;
        review?: string;
    }>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    const status = parseStatus(params.status);
    const page = params.page ? Number(params.page) : 1;
    // PHASE 18B (D-P17-17 / D-P17-18): the "needs attention" view. It is a READ filter on
    // two recoverable states, and review mode deliberately ignores the status filter so an
    // operator sees the whole worklist in one place.
    const needsReview = params.review === "1";

    const result = await listDashboardOrders(scope, {
        status: needsReview ? null : status,
        q: params.q ?? null,
        needsReview,
        page,
        limit: 20,
    });

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Pesanan"
                description="Pesanan tiket dari event yang bisa kamu akses. Total diambil dari snapshot harga saat pemesanan, bukan dari harga tiket saat ini."
            />

            {/*
                PHASE 18B (D-P17-17 / D-P17-18) — the two recoverable states the product
                decisions left manual get a worklist instead of an automatic resolution:
                a late settlement (money in, fulfilment blocked) and a paid order with no
                tickets (issuance is buyer-triggered). Nothing here issues a ticket or
                restores inventory; it only makes the cases findable.
            */}
            <TableToolbar>
                <div className="flex items-center gap-4 text-sm">
                    <TextLink href="/dashboard/orders">
                        {needsReview ? "Semua pesanan" : "• Semua pesanan"}
                    </TextLink>
                    <TextLink href="/dashboard/orders?review=1">
                        {needsReview ? "• Perlu tindakan" : "Perlu tindakan"}
                    </TextLink>
                    <span className="text-xs text-muted-foreground">
                        Pembayaran terlambat &amp; pesanan sudah dibayar tetapi tiket belum
                        terbit
                    </span>
                </div>
            </TableToolbar>

            <DataTable
                minWidth={1060}
                empty={
                    <EmptyBlock
                        title={
                            needsReview
                                ? "Tidak ada pesanan yang perlu tindakan"
                                : "Belum ada pesanan"
                        }
                        description={
                            needsReview
                                ? "Tidak ada pembayaran terlambat dan tidak ada pesanan yang sudah dibayar tetapi belum menerbitkan tiket."
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
                    { header: "Perlu tindakan" },
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
                            status: params.status,
                            q: params.q,
                            review: params.review,
                        }}
                        label="Halaman"
                    />
                }
            />
        </div>
    );
}
