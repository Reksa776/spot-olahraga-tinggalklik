"use client";

import { Box } from "@mantine/core";
import {
    Area,
    AreaChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import { EmptyBlock, SectionCard } from "@/components/dashboard/primitives";
import { CHART_COLORS } from "@/components/dashboard/mantine-theme";

export type DailySale = {
    date: string;
    revenue: number;
    orders: number;
};

/**
 * "Penjualan Harian".
 *
 * The charting library is unchanged (Recharts, already a dependency) and so is every data key,
 * axis setting and tooltip formatter, including the `orders` branch that the current chart draws
 * no series for. This is a container migration: the hand-rolled `rounded-2xl border … p-5` wrapper
 * becomes `SectionCard`, and the colours come from `CHART_COLORS`, which is derived from the same
 * `brand` scale the rest of the dashboard uses rather than Recharts' default palette.
 *
 * Recharts paints SVG presentation attributes, where a CSS custom property is not reliably
 * substituted — hence the exported literals instead of `var(--mantine-color-brand-6)`.
 */
function formatRupiah(value: number) {
    return `Rp ${value.toLocaleString("id-ID")}`;
}

export default function SalesChart({
    data,
}: {
    data: DailySale[];
}) {
    return (
        <SectionCard title="Penjualan Harian" description="Performa penjualan">
            <Box h={320}>
                {data.length === 0 ? (
                    <EmptyBlock
                        title="Belum ada data penjualan"
                        description="Grafik akan terisi setelah ada pesanan pada periode ini."
                    />
                ) : (
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={data}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_COLORS.grid} />

                            <XAxis
                                dataKey="date"
                                tickLine={false}
                                axisLine={false}
                                tick={{ fill: CHART_COLORS.axis, fontSize: 12 }}
                            />

                            <YAxis
                                tickLine={false}
                                axisLine={false}
                                tick={{ fill: CHART_COLORS.axis, fontSize: 12 }}
                                tickFormatter={(value) => `Rp ${Number(value).toLocaleString("id-ID")}`}
                            />

                            <Tooltip
                                formatter={(value, name) => {
                                    if (name === "revenue") {
                                        return [formatRupiah(Number(value)), "Penjualan"];
                                    }

                                    return [value, "Pesanan"];
                                }}
                            />

                            <Area
                                type="monotone"
                                dataKey="revenue"
                                stroke={CHART_COLORS.brand}
                                fill={CHART_COLORS.brandSoft}
                                strokeWidth={2}
                                fillOpacity={0.18}
                            />
                        </AreaChart>
                    </ResponsiveContainer>
                )}
            </Box>

        </SectionCard>
    );
}
