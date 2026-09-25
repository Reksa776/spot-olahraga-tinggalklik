import crypto from "crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import type { AuthzScope } from "@/lib/authz/permissions";
import { prisma } from "@/lib/prisma";

import { writeTicketingAudit } from "../audit-log";
import { withContentionRetry } from "../db-contention";
import { restoreSoldQuota } from "../inventory";
import { moneyString } from "../order-payload";
import { buildRefundPayload, REFUND_SELECT, type RefundPayload } from "./payload";

/**
 * ==========================================
 * REFUND SETTLEMENT (Phase 10B, D-R06/D-R11/D-R14/D-R15/D-R16)
 * ==========================================
 *
 * The transactional core of the refund lifecycle, separated from `service.ts` so the money
 * movement is reachable from a session-less context at all: `service.ts` imports the
 * authorization guards, which import `@/auth` and therefore NextAuth, and dragging that
 * package into a public trust boundary is exactly what this split avoids. Settlement has no
 * actor, no session and no authorization — who may invoke it is decided entirely in
 * `service.ts` (and, before Phase 18B, by the webhook's signature verification).
 *
 * ── PHASE 18B (D-P17-04 = B): THE MANUAL BANK-TRANSFER RAIL ──────────────────────
 * The production refund rail is a manual bank transfer. iPaymu exposes no outbound refund
 * endpoint (D-R17), so nothing here may pretend a provider executed one. The lifecycle is
 * unchanged — `PENDING → APPROVED → PROCESSING → REFUNDED`, with `REJECTED` and `FAILED` as
 * its terminal failures — but `PROCESSING → REFUNDED` now requires the operator to have
 * recorded transfer evidence, and `PROCESSING` explicitly does NOT mean money moved. Only
 * `processConfirmedRefund` may write `REFUNDED`, only an operator may reach it, and only
 * with a reference and a note attached.
 *
 * Everything in `processConfirmedRefund` happens in ONE database transaction, in a fixed
 * order, and any throw rolls all of it back. That is what makes D-R11's "no duplicate state
 * transitions" a database property rather than an application convention.
 */

export type ConfirmedRefundOutcome =
    | {
          outcome: "REFUNDED";
          refundId: number;
          orderNumber: string;
          organizerId: string;
          amount: string;
      }
    | { outcome: "ALREADY_REFUNDED"; refundId: number }
    | { outcome: "RETRY_LATER"; refundId: number; detail: string };

/** `RFD-{epochMillis}-{8 hex}`. Unique by construction, never reused across refunds. */
export function buildRefundNumber(now: Date = new Date()): string {
    return `RFD-${now.getTime()}-${crypto.randomBytes(4).toString("hex")}`;
}

