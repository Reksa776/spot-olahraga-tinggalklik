import { Prisma, type PaymentTransactionType } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { writeTicketingAudit } from "../audit-log";
import { withContentionRetry } from "../db-contention";
import { moneyString } from "../order-payload";
import {
    confirmOrderReservations,
    releaseOrderReservations,
    ReservationIntegrityError,
} from "../reservations";

/**
 * ==========================================
 * TICKETING PAYMENT SETTLEMENT (design §13.3)
 * ==========================================
 *
 * §13.3 is the specification this module implements, and it is explicit that everything
 * below happens in ONE database transaction, in a fixed order, with external calls banned
 * ("Phase 0 already respects this"):
 *
 *   3. Verify amount == EventOrder.total          → done by the caller, before this runs
 *   4. CAS eventorder → PAID (WHERE PENDING_PAYMENT AND paymentStatus != PAID)
 *   5. Payment: CAS status → PAID ; insert PaymentTransaction
 *   6. Per OrderItem: quota CAS  reserved -= q, sold += q
 *   7-10. tickets / attribution / PIC ledger / fee snapshots → Phase 8 and Phase 9
 *   11. COMMIT
 *
 * Steps 7–10 are deliberately absent: ticket issuance is Phase 8, and PIC attribution, the
 * fee ledger and the fee snapshots are Phase 9 (design §40.11). What is here is exactly the
 * pre-issuance boundary.
 *
 * ── THE FOUR PROPERTIES THIS MODULE EXISTS TO GUARANTEE ─────────────────────────
 *
 * 1. **Settlement happens at most once.** Step 4 is a conditional update whose affected-row
 *    count is the decision: `count === 1` means this caller won and owns the settlement;
 *    `count === 0` means somebody already moved the order, and the branch taken is an
 *    idempotent no-op. That is the whole concurrency control, and it is the database's, not
 *    the application's — the same idiom design §30.3 insists on for idempotency.
 *
 * 2. **Inventory moves exactly once, and only through the canonical primitive.** Step 6 is
 *    `confirmOrderReservations`, which calls `confirmReservation` from
 *    `lib/ticketing/inventory.ts` — the design's §11.2 "Confirm (payment settled)"
 *    statement, and the only thing in the codebase permitted to move `reserved` and `sold`.
 *    Nothing here writes a counter, and there is no second availability formula.
 *
 * 3. **Terminal states never resurrect.** `CANCELLED` and `EXPIRED` are excluded by the
 *    step-4 predicate, so a late webhook cannot turn a cancelled or expired order into a
 *    paid one. Design §12.3's row for `CANCELLED / EXPIRED → PAID` is "Not allowed (CAS
 *    rejects)" and the money is handled by the documented late-settlement branch below.
 *
 * 4. **Money that arrived is always recorded.** A verified payment for a terminal order is
 *    not silently dropped — §11.4's "Expired-but-paid" case requires the mismatch to be
 *    recorded so an operator can resolve it, and this is the only place that can write it.
 *
 * ── THE `sold`/`reserved` INVARIANT IS NOT ASSUMED ─────────────────────────────
 * `confirmOrderReservations` THROWS on a counter underflow. Design §11.2 calls
 * `affectedRows === 0` here "a data-integrity alarm: reserved underflow (must never
 * happen)". This module lets that throw roll the transaction back — the order therefore
 * does NOT become PAID on a corrupt counter — and surfaces it as a retryable failure so the
 * provider keeps the event and an operator sees a FAILED ledger row. Swallowing it would
 * mint tickets against quota that was never held, which is the one outcome worse than a
 * failed settlement.
 */

