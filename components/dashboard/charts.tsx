"use client";

import {
    Bar,
    BarChart,
    CartesianGrid,
    ComposedChart,
    Legend,
    Line,
    XAxis,
    YAxis,
} from "recharts";

import { EmptyBlock } from "@/components/dashboard/primitives";
import {
    ChartContainer,
    ChartLegendContent,
    ChartTooltip,
    ChartTooltipContent,
} from "@/components/dashboard/ui/chart";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * ==========================================
 * DASHBOARD CHARTS (shadcn chart composition over Recharts)
 * ==========================================
 *
 * Four charts, each plotting a series that was QUERIED — nothing here invents a trend, smooths a
 * value or fills a gap. The points arrive already bucketed by `lib/dashboard/reports.ts`, so the
 * axis is the window the operator chose, and a day with no sales is a real zero rather than a
 * missing sample.
 *
 * ── NO CHART NAMES A COLOUR ────────────────────────────────────────────────────
 * Every series declares a SEMANTIC name and a palette TOKEN (`var(--chart-1)`), and paints with
 * `var(--color-<series>)` — the custom property `ChartContainer` emits from the config. That is
 * what makes the appearance / accent / chart-palette switchers reach these charts without a single
 * value being edited here, and it is enforced by `__tests__/ui-consolidation/shadcn-dashboard.test.ts`.
 *
 * ── WHY THE PROP SHAPES ARE NUMBERS ────────────────────────────────────────────
 * The payload carries money as the exact decimal STRING (the value of record). These components
 * take numbers because a chart plots geometry, not money: the page converts at the boundary with
 * `Number(...)`, exactly as the existing tables do, and every displayed figure still comes from the
 * server's `Decimal`. No number computed here is ever written back.
 *
 * ── EMPTY, NOT ZERO ────────────────────────────────────────────────────────────
 * A chart given no points renders an explicit empty state. It never draws a zero line, which an
 * operator would read as "we sold nothing" rather than "this window was not measured".
 */

export type SalesTrendPoint = {
    label: string;
    ticketsSold: number;
    paidOrders: number;
};

export type RevenueTrendPoint = {
    label: string;
    revenue: number;
    refundAmount: number;
    netRevenue: number;
};

export type OrderStatusPoint = {
    status: string;
    label: string;
    count: number;
};

export type EventPerformancePoint = {
    title: string;
    ticketsSold: number;
    revenue: number;
};

/** Long event titles are truncated on the axis; the tooltip still names the full row. */
function truncate(text: string, max = 22): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `Rp1,2 jt` / `Rp500 rb` — a compact axis tick, so a revenue axis does not print nine digits. */
function compactIdr(value: number): string {
    if (Math.abs(value) >= 1_000_000_000) {
        return `Rp${(value / 1_000_000_000).toFixed(1)} M`;
    }

    if (Math.abs(value) >= 1_000_000) {
        return `Rp${(value / 1_000_000).toFixed(1)} jt`;
    }

    if (Math.abs(value) >= 1_000) {
        return `Rp${Math.round(value / 1_000)} rb`;
    }

    return `Rp${value}`;
}

const AXIS_PROPS = {
    tickLine: false,
    axisLine: false,
    tickMargin: 8,
} as const;

/* ------------------------------------------------------------------------------------------------
 * 1. SALES TREND — tickets sold over the selected period
 * ------------------------------------------------------------------------------------------------
 */

export function SalesTrendChart({
    data,
    emptyTitle = "Belum ada penjualan pada periode ini",
}: {
    data: SalesTrendPoint[];
    emptyTitle?: string;
}) {
    if (data.length === 0) {
        return (
            <EmptyBlock
                title={emptyTitle}
                description="Pilih periode lain, atau tunggu hingga ada tiket terjual."
            />
        );
    }

    return (
        <ChartContainer
            className="aspect-auto h-72 w-full"
            config={{
                ticketsSold: { label: "Tiket terjual", color: "var(--chart-1)" },
                paidOrders: { label: "Pesanan lunas", color: "var(--chart-2)" },
            }}
        >
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={16} />
                <YAxis {...AXIS_PROPS} width={40} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Legend content={<ChartLegendContent />} />
                <Bar
                    dataKey="ticketsSold"
                    fill="var(--color-ticketsSold)"
                    radius={4}
                />
                <Bar dataKey="paidOrders" fill="var(--color-paidOrders)" radius={4} />
            </BarChart>
        </ChartContainer>
    );
}

/* ------------------------------------------------------------------------------------------------
 * 2. REVENUE & REFUND — gross, refunded and net, on one scale
 * ------------------------------------------------------------------------------------------------
 */

