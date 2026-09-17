import type { Prisma, TicketReservationStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { writeTicketingAudit } from "./audit-log";
import { voidOpenPayments } from "./payment/void";
import {
    confirmReservation,
    releaseReservation,
    type InventoryDb,
} from "./inventory";

/**
 * ==========================================
 * TICKET RESERVATION LIFECYCLE (design §11.4)
 * ==========================================
 *
 * One `TicketReservation` row per `(orderId, ticketTypeId)`. Design §11.4 fixes the
 * status vocabulary and the schema already implements it:
 *
 *   HELD ──→ CONVERTED   (payment settled; reserved -= n, sold += n)
 *        ├─→ RELEASED    (buyer cancelled / failed payment)
 *        └─→ EXPIRED     (TTL elapsed, or reaped)
 *
 * ── WHERE THE DESIGN'S PROSE AND THE SCHEMA DISAGREE ─────────────────────────────
 * Design §11.4's prose writes the middle state as `CONFIRMED`. The shipped enum
 * `TicketReservationStatus` (Phase 2, accepted) is:
 *
 *     HELD | CONVERTED | RELEASED | EXPIRED
 *
 * Brief §5 says to "use the exact statuses/names already defined by the schema/design"
 * and not to invent a duplicate vocabulary. Where the two disagree, this module follows
 * the **schema**, because it is the thing that actually stores the value and because
 * Phase 2 was accepted on it. `CONFIRMED` is therefore never written anywhere. Recorded
 * so the divergence is not rediscovered as a bug.
 *
 * ── THE TWO RULES THAT MAKE THIS SAFE ────────────────────────────────────────────
 *
 * 1. **The state transition is the guard, not a prior read.** Every transition is a
 *    conditional `updateMany` filtered on the CURRENT status:
 *
 *        UPDATE ticketreservation SET status = ? WHERE id = ? AND status = 'HELD'
 *
 *    `count === 1` means this caller won the transition; `count === 0` means somebody
 *    else already moved it. A read-then-write ("if it is HELD, then update") would be a
 *    time-of-check/time-of-use race, which brief §7 explicitly forbids. This is what
 *    makes release idempotent, makes confirm-vs-release mutually exclusive, and stops a
 *    duplicate release from subtracting quota twice.
 *
 * 2. **The inventory mutation happens in the SAME transaction as the state change.**
 *    Design §11.2: "Each statement is executed inside the same transaction as the state
 *    change it belongs to, so an order row and its reservation can never diverge."
 *    `reserveQuota` / `confirmReservation` / `releaseReservation` all accept a
 *    transaction client, so a reservation state and the `reserved` counter can never be
 *    left disagreeing by a crash between the two statements.
 *
 * The counters themselves are NEVER written from this file. `sold`, `reserved` and
 * `version` belong to `lib/ticketing/inventory.ts` (brief §9).
 *
 * ── TTL (design §11.4, LOCKED) ───────────────────────────────────────────────────
 * `expiresAt = now + TTL`, where TTL is `PlatformSetting.reservationTtlMinutes`,
 * default **30 minutes**. The value is read from the setting row rather than
 * hard-coded, so an operator can change it without a deploy.
 *
 * §11.4 also states the MVP simplification that there is **one TTL per order** (so the
 * "partial expiry" case cannot arise). That simplification is adopted here: every
 * reservation of an order is created with the same `expiresAt`, and the order carries
 * the same instant.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────────
 * There is **no scheduler, cron, interval timer or worker** in this file. This module
 * provides the reaper's *body* (`expireDueReservations`) as a bounded, re-runnable batch
 * function; *when* it runs is a deployment/infrastructure decision that the design does
 * not take and this phase must not invent (brief §8).
 */

/** Statuses that mean a reservation will never move again. */
export const TERMINAL_RESERVATION_STATUSES: readonly TicketReservationStatus[] = [
    "CONVERTED",
    "RELEASED",
    "EXPIRED",
];

/** The only status a transition may start from. */
export const RESERVATION_INITIAL_STATUS: TicketReservationStatus = "HELD";

/** Design §11.4's documented default when `PlatformSetting` has no value. */
export const DEFAULT_RESERVATION_TTL_MINUTES = 30;

/** The `PlatformSetting` singleton row id (`Int @id @default(1)`). */
const PLATFORM_SETTING_ID = 1;

/**
 * Design §11.4: TTL is `PlatformSetting.reservationTtlMinutes`, default 30.
 *
 * A missing row, a `null`, or a non-positive value all fall back to the documented
 * default rather than producing a reservation that expires immediately or never.
 */
export async function resolveReservationTtlMinutes(
    db: InventoryDb = prisma
): Promise<number> {
    const setting = await db.platformSetting.findUnique({
        where: { id: PLATFORM_SETTING_ID },
        select: { reservationTtlMinutes: true },
    });

    const configured = setting?.reservationTtlMinutes;

    if (
        typeof configured === "number" &&
        Number.isFinite(configured) &&
        configured > 0
    ) {
        return configured;
    }

    return DEFAULT_RESERVATION_TTL_MINUTES;
}

/** `expiresAt = now + TTL`. Pure, so the arithmetic is testable without a database. */
export function computeExpiresAt(now: Date, ttlMinutes: number): Date {
    return new Date(now.getTime() + ttlMinutes * 60_000);
}

export type CreateReservationInput = {
    orderId: string;
    ticketTypeId: string;
    eventId: string;
    quantity: number;
    expiresAt: Date;
};

/**
 * Insert one `HELD` reservation row.
 *
 * Always called inside the checkout transaction that has just reserved the quota, so
 * the row and the counter are committed together (design §11.2). `status` is left to
 * the schema default (`HELD`) rather than passed, so the initial state has exactly one
 * definition.
 */
export async function createReservation(
    tx: Prisma.TransactionClient,
    input: CreateReservationInput
) {
    return tx.ticketReservation.create({
        data: {
            orderId: input.orderId,
            ticketTypeId: input.ticketTypeId,
            eventId: input.eventId,
            quantity: input.quantity,
            expiresAt: input.expiresAt,
        },
        select: {
            id: true,
            orderId: true,
            ticketTypeId: true,
            quantity: true,
            status: true,
            expiresAt: true,
        },
    });
}

export type ReservationTransitionSummary = {
    /** Rows this call actually moved (`count === 1`). */
    transitioned: number;
    /** Rows another caller had already moved (`count === 0`) — harmless. */
    alreadyMoved: number;
    /** Seats handed back to availability. */
    quantity: number;
    /**
     * Data-integrity reports. Empty in a healthy database. A non-empty entry means an
     * inventory counter disagreed with the reservation rows *before* this call, which
     * is an operator-visible alarm rather than something to swallow.
     */
    anomalies: string[];
};

async function heldReservationsForOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
    now: Date
) {
    return tx.ticketReservation.findMany({
        where: { orderId, status: RESERVATION_INITIAL_STATUS },
        select: { id: true, ticketTypeId: true, quantity: true },
        orderBy: { id: "asc" },
    });
}

