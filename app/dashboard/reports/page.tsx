import { FiBarChart2, FiDollarSign, FiShoppingBag, FiTag } from "react-icons/fi";

import {
    DataTable,
    EmptyBlock,
    PageHeader,
    SectionCard,
    StatCard,
    StatGrid,
} from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { getDashboardReport } from "@/lib/dashboard/reports";
import { formatEventDateShort, formatIdr } from "@/lib/ticketing/ui/format";

/**
 * Reports.
 *
 * Sales, tickets and revenue over an explicit window, all queried from `EventOrder` /
 * `Ticket` / `Payment`. There is no invented trend line: when the window holds no rows the
 * tables say so, and the summary shows real zeros because there genuinely were no sales —
 * a distinction the page makes by keeping the window visible in the description.
 *
 * The default window is the last 30 days; `?from=` and `?to=` narrow it.
 */

export const dynamic = "force-dynamic";

function parseDate(value: string | undefined, fallback: Date): Date {
    if (!value) {
        return fallback;
    }

    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export default async function DashboardReportsPage({
    searchParams,
}: {
    searchParams: Promise<{ from?: string; to?: string }>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    const to = parseDate(params.to, new Date());
    const defaultFrom = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = parseDate(params.from, defaultFrom);

    const report = await getDashboardReport(scope, { from, to });

    const windowLabel = `${formatEventDateShort(from.toISOString())} – ${formatEventDateShort(
        to.toISOString()
    )}`;

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Laporan"
                description={`Periode ${windowLabel}. Semua angka dihitung dari pesanan lunas dan tiket terbit; tidak ada proyeksi atau data contoh.`}
            />

            <StatGrid>
                <StatCard
                    label="Pesanan lunas"
                    value={report.summary.paidOrders}
                    icon={<FiShoppingBag />}
                    hint={`${report.summary.orders} pesanan dibuat pada periode ini`}
                />
                <StatCard
                    label="Tiket terjual"
                    value={report.summary.ticketsSold}
                    icon={<FiTag />}
                    tone="info"
                />
                <StatCard
                    label="Pendapatan"
                    value={formatIdr(Number(report.summary.revenue))}
                    icon={<FiDollarSign />}
                    tone="success"
                />
                <StatCard
                    label="Rata-rata per pesanan"
                    value={formatIdr(Number(report.summary.averageOrderValue))}
                    icon={<FiBarChart2 />}
                    tone="brand"
                />
            </StatGrid>

            <SectionCard
                title="Performa event"
                description="Diurutkan berdasarkan pendapatan pada periode ini"
            >
                <DataTable
                    minWidth={720}
                    columns={[
                        { header: "Event" },
                        { header: "Pesanan lunas", align: "right" },
                        { header: "Tiket terjual", align: "right" },
                        { header: "Pendapatan", align: "right" },
                    ]}
                    rows={report.byEvent.map((event) => ({
                        key: event.eventId,
                        cells: [
                            <span key="title" className="text-sm font-semibold">
                                {event.title}
                            </span>,
                            <span key="orders" className="text-sm tabular-nums">
                                {event.paidOrders}
                            </span>,
                            <span key="tickets" className="text-sm tabular-nums">
                                {event.ticketsSold}
                            </span>,
                            <span
                                key="revenue"
                                className="text-sm font-semibold tabular-nums"
                            >
                                {formatIdr(Number(event.revenue))}
                            </span>,
                        ],
                    }))}
                    empty={
                        <EmptyBlock
                            title="Belum ada penjualan pada periode ini"
                            description="Pilih rentang tanggal lain, atau tunggu hingga ada pesanan lunas."
                        />
                    }
                />
            </SectionCard>

            <SectionCard
                title="Metode pembayaran"
                description="Hanya pembayaran berstatus lunas yang dihitung"
            >
                <DataTable
                    minWidth={560}
                    columns={[
                        { header: "Metode" },
                        { header: "Transaksi", align: "right" },
                        { header: "Jumlah", align: "right" },
                    ]}
                    rows={report.byMethod.map((method) => ({
                        key: method.method,
                        cells: [
                            <span key="method" className="text-sm">
                                {method.method}
                            </span>,
                            <span key="count" className="text-sm tabular-nums">
                                {method.payments}
                            </span>,
                            <span
                                key="amount"
                                className="text-sm font-semibold tabular-nums"
                            >
                                {formatIdr(Number(method.amount))}
                            </span>,
                        ],
                    }))}
                    empty={
                        <EmptyBlock
                            title="Belum ada pembayaran lunas"
                            description="Metode pembayaran yang berhasil akan muncul di sini."
                        />
                    }
                />
            </SectionCard>
        </div>
    );
}
