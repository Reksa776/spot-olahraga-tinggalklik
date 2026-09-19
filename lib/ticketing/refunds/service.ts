import { Prisma } from "@prisma/client";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { requireOrganizerAccess, requireOwnResource } from "@/lib/authz/guards";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz/permissions";
import { prisma } from "@/lib/prisma";

import { writeTicketingAudit } from "../audit-log";
import { moneyString } from "../order-payload";
import { evaluateRefundEligibility } from "./eligibility";
import {
    buildRefundNumber,
    processConfirmedRefund,
    processFailedRefund,
    readRefundPayload,
    releaseRefundClaims,
} from "./settlement";
import { buildRefundPayload, REFUND_SELECT, type RefundPayload } from "./payload";
import type {
    RefundFailInput,
    RefundListQuery,
    RefundRejectInput,
    RefundSettleInput,
} from "./validation";

/**
 * ==========================================
 * REFUND SERVICE — REQUEST, DECIDE, EXECUTE, READ (Phase 10B, D-R01..D-R13)
 * ==========================================
 *
 * The actor-facing half of the refund lifecycle. The transactional half lives in
 * `settlement.ts` (see that module's header for why the split exists). This module owns:
 *
 *   * the OWNERSHIP predicate and the own-scope capability for the buyer's request (D-R02);
 *   * the tenant capability checks for every staff action (D-R02);
 *   * separation of duties — a requester never decides or executes their own request;
 *   * the ONE-PROCESSING-PER-ORDER claim, serialized on the order row (Phase 18B);
 *   * audit rows for the request and the staff decisions (settlement audits its own).
 *
 * Lifecycle (D-R07):
 *
 *   PENDING ──approve──▶ APPROVED ──process──▶ PROCESSING ──settle──▶ REFUNDED
 *      │                                           │
 *      └──reject──▶ REJECTED                       └──fail──▶ FAILED
 *
 * ── PHASE 18B (D-P17-04 = B): THE RAIL IS A MANUAL BANK TRANSFER ──────────────────
 * There is no outbound provider call here any more, and none is missing: iPaymu has no
 * refund endpoint (D-R17), so the earlier `getRefundProvider()` call could only ever return
 * `UNSUPPORTED` and end the refund in `FAILED`. The operator makes the transfer, then
 * records it:
 *
 *   * `executeRefund` (the execute route) CLAIMS the refund: `APPROVED → PROCESSING`.
 *     It moves no money and states nothing about the transfer having happened, which is why
 *     it now writes its own `refund.process` audit row.
 *   * `settleRefund` records the evidence (`transferRef` + note) and only then runs the one
 *     confirmed settlement — the sole point at which money, tickets, quota and the PIC
 *     ledger move.
 *   * `failRefund` closes a processing attempt that did not complete, releasing the claim so
 *     a corrected request can be raised.
 *
 * One order may carry at most ONE `PROCESSING` refund at a time (Phase 18A, D-P17-06). The
 * count and the transition happen in one transaction that locks the ORDER row first, so two
 * concurrent claims cannot both win by reading "none in flight" before either writes.
 *
 * ── CLAIMS AND REJECTIONS ────────────────────────────────────────────────────────
 * `RefundItem.ticketId` is UNIQUE (D-R10's database backstop): one ticket, one claim. A
 * rejected or failed request releases its claims (`releaseRefundClaims`) so the ticket can be
 * requested again, while the `Refund` row and its audit entries remain as the record that the
 * request happened. A REFUNDED request keeps its items forever — they are the immutable
 * record of what was refunded.
 */

export type RefundRequestInput = {
    orderNumber: string;
    ticketIds?: string[];
    reason?: string;
};

function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2002"
    );
}

/** The order's own ticket candidates, with the price snapshot each refund line needs. */
const REFUND_TICKET_SELECT = {
    id: true,
    ticketCode: true,
    status: true,
    checkedInAt: true,
    refundedAt: true,
    refundItem: { select: { id: true } },
    orderItem: {
        select: {
            id: true,
            nameSnapshot: true,
            priceSnapshot: true,
            quantity: true,
        },
    },
} as const;

/**
 * `POST /api/ticketing/refunds` — a buyer (or a PIC who is also a buyer) requests a refund
 * for an order they own (D-R02).
 *
 * Ownership runs first and is a predicate on the query itself (`userId: actor.userId`), so a
 * caller cannot learn anything about an order they do not own. The own-scope capability is
 * then checked against the resolved owner id — the exact pattern `cancelOwnPendingOrder`
 * uses.
 */
