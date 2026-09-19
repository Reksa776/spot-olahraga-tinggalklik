import { notFound } from "next/navigation";

import {
    DataRow,
    DataTable,
    PageHeader,
    SectionCard,
    StatCard,
    StatusBadge,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { getDashboardOrder } from "@/lib/dashboard/orders";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * One order: money snapshot, payments and issued tickets.
 *
 * `getDashboardOrder` scopes the lookup to the organizers the actor may read orders in, so a
 * guessed order number belonging to another tenant resolves to `null` and renders the
 * not-found boundary — no cross-tenant existence leak.
 *
 * Payment instructions are shown exactly as the gateway returned them (VA number, QR image).
 * Nothing on this page can mark an order paid; that transition belongs to the verified
 * webhook alone.
 */

export const dynamic = "force-dynamic";

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

const ORDER_TONE: Record<string, Tone> = {
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

export default async function DashboardOrderDetailPage({
    params,
}: {
    params: Promise<{ orderNumber: string }>;
}) {
    const { orderNumber } = await params;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    const order = await getDashboardOrder(scope, orderNumber);

    if (!order) {
        notFound();
    }

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                <TextLink href="/dashboard/orders">← Semua pesanan</TextLink>
                <PageHeader
                    eyebrow="Dashboard · Pesanan"
                    title={order.orderNumber}
                    description={`${order.event.title} · ${order.organizer.name}`}
                />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <StatCard
                    label="Total"
                    value={formatIdr(Number(order.total))}
                    hint={`Subtotal ${formatIdr(Number(order.subtotal))}`}
                />
                <StatCard
                    label="Status pesanan"
                    value={
                        <StatusBadge tone={ORDER_TONE[order.status] ?? "neutral"}>
                            {order.status}
                        </StatusBadge>
                    }
                />
                <StatCard
                    label="Status pembayaran"
                    value={
                        <StatusBadge
                            tone={PAYMENT_TONE[order.paymentStatus] ?? "neutral"}
                        >
                            {order.paymentStatus}
                        </StatusBadge>
                    }
                    hint={order.paidAt ? `Dibayar ${DATE_FORMAT.format(order.paidAt)}` : undefined}
                />
            </div>

            <SectionCard title="Pembeli">
                <div className="flex flex-col">
                    <DataRow
                        divider={false}
                        title="Nama"
                        trailing={order.buyerName}
                    />
                    <DataRow title="Email" trailing={order.buyerEmail ?? "—"} />
                    <DataRow title="Telepon" trailing={order.buyerPhone ?? "—"} />
                    <DataRow
                        title="Dibuat"
                        trailing={DATE_FORMAT.format(order.createdAt)}
                    />
                </div>
            </SectionCard>

            <SectionCard title="Item">
                <DataTable
                    minWidth={480}
                    columns={[
                        { header: "Jenis tiket" },
                        { header: "Jumlah", align: "right" },
                    ]}
                    rows={order.items.map((item) => ({
                        key: item.id,
                        cells: [
                            <span key="name" className="text-sm">
                                {item.nameSnapshot}
                            </span>,
                            <span key="qty" className="text-sm tabular-nums">
                                {item.quantity}
                            </span>,
                        ],
                    }))}
                    empty={null}
                />
            </SectionCard>

            <SectionCard
                title="Pembayaran"
                description="Instruksi berasal dari respons gateway. Tidak ada tombol yang mengubah status pembayaran secara manual."
            >
                <DataTable
                    minWidth={860}
                    columns={[
                        { header: "Metode" },
                        { header: "Alur" },
                        { header: "Nomor / instruksi" },
                        { header: "Jumlah", align: "right" },
                        { header: "Status" },
                        { header: "Kedaluwarsa" },
                    ]}
                    rows={order.payments.map((payment) => ({
                        key: payment.id,
                        cells: [
                            <span key="method" className="text-sm">
                                {payment.method}
                                {payment.channel ? ` · ${payment.channel}` : ""}
                            </span>,
                            <span key="flow" className="text-xs text-muted-foreground">
                                {payment.providerFlow ?? "—"}
                            </span>,
                            <span key="no" className="font-mono text-xs">
                                {payment.paymentNumber ??
                                    (payment.paymentUrl ? "Halaman pembayaran" : "—")}
                            </span>,
                            <span key="amount" className="text-sm tabular-nums">
                                {formatIdr(Number(payment.amount))}
                            </span>,
                            <StatusBadge
                                key="status"
                                tone={PAYMENT_TONE[payment.status] ?? "neutral"}
                            >
                                {payment.status}
                            </StatusBadge>,
                            <span key="expiry" className="text-xs text-muted-foreground">
                                {payment.providerExpiredAt
                                    ? DATE_FORMAT.format(payment.providerExpiredAt)
                                    : "—"}
                            </span>,
                        ],
                    }))}
                    empty={null}
                />
            </SectionCard>

            <SectionCard title="Tiket">
                <DataTable
                    minWidth={640}
                    columns={[
                        { header: "Kode" },
                        { header: "Peserta" },
                        { header: "Status" },
                        { header: "Check-in" },
                    ]}
                    rows={order.tickets.map((ticket) => ({
                        key: ticket.id,
                        cells: [
                            <span key="code" className="font-mono text-xs">
                                {ticket.ticketCode}
                            </span>,
                            <span key="attendee" className="text-sm">
                                {ticket.attendeeName ?? "—"}
                            </span>,
                            <StatusBadge key="status" tone="neutral">
                                {ticket.status}
                            </StatusBadge>,
                            <span key="checkin" className="text-xs text-muted-foreground">
                                {ticket.checkedInAt
                                    ? DATE_FORMAT.format(ticket.checkedInAt)
                                    : "—"}
                            </span>,
                        ],
                    }))}
                    empty={null}
                />
            </SectionCard>
        </div>
    );
}