export type SettlementOutcome =
    | {
          outcome: "SETTLED";
          orderNumber: string;
          organizerId: string;
          reservationsConverted: number;
          seatsSold: number;
          /**
           * Seats the order says were reserved but that the hold could not convert. Empty
           * in a healthy database; a non-empty array means the order is PAID with
           * `fulfilmentBlockedAt` set and must not be fulfilled until it is investigated.
           */
          anomalies: string[];
      }
    | { outcome: "ALREADY_PAID"; orderNumber: string; organizerId: string }
    | {
          /**
           * Design §13.4's `PENDING → FAILED` row: the provider reported a failure, so the
           * reservations are released and the order is cancelled with `paymentStatus =
           * FAILED`. No money moved, so no `PaymentTransaction` is written.
           */
          outcome: "ORDER_FAILED";
          orderNumber: string;
          organizerId: string;
          reservationsReleased: number;
          seatsReleased: number;
      }
    | {
          outcome: "LATE_SETTLEMENT";
          orderNumber: string;
          organizerId: string;
          /** The terminal status the order was already in. */
          orderStatus: string;
      }
    | {
          outcome: "NOT_APPLICABLE";
          orderNumber: string;
          organizerId: string;
          orderStatus: string;
          paymentStatus: string;
      }
    | {
          outcome: "RETRY_LATER";
          orderNumber: string;
          organizerId: string;
          reason: "CONTENTION_EXHAUSTED" | "INTEGRITY_FAILURE";
          detail?: string;
      };

export type SettlementInput = {
    orderId: string;
    /** The `Payment` row resolved from the reference; null only if none was found. */
    paymentId: string | null;
    provider: string;
    providerTransactionId: string | null;
    providerSessionId: string | null;
    /**
     * The amount the provider reported, already compared against `EventOrder.total` by the
     * caller. Present here only so the ledger can record what the provider said.
     */
    amountReported: string | null;
    /**
     * The provider's own fee, when it reports one.
     *
     * Recorded on the append-only `PaymentTransaction` as a FACT ("the provider took
     * this"). It is deliberately NOT written to `EventOrder.gatewayFee` and does NOT
     * change `organizerNetAmount` or `total`: who BEARS the fee is decision **D-22**, which
     * the design's §39 register leaves open (its "Organizer" entry is a recommendation and
     * §39's preamble states plainly that "nothing in this register is decided by the
     * design"). Under brief §4 the Phase 6 zero-fee baseline is preserved and the decision
     * is reported rather than guessed.
     */
    providerFeeReported: string | null;
    statusCode: string | null;
    channel: string | null;
    eventType: string;
    now?: Date;
};

/** Prisma's unique-violation code, used to detect the ledger's own replay guard. */
function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2002"
    );
}

/**
 * Append the provider's record of money movement (design §13.2, `PaymentTransaction`).
 *
 * "**Append-only.** No update path after creation" — so this only ever inserts. Exactly one
 * `PAYMENT` row is created per settlement because the caller only reaches here after
 * winning the step-4 CAS.
 *
 * `rawSummary` is redacted: the provider's status code, channel and event type only. No
 * buyer PII, no signature, no credential (design §13.2: "rawSummary Json? (redacted: no
 * PII, no secrets)" and §31.3's PII rule).
 */
async function recordProviderTransaction(
    tx: Prisma.TransactionClient,
    params: {
        paymentId: string;
        orderId: string;
        organizerId: string;
        provider: string;
        providerTransactionId: string | null;
        amount: Prisma.Decimal | string;
        providerFee: string | null;
        currency: string;
        statusCode: string | null;
        channel: string | null;
        eventType: string;
        occurredAt: Date;
    }
): Promise<void> {
    const type: PaymentTransactionType = "PAYMENT";

    await tx.paymentTransaction.create({
        data: {
            paymentId: params.paymentId,
            orderId: params.orderId,
            organizerId: params.organizerId,
            provider: params.provider,
            providerTransactionId: params.providerTransactionId,
            type,
            amount: new Prisma.Decimal(params.amount),
            providerFee:
                params.providerFee === null
                    ? null
                    : new Prisma.Decimal(params.providerFee),
            currency: params.currency,
            status: "PAID",
            rawSummary: {
                statusCode: params.statusCode,
                channel: params.channel,
                eventType: params.eventType,
            },
            occurredAt: params.occurredAt,
        },
    });
}