export async function requestRefund(
    input: RefundRequestInput,
    actor: AuthzScope,
    request?: Request
): Promise<RefundPayload> {
    const order = await prisma.eventOrder.findFirst({
        where: { orderNumber: input.orderNumber, userId: actor.userId },
        select: {
            id: true,
            orderNumber: true,
            organizerId: true,
            userId: true,
            status: true,
            paymentStatus: true,
            total: true,
            refundedAmount: true,
            paidAt: true,
            event: { select: { refundDeadlineAt: true } },
        },
    });

    if (!order) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Pesanan tidak ditemukan.",
        });
    }

    await requireOwnResource(PERMISSIONS.REFUND_REQUEST_OWN, actor.userId);

    const tickets = await prisma.ticket.findMany({
        where: {
            orderId: order.id,
            ...(input.ticketIds ? { id: { in: input.ticketIds } } : {}),
        },
        select: REFUND_TICKET_SELECT,
        orderBy: { ticketCode: "asc" },
    });

    if (input.ticketIds && tickets.length !== input.ticketIds.length) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Salah satu tiket tidak ditemukan pada pesanan ini.",
            details: { reason: "TICKET_NOT_FOUND" },
        });
    }

    const eligibility = evaluateRefundEligibility({
        order,
        event: order.event,
        tickets,
        now: new Date(),
    });

    if (!eligibility.eligible) {
        throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
            message: eligibility.message,
            details: {
                reason: eligibility.reason,
                ...(eligibility.ticketId ? { ticketId: eligibility.ticketId } : {}),
            },
        });
    }

    const now = new Date();
    const refundNumber = buildRefundNumber(now);

    let refundId: number;

    try {
        refundId = await prisma.$transaction(
            async (tx) => {
                /* ==========================================
                 * PHASE 15 — SERIALIZE WITH THE GATE (P14-D15 / D-28)
                 * ==========================================
                 *
                 * The primary credit being protected here is that a ticket cannot be BOTH claimed
                 * by an open refund AND `CHECKED_IN`. The gate takes a `SELECT … FOR UPDATE` on the
                 * ticket row before it evaluates its open-refund guard, so both writers now
                 * contend on the same row and exactly one of the two orders is possible:
                 *
                 *   refund first   → the gate's locked read sees this `RefundItem` and refuses
                 *                    with `REFUND_PENDING`
                 *   check-in first → this locked read sees `checkedInAt`/a non-`ISSUED` status
                 *                    and refuses with D-R05's reason
                 *
                 * Rows are locked in ascending id order, the same order the gate's single-row lock
                 * cannot invert, so the two paths cannot deadlock.
                 *
                 * The eligibility decision above was made from an unlocked read; this is the
                 * authoritative re-check, INSIDE the transaction that writes the claim. Removing it
                 * would restore exactly the time-of-check/time-of-use hole this replaces — which is
                 * why it is a locking read rather than another `findMany`.
                 */
                const ticketIds = eligibility.lines.map((line) => line.ticketId);

                const lockedTickets = await tx.$queryRaw<
                    { id: string; status: string; checkedInAt: Date | null }[]
                >`SELECT id, status, checkedInAt FROM ticket
                    WHERE id IN (${Prisma.join(ticketIds)})
                    ORDER BY id
                    FOR UPDATE`;

                const lockedById = new Map(
                    lockedTickets.map((row) => [row.id, row])
                );

                for (const ticketId of ticketIds) {
                    const locked = lockedById.get(ticketId);

                    if (!locked) {
                        throw new AppError(ERROR_CODES.NOT_FOUND, {
                            message: "Tiket tidak ditemukan.",
                            details: { reason: "TICKET_NOT_FOUND" },
                        });
                    }

                    if (locked.checkedInAt !== null) {
                        throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
                            message:
                                "Tiket yang sudah check-in tidak dapat direfund.",
                            details: {
                                reason: "TICKET_CHECKED_IN",
                                ticketId,
                            },
                        });
                    }

                    if (locked.status !== "ISSUED") {
                        throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
                            message:
                                "Tiket tidak berada pada status yang dapat direfund.",
                            details: {
                                reason: "TICKET_NOT_REFUNDABLE",
                                ticketId,
                            },
                        });
                    }
                }

                const refund = await tx.refund.create({
                    data: {
                        refundNumber,
                        organizerId: order.organizerId,
                        eventOrderId: order.id,
                        requestedByUserId: actor.userId,
                        requestedByRole: actor.platformRole,
                        requestedAmount: eligibility.amount,
                        reason: input.reason ?? null,
                        status: "PENDING",
                    },
                    select: { id: true },
                });

                await tx.refundItem.createMany({
                    data: eligibility.lines.map((line) => ({
                        refundId: refund.id,
                        ticketId: line.ticketId,
                        orderItemId: line.orderItemId,
                        amount: line.amount,
                    })),
                });

                return refund.id;
            },
            { timeout: 15_000 }
        );
    } catch (error) {
        if (isUniqueViolation(error)) {
            // The unique `RefundItem.ticketId` decided: somebody claimed one of these tickets
            // between the eligibility read and the insert. D-R10 is intact; the caller is
            // told to reconcile rather than being given a second claim.
            throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
                message: "Salah satu tiket sudah diajukan untuk refund.",
                details: { reason: "TICKET_ALREADY_CLAIMED" },
            });
        }

        throw error;
    }

    const payload = await readRefundPayload(refundId);

    await writeTicketingAudit({
        action: "refund.request",
        actor,
        actorOrganizerId: order.organizerId,
        organizerId: order.organizerId,
        entityType: "EventOrder",
        entityRef: order.orderNumber,
        description:
            "Pembeli mengajukan refund untuk sebagian atau seluruh tiket.",
        beforeState: { refundedAmount: moneyString(order.refundedAmount) },
        afterState: {
            refundNumber,
            status: "PENDING",
            requestedAmount: moneyString(eligibility.amount),
            ticketCount: eligibility.lines.length,
        },
        reason: input.reason ?? "BUYER_REFUND_REQUEST",
        request,
    });

    return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Staff decisions
