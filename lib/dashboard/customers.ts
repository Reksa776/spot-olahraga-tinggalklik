import { Prisma } from "@prisma/client";

import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

import { resolveOrganizerFilter } from "./scope";

/**
 * ==========================================
 * DASHBOARD CUSTOMERS (derived, not a second model)
 * ==========================================
 *
 * A "customer" is a `User` who has placed an `EventOrder` with one of the organizers the
 * actor may read orders in. There is no `Customer` table and none is created: the buyer is
 * already `User`, the relationship is already `EventOrder.buyer`, and inventing a parallel
 * customer domain is exactly the duplication this project keeps refusing.
 *
 * All aggregation happens in the database (grouped counts/sums). Ticket counts are derived
 * from the tickets of those customers' OWN orders on the current page, so the list stays
 * bounded rather than loading every order in the tenant.
 */

export type DashboardCustomerRow = {
    userId: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    orders: number;
    tickets: number;
    /** Sum of PAID orders' `total`, as a decimal string. */
    spend: string;
    lastOrderAt: string;
};

export type DashboardCustomerListParams = {
    organizerId?: string | null;
    q?: string | null;
    page?: number;
    limit?: number;
};

const ZERO = new Prisma.Decimal(0);

export async function listDashboardCustomers(
    scope: AuthzScope,
    params: DashboardCustomerListParams = {}
) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));

    const organizerIds = resolveOrganizerFilter(
        scope,
        PERMISSIONS.ORDER_READ_TENANT,
        params.organizerId
    );

    if (organizerIds.length === 0) {
        return {
            items: [] as DashboardCustomerRow[],
            pagination: { page, limit, total: 0, totalPages: 0 },
        };
    }

    const baseWhere: Prisma.EventOrderWhereInput = {
        organizerId: { in: organizerIds },
        ...(params.q ? { buyer: { is: buildBuyerSearch(params.q) } } : {}),
    };

    // Two grouped projections over the same filter: one for the page (ordered by recency),
    // one for the paid-spend map. A single `groupBy` cannot carry two different `where`
    // clauses, and computing spend from the page rows alone would understate a customer
    // whose paid orders fall on a later page.
    const [groups, allUserGroups, spendGroups] = await Promise.all([
        prisma.eventOrder.groupBy({
            by: ["userId"],
            where: baseWhere,
            _count: { _all: true },
            _max: { createdAt: true },
            orderBy: { _max: { createdAt: "desc" } },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.eventOrder.groupBy({
            by: ["userId"],
            where: baseWhere,
        }),
        prisma.eventOrder.groupBy({
            by: ["userId"],
            where: { ...baseWhere, paymentStatus: "PAID" },
            _sum: { total: true },
        }),
    ]);

    const total = allUserGroups.length;

    if (groups.length === 0) {
        return {
            items: [] as DashboardCustomerRow[],
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        };
    }

    const userIds = groups.map((group) => group.userId);

    const [users, orders, spendByUser] = await Promise.all([
        prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true, phone: true },
        }),
        prisma.eventOrder.findMany({
            where: { organizerId: { in: organizerIds }, userId: { in: userIds } },
            select: { id: true, userId: true },
        }),
        Promise.resolve(
            new Map(
                spendGroups.map((group) => [
                    group.userId,
                    group._sum.total ?? ZERO,
                ])
            )
        ),
    ]);

    const ticketGroups = orders.length
        ? await prisma.ticket.groupBy({
              by: ["orderId"],
              where: { orderId: { in: orders.map((order) => order.id) } },
              _count: { _all: true },
          })
        : [];

    const orderOwner = new Map(
        orders.map((order) => [order.id, order.userId])
    );
    const ticketsByUser = new Map<string, number>();

    for (const group of ticketGroups) {
        const owner = orderOwner.get(group.orderId);

        if (!owner) {
            continue;
        }

        ticketsByUser.set(owner, (ticketsByUser.get(owner) ?? 0) + group._count._all);
    }

    const userById = new Map(users.map((user) => [user.id, user]));

    const items: DashboardCustomerRow[] = groups.map((group) => {
        const user = userById.get(group.userId);

        return {
            userId: group.userId,
            name: user?.name ?? null,
            email: user?.email ?? null,
            phone: user?.phone ?? null,
            orders: group._count._all,
            tickets: ticketsByUser.get(group.userId) ?? 0,
            spend: (spendByUser.get(group.userId) ?? ZERO).toFixed(2),
            lastOrderAt: (
                group._max.createdAt ?? new Date(0)
            ).toISOString(),
        };
    });

    return {
        items,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}

/** Free-text match across the buyer's own columns. */
function buildBuyerSearch(q: string): Prisma.UserWhereInput {
    return {
        OR: [
            { name: { contains: q } },
            { email: { contains: q } },
            { phone: { contains: q } },
        ],
    };
}