export function RevenueRefundChart({
    data,
    emptyTitle = "Belum ada pendapatan atau refund pada periode ini",
}: {
    data: RevenueTrendPoint[];
    emptyTitle?: string;
}) {
    if (data.length === 0) {
        return (
            <EmptyBlock
                title={emptyTitle}
                description="Angka muncul setelah ada pesanan lunas atau refund yang selesai."
            />
        );
    }

    return (
        <ChartContainer
            className="aspect-auto h-72 w-full"
            config={{
                revenue: { label: "Pendapatan kotor", color: "var(--chart-1)" },
                refundAmount: { label: "Refund", color: "var(--chart-2)" },
                netRevenue: { label: "Pendapatan bersih", color: "var(--chart-3)" },
            }}
        >
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={16} />
                <YAxis
                    {...AXIS_PROPS}
                    width={64}
                    tickFormatter={(value: number) => compactIdr(value)}
                />
                <ChartTooltip
                    content={
                        <ChartTooltipContent
                            formatter={(value) => formatIdr(Number(value))}
                        />
                    }
                />
                <Legend content={<ChartLegendContent />} />
                <Bar dataKey="revenue" fill="var(--color-revenue)" radius={4} />
                <Bar
                    dataKey="refundAmount"
                    fill="var(--color-refundAmount)"
                    radius={4}
                />
                <Line
                    dataKey="netRevenue"
                    type="monotone"
                    stroke="var(--color-netRevenue)"
                    strokeWidth={2}
                    dot={false}
                />
            </ComposedChart>
        </ChartContainer>
    );
}

/* ------------------------------------------------------------------------------------------------
 * 3. ORDER STATUS DISTRIBUTION
 * ------------------------------------------------------------------------------------------------
 * Only statuses that EXIST in the schema are ever plotted — the list is the `OrderStatus` enum, and
 * the page passes the counts it received. Statuses with a real zero are dropped, because a bar of
 * length zero adds a label and no information; the count is still visible in the tooltip's absence
 * of that row only when the schema does not have it.
 */

export function OrderStatusChart({
    data,
    emptyTitle = "Belum ada pesanan pada periode ini",
}: {
    data: OrderStatusPoint[];
    emptyTitle?: string;
}) {
    const points = data.filter((point) => point.count > 0);

    if (points.length === 0) {
        return (
            <EmptyBlock
                title={emptyTitle}
                description="Distribusi status muncul setelah ada pesanan dibuat."
            />
        );
    }

    return (
        <ChartContainer
            className="aspect-auto h-72 w-full"
            config={{ count: { label: "Pesanan", color: "var(--chart-1)" } }}
        >
            <BarChart
                data={points}
                layout="vertical"
                margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
            >
                <CartesianGrid horizontal={false} />
                <XAxis type="number" {...AXIS_PROPS} allowDecimals={false} />
                <YAxis
                    type="category"
                    dataKey="label"
                    {...AXIS_PROPS}
                    width={132}
                    tickFormatter={(value: string) => truncate(value, 20)}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={4} />
            </BarChart>
        </ChartContainer>
    );
}

/* ------------------------------------------------------------------------------------------------
 * 4. EVENT PERFORMANCE — tickets sold and revenue per event
 * ------------------------------------------------------------------------------------------------
 * Two series on two axes on purpose: tickets are counts and revenue is money, and sharing one
 * scale would either flatten the counts or make the revenue axis meaningless. The left axis is
 * counts, the right one is money.
 */

export function EventPerformanceChart({
    data,
    emptyTitle = "Belum ada penjualan per event pada periode ini",
}: {
    data: EventPerformancePoint[];
    emptyTitle?: string;
}) {
    if (data.length === 0) {
        return (
            <EmptyBlock
                title={emptyTitle}
                description="Event dengan pesanan lunas akan muncul di sini."
            />
        );
    }

    const points = data.map((point) => ({
        ...point,
        shortTitle: truncate(point.title),
    }));

    return (
        <ChartContainer
            className="aspect-auto h-80 w-full"
            config={{
                ticketsSold: { label: "Tiket terjual", color: "var(--chart-1)" },
                revenue: { label: "Pendapatan", color: "var(--chart-3)" },
            }}
        >
            <BarChart
                data={points}
                layout="vertical"
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
                <CartesianGrid horizontal={false} />
                <XAxis xAxisId={0} type="number" {...AXIS_PROPS} allowDecimals={false} />
                <XAxis
                    xAxisId={1}
                    type="number"
                    orientation="top"
                    {...AXIS_PROPS}
                    tickFormatter={(value: number) => compactIdr(value)}
                />
                <YAxis
                    yAxisId={0}
                    type="category"
                    dataKey="shortTitle"
                    {...AXIS_PROPS}
                    width={148}
                />
                <ChartTooltip
                    content={<ChartTooltipContent />}
                    cursor={{ fillOpacity: 0.08 }}
                />
                <Legend content={<ChartLegendContent />} />
                <Bar
                    yAxisId={0}
                    xAxisId={0}
                    dataKey="ticketsSold"
                    fill="var(--color-ticketsSold)"
                    radius={4}
                />
                <Bar
                    yAxisId={0}
                    xAxisId={1}
                    dataKey="revenue"
                    fill="var(--color-revenue)"
                    radius={4}
                />
            </BarChart>
        </ChartContainer>
    );
}