// ─────────────────────────────────────────────────────────────────────────────

async function loadRefundForDecision(refundId: number) {
    const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        select: {
            id: true,
            refundNumber: true,
            organizerId: true,
            eventOrderId: true,
            requestedByUserId: true,
            requestedAmount: true,
            status: true,
        },
    });

    if (!refund || !refund.organizerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Refund tidak ditemukan.",
        });
    }

    return { ...refund, organizerId: refund.organizerId };
}

/**
 * `POST /api/ticketing/refunds/[refundId]/approve` — staff approve (D-R02).
 *
 * Separation of duties: the requester may never decide their own request. This is the
 * enforceable half of D-R02's "the buyer cannot approve/execute their own refund"; applying
 * it to every requester (not only buyers) is deliberately stricter and removes the
 * self-approval question entirely.
 */
export async function approveRefund(
    refundId: number,
    actor: AuthzScope,
    _input: { note?: string } = {},
    request?: Request
): Promise<RefundPayload> {
    const refund = await loadRefundForDecision(refundId);

    await requireOrganizerAccess(refund.organizerId, PERMISSIONS.REFUND_APPROVE);

    if (refund.requestedByUserId === actor.userId) {
        throw new AppError(ERROR_CODES.FORBIDDEN, {
            message: "Pemohon refund tidak dapat menyetujui permintaannya sendiri.",
            details: { reason: "SEPARATION_OF_DUTIES" },
        });
    }

    if (refund.status !== "PENDING") {
        throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
            message: "Refund ini tidak berada pada status yang dapat disetujui.",
            details: { status: refund.status, reason: "NOT_PENDING" },
        });
    }

    const now = new Date();

    const cas = await prisma.refund.updateMany({
        where: { id: refundId, status: "PENDING" },
        data: {
            status: "APPROVED",
            approvedByUserId: actor.userId,
            approvedAt: now,
            processedByUserId: actor.userId,
            processedAt: now,
        },
    });

    if (cas.count !== 1) {
        throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
            message: "Status refund sudah berubah.",
            details: { reason: "STATE_CHANGED" },
        });
    }

    const payload = await readRefundPayload(refundId);

    await writeTicketingAudit({
        action: "refund.approve",
        actor,
        actorOrganizerId: refund.organizerId,
        organizerId: refund.organizerId,
        entityType: "EventOrder",
        entityRef: refund.refundNumber,
        description: "Refund disetujui oleh staf.",
        beforeState: { status: "PENDING" },
        afterState: { status: "APPROVED" },
        reason: "REFUND_APPROVED",
        request,
    });

    return payload;
}