/**
 * Move every `HELD` reservation of an order to a terminal "quota comes back" status
 * (`RELEASED` for a buyer/system cancellation, `EXPIRED` for a TTL elapse) and return
 * the seats to availability.
 *
 * Idempotent by construction: the second call finds no `HELD` rows, so it reports
 * `transitioned: 0` and touches no counter. Calling it twice therefore cannot produce
 * `reserved < 0`, cannot duplicate the state transition, and cannot double-release.
 *
 * Fail-safe direction: a shortfall is reported as an anomaly, never thrown. Throwing
 * would roll back the state change and leave the seat held forever, which is worse than
 * an anomaly an operator can see.
 */
export async function releaseOrderReservations(
    tx: Prisma.TransactionClient,
    orderId: string,
    to: Extract<TicketReservationStatus, "RELEASED" | "EXPIRED">,
    now: Date = new Date()
): Promise<ReservationTransitionSummary> {
    const held = await heldReservationsForOrder(tx, orderId, now);

    let transitioned = 0;
    let alreadyMoved = 0;
    let quantity = 0;
    const anomalies: string[] = [];

    for (const reservation of held) {
        const cas = await tx.ticketReservation.updateMany({
            where: { id: reservation.id, status: RESERVATION_INITIAL_STATUS },
            data: { status: to },
        });

        if (cas.count === 0) {
            alreadyMoved += 1;
            continue;
        }

        transitioned += 1;
        quantity += reservation.quantity;

        const released = await releaseReservation(
            reservation.ticketTypeId,
            reservation.quantity,
            tx
        );

        if (released.released !== reservation.quantity) {
            anomalies.push(
                `reservation ${reservation.id}: released ${released.released} of ${reservation.quantity} seat(s) from ticket type ${reservation.ticketTypeId}`
            );
        }
    }

    return { transitioned, alreadyMoved, quantity, anomalies };
}

