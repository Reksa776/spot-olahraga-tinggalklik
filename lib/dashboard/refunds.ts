import { Prisma, type RefundStatus } from "@prisma/client";

import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

import { resolveOrganizerFilter } from "./scope";

/**
 * ==========================================
 * DASHBOARD REFUNDS (tenant-scoped read model)
 * ==========================================
 *
 * The back-office view of the refund lifecycle (Phase 10B). Like every other
 * `lib/dashboard/**` module this is a READ model: it lists the refunds a tenant has, and the
 * decisions themselves go through the autorized API routes (`refund.approve` /
 * `refund.execute`). Keeping the list here and the mutation in the service is what stops a
 * dashboard query from ever becoming a second path to moving money.
 *
 * Scoping mirrors `lib/dashboard/orders.ts` exactly: `resolveOrganizerFilter` with
 * `order.read.tenant`, never an unscoped query, and a requested organizer is re-decided
 * rather than trusted. The refund rows are the ones the service wrote; no domain logic is
 * re-implemented here.
 */

export const DASHBOARD_REFUND_SELECT = {
    id: true,
    refundNumber: true,
    status: true,
    requestedAmount: true,
    confirmedAmount: true,
    reason: true,
    failureReason: true,
    feeTreatment: true,
    /**
     * PHASE 18B (D-P17-04 = B): under the manual bank-transfer rail this is the operator's
     * bank/transfer REFERENCE, and `evidenceNote` the note recorded with it. Both are
     * surfaced so a reviewer can reconcile the refund against a bank statement — which is
     * the whole evidence model of a manual rail.
     */
    providerRef: true,
    evidenceNote: true,
    /**
     * PHASE 20B (additive): the server-generated basename of the attached transfer-evidence
     * FILE, read only so the board can build the staff serve href (`refundStaffEvidenceUrl`).
     * It is a dashboard-internal value — `lib/dashboard/**` is a server read model and this
     * route is never serialised — and the buyer payload answers the same question with a
     * boolean instead (see `lib/ticketing/refunds/payload.ts`).
     */
    evidenceFileKey: true,
    createdAt: true,
    approvedAt: true,
    processedAt: true,
    completedAt: true,
    failedAt: true,
    organizerId: true,
    organizer: { select: { id: true, name: true } },
    eventOrder: {
        select: {
            orderNumber: true,
            buyerName: true,
            buyerEmail: true,
            status: true,
            paymentStatus: true,
        },
    },
    requestedByUserId: true,
    _count: { select: { items: true } },
} satisfies Prisma.RefundSelect;

export type DashboardRefundRow = Prisma.RefundGetPayload<{
    select: typeof DASHBOARD_REFUND_SELECT;
}>;

export type DashboardRefundListParams = {
    organizerId?: string | null;
    status?: RefundStatus | null;
    q?: string | null;
    page?: number;
    limit?: number;
};

export async function listDashboardRefunds(
    scope: AuthzScope,
    params: DashboardRefundListParams = {}
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
            items: [] as DashboardRefundRow[],
            pagination: { page, limit, total: 0, totalPages: 0 },
        };
    }

    const where: Prisma.RefundWhereInput = {
        organizerId: { in: organizerIds },
        ...(params.status ? { status: params.status } : {}),
        ...(params.q
            ? {
                  OR: [
                      { refundNumber: { contains: params.q } },
                      { eventOrder: { orderNumber: { contains: params.q } } },
                      { eventOrder: { buyerName: { contains: params.q } } },
                      { eventOrder: { buyerEmail: { contains: params.q } } },
                  ],
              }
            : {}),
    };

    const [items, total] = await Promise.all([
        prisma.refund.findMany({
            where,
            select: DASHBOARD_REFUND_SELECT,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.refund.count({ where }),
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