/**
 * `POST /api/ticketing/refunds/[refundId]/reject` — staff decline (D-R02/D-R13).
 *
 * Rejection releases the ticket claims so the buyer may request again (see the module
 * header). The `Refund` row survives with its reason, which is the audit trail.
 */
export async function rejectRefund(
    refundId: number,
    actor: AuthzScope,
    input: RefundRejectInput,
    request?: Request
): Promise<RefundPayload> {
    const refund = await loadRefundForDecision(refundId);

    await requireOrganizerAccess(refund.organizerId, PERMISSIONS.REFUND_APPROVE);

    if (refund.requestedByUserId === actor.userId) {
        throw new AppError(ERROR_CODES.FORBIDDEN, {
            message: "Pemohon refund tidak dapat menolak permintaannya sendiri.",
            details: { reason: "SEPARATION_OF_DUTIES" },
        });
    }

    if (refund.status !== "PENDING") {
        throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
            message: "Refund ini tidak berada pada status yang dapat ditolak.",
            details: { status: refund.status, reason: "NOT_PENDING" },
        });
    }

    const now = new Date();

    const cas = await prisma.$transaction(
        async (tx) => {
            const updated = await tx.refund.updateMany({
                where: { id: refundId, status: "PENDING" },
                data: {
                    status: "REJECTED",
                    processedByUserId: actor.userId,
                    processedAt: now,
                    failureReason: input.reason,
                },
            });

            if (updated.count === 1) {
                await releaseRefundClaims(tx, refundId);
            }

            return updated;
        },
        { timeout: 15_000 }
    );

    if (cas.count !== 1) {
        throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
            message: "Status refund sudah berubah.",
            details: { reason: "STATE_CHANGED" },
        });
    }

    const payload = await readRefundPayload(refundId);

    await writeTicketingAudit({
        action: "refund.reject",
        actor,
        actorOrganizerId: refund.organizerId,
        organizerId: refund.organizerId,
        entityType: "EventOrder",
        entityRef: refund.refundNumber,
        description: "Refund ditolak oleh staf.",
        beforeState: { status: "PENDING" },
        afterState: { status: "REJECTED", reason: input.reason },
        reason: "REFUND_REJECTED",
        request,
    });

    return payload;
}

/**
 * `POST /api/ticketing/refunds/[refundId]/execute` — staff CLAIM the approved refund for
 * processing (D-R02, re-scoped by Phase 18B).
 *
 * Under the manual bank-transfer rail this is the `APPROVED → PROCESSING` transition and
 * nothing more: it moves no money, calls no provider and asserts nothing about the transfer
 * having happened. `PROCESSING` is the operator holding the refund; `settleRefund` is where
 * the transfer evidence is recorded and where the money is actually reconciled.
 *
 * ── ONE PROCESSING PER ORDER (D-P17-06) ──────────────────────────────────────────
 * "At most one PROCESSING refund may be an order" cannot be a partial unique index on
 * MySQL/Prisma, so it is enforced transactionally on the row every money path already
 * serializes on: the ORDER. The transaction locks `eventorder` with `SELECT … FOR UPDATE`,
 * counts the order's other `PROCESSING` refunds, and only then CASes this one. Two workers
 * claiming two different approved refunds of the same order therefore serialize, and the
 * second finds the first's `PROCESSING` row and is refused — a plain
 * `count() === 0` outside a transaction would let both through.
 *
 * `PENDING` and `APPROVED` are deliberately NOT restricted: the product decision locks one
 * in-flight (processing) refund, not one open request.
 */
