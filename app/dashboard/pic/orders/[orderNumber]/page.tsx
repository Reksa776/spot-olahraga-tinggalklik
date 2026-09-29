import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
    AccessDeniedPanel,
    DataRow,
    DataTable,
    Money,
    PageHeader,
    SectionCard,
    StatCard,
    StatusBadge,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";
import {
    ORDER_STATUS_LABELS,
    PAYMENT_STATUS_LABELS,
} from "@/lib/dashboard/filter-options";
import { getMyPicOrder } from "@/lib/pic/self-service";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * ==========================================
 * ONE REFERRED ORDER, FROM THE PIC'S OWN SCOPE
 * ==========================================
 *
 * The destination of the order number in the PIC dashboard's `Tiket Terjual` table. A referrer
 * holds no operator authority over somebody else's purchase, so neither existing order-detail
 * route could serve them:
 *
 *   `/dashboard/orders/{n}`   resolves through `order.read.tenant`, which a PIC does not hold;
 *   `/ticketing/orders/{n}`   resolves through order OWNERSHIP — the buyer's own session.
 *
 * Both are (correctly) a 404 for a referrer. This page asks the question from the PIC's own
 * authority instead: `requireMyPic` in `lib/pic/self-service.ts` establishes the session's ACTIVE
 * profile and its own-scope read permission, and `getMyPicOrder` AND-s the order number with
 * `picProfileId = that profile`.
 *
 * ── SCOPE IS THE PREDICATE, SO THERE IS NOTHING TO FORGET ───────────────────────
 * An order that exists but was not attributed to this PIC, belongs to another PIC, belongs to
 * another tenant, or belongs to nobody resolves to `null` and renders the not-found boundary —
 * never a page that confirms the order exists, and never another PIC's sale. No `eventId`,
 * `picProfileId` or `organizerId` is read from the URL; the only input is the order number, which
 * is a lookup key inside an already-narrowed query.
 *
 * ── WHAT THIS PAGE DELIBERATELY DOES NOT SHOW ───────────────────────────────────
 * No buyer identity (name, e-mail, phone) and no payment instruction or QR material: the referrer
 * needs to recognise the SALE, not to reach the customer. The money shown is the order's own stored
 * snapshot (`subtotal`, `discount`, `total`) — the same display-only view a buyer gets, with no
 * organizer net, no platform fee and no PIC fee rows. Fees live in the dashboard's `#fees` section,
 * which is computed from the ledger rather than re-derived per order.
 *
 * Nothing on this page can change an order: it is a read, and the order lifecycle belongs to
 * checkout, the verified payment webhook and the refund engine.
 */

export const dynamic = "force-dynamic";

/**
 * Browser tab title, entity-specific: "Pesanan <orderNumber>".
 *
 * The number comes from the ROUTE, not the database, so this asks no question the URL does not
 * already answer. `noindex` mirrors the buyer's order page: a referred order is not public, and
 * the page still resolves it through the PIC-scoped read before rendering anything.
 */
export async function generateMetadata({
    params,
}: {
    params: Promise<{ orderNumber: string }>;
}): Promise<Metadata> {
    const { orderNumber } = await params;

    return {
        title: `Pesanan ${orderNumber}`,
        robots: { index: false, follow: false },
    };
}

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

