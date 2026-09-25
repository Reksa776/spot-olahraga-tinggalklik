import Link from "next/link";
import {
    FiActivity,
    FiCalendar,
    FiCheckCircle,
    FiClock,
    FiCreditCard,
    FiDollarSign,
    FiRefreshCcw,
    FiShoppingBag,
    FiTag,
    FiTrendingUp,
    FiUsers,
    FiXCircle,
} from "react-icons/fi";

import {
    AccountStandingNotice,
    picStandingNotice,
} from "@/components/dashboard/AccountStandingNotice";
import {
    EventPerformanceChart,
    OrderStatusChart,
    RevenueRefundChart,
    SalesTrendChart,
} from "@/components/dashboard/charts";
import {
    DataRow,
    EmptyBlock,
    InfoNote,
    PageHeader,
    SectionCard,
    StatCard,
    StatGrid,
    StatusBadge,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";
import { Button } from "@/components/dashboard/ui/button";
import { Input, Label } from "@/components/dashboard/ui/input";
import { PERMISSIONS, getAuthzScope } from "@/lib/authz";
import { getDashboardActivity, type DashboardActivityPanel } from "@/lib/dashboard/activity";
import { getDashboardOverview } from "@/lib/dashboard/overview";
import {
    DASHBOARD_REPORT_ORDER_STATUS_LABELS,
    DASHBOARD_REPORT_PERIODS,
    getDashboardReport,
    resolveDashboardReportFilters,
    toDashboardChartPoints,
    type DashboardReportPeriod,
} from "@/lib/dashboard/reports";
import { computeDashboardCapabilities, hasOrganizerPermission } from "@/lib/dashboard/scope";
import { findPicProfileStanding } from "@/lib/pic/self-service";
import { eventStatusTone } from "@/lib/events/status";
import { formatEventSchedule, formatIdr } from "@/lib/ticketing/ui/format";

/**
 * Dashboard overview.
 *
 * Reads `getDashboardOverview` (counters), `getDashboardReport` (the windowed series the charts
 * plot) and `getDashboardActivity` (the last few orders / refunds / payouts). Every one of them is
 * scoped by the same permission decisions the API uses, and every block is present only when the
 * actor actually holds the permission for its rows. There are no placeholders: a block the caller
 * may not read renders as an explicit "no access" note rather than as a zero that would read like
 * an empty business.
 *
 * ── ONE WINDOW, CHOSEN BY THE OPERATOR ────────────────────────────────────────
 * The charts share a single window, selected with `?period=7d|30d|3m` or an explicit
 * `?from=&to=` pair. Both go through `resolveDashboardReportFilters` — the SAME parser the reports
 * page and the download endpoint use — so the "last 30 days" on this page and the "last 30 days" on
 * a downloaded report cannot mean two different things.
 *
 * ── THE CHARTS ARE GATED SEPARATELY FROM THE TILES ────────────────────────────
 * The counters come from `dashboard.overview`, but the series need `report.transaction.read`. An
 * actor holding the first and not the second (a CHECKIN_STAFF holds neither; a role with events but
 * no financial read is the real case) sees the tiles they are entitled to and an honest note where
 * the charts would be — never an axis of zeroes, which would be a claim about sales rather than
 * about permission.
 */

export const dynamic = "force-dynamic";

const PERIOD_LABELS: Record<DashboardReportPeriod, string> = {
    "7d": "7 hari",
    "30d": "30 hari",
    "3m": "3 bulan",
};

const ORDER_STATUS_TONE: Record<string, Tone> = {
    PENDING_PAYMENT: "pending",
    PAID: "success",
    CANCELLED: "neutral",
    EXPIRED: "neutral",
    REFUNDED: "info",
    PARTIALLY_REFUNDED: "info",
};

const REFUND_STATUS_TONE: Record<string, Tone> = {
    PENDING: "pending",
    APPROVED: "info",
    PROCESSING: "info",
    REFUNDED: "success",
    REJECTED: "neutral",
    FAILED: "error",
};

const SETTLEMENT_STATUS_TONE: Record<string, Tone> = {
    DRAFT: "neutral",
    PENDING_APPROVAL: "pending",
    APPROVED: "info",
    PAID: "success",
    FAILED: "error",
    CANCELLED: "neutral",
    REQUESTED: "pending",
    REJECTED: "error",
};

/** The last few rows of one vertical, with an explicit no-access state. */
function ActivityPanel({
    title,
    description,
    panel,
    emptyTitle,
    emptyDescription,
    toneFor,
}: {
    title: string;
    description: string;
    panel: DashboardActivityPanel;
    emptyTitle: string;
    emptyDescription: string;
    toneFor: Record<string, Tone>;
}) {
    return (
        <SectionCard title={title} description={description}>
            {!panel.allowed ? (
                <EmptyBlock
                    title="Tidak ada akses"
                    description="Peran kamu belum memiliki izin membaca data ini."
                />
            ) : panel.items.length === 0 ? (
                <EmptyBlock title={emptyTitle} description={emptyDescription} />
            ) : (
                <div className="flex flex-col">
                    {panel.items.map((item, index) => (
                        <DataRow
                            key={item.id}
                            divider={index > 0}
                            align="flex-start"
                            title={
                                item.href ? (
                                    <TextLink href={item.href}>{item.title}</TextLink>
                                ) : (
                                    item.title
                                )
                            }
                            meta={`${item.meta} · ${item.at}`}
                            trailing={
                                <div className="flex flex-col items-end gap-1">
                                    <span className="text-sm font-semibold tabular-nums">
                                        {item.amount}
                                    </span>
                                    <StatusBadge
                                        size="sm"
                                        tone={toneFor[item.status] ?? "neutral"}
                                    >
                                        {item.status}
                                    </StatusBadge>
                                </div>
                            }
                        />
                    ))}
                </div>
            )}
        </SectionCard>
    );
}

export default async function DashboardOverviewPage({
    searchParams,
}: {
    searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    // PHASE 34 — dashboard ENTRY is not the same as an operational surface. A platform
    // MANAGER with no OrganizerMember yet and a PIC whose profile is not ACTIVE may both
    // open the shell; each gets an honest standing state instead of a dashboard of empty
    // numbers (or the generic "no access" panel). This reads the SAME authoritative scope
    // the layout used, so the two cannot disagree.
    const capabilities = computeDashboardCapabilities(scope);
    const hasOperationalSurface =
        capabilities.hasTenantAccess ||
        capabilities.canManageSports ||
        capabilities.canManageGlobalVenues ||
        capabilities.canManagePlatformPic;

    if (!hasOperationalSurface) {
        if (scope.platformRole === "MANAGER") {
            return <AccountStandingNotice standing="manager-no-organizer" />;
        }

        if (scope.platformRole === "PIC") {
            const standing = await findPicProfileStanding(scope.userId);

            if (standing !== "ACTIVE") {
                return (
                    <AccountStandingNotice standing={picStandingNotice(standing)} />
                );
            }
        }
    }

    const reportFilters = resolveDashboardReportFilters({
        from: params.from ?? null,
        to: params.to ?? null,
        period: params.period ?? null,
    });

    // The series need the transaction read; the counters do not. Asking the same decider the
    // reports page asks is what keeps the two surfaces agreeing about who sees what.
    const canReadTransactionReport = hasOrganizerPermission(
        scope,
        PERMISSIONS.REPORT_TRANSACTION_READ
    );

    const [overview, activity, report] = await Promise.all([
        getDashboardOverview(scope),
        getDashboardActivity(scope, 5),
        canReadTransactionReport
            ? getDashboardReport(scope, reportFilters)
            : Promise.resolve(null),
    ]);

    const tenant = overview.tenant;
    const settlements = overview.settlements;

    // A window with no orders, tickets or refunds is a REAL zero. The charts are given an empty
    // series in that case so they render their empty state rather than an axis of zeroes.
    const hasActivity = report
        ? report.summary.orders > 0 ||
          report.summary.ticketsSold > 0 ||
          report.summary.refunds > 0
        : false;

    const trendForCharts =
        hasActivity && report ? toDashboardChartPoints(report.trend) : [];
    const refundsNeedingWork =
        (tenant?.refundsPending ?? 0) + (tenant?.refundsProcessing ?? 0);

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Ringkasan"
                description="Angka di bawah dihitung langsung dari data transaksi. Cakupannya mengikuti izin akun kamu: penyelenggara melihat event miliknya, admin platform melihat agregat yang diizinkan."
            />

            <StatGrid>
                <StatCard
                    label="Total event"
                    value={tenant?.eventsTotal ?? "—"}
                    icon={<FiCalendar />}
                    hint={
                        tenant
                            ? `${tenant.eventsUpcoming} akan datang`
                            : "Tidak ada akses data event"
                    }
                />
                <StatCard
                    label="Event aktif"
                    value={tenant?.eventsPublished ?? "—"}
                    icon={<FiActivity />}
                    tone="info"
                    hint="Sedang dipublikasikan atau berlangsung"
                />
                <StatCard
                    label="Pesanan"
                    value={tenant?.ordersTotal ?? "—"}
                    icon={<FiShoppingBag />}
                    hint={
                        tenant
                            ? `${tenant.ordersPaid} lunas · ${tenant.ordersPendingPayment} menunggu bayar`
                            : "Tidak ada akses data pesanan"
                    }
                />
                <StatCard
                    label="Tiket terjual"
                    value={tenant?.ticketsSold ?? "—"}
                    icon={<FiTag />}
                    tone="info"
                    hint="Tiket terbit dan check-in, tidak termasuk yang void/refund"
                />
                <StatCard
                    label="Pendapatan"
                    value={tenant ? formatIdr(Number(tenant.revenue)) : "—"}
                    icon={<FiDollarSign />}
                    tone="success"
                    hint="Total pesanan berstatus lunas"
                />
                <StatCard
                    label="Pesanan menunggu bayar"
                    value={tenant?.ordersPendingPayment ?? "—"}
                    icon={<FiClock />}
                    tone={tenant && tenant.ordersPendingPayment > 0 ? "pending" : "neutral"}
                    hint="Belum menerima pembayaran"
                />
                <StatCard
                    label="Refund perlu ditangani"
                    value={tenant ? refundsNeedingWork : "—"}
                    icon={<FiRefreshCcw />}
                    tone={refundsNeedingWork > 0 ? "warn" : "neutral"}
                    hint={
                        tenant
                            ? `${tenant.refundsPending} menunggu · ${tenant.refundsProcessing} diproses · ${tenant.refundsCompleted} selesai`
                            : "Tidak ada akses data refund"
                    }
                />
                <StatCard
                    label="Pencairan menunggu"
                    value={settlements ? settlements.awaiting : "—"}
                    icon={<FiCreditCard />}
                    tone={settlements && settlements.awaiting > 0 ? "pending" : "neutral"}
                    hint={
                        settlements
                            ? `${settlements.total} total · ${formatIdr(
                                  Number(settlements.paidAmount)
                              )} sudah dibayar`
                            : "Tidak ada akses data pencairan"
                    }
                />
            </StatGrid>

            {canReadTransactionReport && report ? (
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    <SectionCard
                        title="Tren penjualan"
                        description={
                            report.filters.granularity === "week"
                                ? `Tiket terjual per minggu · ${report.range.label}`
                                : `Tiket terjual per hari · ${report.range.label}`
                        }
                        actions={
                            <div className="flex flex-wrap items-center gap-2">
                                {(
                                    Object.keys(DASHBOARD_REPORT_PERIODS) as DashboardReportPeriod[]
                                ).map((period) => (
                                    <Link
                                        key={period}
                                        href={`/dashboard?period=${period}`}
                                        aria-current={
                                            report.filters.period === period
                                                ? "true"
                                                : undefined
                                        }
                                        className={
                                            report.filters.period === period
                                                ? "rounded-field border border-primary bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary"
                                                : "rounded-field border border-input px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                                        }
                                    >
                                        {PERIOD_LABELS[period]}
                                    </Link>
                                ))}
                            </div>
                        }
                    >
                        <SalesTrendChart data={trendForCharts} />

                        {/*
                         * A custom range. A native GET form because this is a server component and
                         * the window has to be in the URL for the download and the reports page to
                         * be able to repeat it.
                         */}
                        <form
                            method="get"
                            action="/dashboard"
                            className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4"
                        >
                            <div className="flex min-w-36 flex-1 flex-col gap-1.5">
                                <Label htmlFor="dash-from">Dari</Label>
                                <Input
                                    id="dash-from"
                                    type="date"
                                    name="from"
                                    defaultValue={report.range.fromKey}
                                />
                            </div>
                            <div className="flex min-w-36 flex-1 flex-col gap-1.5">
                                <Label htmlFor="dash-to">Sampai</Label>
                                <Input
                                    id="dash-to"
                                    type="date"
                                    name="to"
                                    defaultValue={report.range.toKey}
                                />
                            </div>
                            <div className="flex items-center gap-3">
                                <Button type="submit" size="sm">
                                    Terapkan
                                </Button>
                                <Link
                                    href="/dashboard/reports"
                                    className="text-xs font-semibold text-primary underline-offset-4 hover:underline"
                                >
                                    Laporan lengkap
                                </Link>
                            </div>
                        </form>
                    </SectionCard>

                    <SectionCard
                        title="Pendapatan & refund"
                        description="Pendapatan kotor, nilai refund, dan pendapatan bersih"
                    >
                        <RevenueRefundChart data={trendForCharts} />

                        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 sm:grid-cols-3">
                            <div className="flex flex-col">
                                <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground">
                                    Kotor
                                </span>
                                <span className="text-sm font-semibold tabular-nums">
                                    {formatIdr(Number(report.summary.revenue))}
                                </span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground">
                                    Refund
                                </span>
                                <span className="text-sm font-semibold tabular-nums">
                                    {formatIdr(Number(report.summary.refundAmount))}
                                </span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground">
                                    Bersih
                                </span>
                                <span className="text-sm font-semibold tabular-nums">
                                    {formatIdr(Number(report.summary.netRevenue))}
                                </span>
                            </div>
                        </div>
                    </SectionCard>

                    <SectionCard
                        title="Distribusi status pesanan"
                        description={`Seluruh pesanan pada ${report.range.label}`}
                    >
                        <OrderStatusChart
                            data={report.orderStatus.map((entry) => ({
                                status: entry.status,
                                label: DASHBOARD_REPORT_ORDER_STATUS_LABELS[entry.status],
                                count: entry.count,
                            }))}
                        />

                        <div className="mt-4 flex flex-col border-t border-border pt-2">
                            {report.orderStatus
                                .filter((entry) => entry.count > 0)
                                .map((entry, index) => (
                                    <DataRow
                                        key={entry.status}
                                        divider={index > 0}
                                        title={
                                            DASHBOARD_REPORT_ORDER_STATUS_LABELS[entry.status]
                                        }
                                        trailing={
                                            <div className="flex items-center gap-3">
                                                <span className="text-sm font-semibold tabular-nums">
                                                    {entry.count}
                                                </span>
                                                <StatusBadge
                                                    size="sm"
                                                    tone={
                                                        ORDER_STATUS_TONE[entry.status] ??
                                                        "neutral"
                                                    }
                                                >
                                                    {entry.status}
                                                </StatusBadge>
                                            </div>
                                        }
                                    />
                                ))}
                        </div>
                    </SectionCard>

                    <SectionCard
                        title="Performa event"
                        description={`Tiket terjual dan pendapatan per event · ${report.range.label}`}
                    >
                        <EventPerformanceChart
                            data={report.byEvent.slice(0, 8).map((event) => ({
                                title: event.title,
                                ticketsSold: event.ticketsSold,
                                revenue: Number(event.revenue),
                            }))}
                        />
                    </SectionCard>
                </div>
            ) : (
                <InfoNote tone="info">
                    Grafik penjualan memerlukan izin{" "}
                    <span className="font-semibold">report.transaction.read</span>. Akun kamu belum
                    memilikinya pada penyelenggara mana pun, jadi tidak ada seri penjualan yang
                    ditampilkan — bukan berarti tidak ada penjualan.
                </InfoNote>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <ActivityPanel
                    title="Pesanan terbaru"
                    description="Pesanan yang baru dibuat"
                    panel={activity.orders}
                    emptyTitle="Belum ada pesanan"
                    emptyDescription="Pesanan yang dibuat pembeli akan muncul di sini."
                    toneFor={ORDER_STATUS_TONE}
                />
                <ActivityPanel
                    title="Refund terbaru"
                    description="Permintaan pengembalian dana"
                    panel={activity.refunds}
                    emptyTitle="Belum ada refund"
                    emptyDescription="Permintaan refund dari pembeli akan muncul di sini."
                    toneFor={REFUND_STATUS_TONE}
                />
                <ActivityPanel
                    title="Pencairan terbaru"
                    description="Pembayaran fee PIC"
                    panel={activity.settlements}
                    emptyTitle="Belum ada pencairan"
                    emptyDescription="Pencairan yang disiapkan akan muncul di sini."
                    toneFor={SETTLEMENT_STATUS_TONE}
                />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <SectionCard
                    title="Pembayaran"
                    description="Status percobaan pembayaran pada gateway"
                    className="lg:col-span-1"
                >
                    {tenant ? (
                        <div className="flex flex-col">
                            <DataRow
                                leading={<FiClock size={18} />}
                                title="Menunggu"
                                divider={false}
                                trailing={
                                    <span className="font-semibold tabular-nums">
                                        {tenant.paymentsPending}
                                    </span>
                                }
                            />
                            <DataRow
                                leading={<FiCheckCircle size={18} />}
                                title="Berhasil"
                                trailing={
                                    <span className="font-semibold tabular-nums">
                                        {tenant.paymentsPaid}
                                    </span>
                                }
                            />
                            <DataRow
                                leading={<FiXCircle size={18} />}
                                title="Gagal / kedaluwarsa"
                                trailing={
                                    <span className="font-semibold tabular-nums">
                                        {tenant.paymentsFailed}
                                    </span>
                                }
                            />
                        </div>
                    ) : (
                        <EmptyBlock
                            title="Tidak ada akses pembayaran"
                            description="Peran kamu belum memiliki izin membaca pembayaran."
                        />
                    )}
                </SectionCard>

                <SectionCard
                    title="Event akan datang"
                    description="Event terpublikasi terdekat"
                    className="lg:col-span-2"
                >
                    {overview.upcomingEvents.length > 0 ? (
                        <div className="flex flex-col">
                            {overview.upcomingEvents.map((event, index) => (
                                <DataRow
                                    key={event.id}
                                    divider={index > 0}
                                    title={
                                        <TextLink href={`/dashboard/events/${event.id}`}>
                                            {event.title}
                                        </TextLink>
                                    }
                                    meta={`${formatEventSchedule(event.startAt, null)} · ${event.organizerName}`}
                                    trailing={
                                        // Same tone table as the event list and detail header, so
                                        // a status reads identically on all three surfaces.
                                        <StatusBadge tone={eventStatusTone(event.status)}>
                                            {event.status}
                                        </StatusBadge>
                                    }
                                />
                            ))}
                        </div>
                    ) : (
                        <EmptyBlock
                            icon={<FiTrendingUp size={22} />}
                            title="Belum ada event akan datang"
                            description="Event yang sudah dipublikasikan dan belum mulai akan muncul di sini."
                        />
                    )}
                </SectionCard>
            </div>

            {overview.platform ? (
                <StatGrid className="xl:grid-cols-3">
                    <StatCard
                        label="Cabang olahraga"
                        value={overview.platform.sportsTotal}
                        icon={<FiTrendingUp />}
                        tone="neutral"
                        hint={`${overview.platform.sportsActive} aktif`}
                    />
                    <StatCard
                        label="PIC aktif"
                        value={overview.platform.picActive}
                        icon={<FiUsers />}
                        tone="brand"
                        hint={`${overview.platform.picPending} menunggu persetujuan`}
                    />
                    <StatCard
                        label="Total PIC"
                        value={overview.platform.picTotal}
                        icon={<FiUsers />}
                        tone="neutral"
                    />
                </StatGrid>
            ) : null}
        </div>
    );
}
