import { Prisma, type OrderStatus } from "@prisma/client";

import { AppError } from "@/lib/api/errors";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

import { resolveOrganizerFilter } from "./scope";

/**
 * ==========================================
 * DASHBOARD REPORTS (real aggregates only)
 * ==========================================
 *
 * Every figure is derived from `EventOrder` / `Ticket` / `Payment` / `Refund`. No chart plots a
 * value that was not queried, and no trend is invented: the date range is an explicit window the
 * caller chose, and when a window has no rows the report says "no data" rather than drawing a flat
 * line to zero.
 *
 * ── ONE READ MODEL, THREE CONSUMERS ────────────────────────────────────────────
 * The reports page, the dashboard's charts and the CSV/Excel export all read THIS module — the
 * aggregates from `getDashboardReport` and the row lists from the two loaders below, which share
 * its `where` builders. That is deliberate: "the export must match what the screen shows" is not
 * enforced by a promise here, it is enforced by there being one predicate per concept. If the page
 * and the download could disagree about what a filter means, they eventually would.
 *
 * ── DEFINITIONS (each one reused, never re-invented) ───────────────────────────
 *   orders          every `EventOrder` created inside the window (optionally status-filtered)
 *   paidOrders      those with `paymentStatus = PAID`
 *   revenue         Σ `total` of the PAID orders — the immutable snapshot, never a re-derivation
 *   ticketsSold     `Ticket` rows with `ISSUED`/`CHECKED_IN` created inside the window, so a
 *                   refunded or voided ticket is not counted as sold
 *   refunds         `Refund` rows that reached `REFUNDED` inside the window
 *   refundAmount    Σ `confirmedAmount` of those (the amount that actually left)
 *   netRevenue      revenue − refundAmount, computed in `Decimal`, never in floating point
 *
 * ── MONEY ──────────────────────────────────────────────────────────────────────
 * All money is `Decimal` in the database and a decimal STRING in every payload — the summaries, the
 * per-event/per-status/per-method figures and every exported cell. All arithmetic on it uses
 * `Prisma.Decimal` (exact). The ONE exception is `toDashboardChartPoints`, which converts money to
 * a `number` because a chart plots geometry; that projection is display-only and is never summed,
 * compared or written. No other conversion of a money value exists in this module.
 *
 * ── TIME / WINDOW CONTRACT ────────────────────────────────────────────────────
 * A filter value names an Asia/Jakarta CALENDAR DAY, whatever form it arrives in: `from` resolves
 * to 00:00:00.000 +07:00 of that day and `to` to 23:59:59.999 +07:00 of it, so picking the same day
 * in the date inputs includes that whole day regardless of the browser's or the server's timezone.
 * A date-only value (`YYYY-MM-DD`) names its own day; a FULL ISO TIMESTAMP names the Jakarta day it
 * falls in — the clock time is deliberately discarded and the instant is EXPANDED to the day around
 * it, not honoured to the millisecond. `to` is INCLUSIVE.
 *
 * ── THE TREND IS BUCKETED IN APPLICATION CODE, ON PURPOSE ─────────────────────
 * A per-day series needs a date truncation, and Prisma cannot express one portably — the only
 * alternative is `$queryRaw`, which would couple this module to PostgreSQL's `date_trunc`. So the
 * trend fetches three NARROW projections and buckets them by the Jakarta calendar day in one pass,
 * which keeps the module database-agnostic and unit-testable at the cost of reading the window's
 * rows. The window is therefore CAPPED (`DASHBOARD_REPORT_MAX_DAYS`), while the per-event,
 * per-status and per-method numbers come from database-side `groupBy`/`aggregate` and never depend
 * on that scan.
 */

/** The default window when the caller asks for none: the last 30 calendar days, inclusive. */
export const DASHBOARD_REPORT_DEFAULT_DAYS = 30;

/** The longest window the bucketed trend will serve. Longer is refused (export) / clamped (page). */
export const DASHBOARD_REPORT_MAX_DAYS = 366;

/** Above this many days the trend switches from daily to 7-day buckets, so the axis stays legible. */
export const DASHBOARD_REPORT_WEEK_BUCKET_AFTER_DAYS = 92;

/** The window shortcuts the filter bar offers. */
export const DASHBOARD_REPORT_PERIODS = {
    "7d": 7,
    "30d": 30,
    "3m": 90,
} as const;

export type DashboardReportPeriod = keyof typeof DASHBOARD_REPORT_PERIODS;

