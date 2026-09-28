import type { PaymentStatus } from "@prisma/client";

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
import ReconcilePaymentButton from "@/components/organizer/ReconcilePaymentButton";
import { PERMISSIONS, decideOrganizerPermission, getAuthzScope } from "@/lib/authz";
import { PAYMENT_STATUS_LABELS } from "@/lib/dashboard/filter-options";
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
 * ── THE STATUS FILTER WAS ALREADY IMPLEMENTED AND INVISIBLE ─────────────────────
 * `?status=` has been parsed and forwarded to `listDashboardPayments` since the page was written,
 * but no control ever rendered it — the filter existed only for someone who typed the URL. It is now
 * a visible row of pills over the SAME validated enum members, so nothing about the query changes; the
 * accepted values are exactly the ones `parseStatus` already narrowed against.
 *
 * ── THE RECONCILIATION WORKLIST BECOMES USABLE ──────────────────────────────────
 * `lib/dashboard/payments.ts` describes this list as the reconciliation worklist and notes that "the
 * table already searches by payment reference and order number". That was true of the read model and
 * of no visible control. The search box is the missing half: an operator holding a stuck payment's
 * reference can now find it and verify it in one click. The per-row action is unchanged, and it is
 * still the only thing on this page that can move a payment's state — by ASKING the provider, never
 * by asserting.
 *
 * The column is rendered only where the actor holds `payment.reconcile` in that payment's
 * own tenant, and rows whose provider transaction id was never captured show the reason
 * instead of a button — an inapplicable control is not drawn (phase 12 §15).
 */

export const dynamic = "force-dynamic";

/** Browser tab title. The brand suffix is composed by the root layout's `title.template`. */
export const metadata = { title: "Payments" };

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

    const statusField = buildFilterField({
        name: "status",
        label: "Status pembayaran",
        allLabel: "Semua status",
        values: status ? [status] : [],
        members: VALID_STATUSES,
        labels: PAYMENT_STATUS_LABELS,
    });

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Pembayaran"
                description="Percobaan pembayaran pada gateway. Status berubah menjadi PAID hanya setelah webhook terverifikasi; tidak ada perubahan manual dari dashboard."
            />

            <FilterBar
                basePath="/dashboard/payments"
                current={{
                    status: status ?? undefined,
                    q: params.q,
                }}
                fields={[statusField]}
                search={{
                    label: "Cari pembayaran",
                    placeholder: "Referensi, nomor pesanan, atau pembeli",
                    value: params.q,
                }}
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
                        query={{ status: status ?? undefined, q: params.q }}
                        label="Halaman"
                    />
                }
            />
        </div>
    );
}
