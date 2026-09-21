import type { PaymentStatus } from "@prisma/client";

import {
    DataTable,
    EmptyBlock,
    LinkPagination,
    PageHeader,
    StatusBadge,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";
import ReconcilePaymentButton from "@/components/organizer/ReconcilePaymentButton";
import { PERMISSIONS, decideOrganizerPermission, getAuthzScope } from "@/lib/authz";
import { listDashboardPayments } from "@/lib/dashboard/payments";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * Payments.
 *
 * The back-office view of the gateway's payment attempts. Deliberately has NO "mark as paid"
 * action: `PaymentStatus` moves to PAID only through the signature-verified, idempotent
 * webhook, so an operator cannot manufacture a paid order here. The gateway-issued VA number
 * is shown so an operator can match a bank statement against it.
 *
 * ── PHASE 27E: "VERIFIKASI STATUS" IS NOT A MANUAL PAID OVERRIDE ────────────────
 * The one action added to this page ASKS the provider for the authoritative status of a
 * transaction it already knows about. The operator supplies no amount, no status and no
 * transaction id — the button sends an empty POST whose URL names the payment, and the
 * server resolves everything else. A payment changes state only when the provider's own
 * answer says it was paid, matched against the persisted transaction id, the environment,
 * the reference, the instrument and the amount. So this is the same authority the webhook
 * has, obtained over a different channel; it is not the "admin can mark it paid" control
 * the paragraph above promises is absent.
 *
 * The column is rendered only where the actor holds `payment.reconcile` in that payment's
 * own tenant, and rows whose provider transaction id was never captured show the reason
 * instead of a button — an inapplicable control is not drawn (phase 12 §15).
 */

export const dynamic = "force-dynamic";

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

const STATUS_TONE: Record<string, Tone> = {
    UNPAID: "pending",
    PENDING: "pending",
    PAID: "success",
    FAILED: "error",
    EXPIRED: "warn",
    REFUNDED: "info",
    PARTIALLY_REFUNDED: "info",
};

const VALID_STATUSES: PaymentStatus[] = [
    "UNPAID",
    "PENDING",
    "PAID",
    "FAILED",
    "EXPIRED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
];

function parseStatus(value: string | undefined): PaymentStatus | null {
    return value && (VALID_STATUSES as string[]).includes(value)
        ? (value as PaymentStatus)
        : null;
}

export default async function DashboardPaymentsPage({
    searchParams,
}: {
    searchParams: Promise<{ status?: string; page?: string; q?: string }>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    const status = parseStatus(params.status);
    const page = params.page ? Number(params.page) : 1;

    const result = await listDashboardPayments(scope, {
        status,
        q: params.q ?? null,
        page,
        limit: 20,
    });

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Pembayaran"
                description="Percobaan pembayaran pada gateway. Status berubah menjadi PAID hanya setelah webhook terverifikasi; tidak ada perubahan manual dari dashboard."
            />

            <DataTable
                minWidth={1220}
                empty={
                    <EmptyBlock
                        title="Belum ada pembayaran"
                        description="Percobaan pembayaran akan muncul di sini setelah pembeli memilih metode pembayaran."
                    />
                }
                columns={[
                    { header: "Referensi" },
                    { header: "Pesanan" },
                    { header: "Metode" },
                    { header: "Alur" },
                    { header: "Nomor VA / kode" },
                    { header: "Jumlah", align: "right" },
                    { header: "Status" },
                    { header: "Kedaluwarsa" },
                    { header: "Dibuat" },
                    { header: "Tindakan" },
                ]}
                rows={result.items.map((payment) => ({
                    key: payment.id,
                    cells: [
                        <span key="ref" className="font-mono text-xs">
                            {payment.paymentReference}
                        </span>,
                        <TextLink
                            key="order"
                            href={`/dashboard/orders/${payment.order.orderNumber}`}
                        >
                            <span className="font-mono text-xs">
                                {payment.order.orderNumber}
                            </span>
                        </TextLink>,
                        <span key="method" className="text-sm">
                            {payment.method}
                            {payment.channel ? ` · ${payment.channel}` : ""}
                        </span>,
                        <span key="flow" className="text-xs text-muted-foreground">
                            {payment.providerFlow ?? "—"}
                        </span>,
                        <span key="number" className="font-mono text-xs">
                            {payment.paymentNumber ??
                                (payment.paymentUrl ? "Halaman pembayaran" : "—")}
                        </span>,
                        <span key="amount" className="text-sm font-semibold tabular-nums">
                            {formatIdr(Number(payment.amount))}
                        </span>,
                        <StatusBadge
                            key="status"
                            tone={STATUS_TONE[payment.status] ?? "neutral"}
                        >
                            {payment.status}
                        </StatusBadge>,
                        <span key="expiry" className="text-xs text-muted-foreground">
                            {payment.providerExpiredAt
                                ? DATE_FORMAT.format(payment.providerExpiredAt)
                                : "—"}
                        </span>,
                        <span key="created" className="text-xs text-muted-foreground">
                            {DATE_FORMAT.format(payment.createdAt)}
                        </span>,
                        decideOrganizerPermission(
                            scope,
                            payment.organizer.id,
                            PERMISSIONS.PAYMENT_RECONCILE
                        ).allowed ? (
                            <ReconcilePaymentButton
                                key="action"
                                paymentReference={payment.paymentReference}
                                hasProviderTransactionId={
                                    payment.providerTransactionId !== null
                                }
                            />
                        ) : (
                            <span
                                key="action"
                                className="text-xs text-muted-foreground"
                            >
                                —
                            </span>
                        ),
                    ],
                }))}
                footer={
                    <LinkPagination
                        page={page}
                        totalPages={result.pagination.totalPages}
                        basePath="/dashboard/payments"
                        query={{ status: params.status, q: params.q }}
                        label="Halaman"
                    />
                }
            />
        </div>
    );
}