/** Move the `Payment` row itself to PAID, and ledger the provider's transaction. */
async function settlePaymentRow(
    tx: Prisma.TransactionClient,
    input: {
        paymentId: string | null;
        orderId: string;
        organizerId: string;
        provider: string;
        providerTransactionId: string | null;
        amount: Prisma.Decimal | string;
        providerFee: string | null;
        currency: string;
        statusCode: string | null;
        channel: string | null;
        eventType: string;
        now: Date;
    }
): Promise<void> {
    if (!input.paymentId) {
        return;
    }

    // The Payment's own CAS (§13.3 step 5). `UNPAID` is included because that is the state
    // an attempt is created in, before the provider session is recorded.
    const cas = await tx.payment.updateMany({
        where: {
            id: input.paymentId,
            status: { in: ["UNPAID", "PENDING"] },
        },
        data: { status: "PAID" },
    });

    if (cas.count === 0) {
        // Already PAID, or terminal. Nothing more to write for this payment; a duplicate
        // delivery is handled upstream by the WebhookEvent ledger.
        return;
    }

    await recordProviderTransaction(tx, {
        paymentId: input.paymentId,
        orderId: input.orderId,
        organizerId: input.organizerId,
        provider: input.provider,
        providerTransactionId: input.providerTransactionId,
        amount: input.amount,
        providerFee: input.providerFee,
        currency: input.currency,
        statusCode: input.statusCode,
        channel: input.channel,
        eventType: input.eventType,
        occurredAt: input.now,
    });
}

/**
 * Settle a verified payment.
 *
 * The caller (the webhook) has already: read the raw body, verified the signature,
 * recorded the `WebhookEvent`, resolved the order by reference, and compared the reported
 * amount against `EventOrder.total`. This function does the state work and nothing else, so
 * it can be tested — including its races — without a provider.
 */
