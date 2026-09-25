import { Prisma } from "@prisma/client";

import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

import { hasPlatformPermission, organizerIdsWith } from "./scope";

/**
 * ==========================================
 * DASHBOARD OVERVIEW (back-office read model)
 * ==========================================
 *
 * Real aggregates only. Every figure below is a database query, scoped by the permission
 * that governs the underlying rows — there is no seeded number, no placeholder and no
 * fabricated trend. When the actor holds no tenant membership the tenant block is `null`
 * and the page says so, rather than rendering zeros that look like "no sales happened".
 *
 * ── WHY SOME BLOCKS ARE NULLABLE ──────────────────────────────────────────────────
 * "Zero orders" and "you cannot see orders" are different answers, and a dashboard that
 * renders both as `0` is lying about one of them. Each block is therefore present only
 * when the actor actually holds the permission for it, and `null` otherwise.
 *
 * Platform-scope metrics (sports, global PIC counts) are computed from the platform
 * permission map, which — like the rest of the codebase — never confers tenant access.
 * An ADMIN with a membership sees both blocks; an ADMIN without one sees only the
 * platform block.
 */

export type DashboardOverview = {
    /** Whether the tenant block was resolved at all. */
    hasTenantData: boolean;
    tenant: {
        eventsTotal: number;
        eventsPublished: number;
        eventsUpcoming: number;
        ordersTotal: number;
        ordersPaid: number;
        ordersPendingPayment: number;
        ticketsSold: number;
        /** Sum of PAID orders' `total`, as a decimal string. */
        revenue: string;
        paymentsPending: number;
        paymentsPaid: number;
        paymentsFailed: number;
        /**
         * The refund lifecycle, counted from the SAME permission as the orders block
         * (`order.read.tenant` — the permission the refunds board and the refund read model both
         * resolve). "Pending" is the operator's worklist (`PENDING`), "processing" is money the
         * operator has started moving but not yet evidenced, and "completed" is `REFUNDED`, which
         * is the only status that claims the money actually left.
         */
        refundsPending: number;
        refundsProcessing: number;
        refundsCompleted: number;
        refundsTotal: number;
    } | null;
    /**
     * ── SETTLEMENT / PIC PAYOUT STANDING ────────────────────────────────────────────
     *
     * `null` when the actor holds `settlement.prepare` in no organizer — the same condition
     * `listSettlements` and the Pencairan PIC board use, so an actor who would see an empty board
     * sees `null` here rather than a row of zeros that reads like "nothing is owed".
     *
     * `awaiting` is the operator's queue (`REQUESTED` + `PENDING_APPROVAL`); `paidAmount` is the
     * Σ `netAmount` of settlements that actually reached `PAID`, taken from the same groupBy as the
     * counts so the figure and the badge cannot disagree.
     */
    settlements: {
        total: number;
        awaiting: number;
        paid: number;
        paidAmount: string;
        byStatus: { status: string; count: number }[];
    } | null;
    platform: {
        sportsTotal: number;
        sportsActive: number;
        picActive: number;
        picPending: number;
        picTotal: number;
    } | null;
    /** The most recent events, for the "upcoming" panel. */
    upcomingEvents: {
        id: string;
        title: string;
        slug: string;
        status: string;
        startAt: string;
        organizerName: string;
    }[];
};

const ZERO = new Prisma.Decimal(0);

/** One row of a `groupBy(["status"])` count — used for the refund lifecycle tally. */
type StatusTally = { status: string; _count: { _all: number } };

export async function getDashboardOverview(
    scope: AuthzScope
): Promise<DashboardOverview> {
    const eventIds = organizerIdsWith(scope, PERMISSIONS.EVENT_READ);
    const orderIds = organizerIdsWith(scope, PERMISSIONS.ORDER_READ_TENANT);
    const paymentIds = organizerIdsWith(
        scope,
        PERMISSIONS.PAYMENT_READ_TENANT
    );

    const canReadEvents = eventIds.length > 0;
    const canReadOrders = orderIds.length > 0;
    const canReadPayments = paymentIds.length > 0;

    const [tenant, platform, upcomingEvents, settlements] = await Promise.all([
        canReadEvents || canReadOrders || canReadPayments
            ? readTenantBlock({ eventIds, orderIds, paymentIds })
            : Promise.resolve(null),
        readPlatformBlock(scope),
        readUpcomingEvents(eventIds),
        readSettlementBlock(scope),
    ]);

    return {
        hasTenantData: canReadEvents || canReadOrders || canReadPayments,
        tenant,
        platform,
        settlements,
        upcomingEvents,
    };
}