/** The order statuses that exist in the schema, in lifecycle order. */
export const DASHBOARD_REPORT_ORDER_STATUSES: readonly OrderStatus[] = [
    "PENDING_PAYMENT",
    "PAID",
    "CANCELLED",
    "EXPIRED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
];

/**
 * The operator-facing name of each order status.
 *
 * Defined HERE, beside the enum list, so the filter dropdown, the chart's category axis and the
 * table cannot label the same status three different ways. The values are the schema's own names —
 * nothing is invented, and a status added to the enum without a label here is a TypeScript error
 * rather than a raw `PARTIALLY_REFUNDED` leaking into the UI.
 */
export const DASHBOARD_REPORT_ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
    PENDING_PAYMENT: "Menunggu bayar",
    PAID: "Lunas",
    CANCELLED: "Dibatalkan",
    EXPIRED: "Kedaluwarsa",
    REFUNDED: "Dana dikembalikan",
    PARTIALLY_REFUNDED: "Refund sebagian",
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const JAKARTA_OFFSET = "+07:00";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `YYYY-MM-DD` for an instant, in Jakarta. `en-CA` is the one locale whose short date is already
 * ISO-ordered, so this needs no manual field assembly.
 */
const JAKARTA_DAY_KEY = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

/** `20 Sep` — the axis label on a chart and the date cell in a table. */
const JAKARTA_DAY_LABEL = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "short",
});

/**
 * `00:00:00.000 +07:00` of a Jakarta calendar day.
 *
 * Asia/Jakarta has been a fixed UTC+7 offset with no DST since 1964, so the offset can be written
 * literally and day arithmetic can be whole 24-hour steps. That is what makes the bucket keys
 * independent of the server's own timezone — the defect this convention exists to avoid.
 */
function jakartaDayStart(key: string): Date {
    return new Date(`${key}T00:00:00.000${JAKARTA_OFFSET}`);
}

function jakartaDayEnd(key: string): Date {
    return new Date(`${key}T23:59:59.999${JAKARTA_OFFSET}`);
}

function dayKeyOf(instant: Date): string {
    return JAKARTA_DAY_KEY.format(instant);
}

function dayLabel(key: string): string {
    return JAKARTA_DAY_LABEL.format(jakartaDayStart(key));
}

/** Every Jakarta calendar day from `firstKey` to `lastKey`, inclusive. */
function dayKeyRange(firstKey: string, lastKey: string): string[] {
    const start = jakartaDayStart(firstKey).getTime();
    const end = jakartaDayStart(lastKey).getTime();
    const keys: string[] = [];

    for (let cursor = start; cursor <= end; cursor += MS_PER_DAY) {
        keys.push(dayKeyOf(new Date(cursor)));
    }

    return keys;
}

/** Move a Jakarta day key by whole days. */
function shiftDayKey(key: string, days: number): string {
    return dayKeyOf(new Date(jakartaDayStart(key).getTime() + days * MS_PER_DAY));
}

/**
 * The instant a filter value points at, before `resolveDashboardReportFilters` snaps it to a
 * Jakarta day KEY. A date-only value is already a day boundary (`kind` picks which end); a full ISO
 * timestamp is whatever instant it names, and the caller keeps only the DAY that instant falls in.
 * `null` means the value is not a date at all — the caller decides whether that is a refusal.
 */