export async function settleVerifiedPayment(
    input: SettlementInput
): Promise<SettlementOutcome> {
    const now = input.now ?? new Date();

    const result = await withContentionRetry(async () =>
        prisma.$transaction(
            async (tx) => {
                const current = await tx.eventOrder.findUniqueOrThrow({
                    where: { id: input.orderId },
                    select: {
                        id: true,
                        orderNumber: true,
                        organizerId: true,
                        status: true,
                        paymentStatus: true,
                        paidAt: true,
                        fulfilmentBlockedAt: true,
                        currency: true,
                        total: true,
                    },
                });

                // ── Step 4: the CAS that decides who settles ─────────────────────
                //
                // `paidAt = COALESCE(paidAt, now)` per §13.3, expressed with the value read
                // a few statements above: the predicate guarantees this is the first
                // successful transition, so the coalesce only ever has an effect on a
                // database whose state was already inconsistent.
                const cas = await tx.eventOrder.updateMany({
                    where: {
                        id: input.orderId,
                        status: "PENDING_PAYMENT",
                        paymentStatus: { not: "PAID" },
                    },
                    data: {
                        status: "PAID",
                        paymentStatus: "PAID",
                        paidAt: current.paidAt ?? now,
                    },
                });

                if (cas.count === 0) {
                    // Somebody else already decided. Three distinct meanings:
                    if (current.paymentStatus === "PAID") {
                        // Already settled (this is the idempotent re-delivery path) — or
                        // settled late, which also leaves paymentStatus PAID.
                        return {
                            outcome: "ALREADY_PAID",
                            orderNumber: current.orderNumber,
                            organizerId: current.organizerId,
                        } as SettlementOutcome;
                    }

                    if (
                        current.status === "CANCELLED" ||
                        current.status === "EXPIRED"
                    ) {
                        // ── LATE SETTLEMENT (design §11.4 / §12.3) ───────────────
                        //
                        // "Late settlement is recorded by the webhook as
                        // `paymentStatus = PAID` **without** issuing tickets, raising an
                        // operator alert (§11.4)". §12.3 adds the reason the ledger exists:
                        // "`paymentStatus` may become `PAID` while `status` stays
                        // `CANCELLED` — this mismatch is exactly what the operator queue
                        // exists to resolve".
                        //
                        // So the ORDER STATUS IS NOT CHANGED. No reservation is converted
                        // and no counter moves: the seats were already returned when the
                        // order was cancelled or expired, and taking them back now would
                        // be the double-mutation this phase must prevent. `fulfilmentBlockedAt`
                        // is set because §11.4 requires fulfilment to be held.
                        await tx.eventOrder.updateMany({
                            where: {
                                id: input.orderId,
                                status: { in: ["CANCELLED", "EXPIRED"] },
                                paymentStatus: { not: "PAID" },
                            },
                            data: {
                                paymentStatus: "PAID",
                                paidAt: current.paidAt ?? now,
                                fulfilmentBlockedAt:
                                    current.fulfilmentBlockedAt ?? now,
                            },
                        });

                        // The money genuinely arrived, so the payment chain records it even
                        // though the order cannot be fulfilled.
                        await settlePaymentRow(tx, {
                            paymentId: input.paymentId,
                            orderId: current.id,
                            organizerId: current.organizerId,
                            provider: input.provider,
                            providerTransactionId:
                                input.providerTransactionId,
                            amount: input.amountReported ?? current.total,
                            providerFee: input.providerFeeReported,
                            currency: current.currency,
                            statusCode: input.statusCode,
                            channel: input.channel,
                            eventType: input.eventType,
                            now,
                        });

                        return {
                            outcome: "LATE_SETTLEMENT",
                            orderNumber: current.orderNumber,
                            organizerId: current.organizerId,
                            orderStatus: current.status,
                        } as SettlementOutcome;
                    }

                    return {
                        outcome: "NOT_APPLICABLE",
                        orderNumber: current.orderNumber,
                        organizerId: current.organizerId,
                        orderStatus: current.status,
                        paymentStatus: current.paymentStatus,
                    } as SettlementOutcome;
                }

                // ── Step 5: the payment chain ────────────────────────────────────
                await settlePaymentRow(tx, {
                    paymentId: input.paymentId,
                    orderId: current.id,
                    organizerId: current.organizerId,
                    provider: input.provider,
                    providerTransactionId: input.providerTransactionId,
                    amount: input.amountReported ?? current.total,
                    providerFee: input.providerFeeReported,
                    currency: current.currency,
                    statusCode: input.statusCode,
                    channel: input.channel,
                    eventType: input.eventType,
                    now,
                });

                // ── Step 6: the canonical inventory conversion ───────────────────
                // `confirmOrderReservations` CAS-es each `HELD` reservation to `CONVERTED`
                // and calls `confirmReservation` (reserved -= n, sold += n) inside THIS
                // transaction. It throws on a counter underflow, which rolls everything —
                // including the step-4 PAID — back.
                const conversion = await confirmOrderReservations(tx, current.id);

                // The order's own record of how many seats it bought. Lines are merged per
                // ticket type at checkout, so one reservation per line, and
                // `sum(items.quantity)` is the exact number of holds settlement must find.
                const items = await tx.eventOrderItem.findMany({
                    where: { orderId: current.id },
                    select: { quantity: true },
                });

                const expectedSeats = items.reduce(
                    (sum, item) => sum + item.quantity,
                    0
                );

                const anomalies: string[] = [...conversion.anomalies];

                if (conversion.quantity !== expectedSeats) {
                    anomalies.push(
                        `order ${current.orderNumber}: converted ${conversion.quantity} of ${expectedSeats} expected seat(s)`
                    );
                }

                if (anomalies.length > 0) {
                    // Money is in and the order is PAID, but the inventory does not
                    // reconcile. Design §11.4's answer for "paid but unfulfillable" is to
                    // hold fulfilment and raise it for an operator rather than to guess.
                    await tx.eventOrder.updateMany({
                        where: { id: current.id, fulfilmentBlockedAt: null },
                        data: { fulfilmentBlockedAt: now },
                    });
                }

                return {
                    outcome: "SETTLED",
                    orderNumber: current.orderNumber,
                    organizerId: current.organizerId,
                    reservationsConverted: conversion.transitioned,
                    seatsSold: conversion.quantity,
                    anomalies,
                } as SettlementOutcome;
            },
            { timeout: 20_000 }
        )
    );

    if (!result.ok) {
        // The transaction rolled back completely, so the order is still PENDING_PAYMENT and
        // the provider must keep retrying. Reported rather than thrown so the caller can
        // record the failure on the ledger and answer 500.
        const outcome = await readOrderIdentity(input.orderId);

        return {
            outcome: "RETRY_LATER",
            orderNumber: outcome.orderNumber,
            organizerId: outcome.organizerId,
            reason: "CONTENTION_EXHAUSTED",
            detail: `gave up after ${result.attempts} attempts`,
        };
    }

    const settled = result.value;

    // ── Audit, after the commit ──────────────────────────────────────────────────
    // Phase 6's convention, and the design's §32.3 rule is satisfied in the way that
    // matters: the audit row describes a state that provably exists, because it is written
    // only for an outcome the database has already committed.
    if (settled.outcome === "SETTLED") {
        await writeTicketingAudit({
            action: "payment.success",
            // The provider acted. `PROVIDER` is the explicit actor marker for that
            // (design §32.1's remediation of the overloaded `adminId` sentinel) — never a
            // fabricated user id.
            actorType: "PROVIDER",
            actorOrganizerId: null,
            organizerId: settled.organizerId,
            entityType: "EventOrder",
            entityRef: settled.orderNumber,
            description:
                settled.anomalies.length > 0
                    ? "Pembayaran tiket diterima, tetapi rekonsiliasi kursi memerlukan pemeriksaan operator."
                    : "Pembayaran tiket diterima; kursi dikonversi menjadi penjualan.",
            beforeState: { status: "PENDING_PAYMENT", paymentStatus: "PENDING" },
            afterState: {
                status: "PAID",
                paymentStatus: "PAID",
                reservationsConverted: settled.reservationsConverted,
                seatsSold: settled.seatsSold,
                ...(settled.anomalies.length > 0
                    ? {
                          fulfilmentBlocked: true,
                          anomalies: settled.anomalies,
                      }
                    : {}),
            },
            reason: "PROVIDER_NOTIFICATION_VERIFIED",
        });
    }

    if (settled.outcome === "LATE_SETTLEMENT") {
        await writeTicketingAudit({
            action: "payment.success",
            actorType: "PROVIDER",
            actorOrganizerId: null,
            organizerId: settled.organizerId,
            entityType: "EventOrder",
            entityRef: settled.orderNumber,
            description:
                "OPERATOR ALERT: pembayaran diterima setelah pesanan berstatus final. Tidak ada tiket diterbitkan; dana perlu ditindaklanjuti.",
            beforeState: {
                status: settled.orderStatus,
                paymentStatus: "UNPAID",
            },
            afterState: {
                status: settled.orderStatus,
                paymentStatus: "PAID",
                fulfilmentBlocked: true,
                orderStatusUnchanged: true,
            },
            reason: "LATE_SETTLEMENT_AFTER_TERMINAL_STATE",
        });
    }

    return settled;
}