/**
 * The payout standing for the organizers the actor may settle in.
 *
 * One grouped read rather than a count per status: the status vocabulary is the schema's own enum,
 * and a `groupBy` means a status added later shows up here without this function changing.
 */
async function readSettlementBlock(scope: AuthzScope) {
    const organizerIds = organizerIdsWith(
        scope,
        PERMISSIONS.SETTLEMENT_PREPARE
    );

    if (organizerIds.length === 0) {
        return null;
    }

    const groups = await prisma.settlement.groupBy({
        by: ["status"],
        where: { organizerId: { in: organizerIds } },
        _count: { _all: true },
        _sum: { netAmount: true },
    });

    const countOf = (status: string) =>
        groups.find((group) => group.status === status)?._count._all ?? 0;
    const sumOf = (status: string) =>
        groups.find((group) => group.status === status)?._sum.netAmount ?? ZERO;

    return {
        total: groups.reduce((total, group) => total + group._count._all, 0),
        awaiting: countOf("REQUESTED") + countOf("PENDING_APPROVAL"),
        paid: countOf("PAID"),
        paidAmount: sumOf("PAID").toFixed(2),
        byStatus: groups
            .map((group) => ({ status: group.status, count: group._count._all }))
            .sort((a, b) => b.count - a.count),
    };
}

async function readTenantBlock({
    eventIds,
    orderIds,
    paymentIds,
}: {
    eventIds: string[];
    orderIds: string[];
    paymentIds: string[];
}) {
    const now = new Date();

    const canReadEvents = eventIds.length > 0;
    const canReadOrders = orderIds.length > 0;
    const canReadPayments = paymentIds.length > 0;

    const [
        eventsTotal,
        eventsPublished,
        eventsUpcoming,
        ordersTotal,
        ordersPaid,
        ordersPendingPayment,
        revenueAgg,
        ticketsSold,
        paymentsPending,
        paymentsPaid,
        paymentsFailed,
        refundGroups,
    ] = await Promise.all([
        canReadEvents
            ? prisma.event.count({ where: { organizerId: { in: eventIds } } })
            : Promise.resolve(0),
        /*
         * PUBLISHED **or** ONGOING.
         *
         * The lifecycle is monotonic (`PUBLISHED → ONGOING` at `startAt`, driven by the tick), and
         * both states are listed and on sale. Counting only `PUBLISHED` made the tile drop a live
         * event the moment it started, so "N dipublikasikan" under-reported exactly the events an
         * operator cares about most.
         */
        canReadEvents
            ? prisma.event.count({
                  where: {
                      organizerId: { in: eventIds },
                      status: { in: ["PUBLISHED", "ONGOING"] },
                  },
              })
            : Promise.resolve(0),
        /* Not-yet-started means a FUTURE `startAt`, which only `PUBLISHED` can hold. */
        canReadEvents
            ? prisma.event.count({
                  where: {
                      organizerId: { in: eventIds },
                      status: "PUBLISHED",
                      startAt: { gt: now },
                  },
              })
            : Promise.resolve(0),
        canReadOrders
            ? prisma.eventOrder.count({
                  where: { organizerId: { in: orderIds } },
              })
            : Promise.resolve(0),
        canReadOrders
            ? prisma.eventOrder.count({
                  where: {
                      organizerId: { in: orderIds },
                      paymentStatus: "PAID",
                  },
              })
            : Promise.resolve(0),
        canReadOrders
            ? prisma.eventOrder.count({
                  where: {
                      organizerId: { in: orderIds },
                      status: "PENDING_PAYMENT",
                  },
              })
            : Promise.resolve(0),
        canReadOrders
            ? prisma.eventOrder.aggregate({
                  where: {
                      organizerId: { in: orderIds },
                      paymentStatus: "PAID",
                  },
                  _sum: { total: true },
              })
            : Promise.resolve({ _sum: { total: null } }),
        canReadOrders
            ? prisma.ticket.count({
                  where: {
                      organizerId: { in: orderIds },
                      status: { in: ["ISSUED", "CHECKED_IN"] },
                  },
              })
            : Promise.resolve(0),
        canReadPayments
            ? prisma.payment.count({
                  where: {
                      organizerId: { in: paymentIds },
                      status: { in: ["UNPAID", "PENDING"] },
                  },
              })
            : Promise.resolve(0),
        canReadPayments
            ? prisma.payment.count({
                  where: {
                      organizerId: { in: paymentIds },
                      status: "PAID",
                  },
              })
            : Promise.resolve(0),
        canReadPayments
            ? prisma.payment.count({
                  where: {
                      organizerId: { in: paymentIds },
                      status: { in: ["FAILED", "EXPIRED"] },
                  },
              })
            : Promise.resolve(0),
        /*
         * Refunds are read under `order.read.tenant` — deliberately the SAME permission the refunds
         * board and `listDashboardRefunds` resolve, so an actor who sees refunds on the board sees
         * them counted here, and one who does not sees zeroes for the same reason.
         */
        canReadOrders
            ? prisma.refund.groupBy({
                  by: ["status"],
                  where: { organizerId: { in: orderIds } },
                  _count: { _all: true },
              })
            : Promise.resolve<StatusTally[]>([]),
    ]);

    const refundCount = (status: string) =>
        refundGroups.find((group) => group.status === status)?._count._all ?? 0;

    return {
        eventsTotal,
        eventsPublished,
        eventsUpcoming,
        ordersTotal,
        ordersPaid,
        ordersPendingPayment,
        ticketsSold,
        revenue: (revenueAgg._sum.total ?? ZERO).toFixed(2),
        paymentsPending,
        paymentsPaid,
        paymentsFailed,
        refundsPending: refundCount("PENDING"),
        refundsProcessing: refundCount("PROCESSING"),
        refundsCompleted: refundCount("REFUNDED"),
        refundsTotal: refundGroups.reduce(
            (total, group) => total + group._count._all,
            0
        ),
    };
}

