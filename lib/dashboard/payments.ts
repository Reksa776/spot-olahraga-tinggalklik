import { Prisma, type PaymentStatus } from "@prisma/client";

import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

import { resolveOrganizerFilter } from "./scope";

/**
 * ==========================================
 * DASHBOARD PAYMENTS (tenant-scoped read model)
 * ==========================================
 *
 * A READ of the `Payment` rows the existing iPaymu flow wrote. Nothing here can move a
 * payment to PAID: the only writer of a terminal payment state is the signature-verified,
 * idempotent webhook (`lib/ticketing/payment/webhook.ts`). An admin button that flips a
 * payment to PAID by hand is deliberately absent — the design forbids admin control of
 * money, and a "mark as paid" control would be exactly that.
 *
 * For a DIRECT instruction the gateway-issued instrument fields are selected so the
 * payments page can show the SAME QRIS/VA the buyer sees, rather than a summary that
 * loses it.
 *
 * ── PHASE 27E: THIS LIST IS THE RECONCILIATION WORKLIST ────────────────────────
 * Reconciliation ("Verifikasi status") is a per-row action on this table, and the table
 * already searches by payment reference and order number, so an operator holding a stuck
 * payment's reference finds it here and verifies it in one click. No second worklist query
 * was added: one would duplicate this filter and call no provider either way, while a
 * verification run must always be an explicit, one-payment decision — never something a
 * list render does in bulk.
 *
 * `providerTransactionId` is selected because the action depends on it: a row whose
 * provider transaction id was never captured cannot be verified at all, and the page says
 * so instead of drawing a button that must fail.
 */

const PAYMENT_SELECT = {
    id: true,
    provider: true,
    providerEnvironment: true,
    providerFlow: true,
    method: true,
    channel: true,
    amount: true,
    currency: true,
    status: true,
    paymentReference: true,
    paymentNumber: true,
    paymentName: true,
    qrImageUrl: true,
    qrString: true,
    paymentUrl: true,
    externalSessionId: true,
    /** Phase 27E: the persisted provider transaction id, or NULL when none was captured. */
    providerTransactionId: true,
    expiresAt: true,
    providerExpiredAt: true,
    createdAt: true,
    updatedAt: true,
    order: {
        select: {
            orderNumber: true,
            status: true,
            paymentStatus: true,
            paidAt: true,
            buyerName: true,
            buyerEmail: true,
            total: true,
            event: { select: { title: true, slug: true } },
        },
    },
    organizer: { select: { id: true, name: true } },
} satisfies Prisma.PaymentSelect;

export type DashboardPaymentRow = Prisma.PaymentGetPayload<{
    select: typeof PAYMENT_SELECT;
}>;

export type DashboardPaymentListParams = {
    organizerId?: string | null;
    status?: PaymentStatus | null;
    q?: string | null;
    page?: number;
    limit?: number;
};

export async function listDashboardPayments(
    scope: AuthzScope,
    params: DashboardPaymentListParams = {}
) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));

    const organizerIds = resolveOrganizerFilter(
        scope,
        PERMISSIONS.PAYMENT_READ_TENANT,
        params.organizerId
    );

    if (organizerIds.length === 0) {
        return {
            items: [] as DashboardPaymentRow[],
            pagination: { page, limit, total: 0, totalPages: 0 },
        };
    }

    const where: Prisma.PaymentWhereInput = {
        organizerId: { in: organizerIds },
        ...(params.status ? { status: params.status } : {}),
        ...(params.q
            ? {
                  OR: [
                      { paymentReference: { contains: params.q } },
                      { order: { orderNumber: { contains: params.q } } },
                      { order: { buyerName: { contains: params.q } } },
                  ],
              }
            : {}),
    };

    const [items, total] = await Promise.all([
        prisma.payment.findMany({
            where,
            select: PAYMENT_SELECT,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.payment.count({ where }),
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