/** How many reservations of this order are still `HELD`. */
export async function countHeldReservations(
    tx: Prisma.TransactionClient,
    orderId: string
): Promise<number> {
    return tx.ticketReservation.count({
        where: { orderId, status: RESERVATION_INITIAL_STATUS },
    });
}

/**
 * Convert every `HELD` reservation of an order to `CONVERTED` and move the seats from
 * `reserved` to `sold`.
 *
 * INTERFACE ONLY IN PHASE 6. Its production caller is the settlement path (design
 * §12.3 `PENDING_PAYMENT → PAID`, "webhook only"), which is Phase 7. It is implemented
 * and tested here because the reservation lifecycle is this phase's deliverable and
 * because `confirm-vs-release` and `confirm-vs-expiry` races are required test cases
 * (brief §29), not because anything calls it yet.
 *
 * State-safe: the CAS makes a second confirmation a no-op, and once a reservation is
 * `RELEASED`/`EXPIRED` it can never be confirmed.
 *
 * Unlike release, a counter shortfall here **throws**, inside the caller's transaction,
 * so the whole settlement rolls back and fails loudly. Design §11.2 calls
 * `affectedRows === 0` on confirm "a data-integrity alarm: reserved underflow (must
 * never happen)" — swallowing it would silently mint a ticket against quota that was
 * never held.
 */
export async function confirmOrderReservations(
    tx: Prisma.TransactionClient,
    orderId: string
): Promise<ReservationTransitionSummary> {
    const held = await heldReservationsForOrder(tx, orderId, new Date());

    let transitioned = 0;
    let alreadyMoved = 0;
    let quantity = 0;
    const anomalies: string[] = [];

    for (const reservation of held) {
        const cas = await tx.ticketReservation.updateMany({
            where: { id: reservation.id, status: RESERVATION_INITIAL_STATUS },
            data: { status: "CONVERTED" },
        });

        if (cas.count === 0) {
            alreadyMoved += 1;
            continue;
        }

        const confirmed = await confirmReservation(
            reservation.ticketTypeId,
            reservation.quantity,
            tx
        );

        if (!confirmed.ok) {
            throw new ReservationIntegrityError(
                `confirm underflow on ticket type ${reservation.ticketTypeId} ` +
                    `(${confirmed.reason}) for reservation ${reservation.id}`
            );
        }

        transitioned += 1;
        quantity += reservation.quantity;
    }

    return { transitioned, alreadyMoved, quantity, anomalies };
}

/**
 * Design §11.2's "data-integrity alarm". Thrown only when a confirm would drive
 * `reserved` negative, which means the counters were already wrong.
 */
export class ReservationIntegrityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReservationIntegrityError";
    }
}

/**
 * The reaper's batch *selector* (design §11.4): `status = HELD AND expiresAt < now()`,
 * oldest first, bounded by `batchSize`.
 *
 * Returns order ids because the design's unit of work is the order — reservations are
 * released together and the parent order transitions once — not the reservation row.
 */
