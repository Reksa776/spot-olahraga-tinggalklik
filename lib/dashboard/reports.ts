import { Prisma } from "@prisma/client";

import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

import { resolveOrganizerFilter } from "./scope";

/**
 * ==========================================
 * DASHBOARD REPORTS (real aggregates only)
 * ==========================================
 *
 * Every figure is derived from `EventOrder` / `Ticket` / `Payment`. No chart plots a value
 * that was not queried, and no trend is invented: the date range is an explicit window the
 * caller chose, and when a window has no rows the report says "no data" rather than drawing
 * a flat line to zero.
 *
 * Revenue is counted once, from PAID orders' `total` snapshot. Ticket counts come from the
 * `Ticket` rows (one per admittee) rather than from order quantities, so a refunded or
 * voided ticket is not counted as sold — the same definition the overview uses.
 */

export type DashboardReport = {
    range: { from: string | null; to: string | null };
    summary: {
        orders: number;
        paidOrders: number;
        ticketsSold: number;
        revenue: string;
        averageOrderValue: string;
    };
    byEvent: {
        eventId: string;
        title: string;
        slug: string;
        paidOrders: number;
        ticketsSold: number;
        revenue: string;
    }[];
    byMethod: {
        method: string;
        payments: number;
        amount: string;
    }[];
};

export type DashboardReportParams = {
    organizerId?: string | null;
    /** Inclusive lower bound. `null` = no lower bound. */
    from?: Date | null;
    /** Exclusive upper bound. `null` = now. */
    to?: Date | null;
};

export async function getDashboardReport(
    scope: AuthzScope,
    params: DashboardReportParams = {}
): Promise<DashboardReport> {
    const organizerIds = resolveOrganizerFilter(
        scope,
        PERMISSIONS.REPORT_TRANSACTION_READ,
        params.organizerId
    );

    const empty: DashboardReport = {
        range: {
            from: params.from?.toISOString() ?? null,
            to: params.to?.toISOString() ?? null,
        },
        summary: {
            orders: 0,
            paidOrders: 0,
            ticketsSold: 0,
            revenue: "0.00",
            averageOrderValue: "0.00",
        },
        byEvent: [],
        byMethod: [],
    };

    if (organizerIds.length === 0) {
        return empty;
    }

    const createdAt =
        params.from || params.to
            ? {
                  ...(params.from ? { gte: params.from } : {}),
                  ...(params.to ? { lt: params.to } : {}),
              }
            : undefined;

    const orderWhere: Prisma.EventOrderWhereInput = {
        organizerId: { in: organizerIds },
        ...(createdAt ? { createdAt } : {}),
    };

    const paidWhere: Prisma.EventOrderWhereInput = {
        ...orderWhere,
        paymentStatus: "PAID",
    };

    const [
        orders,
        paidOrders,
        revenueAgg,
        ticketsSold,
        eventGroups,
        methodGroups,
    ] = await Promise.all([
        prisma.eventOrder.count({ where: orderWhere }),
        prisma.eventOrder.count({ where: paidWhere }),
        prisma.eventOrder.aggregate({
            where: paidWhere,
            _sum: { total: true },
        }),
        prisma.ticket.count({
            where: {
                organizerId: { in: organizerIds },
                status: { in: ["ISSUED", "CHECKED_IN"] },
                ...(createdAt ? { createdAt } : {}),
            },
        }),
        prisma.eventOrder.groupBy({
            by: ["eventId"],
            where: paidWhere,
            _count: { _all: true },
            _sum: { total: true },
            orderBy: { _sum: { total: "desc" } },
            take: 20,
        }),
        prisma.payment.groupBy({
            by: ["method"],
            where: {
                organizerId: { in: organizerIds },
                status: "PAID",
                ...(createdAt ? { createdAt } : {}),
            },
            _count: { _all: true },
            _sum: { amount: true },
            orderBy: { _sum: { amount: "desc" } },
        }),
    ]);

    const revenue = revenueAgg._sum.total ?? new Prisma.Decimal(0);
    const average =
        paidOrders > 0
            ? revenue.div(paidOrders).toDecimalPlaces(2)
            : new Prisma.Decimal(0);

    const eventIds = eventGroups.map((group) => group.eventId);
    const events = eventIds.length
        ? await prisma.event.findMany({
              where: { id: { in: eventIds } },
              select: { id: true, title: true, slug: true },
          })
        : [];
    const eventById = new Map(events.map((event) => [event.id, event]));

    const ticketsByEvent = eventIds.length
        ? await prisma.ticket.groupBy({
              by: ["eventId"],
              where: {
                  eventId: { in: eventIds },
                  status: { in: ["ISSUED", "CHECKED_IN"] },
              },
              _count: { _all: true },
          })
        : [];
    const ticketCountByEvent = new Map(
        ticketsByEvent.map((group) => [group.eventId, group._count._all])
    );

    return {
        range: {
            from: params.from?.toISOString() ?? null,
            to: params.to?.toISOString() ?? null,
        },
        summary: {
            orders,
            paidOrders,
            ticketsSold,
            revenue: revenue.toFixed(2),
            averageOrderValue: average.toFixed(2),
        },
        byEvent: eventGroups.map((group) => ({
            eventId: group.eventId,
            title: eventById.get(group.eventId)?.title ?? "Event",
            slug: eventById.get(group.eventId)?.slug ?? "",
            paidOrders: group._count._all,
            ticketsSold: ticketCountByEvent.get(group.eventId) ?? 0,
            revenue: (group._sum.total ?? new Prisma.Decimal(0)).toFixed(2),
        })),
        byMethod: methodGroups.map((group) => ({
            method: group.method,
            payments: group._count._all,
            amount: (group._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
        })),
    };
}
