import { FiBarChart2, FiDollarSign, FiRefreshCcw, FiShoppingBag, FiTag } from "react-icons/fi";

import {
    DataTable,
    EmptyBlock,
    InfoNote,
    PageHeader,
    SectionCard,
    StatCard,
    StatGrid,
    StatusBadge,
    type Tone,
} from "@/components/dashboard/primitives";
import { RevenueRefundChart, SalesTrendChart } from "@/components/dashboard/charts";
import { ReportFilterBar } from "@/components/dashboard/ReportFilters";
import { PERMISSIONS, getAuthzScope } from "@/lib/authz";
import { hasOrganizerPermission } from "@/lib/dashboard/scope";
import {
    DASHBOARD_REPORT_ORDER_STATUSES,
    DASHBOARD_REPORT_ORDER_STATUS_LABELS,
    DASHBOARD_REPORT_PERIODS,
    getDashboardReport,
    resolveDashboardReportFilters,
    toDashboardChartPoints,
    type DashboardReportPeriod,
} from "@/lib/dashboard/reports";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * Laporan.
 *
 * Sales, tickets, revenue and refunds over an explicit window, queried from `EventOrder` /
 * `Ticket` / `Payment` / `Refund` through `getDashboardReport`. There is no invented trend line:
 * when the window holds no rows the charts say so, and the summary shows real zeros because there
 * genuinely were no sales — a distinction the page keeps by leaving the window visible in the
 * heading.
 *
 * ── THE WINDOW IS EXPLICIT AND INCLUSIVE ──────────────────────────────────────
 * `?from=` and `?to=` are Asia/Jakarta CALENDAR DAYS, both ends included, so picking the same day
 * in both inputs means that whole day rather than an empty range. The default is the last 30 days.
 * `?period=7d|30d|3m` is a shortcut for the same thing, and it is resolved by the same parser the
 * download endpoint uses, so a shared URL cannot mean two different windows.
 *
 * ── FILTERS ARE IGNORED, NOT FATAL ────────────────────────────────────────────
 * This is a page render, so an unrecognised status or an impossible range falls back to the default
 * window and the bar says so — the same rule the refunds and settlements boards already use. The
 * download endpoint parses the identical query in strict mode, where the same input is a 400.
 *
 * ── DOWNLOADS USE THESE EXACT FILTERS ─────────────────────────────────────────
 * The links carry the RESOLVED day keys (`fromKey`/`toKey`), not the period shortcut, so the file
 * covers precisely the window on screen even if "now" moves between the render and the click. The
 * buttons are only rendered when the actor holds both the report read permission and
 * `report.export.transaction` — the endpoint re-checks either way.
 */

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = {
    PENDING_PAYMENT: "pending",
    PAID: "success",
    CANCELLED: "neutral",
    EXPIRED: "neutral",
    REFUNDED: "info",
    PARTIALLY_REFUNDED: "info",
};

const PERIOD_LABELS: Record<DashboardReportPeriod, string> = {
    "7d": "7 hari",
    "30d": "30 hari",
    "3m": "3 bulan",
};

/** Only the filters that are actually set become query parameters. */
function queryString(params: Record<string, string | null | undefined>): string {
    const search = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (value) search.set(key, value);
    }

    const serialised = search.toString();

    return serialised ? `?${serialised}` : "";
}

