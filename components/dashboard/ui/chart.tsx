"use client";

import * as React from "react";
import * as RechartsPrimitive from "recharts";

import { cn } from "@/lib/utils";

/**
 * ==========================================
 * CHART SYSTEM (shadcn/ui)
 * ==========================================
 *
 * The shadcn chart composition — `ChartContainer`, `ChartTooltip`, `ChartTooltipContent`,
 * `ChartLegend`, `ChartLegendContent` — over the Recharts the project already depends on. No new
 * charting library was added.
 *
 * HOW A PALETTE CHANGE REACHES A CHART
 * ------------------------------------
 * A chart never names a colour. It declares a config:
 *
 *     const config = { revenue: { label: "Penjualan", color: "var(--chart-1)" } }
 *
 * and renders `<Area dataKey="revenue" stroke="var(--color-revenue)" />`. `ChartContainer` emits one
 * scoped rule per entry (`--color-revenue: var(--chart-1)`), so every series resolves through the
 * chart tokens in `app/globals.css`. Selecting a different palette swaps those tokens, and every
 * line, area, bar, slice, legend dot and tooltip dot in the dashboard follows in one cascade —
 * without a single chart component being edited or re-rendered.
 *
 * The `--color-*` indirection is not decoration: it is what lets a component use a *semantic* series
 * name (revenue, orders, refunds) while the actual hue stays a user preference.
 *
 * Recharts paints SVG presentation attributes, which is why the values are CSS custom properties
 * rather than literals — the same reason the previous chart module exported hex constants, solved
 * one level better: this one is themeable.
 */

export type ChartConfig = Record<
    string,
    {
        label?: React.ReactNode;
        /** A CSS colour, normally `var(--chart-N)`. */
        color?: string;
    }
>;

type ChartContextValue = { config: ChartConfig };

const ChartContext = React.createContext<ChartContextValue | null>(null);

function useChart() {
    const context = React.useContext(ChartContext);

    if (!context) {
        throw new Error("useChart must be used inside a ChartContainer");
    }

    return context;
}

function ChartContainer({
    id,
    className,
    children,
    config,
    ...props
}: React.ComponentProps<"div"> & {
    config: ChartConfig;
    children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}) {
    const uniqueId = React.useId();
    const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`;

    return (
        <ChartContext.Provider value={{ config }}>
            <div
                data-chart={chartId}
                className={cn(
                    "flex aspect-video w-full justify-center text-xs",
                    "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground",
                    "[&_.recharts-cartesian-grid_line]:stroke-border",
                    "[&_.recharts-surface]:outline-none",
                    className
                )}
                {...props}
            >
                {/* One scoped rule per series: this is the whole palette indirection. */}
                <style
                    dangerouslySetInnerHTML={{
                        __html: Object.entries(config)
                            .filter(([, value]) => Boolean(value.color))
                            .map(([key, value]) => `[data-chart=${chartId}] { --color-${key}: ${value.color}; }`)
                            .join("\n"),
                    }}
                />

                <RechartsPrimitive.ResponsiveContainer>
                    {children}
                </RechartsPrimitive.ResponsiveContainer>
            </div>
        </ChartContext.Provider>
    );
}

const ChartTooltip = RechartsPrimitive.Tooltip;

type TooltipRow = {
    name?: string | number;
    dataKey?: string | number;
    value?: number | string;
    color?: string;
    payload?: Record<string, unknown>;
};

function ChartTooltipContent({
    active,
    payload,
    label,
    formatter,
    labelFormatter,
    className,
}: {
    active?: boolean;
    payload?: TooltipRow[];
    label?: string | number;
    formatter?: (value: number | string, name: string) => React.ReactNode;
    labelFormatter?: (label: string | number) => React.ReactNode;
    className?: string;
}) {
    const { config } = useChart();

    if (!active || !payload?.length) {
        return null;
    }

    return (
        <div
            className={cn(
                "min-w-40 rounded-card border border-border bg-popover px-3 py-2 text-popover-foreground shadow-pop",
                className
            )}
        >
            {label !== undefined ? (
                <p className="mb-1.5 text-xs font-semibold">
                    {labelFormatter ? labelFormatter(label) : label}
                </p>
            ) : null}

            <div className="flex flex-col gap-1">
                {payload.map((row, index) => {
                    const key = String(row.dataKey ?? row.name ?? index);
                    const series = config[key];
                    const name = series?.label ?? row.name ?? key;

                    return (
                        <div
                            key={key}
                            className="flex items-center justify-between gap-4 text-xs"
                        >
                            <span className="flex items-center gap-2 text-muted-foreground">
                                <span
                                    aria-hidden
                                    className="size-2 shrink-0 rounded-full"
                                    style={{ backgroundColor: `var(--color-${key})` }}
                                />
                                {name}
                            </span>

                            <span className="font-semibold tabular-nums text-foreground">
                                {formatter
                                    ? formatter(row.value ?? "", key)
                                    : String(row.value ?? "")}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function ChartLegendContent({
    payload,
    className,
}: {
    payload?: { dataKey?: string | number; value?: string | number }[];
    className?: string;
}) {
    const { config } = useChart();

    if (!payload?.length) {
        return null;
    }

    return (
        <div className={cn("flex flex-wrap items-center justify-center gap-4 pt-3", className)}>
            {payload.map((entry, index) => {
                const key = String(entry.dataKey ?? entry.value ?? index);

                return (
                    <span key={key} className="flex items-center gap-2 text-xs">
                        <span
                            aria-hidden
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: `var(--color-${key})` }}
                        />
                        <span className="text-muted-foreground">
                            {config[key]?.label ?? entry.value}
                        </span>
                    </span>
                );
            })}
        </div>
    );
}

const ChartLegend = RechartsPrimitive.Legend;

export {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    ChartLegend,
    ChartLegendContent,
    useChart,
    RechartsPrimitive,
};