export async function selectOrdersWithDueReservations(
    now: Date,
    batchSize: number,
    db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<{ orderIds: string[]; scanned: number }> {
    const due = await db.ticketReservation.findMany({
        where: { status: RESERVATION_INITIAL_STATUS, expiresAt: { lt: now } },
        select: { orderId: true },
        orderBy: { expiresAt: "asc" },
        take: batchSize,
    });

    const orderIds = Array.from(new Set(due.map((row) => row.orderId)));

    return { orderIds, scanned: due.length };
}

export type ExpireBatchResult = {
    scanned: number;
    ordersTouched: number;
    ordersExpired: number;
    reservationsExpired: number;
    seatsReleased: number;
    anomalies: string[];
};

/**
 * THE REAPER BODY — design §11.4, executed as one bounded, re-runnable batch.
 *
 * For each order with a due reservation: CAS `HELD → EXPIRED`, release the seats, and
 * transition the parent order to `EXPIRED` **if it has no `HELD` reservations left**.
 * The order transition is itself guarded (`status = PENDING_PAYMENT`) so a paid or
 * cancelled order can never be flipped to `EXPIRED` — the design's anti-resurrection
 * rule (§12.3: `CANCELLED / EXPIRED → PAID` is not allowed, and by the same logic a
 * paid order cannot become expired).
 *
 * RUNNING IT TWICE IS SAFE: every step is guarded by a status predicate, so a second
 * run finds nothing `HELD` and changes nothing. Design §11.4: "The reaper's CAS
 * (`WHERE status = 'HELD'`) plus the `GREATEST(0, ...)` release guard make a double-run
 * safe."
 *
 * IT IS NOT SCHEDULED HERE. Design §11.4 specifies a scheduled job with a 1-minute
 * interval and single-flight invocation, and §40.11 assigns the job runner to another
 * phase; the Phase 2 schema comment records that "no background worker exists" yet.
 * Brief §8 forbids inventing scheduler infrastructure, and no infrastructure decision
 * exists in the design. So this function is the mechanism, exported for a future
 * runner and for tests, and the invocation decision is reported as outstanding rather
 * than improvised.
 */
export async function expireDueReservations(options?: {
    batchSize?: number;
    now?: Date;
}): Promise<ExpireBatchResult> {
    const now = options?.now ?? new Date();
    const batchSize = options?.batchSize ?? 100;

    const { orderIds, scanned } = await selectOrdersWithDueReservations(
        now,
        batchSize
    );

    let ordersExpired = 0;
    let reservationsExpired = 0;
    let seatsReleased = 0;
    const anomalies: string[] = [];

    for (const orderId of orderIds) {
        // One transaction per order: the reservation state, the counters and the parent
        // order's status are committed together or not at all (design §11.2).
        const outcome = await prisma.$transaction(
            async (tx) => {
                /* ==========================================
                 * PHASE 7 FIX — CLAIM THE EXPIRY DECISION BEFORE RELEASING
                 * ==========================================
                 *
                 * This used to release the holds FIRST and check the parent order
                 * afterwards. That is safe while nothing else can settle an order, and it
                 * stops being safe the moment a settlement path exists:
                 *
                 *   * settlement locks the order row, sets PAID, then converts the holds;
                 *   * the old reaper released the holds first and only then found the order
                 *     no longer PENDING_PAYMENT — but it had already moved the seats, and
                 *     returning early did NOT roll the transaction back.
                 *
                 * A settlement that won the order row while the reaper had already
                 * released the holds would therefore commit `status = PAID` against
                 * `reserved` that had just been given away, and the subsequent
                 * `confirmOrderReservations` would find nothing to convert: an order PAID
                 * with zero seats sold. That is the "paid but ticketless" class of bug
                 * design §11.4 exists to prevent.
                 *
                 * The fix is ordering, and it is also the lock order the cancel and
                 * settlement paths use (order row → reservations → ticket types), so the
                 * three transitions now contend on one row in one direction and cannot
                 * deadlock against each other either (brief §16/§17).
                 */
                const claimed = await tx.eventOrder.updateMany({
                    where: { id: orderId, status: "PENDING_PAYMENT" },
                    data: { status: "EXPIRED" },
                });

                const parent = await tx.eventOrder.findUniqueOrThrow({
                    where: { id: orderId },
                    select: { orderNumber: true, organizerId: true, status: true },
                });

                if (claimed.count === 0) {
                    // Another transition owns this order: a settlement marked it PAID (and
                    // is converting the holds), or a cancel released them. Releasing here
                    // would double-release seats for an order that may now be paid, so the
                    // default is to touch nothing and report it.
                    //
                    // The one exception is deliberate self-healing: if the order is
                    // terminal and NOT paid but still holds seats — which the atomic cancel
                    // and this reaper cannot produce, so it can only be pre-existing
                    // damage — the seats are returned rather than left stranded forever.
                    const orphaned =
                        parent.status !== "PAID" &&
                        parent.status !== "PENDING_PAYMENT"
                            ? await releaseOrderReservations(
                                  tx,
                                  orderId,
                                  "EXPIRED",
                                  now
                              )
                            : null;

                    return {
                        summary: orphaned,
                        expiredOrder: false,
                        paymentsVoided: 0,
                        // Flat copies so the audit block below does not have to narrow
                        // `summary`, which is nullable on the branch that skipped the
                        // release. The counts are meaningful either way (0 when nothing
                        // was released).
                        expiredReservations: orphaned?.transitioned ?? 0,
                        expiredSeats: orphaned?.quantity ?? 0,
                        organizerId: parent.organizerId,
                        orderNumber: parent.orderNumber,
                    };
                }

                // This caller owns the expiry. Seats come back, and any open payment
                // attempt for the order is closed (design §13.4's `PENDING → EXPIRED`).
                const summary = await releaseOrderReservations(
                    tx,
                    orderId,
                    "EXPIRED",
                    now
                );

                const paymentsVoided = await voidOpenPayments(tx, orderId);

                const stillHeld = await countHeldReservations(tx, orderId);

                return {
                    summary: {
                        ...summary,
                        // A hold that survived its own expiry is an anomaly worth naming,
                        // not something to swallow.
                        anomalies: [
                            ...summary.anomalies,
                            ...(stillHeld > 0
                                ? [
                                      `order ${orderId}: ${stillHeld} reservation(s) still HELD after expiry`,
                                  ]
                                : []),
                        ],
                    },
                    expiredOrder: true,
                    paymentsVoided,
                    expiredReservations: summary.transitioned,
                    expiredSeats: summary.quantity,
                    organizerId: parent.organizerId,
                    orderNumber: parent.orderNumber,
                };
            },
            { timeout: 15_000 }
        );

        if (outcome.summary) {
            reservationsExpired += outcome.summary.transitioned;
            seatsReleased += outcome.summary.quantity;
            anomalies.push(...outcome.summary.anomalies);
        }

        if (outcome.paymentsVoided > 0) {
            await writeTicketingAudit({
                action: "payment.expired",
                actorType: "SYSTEM",
                actorOrganizerId: null,
                organizerId: outcome.organizerId,
                entityType: "Payment",
                entityRef: outcome.orderNumber,
                description:
                    "Sesi pembayaran ditutup karena masa berlaku pesanan berakhir.",
                afterState: {
                    paymentStatus: "EXPIRED",
                    attempts: outcome.paymentsVoided,
                },
                reason: "ORDER_EXPIRED",
            });
        }

        if (outcome.expiredOrder) {
            ordersExpired += 1;

            // Audited per order, after its own transaction committed — and only when the
            // parent order actually transitioned, so a re-run of the batch (which finds
            // nothing HELD) writes no duplicate rows.
            await writeTicketingAudit({
                action: "order.expire",
                actorType: "SYSTEM",
                actorOrganizerId: null,
                organizerId: outcome.organizerId,
                entityType: "EventOrder",
                entityRef: outcome.orderNumber,
                description:
                    "Pesanan tiket kedaluwarsa; kursi dikembalikan ke ketersediaan.",
                beforeState: { status: "PENDING_PAYMENT" },
                afterState: {
                    status: "EXPIRED",
                    reservationsExpired: outcome.expiredReservations,
                    seatsReleased: outcome.expiredSeats,
                },
                reason: "RESERVATION_TTL_ELAPSED",
            });
        }
    }

    return {
        scanned,
        ordersTouched: orderIds.length,
        ordersExpired,
        reservationsExpired,
        seatsReleased,
        anomalies,
    };
}