export default async function DashboardReportsPage({
    searchParams,
}: {
    searchParams: Promise<{
        from?: string;
        to?: string;
        period?: string;
        eventId?: string;
        status?: string;
    }>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    const filters = resolveDashboardReportFilters({
        from: params.from ?? null,
        to: params.to ?? null,
        period: params.period ?? null,
        eventId: params.eventId ?? null,
        status: params.status ?? null,
    });

    const report = await getDashboardReport(scope, filters);

    // The download requires the report READ and the export permission. Both are asked of the same
    // decider the endpoint uses, so the button and the endpoint cannot disagree about who may
    // download — and the button is a courtesy, never the control.
    const canExport =
        hasOrganizerPermission(scope, PERMISSIONS.REPORT_TRANSACTION_READ) &&
        hasOrganizerPermission(scope, PERMISSIONS.REPORT_EXPORT_TRANSACTION);

    const periodHref = (period: DashboardReportPeriod) =>
        `/dashboard/reports${queryString({
            period,
            eventId: params.eventId ?? null,
            status: params.status ?? null,
        })}`;

    // A window with no orders, no tickets and no refunds is a REAL zero, and every figure on the
    // page says so. The charts get an empty series in that case so they render their empty state
    // rather than an axis of thirty zero bars, which would read like a flat week.
    const hasActivity =
        report.summary.orders > 0 ||
        report.summary.ticketsSold > 0 ||
        report.summary.refunds > 0;

    const trendForCharts = hasActivity ? toDashboardChartPoints(report.trend) : [];

    const notices: string[] = [];

    if (report.filters.clamped) {
        notices.push(
            `Rentang tanggal dipersempit ke maksimal 366 hari terakhir yang berakhir pada ${report.range.toKey}.`
        );
    }

    if (params.status && !report.filters.orderStatus) {
        notices.push(`Status pesanan "${params.status}" tidak dikenal, filter diabaikan.`);
    }

    if (params.period && !report.filters.period) {
        notices.push(`Periode "${params.period}" tidak dikenal, filter diabaikan.`);
    }

    if (report.filters.rangeFallback) {
        notices.push(
            "Rentang tanggal tidak valid (dari > sampai), dipakai jendela default 30 hari."
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Laporan"
                description={`Periode ${report.range.label} (termasuk kedua tanggal). Semua angka dihitung dari pesanan dan tiket yang benar-benar ada: tidak ada proyeksi, tidak ada data contoh.`}
            />

            <ReportFilterBar
                action="/dashboard/reports"
                values={{
                    from: report.range.fromKey,
                    to: report.range.toKey,
                    eventId: report.filters.eventId ?? "",
                    status: report.filters.orderStatus ?? "",
                }}
                events={report.eventOptions.map((event) => ({
                    id: event.id,
                    title: event.title,
                }))}
                statuses={DASHBOARD_REPORT_ORDER_STATUSES.map((status) => ({
                    value: status,
                    label: DASHBOARD_REPORT_ORDER_STATUS_LABELS[status],
                }))}
                periods={(Object.keys(DASHBOARD_REPORT_PERIODS) as DashboardReportPeriod[]).map(
                    (period) => ({
                        key: period,
                        label: PERIOD_LABELS[period],
                        href: periodHref(period),
                        active: report.filters.period === period,
                    })
                )}
                downloads={
                    canExport
                        ? [
                              {
                                  key: "csv",
                                  label: "Download CSV",
                                  href: `/api/organizer/reports/export${queryString({
                                      format: "csv",
                                      from: report.range.fromKey,
                                      to: report.range.toKey,
                                      eventId: report.filters.eventId,
                                      status: report.filters.orderStatus,
                                  })}`,
                              },
                              {
                                  key: "xlsx",
                                  label: "Download Excel",
                                  href: `/api/organizer/reports/export${queryString({
                                      format: "xlsx",
                                      from: report.range.fromKey,
                                      to: report.range.toKey,
                                      eventId: report.filters.eventId,
                                      status: report.filters.orderStatus,
                                  })}`,
                              },
                          ]
                        : []
                }
                notice={notices.length > 0 ? notices.join(" ") : null}
            />

            {!canExport ? (
                <InfoNote tone="info">
                    Akun kamu dapat melihat laporan ini tetapi tidak memiliki izin
                    <span className="font-semibold"> report.export.transaction</span> untuk
                    mengunduhnya. Hubungi pemilik penyelenggara bila kamu memerlukannya.
                </InfoNote>
            ) : null}

            <div className="flex flex-col gap-4">
                <StatGrid>
                    <StatCard
                        label="Pesanan dibuat"
                        value={report.summary.orders}
                        icon={<FiShoppingBag />}
                        hint={`${report.summary.paidOrders} lunas`}
                    />
                    <StatCard
                        label="Pesanan lunas"
                        value={report.summary.paidOrders}
                        icon={<FiShoppingBag />}
                        tone="success"
                        hint={`Rata-rata ${formatIdr(Number(report.summary.averageOrderValue))}`}
                    />
                    <StatCard
                        label="Tiket terjual"
                        value={report.summary.ticketsSold}
                        icon={<FiTag />}
                        tone="info"
                        hint="Tiket terbit dan check-in, tidak termasuk void/refund"
                    />
                    <StatCard
                        label="Pendapatan kotor"
                        value={formatIdr(Number(report.summary.revenue))}
                        icon={<FiDollarSign />}
                        tone="brand"
                        hint="Total pesanan berstatus lunas"
                    />
                </StatGrid>

                <StatGrid className="xl:grid-cols-3">
                    <StatCard
                        label="Refund"
                        value={report.summary.refunds}
                        icon={<FiRefreshCcw />}
                        tone={report.summary.refunds > 0 ? "warn" : "neutral"}
                        hint={`Nilai ${formatIdr(Number(report.summary.refundAmount))}`}
                    />
                    <StatCard
                        label="Pendapatan bersih"
                        value={formatIdr(Number(report.summary.netRevenue))}
                        icon={<FiBarChart2 />}
                        tone="success"
                        hint="Pendapatan kotor dikurangi refund yang sudah selesai"
                    />
                    <StatCard
                        label="Rata-rata per pesanan"
                        value={formatIdr(Number(report.summary.averageOrderValue))}
                        icon={<FiBarChart2 />}
                        tone="neutral"
                        hint="Dihitung dari pesanan lunas pada periode ini"
                    />
                </StatGrid>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <SectionCard
                    title="Tren penjualan"
                    description={
                        report.filters.granularity === "week"
                            ? "Tiket terjual per minggu (bucket 7 hari)"
                            : "Tiket terjual per hari"
                    }
                >
                    <SalesTrendChart data={trendForCharts} />
                </SectionCard>

                <SectionCard
                    title="Pendapatan & refund"
                    description="Pendapatan kotor, nilai refund, dan pendapatan bersih per periode"
                >
                    <RevenueRefundChart data={trendForCharts} />
                </SectionCard>
            </div>

            <SectionCard
                title="Performa event"
                description="Diurutkan berdasarkan pendapatan kotor pada periode ini"
            >
                <DataTable
                    minWidth={900}
                    columns={[
                        { header: "Event" },
                        { header: "Pesanan lunas", align: "right" },
                        { header: "Tiket terjual", align: "right" },
                        { header: "Pendapatan", align: "right" },
                        { header: "Refund", align: "right" },
                        { header: "Bersih", align: "right" },
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
                            <span key="refund" className="text-sm tabular-nums">
                                {formatIdr(Number(event.refundAmount))}
                            </span>,
                            <span
                                key="net"
                                className="text-sm font-semibold tabular-nums"
                            >
                                {formatIdr(Number(event.netRevenue))}
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
                title="Distribusi status pesanan"
                description="Seluruh pesanan yang dibuat pada periode ini, tanpa filter status"
            >
                <DataTable
                    minWidth={520}
                    columns={[
                        { header: "Status" },
                        { header: "Pesanan", align: "right" },
                    ]}
                    rows={report.orderStatus
                        .filter((entry) => entry.count > 0)
                        .map((entry) => ({
                            key: entry.status,
                            cells: [
                                <div
                                    key="status"
                                    className="flex items-center gap-2"
                                >
                                    <StatusBadge
                                        size="sm"
                                        tone={STATUS_TONE[entry.status] ?? "neutral"}
                                    >
                                        {entry.status}
                                    </StatusBadge>
                                    <span className="text-sm">
                                        {DASHBOARD_REPORT_ORDER_STATUS_LABELS[entry.status]}
                                    </span>
                                </div>,
                                <span
                                    key="count"
                                    className="text-sm font-semibold tabular-nums"
                                >
                                    {entry.count}
                                </span>,
                            ],
                        }))}
                    empty={
                        <EmptyBlock
                            title="Belum ada pesanan pada periode ini"
                            description="Status akan muncul setelah ada pesanan dibuat."
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

            <p className="text-xs text-muted-foreground">
                Unduhan memakai filter yang sama persis dengan halaman ini: CSV berisi baris
                pesanan, Excel berisi ringkasan, pesanan, penjualan tiket, refund, dan pencairan
                (bila kamu berwenang). Setiap unduhan tercatat di jejak audit.
            </p>
        </div>
    );
}