export async function executeRefund(
    refundId: number,
    actor: AuthzScope,
    _input: { note?: string } = {},
    request?: Request
): Promise<RefundPayload> {
    const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        select: {
            id: true,
            refundNumber: true,
            organizerId: true,
            eventOrderId: true,
            requestedByUserId: true,
            status: true,
        },
    });

    if (!refund || !refund.organizerId || !refund.eventOrderId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Refund tidak ditemukan.",
        });
    }

    await requireOrganizerAccess(refund.organizerId, PERMISSIONS.REFUND_EXECUTE);

    if (refund.requestedByUserId === actor.userId) {
        throw new AppError(ERROR_CODES.FORBIDDEN, {
            message:
                "Pemohon refund tidak dapat mengeksekusi permintaannya sendiri.",
            details: { reason: "SEPARATION_OF_DUTIES" },
        });
    }

    if (refund.status !== "APPROVED") {
        throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
            message: "Refund ini tidak berada pada status yang dapat dieksekusi.",
            details: { status: refund.status, reason: "NOT_APPROVED" },
        });
    }

    const orderId = refund.eventOrderId;
    const now = new Date();

    const claim = await prisma.$transaction(
        async (tx) => {
            await tx.$queryRaw`SELECT id FROM eventorder WHERE id = ${orderId} FOR UPDATE`;

            const inFlight = await tx.refund.count({
                where: {
                    eventOrderId: orderId,
                    status: "PROCESSING",
                    id: { not: refundId },
                },
            });

            if (inFlight > 0) {
                return { claim: false as const, reason: "REFUND_ALREADY_PROCESSING" };
            }

            const cas = await tx.refund.updateMany({
                where: { id: refundId, status: "APPROVED" },
                data: {
                    status: "PROCESSING",
                    processedByUserId: actor.userId,
                    processedAt: now,
                },
            });

            if (cas.count !== 1) {
                return { claim: false as const, reason: "STATE_CHANGED" };
            }

            return { claim: true as const };
        },
        { timeout: 15_000 }
    );

    if (!claim.claim) {
        throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
            message:
                claim.reason === "REFUND_ALREADY_PROCESSING"
                    ? "Masih ada refund lain yang sedang diproses untuk pesanan ini."
                    : "Status refund sudah berubah.",
            details: { reason: claim.reason },
        });
    }

    await writeTicketingAudit({
        action: "refund.process",
        actor,
        actorOrganizerId: refund.organizerId,
        organizerId: refund.organizerId,
        entityType: "EventOrder",
        entityRef: refund.refundNumber ?? String(refundId),
        description:
            "Staf mulai memproses refund; dana belum dipindahkan sampai bukti transfer dicatat.",
        beforeState: { status: "APPROVED" },
        afterState: { status: "PROCESSING" },
        reason: "REFUND_PROCESSING",
        request,
    });

    return readRefundPayload(refundId);
}

/**
 * `POST /api/ticketing/refunds/[refundId]/settle` — record the manual transfer and settle.
 *
 * THE ONLY WAY A REFUND BECOMES `REFUNDED` (D-R14/D-R15). The operator must supply the
 * transfer reference and a note; without them the refund stays `PROCESSING`. `PROCESSING`
 * therefore never means "money moved" — only this transition may claim that.
 *
 * ── WHAT THE CLIENT CANNOT SAY ────────────────────────────────────────────────────
 * The body carries the reference and the note and NOTHING else. The amount confirmed is the
 * server-derived sum of the refund's own `RefundItem` rows, so no request can widen a refund
 * to a larger figure, and the reference is evidence attached to that figure rather than an
 * input to it. A reference is REQUIRED — an operator cannot complete a transfer they did not
 * record.
 *
 * A settlement whose conditional balance write fails (`refundedAmount + amount > total`)
 * throws out of the transaction, leaving the refund `PROCESSING` with nothing moved; the
 * operator resolves it through the same surface. Idempotent by CAS: a repeated submit finds
 * the row `REFUNDED` and returns the settled payload without a second movement.
 */
