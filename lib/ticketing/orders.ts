import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { requireOwnResource } from "@/lib/authz/guards";

import { writeTicketingAudit } from "./audit-log";
import { voidOpenPayments } from "./payment/void";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz/permissions";
import { prisma } from "@/lib/prisma";

import {
    ORDER_PAYLOAD_SELECT,
    buildOrderPayload,
    type OrderPayload,
} from "./order-payload";
import { releaseOrderReservations } from "./reservations";

/**
 * ==========================================
 * CUSTOMER ORDER OPERATIONS (design §26)
 * ==========================================
 *
 * §26's preamble is the rule this module implements:
 *
 *   "All endpoints below require a session. Every one applies an **ownership
 *    predicate** (`userId = session.user.id`) in addition to any permission check —
 *    the Phase 0 pattern (`where: { id, userId }`, verified in
 *    `app/api/orders/[id]/route.ts`) is preserved and is mandatory."
 *
 * So there are two independent gates and both are here:
 *
 *   1. **Ownership** — every query filters on `userId: actor.userId`. An order that
 *      belongs to somebody else simply is not found, and the answer is `NOT_FOUND`
 *      (404). It is never 403-for-your-own-record-missing, because a 403 would confirm
 *      that the order exists (brief §14: no IDOR, no existence oracle).
 *   2. **Permission** — `requireOwnResource` checks the own-scope capability from the
 *      Phase 3 map. This is the design's "in addition to any permission check", and it
 *      is what stops a role that is authenticated but has no own-scope order capability
 *      from touching an order it happens to own.
 *
 * Ordering matters: the ownership predicate runs **first**, so a caller cannot learn
 * anything about an order they do not own, whatever their permissions.
 */

/**
 * Resolve one of the actor's own orders, or 404.
 *
 * Shared by the read and the cancel path so there is exactly one ownership predicate
 * for orders in the codebase.
 */
async function findOwnOrderRow(orderNumber: string, actor: AuthzScope) {
    const order = await prisma.eventOrder.findFirst({
        where: { orderNumber, userId: actor.userId },
        // `organizerId` is read for the AUDIT row's tenant column only (§32.2). It is
        // never projected into a customer payload — `ORDER_PAYLOAD_SELECT` deliberately
        // omits it.
        select: { id: true, status: true, organizerId: true },
    });

    if (!order) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Pesanan tidak ditemukan.",
        });
    }

    return order;
}

/** `GET /api/orders/{orderNumber}` — the buyer's own order (design §26.2). */
export async function getOwnOrder(
    orderNumber: string,
    actor: AuthzScope
): Promise<OrderPayload> {
    const order = await findOwnOrderRow(orderNumber, actor);

    // The second gate: the row is provably the actor's, so checking the own-scope
    // capability against the actor's own id is exact.
    await requireOwnResource(PERMISSIONS.ORDER_READ_OWN, actor.userId);

    const row = await prisma.eventOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: ORDER_PAYLOAD_SELECT,
    });

    return buildOrderPayload(row);
}

/**
 * `POST /api/orders/{orderNumber}/cancel` — cancel an unpaid order (design §26.4).
 *
 * §26.4: "Allowed only while `PENDING_PAYMENT`. Releases reservations (`reserved -= n`),
 * voids the open `Payment`, and sets `CANCELLED`. A paid order **cannot** be cancelled."
 *
 * Two notes on the differences from that sentence in this phase:
 *
 *   - There is no `Payment` row to void, because creating one is Phase 7 (the Phase 6
 *     brief forbids invoking the gateway). The design's quota effect — releasing the
 *     reservations — is fully implemented; the payment half becomes a no-op-with-nothing-
 *     to-void rather than being skipped.
 *   - The order status transition is a **guarded** `updateMany`, not a read-then-write.
 *     That is what makes "cancel" race-safe against the expiry path: if the reaper
 *     expired this order a millisecond earlier, this call loses cleanly and reports
 *     `ORDER_NOT_PAYABLE` instead of resurrecting an expired order into `CANCELLED`
 *     (§12.3 forbids `EXPIRED → CANCELLED`).
 */