/** Read the two identity fields an outcome needs even when the transaction rolled back. */
async function readOrderIdentity(
    orderId: string
): Promise<{ orderNumber: string; organizerId: string }> {
    const row = await prisma.eventOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: { orderNumber: true, organizerId: true },
    });

    return { orderNumber: row.orderNumber, organizerId: row.organizerId };
}

/**
 * Turn a thrown settlement error into an outcome the webhook can record.
 *
 * Kept separate from `settleVerifiedPayment` so the transaction body stays readable, and
 * because the two cases need different operator messages: exhaustion is transient, an
 * integrity failure is not.
 */
export function settlementFailureOutcome(params: {
    error: unknown;
    orderNumber: string;
    organizerId: string;
}): SettlementOutcome {
    if (params.error instanceof ReservationIntegrityError) {
        return {
            outcome: "RETRY_LATER",
            orderNumber: params.orderNumber,
            organizerId: params.organizerId,
            reason: "INTEGRITY_FAILURE",
            detail: params.error.message,
        };
    }

    if (isUniqueViolation(params.error)) {
        return {
            outcome: "RETRY_LATER",
            orderNumber: params.orderNumber,
            organizerId: params.organizerId,
            reason: "INTEGRITY_FAILURE",
            detail: "duplicate ledger entry",
        };
    }

    throw params.error;
}

/**
 * Design §13.4's failure transition:
 *
 *   "| `PENDING → FAILED` | webhook failed classification | release reservations; cancel
 *    attributed commission/PIC fee (none exists yet); order `CANCELLED` with
 *    `paymentStatus = FAILED`; notify buyer |"
 *
 * Implemented exactly as far as this phase owns it:
 *
 *   * **release reservations** — via the canonical `releaseOrderReservations`, so the seats
 *     return exactly once and a repeat delivery cannot double-release (`GREATEST(0, …)`);
 *   * **order → CANCELLED with paymentStatus FAILED** — one guarded update, so an order that
 *     was paid or expired in the meantime is never flipped into `CANCELLED`;
 *   * the two "cancel attributed commission/PIC fee" clauses are no-ops because no such
 *     records exist yet (attribution and the fee ledger are Phase 9), and no ledger
 *     adjustment is invented for them;
 *   * **notify buyer** is Phase 8's notification foundation, NOT implemented here.
 *
 * `CancelledAt` and `cancelReason` are set so the cancellation is indistinguishable in
 * shape from a buyer-initiated one, with a reason that names the cause.
 *
 * Lock order matches the cancel and settlement paths (order row first, then reservations,
 * then ticket types), which is what keeps these three transitions from deadlocking against
 * each other under concurrency (brief §17).
 */