export default async function PicOrderDetailPage({
    params,
}: {
    params: Promise<{ orderNumber: string }>;
}) {
    const { orderNumber } = await params;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    let order;

    try {
        order = await getMyPicOrder(scope.userId, orderNumber);
    } catch (error) {
        if (!isAuthzError(error)) {
            throw error;
        }

        // A caller with no ACTIVE PIC profile (or without the own-scope attribution read) is
        // refused HERE, the same way the dashboard page refuses them — not shown an empty page
        // that would read like "no such order".
        return (
            <AccessDeniedPanel
                title="Akses ditolak"
                body={
                    <p className="text-sm leading-relaxed">
                        Profil PIC kamu belum dapat membaca pesanan ini.
                    </p>
                }
                actionHref="/dashboard"
                actionLabel="Kembali ke ringkasan"
            />
        );
    }

    /* Outside the try: `notFound()` throws its own interrupt, and catching it here would swallow
     * the 404 into the denial branch. A foreign order is indistinguishable from a missing one. */
    if (!order) {
        notFound();
    }

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                <TextLink href="/dashboard/pic#tickets-sold">
                    ← Tiket Terjual
                </TextLink>
                <PageHeader
                    eyebrow="Dashboard · PIC · Pesanan"
                    title={order.orderNumber}
                    description={`${order.eventTitle} · atribusi penjualan atas namamu`}
                />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <StatCard
                    label="Total pesanan"
                    value={formatIdr(Number(order.total))}
                    hint={`Subtotal ${formatIdr(Number(order.subtotal))}`}
                />
                <StatCard
                    label="Jumlah tiket"
                    value={order.ticketQuantity}
                    hint="Jumlah pada tiket pesanan ini"
                />
                <StatCard
                    label="Status pembayaran"
                    value={
                        <StatusBadge
                            tone={PAYMENT_TONE[order.paymentStatus] ?? "neutral"}
                        >
                            {PAYMENT_STATUS_LABELS[order.paymentStatus] ??
                                order.paymentStatus}
                        </StatusBadge>
                    }
                    hint={
                        order.paidAt
                            ? `Dibayar ${DATE_FORMAT.format(new Date(order.paidAt))}`
                            : "Belum lunas"
                    }
                />
            </div>

            <SectionCard
                title="Ringkasan Pesanan"
                description="Nilai yang tampil di sini adalah snapshot pesanan saat checkout — tidak dihitung ulang dari konfigurasi fee saat ini."
            >
                <div className="flex flex-col">
                    <DataRow
                        divider={false}
                        title="Event"
                        trailing={order.eventTitle}
                    />
                    <DataRow
                        title="Status pesanan"
                        trailing={
                            <StatusBadge tone={ORDER_TONE[order.status] ?? "neutral"}>
                                {ORDER_STATUS_LABELS[order.status] ?? order.status}
                            </StatusBadge>
                        }
                    />
                    <DataRow
                        title="Dibuat"
                        trailing={DATE_FORMAT.format(new Date(order.createdAt))}
                    />
                    <DataRow
                        title="Jumlah tiket"
                        trailing={
                            <span className="text-sm tabular-nums">
                                {order.ticketQuantity}
                            </span>
                        }
                    />
                </div>
            </SectionCard>

            <SectionCard
                title="Tiket"
                description="Satu baris per jenis tiket yang dibeli pada pesanan ini."
            >
                <DataTable
                    minWidth={560}
                    columns={[
                        { header: "Jenis tiket" },
                        { header: "Jumlah", align: "right" },
                        { header: "Harga", align: "right" },
                        { header: "Subtotal", align: "right" },
                    ]}
                    rows={order.items.map((item) => ({
                        key: item.id,
                        cells: [
                            <span key="name" className="text-sm">
                                {item.name}
                            </span>,
                            <span key="qty" className="text-sm tabular-nums">
                                {item.quantity}
                            </span>,
                            <Money
                                key="price"
                                value={formatIdr(Number(item.price))}
                            />,
                            <Money
                                key="subtotal"
                                value={formatIdr(Number(item.subtotal))}
                            />,
                        ],
                    }))}
                    empty={null}
                />
            </SectionCard>

            <SectionCard title="Pembayaran">
                <div className="flex flex-col">
                    <DataRow
                        divider={false}
                        title="Subtotal"
                        trailing={
                            <Money value={formatIdr(Number(order.subtotal))} />
                        }
                    />
                    <DataRow
                        title="Diskon"
                        trailing={
                            <Money value={formatIdr(Number(order.discount))} />
                        }
                    />
                    <DataRow
                        title="Total"
                        trailing={<Money value={formatIdr(Number(order.total))} />}
                    />
                </div>
            </SectionCard>
        </div>
    );
}