async function readPlatformBlock(scope: AuthzScope) {
    const canManageSports = hasPlatformPermission(
        scope,
        PERMISSIONS.SPORT_MANAGE
    );
    const canManagePic = hasPlatformPermission(scope, PERMISSIONS.PIC_MANAGE);

    if (!canManageSports && !canManagePic) {
        return null;
    }

    const [sportsTotal, sportsActive, picActive, picPending, picTotal] =
        await Promise.all([
            canManageSports
                ? prisma.sport.count()
                : Promise.resolve(0),
            canManageSports
                ? prisma.sport.count({ where: { isActive: true } })
                : Promise.resolve(0),
            canManagePic
                ? prisma.pICProfile.count({ where: { status: "ACTIVE" } })
                : Promise.resolve(0),
            canManagePic
                ? prisma.pICProfile.count({ where: { status: "PENDING" } })
                : Promise.resolve(0),
            canManagePic
                ? prisma.pICProfile.count()
                : Promise.resolve(0),
        ]);

    return { sportsTotal, sportsActive, picActive, picPending, picTotal };
}

async function readUpcomingEvents(eventIds: string[]) {
    if (eventIds.length === 0) {
        return [];
    }

    const events = await prisma.event.findMany({
        where: {
            organizerId: { in: eventIds },
            status: { in: ["PUBLISHED", "ONGOING"] },
            startAt: { gt: new Date() },
        },
        select: {
            id: true,
            title: true,
            slug: true,
            status: true,
            startAt: true,
            organizer: { select: { name: true } },
        },
        orderBy: { startAt: "asc" },
        take: 5,
    });

    return events.map((event) => ({
        id: event.id,
        title: event.title,
        slug: event.slug,
        status: event.status,
        startAt: event.startAt.toISOString(),
        organizerName: event.organizer.name,
    }));
}