export async function failVerifiedPayment(input: {
    orderId: string;
    paymentId: string | null;
    orderNumber: string;
    organizerId: string;
    providerFeeReported: string | null;
    statusCode: string | null;
    channel: string | null;
    eventType: string;
    now?: Date;
}): Promise<SettlementOutcome> {
    const now = input.now ?? new Date();

    const result = await withContentionRetry(async () =>
        prisma.$transaction(
            async (tx) => {
                const current = await tx.eventOrder.findUniqueOrThrow({
                    where: { id: input.orderId },
                    select: {
                        orderNumber: true,
                        organizerId: true,
                        status: true,
                        paymentStatus: true,
                    },
                });

                // CAS first, exactly like cancel and settlement, so the three transitions
                // contend on one row in one order and exactly one of them can win.
                const cas = await tx.eventOrder.updateMany({
                    where: {
                        id: input.orderId,
                        status: "PENDING_PAYMENT",
                        paymentStatus: { not: "PAID" },
                    },
                    data: {
                        status: "CANCELLED",
                        paymentStatus: "FAILED",
                        cancelledAt: now,
                        cancelReason: "Pembayaran gagal di penyedia.",
                    },
                });

                if (cas.count === 0) {
                    if (current.paymentStatus === "PAID") {
                        return {
                            outcome: "ALREADY_PAID",
                            orderNumber: current.orderNumber,
                            organizerId: current.organizerId,
                        } as SettlementOutcome;
                    }

                    return {
                        outcome: "NOT_APPLICABLE",
                        orderNumber: current.orderNumber,
                        organizerId: current.organizerId,
                        orderStatus: current.status,
                        paymentStatus: current.paymentStatus,
                    } as SettlementOutcome;
                }

                // Seats come back in the SAME transaction as the status change, so a crash
                // cannot leave a cancelled order still holding inventory (design §11.2).
                const released = await releaseOrderReservations(
                    tx,
                    input.orderId,
                    "RELEASED",
                    now
                );

                if (input.paymentId) {
                    await tx.payment.updateMany({
                        where: {
                            id: input.paymentId,
                            status: { in: ["UNPAID", "PENDING"] },
                        },
                        data: { status: "FAILED" },
                    });
                }

                return {
                    outcome: "ORDER_FAILED",
                    orderNumber: current.orderNumber,
                    organizerId: current.organizerId,
                    reservationsReleased: released.transitioned,
                    seatsReleased: released.quantity,
                } as SettlementOutcome;
            },
            { timeout: 20_000 }
        )
    );

    if (!result.ok) {
        return {
            outcome: "RETRY_LATER",
            orderNumber: input.orderNumber,
            organizerId: input.organizerId,
            reason: "CONTENTION_EXHAUSTED",
            detail: `gave up after ${result.attempts} attempts`,
        };
    }

    if (result.value.outcome === "ORDER_FAILED") {
        await writeTicketingAudit({
            action: "payment.failed",
            actorType: "PROVIDER",
            actorOrganizerId: null,
            organizerId: result.value.organizerId,
            entityType: "EventOrder",
            entityRef: result.value.orderNumber,
            description:
                "Pembayaran gagal di penyedia; pesanan dibatalkan dan kursi dikembalikan.",
            beforeState: { status: "PENDING_PAYMENT", paymentStatus: "PENDING" },
            afterState: {
                status: "CANCELLED",
                paymentStatus: "FAILED",
                reservationsReleased: result.value.reservationsReleased,
                seatsReleased: result.value.seatsReleased,
            },
            reason: `PROVIDER_FAILED_${input.eventType}`,
        });
    }

    return result.value;
}

/** Re-exported so the webhook can render an amount without importing the payload module. */
export { moneyString as formatAmount };