export async function cancelOwnPendingOrder(
    orderNumber: string,
    actor: AuthzScope,
    reason?: string
): Promise<OrderPayload> {
    const order = await findOwnOrderRow(orderNumber, actor);

    await requireOwnResource(PERMISSIONS.ORDER_CANCEL_OWN, actor.userId);

    if (order.status !== "PENDING_PAYMENT") {
        throw new AppError(ERROR_CODES.ORDER_NOT_PAYABLE, {
            message: "Pesanan ini tidak dapat dibatalkan.",
            details: { status: order.status, reason: "NOT_PENDING_PAYMENT" },
        });
    }

    const cancelledAt = new Date();
    let paymentsVoided = 0;

    await prisma.$transaction(
        async (tx) => {
            /* ==========================================
             * PHASE 7 — THE CAS COMES FIRST
             * ==========================================
             *
             * Phase 6 released the reservations and only then checked that the order was
             * still `PENDING_PAYMENT`. That was already safe (the loser throws, so its
             * release rolls back), but it took the locks in the opposite order to the
             * settlement path — reservations first, order row second — while settlement
             * (and, after the Phase 7 reaper fix, expiry) take the order row first. Two
             * transactions acquiring the same two rows in opposite orders is the classic
             * deadlock, and InnoDB resolves it by killing one: the buyer would see a 500
             * instead of a clean "cannot cancel".
             *
             * Claiming the order row first makes all three transitions (cancel, expire,
             * settle) lock in the SAME direction, so exactly one can win and the losers get
             * a deterministic answer — which is what brief §17 asks for ("exactly one valid
             * terminal outcome"). Behaviour on the losing path is unchanged: the throw still
             * rolls everything back.
             */
            const updated = await tx.eventOrder.updateMany({
                where: { id: order.id, status: "PENDING_PAYMENT" },
                data: {
                    status: "CANCELLED",
                    cancelledAt,
                    cancelReason: reason ?? "Dibatalkan oleh pembeli.",
                },
            });

            if (updated.count !== 1) {
                // Lost the race to the expiry job, to a settlement, or to a second
                // concurrent cancel. Nothing has been written yet, so this is a clean
                // refusal rather than a rollback of real work.
                throw new AppError(ERROR_CODES.ORDER_NOT_PAYABLE, {
                    message: "Status pesanan sudah berubah.",
                    details: { reason: "ORDER_STATE_CHANGED" },
                });
            }

            // Seats come back in the SAME transaction as the status change, so a crash
            // cannot leave a cancelled order still holding inventory (§11.2).
            await releaseOrderReservations(tx, order.id, "RELEASED");

            // Design §26.4: cancellation also "void[s] the open `Payment`". Phase 6 had no
            // payment row to void; Phase 7 creates one, so the abandoned provider session
            // is closed here rather than left live against a dead order.
            paymentsVoided = await voidOpenPayments(tx, order.id);
        },
        { timeout: 15_000 }
    );

    const row = await prisma.eventOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: ORDER_PAYLOAD_SELECT,
    });

    // After the commit: the seats are provably back and the order is provably CANCELLED,
    // so the audit row describes a state that exists. A loser of the guarded CAS never
    // reaches this point, so a failed concurrent cancel writes nothing.
    await writeTicketingAudit({
        action: "order.cancel",
        actor,
        actorOrganizerId: null,
        organizerId: order.organizerId,
        entityType: "EventOrder",
        entityRef: row.orderNumber,
        description: "Pesanan tiket dibatalkan oleh pembeli.",
        beforeState: { status: "PENDING_PAYMENT" },
        afterState: {
            status: "CANCELLED",
            cancelledAt: cancelledAt.toISOString(),
        },
        reason: reason ?? null,
    });

    if (paymentsVoided > 0) {
        // The buyer (a USER) caused the session to be abandoned, so the actor here is the
        // actor, not the system — this is a user-driven state change, not a job's.
        await writeTicketingAudit({
            action: "payment.expired",
            actor,
            actorOrganizerId: null,
            organizerId: order.organizerId,
            entityType: "Payment",
            entityRef: row.orderNumber,
            description:
                "Sesi pembayaran ditutup karena pesanan dibatalkan pembeli.",
            beforeState: { paymentStatus: "PENDING" },
            afterState: {
                paymentStatus: "EXPIRED",
                attempts: paymentsVoided,
            },
            reason: reason ?? "ORDER_CANCELLED",
        });
    }

    return buildOrderPayload(row);
}