/** Read the row a refund response is built from. Fresh, so it is committed truth. */
export async function readRefundPayload(
    refundId: number,
    db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<RefundPayload> {
    const row = await db.refund.findUniqueOrThrow({
        where: { id: refundId },
        select: REFUND_SELECT,
    });

    return buildRefundPayload(row);
}

/** Delete the ticket claims of a request that is not (and will not be) a refund. */
export async function releaseRefundClaims(
    tx: Prisma.TransactionClient,
    refundId: number
): Promise<void> {
    await tx.refundItem.deleteMany({ where: { refundId } });
}

/**
 * The ONE place a refund becomes real (D-R14/D-R15/D-R16).
 *
 * Lock order mirrors the settlement/cancel paths (order row first, then tickets, then the
 * `tickettype` counters) so refund settlement cannot deadlock against them (brief §17).
 */
export async function processConfirmedRefund(
    refundId: number,
    params: {
        /** Under the manual rail this is the operator's bank/transfer reference (D-R12). */
        providerRef: string | null;
        confirmedAmount: string;
        /** PHASE 18B: the operator's evidence note for a manual settlement. */
        evidenceNote?: string | null;
        actor?: AuthzScope;
        request?: Request;
        now?: Date;
    }
): Promise<ConfirmedRefundOutcome> {
    const now = params.now ?? new Date();

    const result = await withContentionRetry(async () =>
        prisma.$transaction(
            async (tx) => {
                const refund = await tx.refund.findUniqueOrThrow({
                    where: { id: refundId },
                    select: {
                        id: true,
                        refundNumber: true,
                        organizerId: true,
                        eventOrderId: true,
                        status: true,
                        items: {
                            select: {
                                id: true,
                                ticketId: true,
                                orderItemId: true,
                                amount: true,
                            },
                        },
                    },
                });

                if (!refund.eventOrderId || !refund.organizerId) {
                    throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
                        message: "Refund tidak terhubung ke pesanan.",
                    });
                }

                const amount = refund.items.reduce(
                    (sum, item) => sum.plus(item.amount),
                    new Prisma.Decimal(0)
                );

                /* ==========================================================
                 * PHASE 18B (D-P17-05) — LOCK THE ORDER ROW FIRST
                 * ==========================================================
                 *
                 * Every writer that can move an order's money takes this same row lock, and
                 * it is taken FIRST so the documented lock order ("order row first, then
                 * tickets, then the tickettype counters") is actually true of this path.
                 * `executeRefund` serializes the one-PROCESSING-per-order claim on the same
                 * lock, which is what makes the two transitions unable to race each other
                 * into an invalid pair of states.
                 */
                await tx.$queryRaw`SELECT id FROM eventorder WHERE id = ${refund.eventOrderId} FOR UPDATE`;

                // The CAS that decides who settles. A duplicate settlement (an operator
                // double-submitting the same transfer evidence, or a replay) finds the row
                // away from PROCESSING and does nothing.
                const cas = await tx.refund.updateMany({
                    where: { id: refundId, status: "PROCESSING" },
                    data: {
                        status: "REFUNDED",
                        confirmedAmount: new Prisma.Decimal(params.confirmedAmount),
                        providerRef: params.providerRef,
                        evidenceNote: params.evidenceNote ?? null,
                        completedAt: now,
                        failureReason: null,
                        failedAt: null,
                    },
                });

                if (cas.count === 0) {
                    return {
                        outcome: "ALREADY_REFUNDED",
                        refundId,
                    } as ConfirmedRefundOutcome;
                }

                const order = await tx.eventOrder.findUniqueOrThrow({
                    where: { id: refund.eventOrderId },
                    select: {
                        id: true,
                        orderNumber: true,
                        organizerId: true,
                        status: true,
                        paymentStatus: true,
                        total: true,
                        refundedAmount: true,
                        currency: true,
                        event: { select: { returnQuotaOnRefund: true } },
                        payments: {
                            where: { status: "PAID" },
                            orderBy: { createdAt: "desc" },
                            take: 1,
                            select: { id: true, provider: true },
                        },
                        items: {
                            select: { id: true, ticketTypeId: true, quantity: true },
                        },
                    },
                });

                if (
                    order.status !== "PAID" &&
                    order.status !== "PARTIALLY_REFUNDED"
                ) {
                    // The refund was approved against a paid order; if the order moved
                    // outside this lifecycle, guessing would corrupt the ledger. Roll back.
                    throw new AppError(ERROR_CODES.SETTLEMENT_STATE_INVALID, {
                        message:
                            "Pesanan tidak berada pada status yang dapat direfund.",
                        details: { orderStatus: order.status },
                    });
                }

                // ── Tickets: ISSUED → REFUNDED, one guarded update each ────────────
                for (const item of refund.items) {
                    const ticketCas = await tx.ticket.updateMany({
                        where: {
                            id: item.ticketId,
                            status: "ISSUED",
                            refundedAt: null,
                            checkedInAt: null,
                        },
                        data: { status: "REFUNDED", refundedAt: now },
                    });

                    if (ticketCas.count !== 1) {
                        // The ticket moved between approval and settlement (checked in, or
                        // refunded by another request). Refunding money for an admitted
                        // ticket is worse than failing, so roll everything back.
                        throw new AppError(ERROR_CODES.TICKET_ALREADY_CHECKED_IN, {
                            message:
                                "Tiket tidak dapat direfund karena statusnya sudah berubah.",
                            details: { ticketId: item.ticketId },
                        });
                    }
                }

                /* ── Order totals: D-R14 + the Phase 18B balance guard ──────────────
                 *
                 * D-R14 said "the confirmed amount only". Phase 18B adds the invariant the
                 * confirmation must also satisfy: `refundedAmount + amount <= total`. It is
                 * a CONDITIONAL write, not a read-then-write — MySQL evaluates the predicate
                 * against the locked row, so two refunds settling against the same balance
                 * cannot both pass. The row lock above makes the failure mode a clean
                 * refusal rather than a lost update, and the transaction rolls the whole
                 * settlement back, leaving the refund `PROCESSING` for an operator (which is
                 * the honest state: the money has NOT been recorded as moved).
                 */
                const balanceCas = await tx.eventOrder.updateMany({
                    where: {
                        id: order.id,
                        refundedAmount: {
                            lte: new Prisma.Decimal(order.total).minus(amount),
                        },
                    },
                    data: { refundedAmount: { increment: amount } },
                });

                if (balanceCas.count !== 1) {
                    throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
                        message:
                            "Jumlah refund melebihi sisa nilai pesanan yang dapat direfund.",
                        details: { reason: "REFUNDABLE_BALANCE_EXCEEDED" },
                    });
                }

                const fresh = await tx.eventOrder.findUniqueOrThrow({
                    where: { id: order.id },
                    select: { refundedAmount: true, total: true },
                });

                const fullyRefunded = !fresh.refundedAmount.lessThan(fresh.total);

                await tx.eventOrder.updateMany({
                    where: {
                        id: order.id,
                        status: { in: ["PAID", "PARTIALLY_REFUNDED"] },
                    },
                    data: {
                        status: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
                        paymentStatus: fullyRefunded
                            ? "REFUNDED"
                            : "PARTIALLY_REFUNDED",
                    },
                });

                // ── Quota: D-R06, only now, only if the event opted in ─────────────
                if (order.event?.returnQuotaOnRefund) {
                    const perType = new Map<string, number>();

                    for (const item of refund.items) {
                        const orderItem = order.items.find(
                            (candidate) => candidate.id === item.orderItemId
                        );

                        if (orderItem?.ticketTypeId) {
                            perType.set(
                                orderItem.ticketTypeId,
                                (perType.get(orderItem.ticketTypeId) ?? 0) + 1
                            );
                        }
                    }

                    for (const [ticketTypeId, quantity] of perType) {
                        await restoreSoldQuota(ticketTypeId, quantity, tx);
                    }
                }

                // ── PIC fee reversal: D-R16, once per order item ───────────────────
                const feeTreatment = await reversePicFeesForRefund(tx, {
                    refundId,
                    items: refund.items,
                    orderItems: order.items,
                });

                // ── Provider transaction: append-only ──────────────────────────────
                const payment = order.payments[0] ?? null;

                if (payment) {
                    await tx.paymentTransaction.create({
                        data: {
                            paymentId: payment.id,
                            orderId: order.id,
                            organizerId: order.organizerId,
                            provider: payment.provider,
                            providerTransactionId: params.providerRef,
                            type: "REFUND",
                            amount,
                            currency: order.currency,
                            status: "REFUNDED",
                            rawSummary: {
                                refundNumber: refund.refundNumber,
                                eventType: "refund.completed",
                            },
                            occurredAt: now,
                        },
                    });
                }

                await tx.refund.update({
                    where: { id: refundId },
                    data: { feeTreatment },
                });

                return {
                    outcome: "REFUNDED",
                    refundId,
                    orderNumber: order.orderNumber,
                    organizerId: order.organizerId,
                    amount: moneyString(amount),
                } as ConfirmedRefundOutcome;
            },
            { timeout: 20_000 }
        )
    );

    if (!result.ok) {
        return {
            outcome: "RETRY_LATER",
            refundId,
            detail: `gave up after ${result.attempts} attempts`,
        };
    }

    const settled = result.value;

    if (settled.outcome === "REFUNDED") {
        await writeTicketingAudit({
            action: "refund.settle",
            actor: params.actor,
            actorType: params.actor ? "USER" : "PROVIDER",
            actorOrganizerId: params.actor ? settled.organizerId : null,
            organizerId: settled.organizerId,
            entityType: "EventOrder",
            entityRef: settled.orderNumber,
            description:
                params.actor
                    ? "Refund diselesaikan dengan bukti transfer manual; tiket, kuota, dan ledger PIC disesuaikan."
                    : "Refund terkonfirmasi; tiket, kuota, dan ledger PIC disesuaikan.",
            beforeState: { status: "PROCESSING" },
            afterState: {
                status: "REFUNDED",
                amount: settled.amount,
                // The transfer reference / evidence note are the operator's evidence; the
                // number is what a reviewer reconciles against the bank statement.
                providerRef: params.providerRef,
                evidenceNote: params.evidenceNote ?? null,
                refundId: settled.refundId,
            },
            reason: params.actor ? "REFUND_SETTLED_MANUAL" : "REFUND_SETTLED",
            request: params.request,
        });
    }

    return settled;
}

