import { Prisma, type OrderStatus, type PaymentStatus } from "@prisma/client";

import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

import { resolveOrganizerFilter } from "./scope";

/**
 * ==========================================
 * DASHBOARD ORDERS (tenant-scoped read model)
 * ==========================================
 *
 * Reads `EventOrder` for the organizers the actor may read orders in. There is no order
 * domain re-implementation here — the rows are the ones the checkout wrote, and the
 * statuses are the model's own enums. This is a READ; nothing on this surface can move an
 * order or a payment, which is what keeps "admin cannot freely change money" structural
 * rather than a promise.
 *
 * The money shown is the immutable snapshot on the order (`total`, `subtotal`, ...), not a
 * re-derivation from current ticket prices, so a historical order keeps its historical
 * value.
 */

/**
 * The ORDER lifecycle states the dashboard is willing to QUERY, in lifecycle order.
 *
 * The tuple is `as const` so a typo in a page becomes a compile error, and it is typed as a subset
 * of the Prisma enum, so a rename in the schema breaks the build here rather than silently at
 * runtime. It is what the orders page validates a deep-linked `?status=` against before the value
 * reaches Prisma — an unrecognised value is ignored rather than handed to the query layer, where an
 * enum comparison would raise instead of rendering a page.
 */
export const ORDER_STATUS_FILTERS = [
    "PENDING_PAYMENT",
    "PAID",
    "CANCELLED",
    "EXPIRED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
] as const satisfies readonly OrderStatus[];

/**
 * The GATEWAY payment states the orders list offers as its one status filter, in lifecycle order.
 *
 * Exported from the read model because THAT is where the two lifecycles are defined: the orders page
 * imports this rather than keeping a second copy, so the options a pill offers and the values the
 * `paymentStatus` predicate accepts cannot drift apart.
 */
export const PAYMENT_STATUS_FILTERS = [
    "UNPAID",
    "PENDING",
    "PAID",
    "FAILED",
    "EXPIRED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
] as const satisfies readonly PaymentStatus[];

const ORDER_SELECT = {
    id: true,
    orderNumber: true,
    status: true,
    paymentStatus: true,
    buyerName: true,
    buyerEmail: true,
    buyerPhone: true,
    subtotal: true,
    discount: true,
    total: true,
    currency: true,
    createdAt: true,
    paidAt: true,
    cancelledAt: true,
    expiresAt: true,
    /**
     * PHASE 18B (D-P17-17): a late settlement — money received for an order that was already
     * final — is recorded on the row and its fulfilment blocked. Surfacing the timestamp is
     * what makes that state OPERABLE: an operator can see which orders moved money without
     * moving inventory, without this read model being able to change anything.
     */
    fulfilmentBlockedAt: true,
    event: { select: { id: true, title: true, slug: true } },
    organizer: { select: { id: true, name: true } },
    items: {
        select: { id: true, nameSnapshot: true, quantity: true },
    },
    _count: { select: { tickets: true } },
} satisfies Prisma.EventOrderSelect;

export type DashboardOrderRow = Prisma.EventOrderGetPayload<{
    select: typeof ORDER_SELECT;
}>;

export type DashboardOrderListParams = {
    organizerId?: string | null;
    status?: OrderStatus | null;
    /**
     * The GATEWAY payment state (`EventOrder.paymentStatus`) — a separate concept from the order
     * status above.
     *
     * It exists because "Tiket terjual" opens the orders list filtered on `paymentStatus = PAID`,
     * and that is deliberately NOT the same predicate as `status = PAID`: a late settlement leaves
     * a terminal order status (`CANCELLED`/`EXPIRED`) while `paymentStatus` becomes `PAID`. Keeping
     * the two fields distinct is what lets each filter mean exactly what the KPI means.
     *
     * When both `status` and `paymentStatus` are supplied they are AND-ed as sibling where keys —
     * one narrows the other, it never replaces it.
     */
    paymentStatus?: PaymentStatus | null;
    q?: string | null;
    /**
     * PHASE 18B (D-P17-17 / D-P17-18): the reconciliation read. It selects the two recoverable
     * states the product decisions left deliberately manual:
     *
     *   * a LATE SETTLEMENT (`fulfilmentBlockedAt` set) — money recorded, fulfilment blocked,
     *     never silently resurrected; and
     *   * a PAID order with ZERO tickets — allowed by construction because ticket issuance is
     *     buyer-triggered, and recoverable without the platform minting tickets on its own.
     *
     * ── WHY IT IS NO LONGER A CONTROL ON THE ORDERS PAGE ────────────────────────────
     * The orders list now offers ONE status filter (the gateway `paymentStatus`) plus search, so the
     * `Tampilan` / "Perlu tindakan" pill row and the page's `?review=1` handling were removed from the
     * SURFACE. This capability is deliberately retained: it is the read a reconciliation sweep uses to
     * find orders that moved money without moving inventory (`refund-reconciliation-visibility`
     * exercises it directly), and an operational/audit view of those two states must keep existing.
     * Nothing about the predicate changed — only who can reach it from the dashboard.
     *
     * Read-only: it changes no order, and neither branch here can issue a ticket.
     */
    needsReview?: boolean;
    page?: number;
    limit?: number;
};

export async function listDashboardOrders(
    scope: AuthzScope,
    params: DashboardOrderListParams = {}
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
            items: [] as DashboardOrderRow[],
            pagination: { page, limit, total: 0, totalPages: 0 },
        };
    }

    // Both optional predicates are `OR` groups, so they are combined under `AND` rather than
    // merged as sibling `OR` keys (which would silently have one clause override the other).
    const and: Prisma.EventOrderWhereInput[] = [];

    if (params.q) {
        and.push({
            OR: [
                { orderNumber: { contains: params.q } },
                { buyerName: { contains: params.q } },
                { buyerEmail: { contains: params.q } },
            ],
        });
    }

    if (params.needsReview) {
        and.push({
            OR: [
                { fulfilmentBlockedAt: { not: null } },
                { status: "PAID", tickets: { none: {} } },
            ],
        });
    }

    const where: Prisma.EventOrderWhereInput = {
        organizerId: { in: organizerIds },
        ...(params.status ? { status: params.status } : {}),
        ...(params.paymentStatus
            ? { paymentStatus: params.paymentStatus }
            : {}),
        ...(and.length > 0 ? { AND: and } : {}),
    };

    const [items, total] = await Promise.all([
        prisma.eventOrder.findMany({
            where,
            select: ORDER_SELECT,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.eventOrder.count({ where }),
    ]);

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

/** One order, for the detail view — scoped by the same permission as the list. */
export async function getDashboardOrder(
    scope: AuthzScope,
    orderNumber: string
) {
    const organizerIds = resolveOrganizerFilter(
        scope,
        PERMISSIONS.ORDER_READ_TENANT
    );

    if (organizerIds.length === 0) {
        return null;
    }

    return prisma.eventOrder.findFirst({
        where: { orderNumber, organizerId: { in: organizerIds } },
        select: {
            ...ORDER_SELECT,
            payments: {
                select: {
                    id: true,
                    method: true,
                    channel: true,
                    status: true,
                    amount: true,
                    providerFlow: true,
                    paymentNumber: true,
                    paymentName: true,
                    qrImageUrl: true,
                    paymentUrl: true,
                    createdAt: true,
                    providerExpiredAt: true,
                },
                orderBy: { createdAt: "desc" },
            },
            tickets: {
                select: {
                    id: true,
                    ticketCode: true,
                    status: true,
                    attendeeName: true,
                    checkedInAt: true,
                },
                orderBy: { sequenceNo: "asc" },
            },
        },
    });
}