function parseBoundary(value: string, kind: "start" | "end"): Date | null {
    if (DATE_ONLY.test(value)) {
        const parsed = kind === "start" ? jakartaDayStart(value) : jakartaDayEnd(value);

        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* ------------------------------------------------------------------------------------------------
 * FILTERS
 * ------------------------------------------------------------------------------------------------
 */

export type DashboardReportQuery = {
    organizerId?: string | null;
    from?: string | null;
    to?: string | null;
    /** A `7d` / `30d` / `3m` shortcut, resolved against "now". Ignored when `from` is given. */
    period?: string | null;
    eventId?: string | null;
    status?: string | null;
};

export type DashboardReportFilters = {
    organizerId: string | null;
    from: Date;
    to: Date;
    fromKey: string;
    toKey: string;
    eventId: string | null;
    orderStatus: OrderStatus | null;
    period: DashboardReportPeriod | null;
    granularity: "day" | "week";
    /** True when the requested window exceeded `DASHBOARD_REPORT_MAX_DAYS` and was shortened. */
    clamped: boolean;
    /**
     * True when the caller's `from` was AFTER their `to` and the lenient parser replaced the
     * window with the default one. The page surfaces it so a mis-typed range is visible rather
     * than silently reported as "the last 30 days". Always `false` in strict mode, which refuses
     * the range instead of falling back.
     */
    rangeFallback: boolean;
};

/**
 * Resolve and validate report filters.
 *
 * ONE parser for the page and the export, with ONE deliberate difference between them, expressed
 * as `strict`:
 *
 *   * `strict: true` (the download endpoint) — an unrecognised value is a `VALIDATION_ERROR`,
 *     because a client that asked for `status=PAOD` must not receive an unfiltered export and
 *     believe the filter had applied;
 *   * `strict: false` (the HTML form) — an unrecognised value is ignored and the default applies,
 *     which is the same rule the refunds and settlements boards already use, so a hand-edited or
 *     stale URL degrades to "no filter" rather than to a 500 inside a page render.
 *
 * An impossible window (`from` after `to`) is a refusal in strict mode and "the default window
 * ending at your chosen `to`" in lenient mode. An over-long window is refused in strict mode and
 * clamped in lenient mode. Both are reported back as `clamped` so the UI can say so.
 */
export function resolveDashboardReportFilters(
    query: DashboardReportQuery = {},
    options: { strict?: boolean; now?: Date } = {}
): DashboardReportFilters {
    const strict = options.strict ?? false;
    const now = options.now ?? new Date();

    const period =
        query.period && query.period in DASHBOARD_REPORT_PERIODS
            ? (query.period as DashboardReportPeriod)
            : null;

    if (query.period && !period && strict) {
        throw AppError.validation(`Periode tidak dikenal: ${query.period}.`);
    }

    let toKey: string;

    if (query.to) {
        const parsed = parseBoundary(query.to, "end");

        if (!parsed) {
            if (strict) throw AppError.validation(`Tanggal tidak valid: ${query.to}.`);
            toKey = dayKeyOf(now);
        } else {
            toKey = dayKeyOf(parsed);
        }
    } else {
        toKey = dayKeyOf(now);
    }

    let fromKey: string | null = null;

    if (query.from) {
        const parsed = parseBoundary(query.from, "start");

        if (!parsed) {
            if (strict) throw AppError.validation(`Tanggal tidak valid: ${query.from}.`);
        } else {
            fromKey = dayKeyOf(parsed);
        }
    } else if (period) {
        fromKey = shiftDayKey(toKey, -(DASHBOARD_REPORT_PERIODS[period] - 1));
    }

    if (!fromKey) {
        fromKey = shiftDayKey(toKey, -(DASHBOARD_REPORT_DEFAULT_DAYS - 1));
    }

    let rangeFallback = false;

    if (fromKey > toKey) {
        if (strict) {
            throw AppError.validation("Rentang tanggal tidak valid (dari > sampai).");
        }

        fromKey = shiftDayKey(toKey, -(DASHBOARD_REPORT_DEFAULT_DAYS - 1));
        rangeFallback = true;
    }

    let clamped = false;

    if (dayKeyRange(fromKey, toKey).length > DASHBOARD_REPORT_MAX_DAYS) {
        if (strict) {
            throw AppError.validation(
                `Rentang tanggal maksimal ${DASHBOARD_REPORT_MAX_DAYS} hari.`
            );
        }

        fromKey = shiftDayKey(toKey, -(DASHBOARD_REPORT_MAX_DAYS - 1));
        clamped = true;
    }

    let orderStatus: OrderStatus | null = null;

    if (query.status) {
        if (DASHBOARD_REPORT_ORDER_STATUSES.includes(query.status as OrderStatus)) {
            orderStatus = query.status as OrderStatus;
        } else if (strict) {
            throw AppError.validation(`Status pesanan tidak dikenal: ${query.status}.`);
        }
    }

    return {
        organizerId: query.organizerId?.trim() ? query.organizerId.trim() : null,
        from: jakartaDayStart(fromKey),
        to: jakartaDayEnd(toKey),
        fromKey,
        toKey,
        eventId: query.eventId?.trim() ? query.eventId.trim() : null,
        orderStatus,
        period,
        granularity:
            dayKeyRange(fromKey, toKey).length > DASHBOARD_REPORT_WEEK_BUCKET_AFTER_DAYS
                ? "week"
                : "day",
        clamped,
        rangeFallback,
    };
}

/* ------------------------------------------------------------------------------------------------
 * WHERE BUILDERS
 * ------------------------------------------------------------------------------------------------
 * Exported so the row loaders — and only those — share them. There is one predicate per concept,
 * which is what makes "the export shows exactly what the screen shows" structural.
 */

/** Organizer scope + event + window. The `status` filter is deliberately NOT part of this. */
export function buildDashboardReportScopeWhere(
    filters: DashboardReportFilters,
    organizerIds: readonly string[]
): Prisma.EventOrderWhereInput {
    return {
        organizerId: { in: [...organizerIds] },
        createdAt: { gte: filters.from, lte: filters.to },
        ...(filters.eventId ? { eventId: filters.eventId } : {}),
    };
}

/** The scope above, narrowed by the order-status filter. */
export function buildDashboardReportOrderWhere(
    filters: DashboardReportFilters,
    organizerIds: readonly string[]
): Prisma.EventOrderWhereInput {
    return {
        ...buildDashboardReportScopeWhere(filters, organizerIds),
        ...(filters.orderStatus ? { status: filters.orderStatus } : {}),
    };
}

/** The orders whose `total` is revenue. */
export function buildDashboardReportPaidWhere(
    filters: DashboardReportFilters,
    organizerIds: readonly string[]
): Prisma.EventOrderWhereInput {
    return {
        ...buildDashboardReportOrderWhere(filters, organizerIds),
        paymentStatus: "PAID",
    };
}

/** Tickets counted as sold: issued or checked in, inside the window. */
export function buildDashboardReportTicketWhere(
    filters: DashboardReportFilters,
    organizerIds: readonly string[]
): Prisma.TicketWhereInput {
    return {
        organizerId: { in: [...organizerIds] },
        createdAt: { gte: filters.from, lte: filters.to },
        status: { in: ["ISSUED", "CHECKED_IN"] },
        ...(filters.eventId ? { eventId: filters.eventId } : {}),
    };
}

/**
 * Refunds that actually completed inside the window.
 *
 * The ORDER-level filters (`eventId`, and the status filter) are applied through the refund's
 * order, not ignored. That is what keeps `netRevenue` coherent: with, say, `status=PENDING_PAYMENT`
 * selected, the revenue side is zero, and a refund belonging to a LUNAS order must not then be
 * subtracted from it — that would print a negative net revenue for a filter that selected no money
 * at all. The refund set is therefore the refunds OF the orders in scope.
 */
export function buildDashboardReportRefundWhere(
    filters: DashboardReportFilters,
    organizerIds: readonly string[]
): Prisma.RefundWhereInput {
    const orderFilter: Prisma.EventOrderWhereInput = {
        ...(filters.eventId ? { eventId: filters.eventId } : {}),
        ...(filters.orderStatus ? { status: filters.orderStatus } : {}),
    };

    return {
        organizerId: { in: [...organizerIds] },
        createdAt: { gte: filters.from, lte: filters.to },
        status: "REFUNDED",
        ...(Object.keys(orderFilter).length > 0 ? { eventOrder: orderFilter } : {}),
    };
}

/** Settled payment attempts — the money actually collected, per method / channel. */
export function buildDashboardReportPaymentWhere(
    filters: DashboardReportFilters,
    organizerIds: readonly string[]
): Prisma.PaymentWhereInput {
    return {
        organizerId: { in: [...organizerIds] },
        status: "PAID",
        createdAt: { gte: filters.from, lte: filters.to },
        ...(filters.eventId ? { order: { eventId: filters.eventId } } : {}),
    };
}

/* ------------------------------------------------------------------------------------------------
 * PAYLOAD
 * ------------------------------------------------------------------------------------------------
 */

export type DashboardReportSummary = {
    orders: number;
    paidOrders: number;
    ticketsSold: number;
    revenue: string;
    refunds: number;
    refundAmount: string;
    netRevenue: string;
    averageOrderValue: string;
};

export type DashboardReportTrendPoint = {
    /** Bucket start, as a Jakarta `YYYY-MM-DD` key. */
    key: string;
    label: string;
    orders: number;
    paidOrders: number;
    ticketsSold: number;
    revenue: string;
    refundAmount: string;
    netRevenue: string;
};

export type DashboardReportEventRow = {
    eventId: string;
    title: string;
    slug: string;
    paidOrders: number;
    ticketsSold: number;
    revenue: string;
    refundAmount: string;
    netRevenue: string;
};

export type DashboardReport = {
    range: {
        from: string;
        to: string;
        fromKey: string;
        toKey: string;
        label: string;
    };
    filters: {
        organizerId: string | null;
        eventId: string | null;
        orderStatus: OrderStatus | null;
        period: DashboardReportPeriod | null;
        granularity: "day" | "week";
        clamped: boolean;
        rangeFallback: boolean;
    };
    summary: DashboardReportSummary;
    trend: DashboardReportTrendPoint[];
    orderStatus: { status: OrderStatus; count: number }[];
    byEvent: DashboardReportEventRow[];
    byMethod: { method: string; payments: number; amount: string }[];
    /** Events the actor may filter by — resolved under the SAME authority as the rows. */
    eventOptions: { id: string; title: string; slug: string }[];
};

const ZERO = new Prisma.Decimal(0);

type TrendOrderRow = { createdAt: Date; paymentStatus: string; total: Prisma.Decimal };
type TrendTicketRow = { createdAt: Date };
type TrendRefundRow = { createdAt: Date; confirmedAmount: Prisma.Decimal };

/**
 * Fold the three narrow projections into one series of buckets.
 *
 * Buckets are 7 days wide once the window exceeds `DASHBOARD_REPORT_WEEK_BUCKET_AFTER_DAYS`.
 * Days with no rows are KEPT as explicit zeros: the range is a window the operator chose, so
 * "nothing sold on the 14th" is a real answer rather than missing data. When the WHOLE window is
 * empty the page renders its empty state instead of this series (`summary` is all zeros).
 */
export function buildDashboardTrend(
    filters: DashboardReportFilters,
    orders: readonly TrendOrderRow[],
    tickets: readonly TrendTicketRow[],
    refunds: readonly TrendRefundRow[]
): DashboardReportTrendPoint[] {
    const keys = dayKeyRange(filters.fromKey, filters.toKey);
    const size = filters.granularity === "week" ? 7 : 1;
    const groups: string[][] = [];

    for (let index = 0; index < keys.length; index += size) {
        groups.push(keys.slice(index, index + size));
    }

    const bucketForDay = new Map<string, number>();

    groups.forEach((group, index) => {
        for (const key of group) {
            bucketForDay.set(key, index);
        }
    });

    const points = groups.map((group) => ({
        key: group[0],
        label:
            group.length > 1
                ? `${dayLabel(group[0])} – ${dayLabel(group[group.length - 1])}`
                : dayLabel(group[0]),
        orders: 0,
        paidOrders: 0,
        ticketsSold: 0,
        revenue: ZERO,
        refundAmount: ZERO,
    }));

    for (const order of orders) {
        const index = bucketForDay.get(dayKeyOf(order.createdAt));

        if (index === undefined) continue;

        points[index].orders += 1;

        if (order.paymentStatus === "PAID") {
            points[index].paidOrders += 1;
            points[index].revenue = points[index].revenue.plus(order.total);
        }
    }

    for (const ticket of tickets) {
        const index = bucketForDay.get(dayKeyOf(ticket.createdAt));

        if (index === undefined) continue;

        points[index].ticketsSold += 1;
    }

    for (const refund of refunds) {
        const index = bucketForDay.get(dayKeyOf(refund.createdAt));

        if (index === undefined) continue;

        points[index].refundAmount = points[index].refundAmount.plus(refund.confirmedAmount);
    }

    return points.map((point) => ({
        key: point.key,
        label: point.label,
        orders: point.orders,
        paidOrders: point.paidOrders,
        ticketsSold: point.ticketsSold,
        revenue: point.revenue.toFixed(2),
        refundAmount: point.refundAmount.toFixed(2),
        netRevenue: point.revenue.minus(point.refundAmount).toFixed(2),
    }));
}

/**
 * A trend point shaped for a chart: the same figures with the money as NUMBERS.
 *
 * This function is the ONE place in the dashboard where a `Decimal` string becomes a `number`, and
 * it exists so that conversion happens exactly once rather than in each chart's caller. It is a
 * DISPLAY projection only — a chart plots geometry, and the value of record stays the decimal
 * string on the payload. Nothing computed here is written back or compared.
 */
export type DashboardReportChartPoint = {
    label: string;
    orders: number;
    paidOrders: number;
    ticketsSold: number;
    revenue: number;
    refundAmount: number;
    netRevenue: number;
};

export function toDashboardChartPoints(
    points: readonly DashboardReportTrendPoint[]
): DashboardReportChartPoint[] {
    return points.map((point) => ({
        label: point.label,
        orders: point.orders,
        paidOrders: point.paidOrders,
        ticketsSold: point.ticketsSold,
        revenue: Number(point.revenue),
        refundAmount: Number(point.refundAmount),
        netRevenue: Number(point.netRevenue),
    }));
}

function emptyReport(filters: DashboardReportFilters): DashboardReport {
    return {
        range: {
            from: filters.from.toISOString(),
            to: filters.to.toISOString(),
            fromKey: filters.fromKey,
            toKey: filters.toKey,
            label: `${dayLabel(filters.fromKey)} – ${dayLabel(filters.toKey)}`,
        },
        filters: {
            organizerId: filters.organizerId,
            eventId: filters.eventId,
            orderStatus: filters.orderStatus,
            period: filters.period,
            granularity: filters.granularity,
            clamped: filters.clamped,
            rangeFallback: filters.rangeFallback,
        },
        summary: {
            orders: 0,
            paidOrders: 0,
            ticketsSold: 0,
            revenue: "0.00",
            refunds: 0,
            refundAmount: "0.00",
            netRevenue: "0.00",
            averageOrderValue: "0.00",
        },
        trend: buildDashboardTrend(filters, [], [], []),
        orderStatus: DASHBOARD_REPORT_ORDER_STATUSES.map((status) => ({ status, count: 0 })),
        byEvent: [],
        byMethod: [],
        // The event list is still offered: an actor with no reportable tenant sees no rows, but a
        // tenant they CAN see with no sales in the window still needs its events in the dropdown.
        eventOptions: [],
    };
}

/* ------------------------------------------------------------------------------------------------
 * THE REPORT
 * ------------------------------------------------------------------------------------------------
 */

export async function getDashboardReport(
    scope: AuthzScope,
    filters: DashboardReportFilters
): Promise<DashboardReport> {
    const organizerIds = resolveOrganizerFilter(
        scope,
        PERMISSIONS.REPORT_TRANSACTION_READ,
        filters.organizerId
    );

    if (organizerIds.length === 0) {
        return emptyReport(filters);
    }

    const orderWhere = buildDashboardReportOrderWhere(filters, organizerIds);
    const paidWhere = buildDashboardReportPaidWhere(filters, organizerIds);
    const scopeWhere = buildDashboardReportScopeWhere(filters, organizerIds);
    const ticketWhere = buildDashboardReportTicketWhere(filters, organizerIds);
    const refundWhere = buildDashboardReportRefundWhere(filters, organizerIds);
    const paymentWhere = buildDashboardReportPaymentWhere(filters, organizerIds);

    const [
        orderRows,
        ticketRows,
        refundRows,
        revenueAgg,
        eventGroups,
        methodGroups,
        statusGroups,
        eventOptions,
    ] = await Promise.all([
        prisma.eventOrder.findMany({
            where: orderWhere,
            select: { createdAt: true, paymentStatus: true, total: true },
        }),
        prisma.ticket.findMany({
            where: ticketWhere,
            select: { createdAt: true, eventId: true },
        }),
        prisma.refund.findMany({
            where: refundWhere,
            select: {
                createdAt: true,
                confirmedAmount: true,
                eventOrder: { select: { eventId: true } },
            },
        }),
        prisma.eventOrder.aggregate({ where: paidWhere, _sum: { total: true } }),
        prisma.eventOrder.groupBy({
            by: ["eventId"],
            where: paidWhere,
            _count: { _all: true },
            _sum: { total: true },
            orderBy: { _sum: { total: "desc" } },
            take: 50,
        }),
        prisma.payment.groupBy({
            by: ["method"],
            where: paymentWhere,
            _count: { _all: true },
            _sum: { amount: true },
            orderBy: { _sum: { amount: "desc" } },
        }),
        // Deliberately the SCOPE where (no status filter): a distribution narrowed by its own
        // filter would always collapse to a single bar and stop being a distribution.
        prisma.eventOrder.groupBy({
            by: ["status"],
            where: scopeWhere,
            _count: { _all: true },
        }),
        prisma.event.findMany({
            where: { organizerId: { in: organizerIds } },
            select: { id: true, title: true, slug: true },
            orderBy: [{ startAt: "desc" }, { createdAt: "desc" }],
            take: 200,
        }),
    ]);

    // ── Summary ─────────────────────────────────────────────────────────────────────────
    const paidOrders = orderRows.filter((row) => row.paymentStatus === "PAID").length;
    const revenue = revenueAgg._sum.total ?? ZERO;
    const refundAmount = refundRows.reduce(
        (total, row) => total.plus(row.confirmedAmount),
        ZERO
    );

    const summary: DashboardReportSummary = {
        orders: orderRows.length,
        paidOrders,
        ticketsSold: ticketRows.length,
        revenue: revenue.toFixed(2),
        refunds: refundRows.length,
        refundAmount: refundAmount.toFixed(2),
        netRevenue: revenue.minus(refundAmount).toFixed(2),
        averageOrderValue:
            paidOrders > 0 ? revenue.div(paidOrders).toDecimalPlaces(2).toFixed(2) : "0.00",
    };

    // ── Per-event ───────────────────────────────────────────────────────────────────────
    const eventById = new Map(eventOptions.map((event) => [event.id, event]));
    const paidEventIds = new Set(eventGroups.map((group) => group.eventId));

    const ticketsByEvent = new Map<string, number>();

    for (const ticket of ticketRows) {
        if (!paidEventIds.has(ticket.eventId)) continue;

        ticketsByEvent.set(ticket.eventId, (ticketsByEvent.get(ticket.eventId) ?? 0) + 1);
    }

    const refundsByEvent = new Map<string, Prisma.Decimal>();

    for (const refund of refundRows) {
        const eventId = refund.eventOrder?.eventId;

        if (!eventId) continue;

        refundsByEvent.set(
            eventId,
            (refundsByEvent.get(eventId) ?? ZERO).plus(refund.confirmedAmount)
        );
    }

    const byEvent: DashboardReportEventRow[] = eventGroups.map((group) => {
        const gross = group._sum.total ?? ZERO;
        const refunded = refundsByEvent.get(group.eventId) ?? ZERO;

        return {
            eventId: group.eventId,
            title: eventById.get(group.eventId)?.title ?? "Event",
            slug: eventById.get(group.eventId)?.slug ?? "",
            paidOrders: group._count._all,
            ticketsSold: ticketsByEvent.get(group.eventId) ?? 0,
            revenue: gross.toFixed(2),
            refundAmount: refunded.toFixed(2),
            netRevenue: gross.minus(refunded).toFixed(2),
        };
    });

    return {
        range: {
            from: filters.from.toISOString(),
            to: filters.to.toISOString(),
            fromKey: filters.fromKey,
            toKey: filters.toKey,
            label: `${dayLabel(filters.fromKey)} – ${dayLabel(filters.toKey)}`,
        },
        filters: {
            organizerId: filters.organizerId,
            eventId: filters.eventId,
            orderStatus: filters.orderStatus,
            period: filters.period,
            granularity: filters.granularity,
            clamped: filters.clamped,
            rangeFallback: filters.rangeFallback,
        },
        summary,
        trend: buildDashboardTrend(filters, orderRows, ticketRows, refundRows),
        orderStatus: DASHBOARD_REPORT_ORDER_STATUSES.map((status) => ({
            status,
            count: statusGroups.find((group) => group.status === status)?._count._all ?? 0,
        })),
        byEvent,
        byMethod: methodGroups.map((group) => ({
            method: group.method,
            payments: group._count._all,
            amount: (group._sum.amount ?? ZERO).toFixed(2),
        })),
        eventOptions,
    };
}

/* ------------------------------------------------------------------------------------------------
 * ROW LOADERS (the export's sheets)
 * ------------------------------------------------------------------------------------------------
 * Each one resolves the organizer scope with the export permission, then reuses the SAME where
 * builders as the aggregates. `EXPORT_ROW_LIMIT` bounds a download so a runaway window cannot
 * exhaust the process; the Summary sheet says when it was reached, so a truncated file is never
 * mistaken for a complete one.
 */

export const DASHBOARD_REPORT_EXPORT_ROW_LIMIT = 20000;

export type DashboardReportOrderRow = {
    orderNumber: string;
    createdAt: string;
    paidAt: string | null;
    eventTitle: string;
    organizerName: string;
    buyerName: string;
    buyerEmail: string | null;
    status: OrderStatus;
    paymentStatus: string;
    subtotal: string;
    discount: string;
    total: string;
    currency: string;
};

export type DashboardReportRefundRow = {
    refundNumber: string;
    createdAt: string;
    completedAt: string | null;
    orderNumber: string;
    buyerName: string;
    eventTitle: string;
    status: string;
    requestedAmount: string;
    confirmedAmount: string;
    providerRef: string | null;
};

async function reportOrganizerIds(
    scope: AuthzScope,
    filters: DashboardReportFilters,
    permission: string
): Promise<string[]> {
    return resolveOrganizerFilter(scope, permission, filters.organizerId);
}

/** The order-level rows behind the aggregates. Requires `report.export.transaction`. */
export async function loadDashboardReportOrderRows(
    scope: AuthzScope,
    filters: DashboardReportFilters
): Promise<{ rows: DashboardReportOrderRow[]; truncated: boolean }> {
    const organizerIds = await reportOrganizerIds(
        scope,
        filters,
        PERMISSIONS.REPORT_EXPORT_TRANSACTION
    );

    if (organizerIds.length === 0) {
        return { rows: [], truncated: false };
    }

    const rows = await prisma.eventOrder.findMany({
        where: buildDashboardReportOrderWhere(filters, organizerIds),
        select: {
            orderNumber: true,
            createdAt: true,
            paidAt: true,
            buyerName: true,
            buyerEmail: true,
            status: true,
            paymentStatus: true,
            subtotal: true,
            discount: true,
            total: true,
            currency: true,
            event: { select: { title: true } },
            organizer: { select: { name: true } },
        },
        orderBy: [{ createdAt: "asc" }, { orderNumber: "asc" }],
        take: DASHBOARD_REPORT_EXPORT_ROW_LIMIT + 1,
    });

    const truncated = rows.length > DASHBOARD_REPORT_EXPORT_ROW_LIMIT;

    return {
        truncated,
        rows: rows.slice(0, DASHBOARD_REPORT_EXPORT_ROW_LIMIT).map((row) => ({
            orderNumber: row.orderNumber,
            createdAt: row.createdAt.toISOString(),
            paidAt: row.paidAt?.toISOString() ?? null,
            eventTitle: row.event.title,
            organizerName: row.organizer.name,
            buyerName: row.buyerName,
            buyerEmail: row.buyerEmail,
            status: row.status,
            paymentStatus: row.paymentStatus,
            subtotal: row.subtotal.toFixed(2),
            discount: row.discount.toFixed(2),
            total: row.total.toFixed(2),
            currency: row.currency,
        })),
    };
}

/** The refund rows behind the aggregates. Requires `report.export.transaction`. */
export async function loadDashboardReportRefundRows(
    scope: AuthzScope,
    filters: DashboardReportFilters
): Promise<{ rows: DashboardReportRefundRow[]; truncated: boolean }> {
    const organizerIds = await reportOrganizerIds(
        scope,
        filters,
        PERMISSIONS.REPORT_EXPORT_TRANSACTION
    );

    if (organizerIds.length === 0) {
        return { rows: [], truncated: false };
    }

    const rows = await prisma.refund.findMany({
        where: buildDashboardReportRefundWhere(filters, organizerIds),
        select: {
            refundNumber: true,
            createdAt: true,
            completedAt: true,
            status: true,
            requestedAmount: true,
            confirmedAmount: true,
            providerRef: true,
            eventOrder: {
                select: {
                    orderNumber: true,
                    buyerName: true,
                    event: { select: { title: true } },
                },
            },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: DASHBOARD_REPORT_EXPORT_ROW_LIMIT + 1,
    });

    const truncated = rows.length > DASHBOARD_REPORT_EXPORT_ROW_LIMIT;

    return {
        truncated,
        rows: rows.slice(0, DASHBOARD_REPORT_EXPORT_ROW_LIMIT).map((row) => ({
            refundNumber: row.refundNumber ?? "",
            createdAt: row.createdAt.toISOString(),
            completedAt: row.completedAt?.toISOString() ?? null,
            orderNumber: row.eventOrder?.orderNumber ?? "",
            buyerName: row.eventOrder?.buyerName ?? "",
            eventTitle: row.eventOrder?.event?.title ?? "",
            status: row.status,
            requestedAmount: row.requestedAmount.toFixed(2),
            confirmedAmount: row.confirmedAmount.toFixed(2),
            providerRef: row.providerRef,
        })),
    };
}

export const __reportsInternals = {
    dayKeyOf,
    dayLabel,
    dayKeyRange,
    shiftDayKey,
    parseBoundary,
    jakartaDayStart,
    jakartaDayEnd,
};