/**
 * Reverse the PIC fee for the newly refunded quantity of every affected order item
 * (D-R16, Phase 30 revision — BUG-3).
 *
 * The existing `PICFeeLedger` is the only ledger: each refund event appends one new
 * `type = REVERSAL`, `direction = DEBIT` row whose `reversalRef` is that refund's id, so
 * an order item may carry many incremental reversals. `PICFeeLedger.(orderItemId, type,
 * reversalRef)` is UNIQUE, which keeps the one-EARNED-per-item wall intact while letting
 * each refund reverse exactly the tickets it refunded:
 *
 *   newlyRefundedQty = tickets(REFUNDED) − ∑ quantity of existing REVERSAL rows
 *
 * The amount is `earned.amount × newlyRefundedQty / quantity`, floored to 2dp for every
 * NON-final increment; the increment that takes the item to fully refunded absorbs the
 * rounding remainder (`earned.amount − ∑ reversals`), so the cumulative reversal is EXACTLY
 * the original EARNED amount and can never overshoot it. A re-run of an already-settled
 * refund finds `newlyRefundedQty = 0` and posts nothing. No payout, settlement or
 * adjustment row is invented.
 */
async function reversePicFeesForRefund(
    tx: Prisma.TransactionClient,
    input: {
        refundId: number;
        items: readonly { orderItemId: string | null }[];
        orderItems: readonly { id: string; ticketTypeId: string | null; quantity: number }[];
    }
): Promise<"REVERSED" | "RETAINED"> {
    const affectedOrderItemIds = Array.from(
        new Set(
            input.items
                .map((item) => item.orderItemId)
                .filter((id): id is string => id !== null)
        )
    );

    let reversedAny = false;

    for (const orderItemId of affectedOrderItemIds) {
        const earned = await tx.pICFeeLedger.findFirst({
            where: { orderItemId, type: "EARNED" },
        });

        if (!earned) {
            continue;
        }

        const refundedTickets = await tx.ticket.count({
            where: { orderItemId, status: "REFUNDED" },
        });

        const orderItem = input.orderItems.find((item) => item.id === orderItemId);
        const quantity = orderItem?.quantity ?? earned.quantity;

        const existingReversals = await tx.pICFeeLedger.findMany({
            where: { orderItemId, type: "REVERSAL" },
            select: { quantity: true, amount: true },
        });

        const alreadyReversedQty = existingReversals.reduce(
            (sum, row) => sum + row.quantity,
            0
        );
        const alreadyReversedAmount = existingReversals.reduce(
            (sum, row) => sum.plus(row.amount),
            new Prisma.Decimal(0)
        );

        // How many of this item's tickets have been refunded but not yet reversed. A
        // re-run of a settled refund finds zero (its reversal is already on the ledger);
        // a legacy full-item reversal also zeroes this out, so nothing double-posts.
        const newlyRefundedQty = refundedTickets - alreadyReversedQty;

        if (newlyRefundedQty <= 0) {
            continue;
        }

        const fullyRefunded = refundedTickets >= quantity;

        let amount: Prisma.Decimal;
        if (fullyRefunded) {
            // The increment that fully refunds the item absorbs the rounding remainder,
            // so ∑ REVERSAL == original EARNED exactly.
            amount = earned.amount.minus(alreadyReversedAmount);
        } else {
            amount = earned.amount
                .mul(newlyRefundedQty)
                .div(quantity)
                .toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
        }

        if (amount.lessThanOrEqualTo(0)) {
            continue;
        }

        await tx.pICFeeLedger.create({
            data: {
                picProfileId: earned.picProfileId,
                organizerId: earned.organizerId,
                eventId: earned.eventId,
                orderId: earned.orderId,
                orderItemId,
                ticketTypeId: earned.ticketTypeId,
                attributionId: earned.attributionId,
                type: "REVERSAL",
                direction: "DEBIT",
                amount,
                currency: earned.currency,
                feeType: earned.feeType,
                rateBp: earned.rateBp,
                fixedAmount: earned.fixedAmount,
                basisType: earned.basisType,
                basisAmount: earned.basisAmount,
                quantity: newlyRefundedQty,
                status: "VOID",
                refundId: input.refundId,
                adjustmentReason: "REFUND",
                reversalRef: String(input.refundId),
                idempotencyKey: `fee:reversal:${input.refundId}:${orderItemId}`,
            },
        });

        reversedAny = true;
    }

    return reversedAny ? "REVERSED" : "RETAINED";
}