export async function settleRefund(
    refundId: number,
    input: RefundSettleInput,
    actor: AuthzScope,
    request?: Request
): Promise<RefundPayload> {
    const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        select: {
            id: true,
            refundNumber: true,
            organizerId: true,
            requestedByUserId: true,
            status: true,
            items: { select: { amount: true } },
        },
    });

    if (!refund || !refund.organizerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Refund tidak ditemukan.",
        });
    }

    await requireOrganizerAccess(refund.organizerId, PERMISSIONS.REFUND_EXECUTE);

    if (refund.requestedByUserId === actor.userId) {
        throw new AppError(ERROR_CODES.FORBIDDEN, {
            message:
                "Pemohon refund tidak dapat menyelesaikan permintaannya sendiri.",
            details: { reason: "SEPARATION_OF_DUTIES" },
        });
    }

    // A settled refund is returned as-is (idempotent replay); anything else must be in flight.
    if (refund.status !== "PROCESSING") {
        if (refund.status === "REFUNDED") {
            return readRefundPayload(refundId);
        }

        throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
            message: "Refund ini tidak berada pada status yang dapat diselesaikan.",
            details: { status: refund.status, reason: "NOT_PROCESSING" },
        });
    }

    const amount = refund.items.reduce(
        (sum, item) => sum.plus(item.amount),
        new Prisma.Decimal(0)
    );

    if (amount.lessThanOrEqualTo(0)) {
        throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
            message: "Refund ini tidak memiliki nilai yang dapat diselesaikan.",
            details: { reason: "NOTHING_REFUNDABLE" },
        });
    }

    const outcome = await processConfirmedRefund(refundId, {
        // D-P17-04 = B: the "provider reference" on a manual rail is the bank reference.
        providerRef: input.transferRef,
        // Derived from the stored claim, never from the request body.
        confirmedAmount: moneyString(amount),
        evidenceNote: input.note ?? null,
        actor,
        request,
    });

    if (outcome.outcome === "RETRY_LATER") {
        throw new AppError(ERROR_CODES.CONFLICT, {
            message:
                "Refund gagal diselesaikan karena kontensi database; coba lagi.",
            details: { reason: "SETTLEMENT_CONTENTION", refundId },
        });
    }

    return readRefundPayload(refundId);
}

/**
 * `POST /api/ticketing/refunds/[refundId]/fail` — the transfer did not complete.
 *
 * `PROCESSING → FAILED` (D-R07), with the operator's reason persisted (D-R13) and the ticket
 * claims released so a corrected request can be raised. Moving no money is the point: a
 * failed transfer must leave the financial state exactly as it was, and it must free the
 * one-in-flight claim so the next legitimate refund is not blocked forever.
 */
export async function failRefund(
    refundId: number,
    input: RefundFailInput,
    actor: AuthzScope,
    request?: Request
): Promise<RefundPayload> {
    const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        select: {
            id: true,
            refundNumber: true,
            organizerId: true,
            requestedByUserId: true,
            status: true,
        },
    });

    if (!refund || !refund.organizerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Refund tidak ditemukan.",
        });
    }

    await requireOrganizerAccess(refund.organizerId, PERMISSIONS.REFUND_EXECUTE);

    if (refund.requestedByUserId === actor.userId) {
        throw new AppError(ERROR_CODES.FORBIDDEN, {
            message: "Pemohon refund tidak dapat menggagalkan permintaannya sendiri.",
            details: { reason: "SEPARATION_OF_DUTIES" },
        });
    }

    if (refund.status === "FAILED") {
        return readRefundPayload(refundId);
    }

    if (refund.status !== "PROCESSING") {
        throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
            message: "Refund ini tidak berada pada status yang dapat digagalkan.",
            details: { status: refund.status, reason: "NOT_PROCESSING" },
        });
    }

    await processFailedRefund(refundId, input.reason, { actor, request });

    return readRefundPayload(refundId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Read side
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `GET /api/ticketing/refunds` — a buyer's own refunds, or a tenant's when the caller holds
 * `order.read.tenant` for the requested organizer.
 *
 * The two modes are deliberately separate: an own-scope read never needs a tenant check, and
 * a tenant read is gated by `requireOrganizerAccess`, so passing an `organizerId` the actor
 * is not a member of fails as a cross-tenant denial (404).
 */
export async function listRefunds(
    actor: AuthzScope,
    query: RefundListQuery
): Promise<{ items: RefundPayload[]; total: number }> {
    if (query.organizerId) {
        await requireOrganizerAccess(
            query.organizerId,
            PERMISSIONS.ORDER_READ_TENANT
        );
    } else {
        await requireOwnResource(PERMISSIONS.ORDER_READ_OWN, actor.userId);
    }

    const where: Prisma.RefundWhereInput = {
        ...(query.organizerId
            ? { organizerId: query.organizerId }
            : { requestedByUserId: actor.userId }),
        ...(query.status ? { status: query.status } : {}),
        ...(query.orderNumber
            ? { eventOrder: { orderNumber: query.orderNumber } }
            : {}),
    };

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [rows, total] = await Promise.all([
        prisma.refund.findMany({
            where,
            select: REFUND_SELECT,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.refund.count({ where }),
    ]);

    return { items: rows.map(buildRefundPayload), total };
}
