/**
 * ==========================================
 * PHASE 10B TEST HARNESS (shared, not a suite)
 * ==========================================
 *
 * Extends the Phase 8 issuance harness, which already extends Phase 7's payment harness.
 * It adds exactly what the refund lifecycle needs and nothing else:
 *
 *   * the teardown ordering the refund tables impose (`RefundItem.ticket` is
 *     `onDelete: Restrict`, and `Refund.eventOrder` is `SET NULL`, so a refund must be
 *     deleted BEFORE its tickets and orders);
 *   * a two-step settlement helper for the MANUAL BANK-TRANSFER rail, so the
 *     confirmed-settlement path is reachable without a provider (Phase 18B: the rail is a
 *     manual transfer, and iPaymu has no outbound refund endpoint);
 *   * a reader for refund rows/items that reads the database, never a service's report.
 *
 * WHAT IS REAL: the database, checkout, payment creation, HMAC webhook verification,
 * settlement, issuance, the refund service, guard-based authz, the CAS transitions and the
 * real InnoDB constraints. Only the provider SOCKET (Phase 7) is substituted.
 */

import type { AuthzScope } from "@/lib/authz/permissions";
import { prisma } from "@/lib/prisma";
import {
    executeRefund,
    settleRefund,
} from "@/lib/ticketing/refunds/service";

import { nextRequest } from "../ticketing-issuance/issuance-harness";

import { teardownIssuanceFixtures } from "../ticketing-issuance/issuance-harness";
import type { Fixtures } from "../ticketing-payment/payment-harness";

/* Re-export the whole Phase 8 surface so a refund suite has one import site. */
export {
    counters,
    createOrder,
    createPaidOrder,
    createType,
    customerScope,
    expectRejection,
    installGatewayStub,
    issue,
    nextRequest,
    organizerScope,
    orderState,
    setupIssuanceFixtures as setupRefundFixtures,
    signInAs,
    ticketsFor,
} from "../ticketing-issuance/issuance-harness";

export {
    signedCallback,
    SUFFIX,
} from "../ticketing-payment/payment-harness";

export type { Fixtures, Rejection } from "../ticketing-payment/payment-harness";

/**
 * Take an APPROVED refund all the way to REFUNDED through the REAL manual rail.
 *
 * PHASE 18B (D-P17-04 = B): there is no provider to call, so settling is two operator steps —
 * claim the refund for processing (`executeRefund`), then record the bank transfer
 * (`settleRefund`). This helper performs exactly those two service calls; it does not write
 * the refund row itself, so a suite using it still exercises both CAS transitions, the
 * one-in-flight claim and the evidence requirement.
 *
 * `transferRef` becomes the persisted `providerRef` (the bank reference on a manual rail),
 * which is why the existing assertions on `providerRef` keep their meaning.
 */
export async function settleAsOperator(
    refundId: number,
    scope: AuthzScope,
    transferRef = "BANK-TRANSFER-TEST"
) {
    await executeRefund(refundId, scope, {}, nextRequest());

    return settleRefund(refundId, { transferRef }, scope, nextRequest());
}

/** The refund row, read from the table. */
export function refundRow(refundId: number) {
    return prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
}

/** The claim rows for a refund, read from the table. */
export function refundItems(refundId: number) {
    return prisma.refundItem.findMany({ where: { refundId } });
}

/** The `REFUND` PaymentTransaction rows for an order. */
export function refundTransactions(orderId: string) {
    return prisma.paymentTransaction.findMany({
        where: { orderId, type: "REFUND" },
        orderBy: { createdAt: "asc" },
    });
}

/**
 * The `refund.*` audit rows for one refund.
 *
 * Accepts both refs the lifecycle uses: `refund.request` is recorded against the ORDER
 * number (the buyer acted on an order) while approve/reject use the refund number, and
 * `refund.settle`/`refund.fail` go back to the order number. Passing both keeps the query
 * from encoding which action chose which.
 */
export function refundAuditRows(entityRefs: string | string[]) {
    const refs = Array.isArray(entityRefs) ? entityRefs : [entityRefs];

    return prisma.adminAuditLog.findMany({
        where: {
            action: { startsWith: "refund." },
            entityRef: { in: refs.filter((ref) => ref.length > 0) },
        },
        orderBy: { createdAt: "asc" },
    });
}

/**
 * Remove this phase's residue, then the parent's.
 *
 * Refunds first: deleting a ticket or an order while a claim or a refund row still points
 * at it is blocked by the foreign keys, and the parent teardown is what removes the
 * tickets and orders. `Refund` deletion cascades to `RefundItem`.
 */
export async function teardownRefundFixtures(f: Fixtures): Promise<void> {
    const orderIds = (
        await prisma.eventOrder.findMany({
            where: { eventId: { in: [f.eventA.id, f.eventB.id] } },
            select: { id: true },
        })
    ).map((row) => row.id);

    // PIC ledger rows restrict the order delete and are set-null on refund delete, so they
    // go first (these suites do not create any, but the ordering is the safe one).
    await prisma.pICFeeLedger.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.refund.deleteMany({ where: { eventOrderId: { in: orderIds } } });

    await teardownIssuanceFixtures(f);
}