/**
 * `PROCESSING → FAILED` (D-R07).
 *
 * PHASE 18B (D-P17-04 = B): under the manual bank-transfer rail this is the operator's
 * "the transfer did not go through" action, and it is the ONLY way out of `PROCESSING`
 * other than a recorded settlement. The ticket claims are released so a corrected request
 * can be raised again; the order and tickets are otherwise untouched; the failure reason is
 * persisted for the operator (D-R13).
 *
 * The `FAILED` state is what RELEASES the one-in-flight claim
 * (`executeRefund` counts only `PROCESSING` rows), so a failed transfer never blocks the
 * next legitimate refund on the same order.
 */
export async function processFailedRefund(
    refundId: number,
    failureReason: string,
    params: { actor?: AuthzScope; request?: Request } = {}
): Promise<void> {
    const now = new Date();

    const updated = await prisma.$transaction(
        async (tx) => {
            const cas = await tx.refund.updateMany({
                where: { id: refundId, status: "PROCESSING" },
                data: {
                    status: "FAILED",
                    failedAt: now,
                    failureReason,
                },
            });

            if (cas.count === 1) {
                await releaseRefundClaims(tx, refundId);
            }

            return cas;
        },
        { timeout: 15_000 }
    );

    if (updated.count !== 1) {
        return;
    }

    const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        select: { organizerId: true, refundNumber: true },
    });

    await writeTicketingAudit({
        action: "refund.fail",
        // An operator-driven failure records the real actor; a system-driven one (a job or
        // a provider reply) keeps the SYSTEM marker, exactly as the settlement path does.
        actor: params.actor,
        actorType: params.actor ? "USER" : "SYSTEM",
        actorOrganizerId: params.actor ? (refund?.organizerId ?? null) : null,
        organizerId: refund?.organizerId ?? null,
        entityType: "EventOrder",
        entityRef: refund?.refundNumber ?? String(refundId),
        description: "Refund gagal diproses; tidak ada dana yang dipindahkan.",
        beforeState: { status: "PROCESSING" },
        afterState: { status: "FAILED", failureReason },
        reason: "REFUND_FAILED",
        request: params.request,
    });
}

/* ==========================================================
 * PHASE 18B — `confirmInboundRefund` WAS REMOVED (D-P17-04 = B)
 * ==========================================================
 *
 * It resolved the refund to settle with `findFirst({ eventOrderId, status: PROCESSING })`
 * and then compared the provider's reported amount — i.e. it identified a refund by
 * (order, amount) rather than by the refund's own identity. Phase 18A forbade that, and the
 * product decision replaced the rail that made it reachable: there is no outbound provider
 * refund to acknowledge, so a "refund" callback can no longer be the authority for
 * anything.
 *
 * Nothing replaces it here. The manual rail settles through `processConfirmedRefund`
 * via `settleRefund`, which takes the refund id and requires the operator's transfer
 * evidence; the webhook now records such a callback and never acts on it (see
 * `lib/ticketing/payment/webhook.ts#applyRefundOutcome`). The security boundary it used to
 * sit behind — signature-before-anything, the replay ledger — is untouched.
 */

/** Exported for tests. */
export const __internals = {
    releaseRefundClaims,
    reversePicFeesForRefund,
};
