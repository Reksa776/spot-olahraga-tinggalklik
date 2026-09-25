import { Prisma } from "@prisma/client";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import type { AuthzScope } from "@/lib/authz/permissions";
import {
    classifySalesState,
    isEventPurchasable,
    type EventSalesWindow,
    type TicketTypeSnapshot,
} from "@/lib/events/sales-state";
import { resolveReferralAtCheckout } from "@/lib/pic/attribution";
import { prisma } from "@/lib/prisma";

import type { CheckoutRequest } from "./checkout-validation";
import {
    computeCheckoutRequestHash,
    computeIdempotencyExpiresAt,
    IDEMPOTENCY_SCOPE_CHECKOUT,
    normalizeCheckoutItems,
} from "./idempotency";
import { writeTicketingAudit } from "./audit-log";
import {
    contentionBackoff,
    CONTENTION_MAX_ATTEMPTS,
    isTransientContention,
} from "./db-contention";
import { reserveQuota } from "./inventory";
import {
    ORDER_PAYLOAD_SELECT,
    buildOrderPayload,
    moneyString,
    type OrderPayload,
} from "./order-payload";
import {
    computeExpiresAt,
    createReservation,
    resolveReservationTtlMinutes,
} from "./reservations";

/**
 * ==========================================
 * TICKET CHECKOUT (design §25.5, §11.2, §11.3, §12.1, §17.2, §30)
 * ==========================================
 *
 * Creates an `EventOrder` + `EventOrderItem[]` + `TicketReservation[]` and holds the
 * quota. It does **not** create a `Payment`, does not talk to iPaymu and does not issue
 * tickets: the output is a *payment-ready* order in `PENDING_PAYMENT` (design §12.2),
 * which is where Phase 6 ends and Phase 7 begins.
 *
 * ── THE ONE TRANSACTION ──────────────────────────────────────────────────────────
 * Everything below happens inside a single `prisma.$transaction`:
 *
 *   idempotency key row → order → (per line, ticketTypeId ascending):
 *       reserveQuota CAS → order item → reservation row
 *   → key marked COMPLETED
 *
 * Design §11.2: "Each statement is executed inside the same transaction as the state
 * change it belongs to, so an order row and its reservation can never diverge." This is
 * what makes the brief's critical failure case impossible: if the reservation row cannot
 * be written, the quota CAS rolls back with it, so **reserved inventory can never be
 * stranded**, and an order can never exist without its hold.
 *
 * ── DETERMINISTIC LOCK ORDER (design §11.3, LOCKED) ──────────────────────────────
 * Lines are processed **sorted by `ticketTypeId` ascending** and, if any line's CAS
 * fails, the whole transaction rolls back and the response is `SOLD_OUT` **naming the
 * specific ticket type** (§11.3). The sort prevents the classic deadlock where order X
 * locks type 1 then 2 while order Y locks 2 then 1.
 *
 * ── PRICING IS SERVER-SIDE, ALWAYS (design §17.2, brief §17) ─────────────────────
 * The client sends `ticketTypeId` and `quantity` and nothing else. Prices come from
 * `TicketType.price`, and every stored amount is a Prisma `Decimal` computed with
 * decimal.js — never `Number`, never `Math.round`, never a client-supplied figure.
 */

export type CheckoutOutcome = {
    payload: OrderPayload;
    /** True when this response is a replay of an earlier identical request (§30.1 #1). */
    replayed: boolean;
};

/** design §17.5: "Round once, at the point a monetary value is first persisted." */
function roundToRupiah(value: Prisma.Decimal): Prisma.Decimal {
    return value.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * `EVT-{epochMillis}-{8 hex}` — the shape of the design's example
 * (`EVT-1758000000000-7f3a91c2`). `orderNumber` is `@unique` (constraint register C-12),
 * and the insert is the authority: a collision is caught and retried rather than
 * assumed away.
 */
function generateOrderNumber(now: Date): string {
    const random = Math.floor(Math.random() * 0xffffffff)
        .toString(16)
        .padStart(8, "0");

    return `EVT-${now.getTime()}-${random}`;
}

/** Prisma unique-violation target names, used to tell *which* constraint rejected a write. */
function uniqueViolationTargets(error: unknown): string[] {
    if (typeof error !== "object" || error === null) {
        return [];
    }

    const candidate = error as { code?: string; meta?: { target?: unknown } };

    if (candidate.code !== "P2002") {
        return [];
    }

    const target = candidate.meta?.target;

    if (Array.isArray(target)) {
        return target.map((value) => String(value));
    }

    return typeof target === "string" ? [target] : [];
}

function isIdempotencyCollision(error: unknown): boolean {
    return uniqueViolationTargets(error).some(
        (target) =>
            target.includes("idempotencykey") ||
            target.includes("scope") ||
            target.includes("key")
    );
}

function isOrderNumberCollision(error: unknown): boolean {
    return uniqueViolationTargets(error).some((target) =>
        target.includes("orderNumber")
    );
}

/**
 * How many times one checkout request may be re-attempted.
 *
 * Used for BOTH retryable causes: an `orderNumber` collision and a transient InnoDB
 * serialization failure. Every attempt re-runs the entire request from scratch — the
 * purchase gate, the conditional `UPDATE`, the idempotency-key insert — so a retry can
 * never skip a guard; it can only re-evaluate them. That is what makes a bounded retry
 * safe here, as opposed to the unguarded "sleep and try again" the brief rules out.
 *
 * The bound itself is `CONTENTION_MAX_ATTEMPTS` (Phase 7): one number, shared with the
 * settlement path, so the two cannot drift apart.
 */
const CHECKOUT_MAX_ATTEMPTS = CONTENTION_MAX_ATTEMPTS;

/**
 * Transient InnoDB serialization classification and the jittered retry pause now live in
 * `lib/ticketing/db-contention.ts`.
 *
 * PHASE 7 moved them (behaviour unchanged) because the settlement path needs the identical
 * bounded, jittered retry — brief §18 requires it there by name — and duplicating the
 * classifier and the backoff would create the second implementation the brief forbids.
 * `isTransientContention` and `contentionBackoff` are imported below; nothing about when
 * this file retries has changed.
 */

/**
 * The `TicketType` projection the purchase gate and the price snapshot both need.
 *
 * `price` is narrowed from `TicketTypeSnapshot`'s `unknown` to the two shapes a Prisma
 * `Decimal` column can actually be read as, so the `Decimal` construction below is
 * type-checked rather than cast.
 */
type PurchasableTicketType = Omit<TicketTypeSnapshot, "price"> & {
    id: string;
    name: string;
    currency: string;
    minPerOrder: number;
    maxPerOrder: number | null;
    price: Prisma.Decimal | string;
};

/**
 * The early availability gate (design §11.1, §25.1 codes; brief §11).
 *
 * Every refusal here is **advisory**: another buyer may take the last seat between this
 * read and the CAS, so `reserveQuota` remains the authority. This exists to give the
 * buyer an accurate error *before* any write, not to protect the quota.
 *
 * Error codes follow §25.1 exactly:
 *   INACTIVE / window closed / not started → `SALES_NOT_OPEN` (409)
 *   exhausted                              → `SOLD_OUT` (409, `details.ticketTypeId`)
 *   min/max violated                       → `LIMIT_EXCEEDED` (409)
 */
function assertPurchasable(
    type: PurchasableTicketType,
    quantity: number,
    eventWindow: EventSalesWindow,
    now: Date
): void {
    if (!type.isActive) {
        throw new AppError(ERROR_CODES.SALES_NOT_OPEN, {
            message: "Jenis tiket ini sedang tidak dijual.",
            details: { ticketTypeId: type.id, reason: "INACTIVE" },
        });
    }

    // The canonical classifier from `lib/events/sales-state.ts` — the same function the
    // public catalog uses. Brief §11 forbids a second implementation.
    const state = classifySalesState(type, eventWindow, now);

    if (state === "NOT_STARTED" || state === "CLOSED") {
        throw new AppError(ERROR_CODES.SALES_NOT_OPEN, {
            message: "Penjualan tiket ini belum dibuka atau sudah ditutup.",
            details: { ticketTypeId: type.id, reason: state },
        });
    }

    if (state === "SOLD_OUT") {
        throw new AppError(ERROR_CODES.SOLD_OUT, {
            message: "Tiket sudah habis.",
            details: { ticketTypeId: type.id },
        });
    }

    if (quantity < type.minPerOrder) {
        throw new AppError(ERROR_CODES.LIMIT_EXCEEDED, {
            message: `Minimal pembelian ${type.minPerOrder} tiket untuk jenis ini.`,
            details: {
                ticketTypeId: type.id,
                minPerOrder: type.minPerOrder,
                maxPerOrder: type.maxPerOrder,
                quantity,
                reason: "BELOW_MIN_PER_ORDER",
            },
        });
    }

    if (type.maxPerOrder !== null && quantity > type.maxPerOrder) {
        throw new AppError(ERROR_CODES.LIMIT_EXCEEDED, {
            message: `Maksimal pembelian ${type.maxPerOrder} tiket untuk jenis ini.`,
            details: {
                ticketTypeId: type.id,
                minPerOrder: type.minPerOrder,
                maxPerOrder: type.maxPerOrder,
                quantity,
                reason: "ABOVE_MAX_PER_ORDER",
            },
        });
    }
}

export async function createTicketOrder(params: {
    request: CheckoutRequest;
    actor: AuthzScope;
    idempotencyKey: string;
    now?: Date;
    /** Optional HTTP request, used only for the audit row's IP / user-agent. */
    httpRequest?: Request;
}): Promise<CheckoutOutcome> {
    const now = params.now ?? new Date();
    const { request, actor, idempotencyKey } = params;

    // ── Coupons are post-MVP (design §4.2) ───────────────────────────────────────
    // §17.2 fixes MVP `discount = 0`. A supplied code is REFUSED rather than silently
    // ignored, because accepting a coupon and charging full price would be a worse
    // failure than saying the feature is unavailable.
    if (request.couponCode) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
            message: "Kupon belum tersedia.",
            details: {
                field: "couponCode",
                reason: "COUPONS_NOT_AVAILABLE_IN_MVP",
            },
        });
    }

    // Merge repeated lines for one ticket type and order by ticketTypeId (§11.3/§11.4).
    const lines = normalizeCheckoutItems(request.items);

    const requestHash = computeCheckoutRequestHash({
        eventId: request.eventId,
        buyerName: request.buyerName,
        buyerEmail: request.buyerEmail,
        buyerPhone: request.buyerPhone,
        couponCode: request.couponCode ?? null,
        shareToken: request.shareToken ?? null,
        items: lines,
    });

    // ── The Event is resolved from the database (brief §12) ──────────────────────
    const event = await prisma.event.findUnique({
        where: { id: request.eventId },
        select: {
            id: true,
            organizerId: true,
            status: true,
            visibility: true,
            archivedAt: true,
            cancelledAt: true,
            salesStartAt: true,
            salesEndAt: true,
            startAt: true,
            maxTicketsPerOrder: true,
        },
    });

    if (!event) {
        // Same answer as the public detail endpoint for an unknown slug (§25.3).
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Event tidak ditemukan.",
        });
    }

    if (!isEventPurchasable(event)) {
        // A cancelled event is publicly visible and stays readable (D-14), so "sales are
        // not open" is the honest answer. Anything else — draft, private, archived — is
        // not a public event at all, so it is reported as not found exactly as the
        // catalog does, and no existence is confirmed.
        if (event.status === "CANCELLED" || event.cancelledAt !== null) {
            throw new AppError(ERROR_CODES.SALES_NOT_OPEN, {
                message: "Event ini sudah dibatalkan.",
                details: { reason: "EVENT_CANCELLED" },
            });
        }

        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Event tidak ditemukan.",
        });
    }

    // ── Per-order ceiling (design §25.5 validation) ──────────────────────────────
    // `Event.maxTicketsPerOrder` is nullable, meaning "no explicit ceiling", in which
    // case no aggregate limit is invented here.
    const requestedTotal = lines.reduce((sum, line) => sum + line.quantity, 0);

    if (
        event.maxTicketsPerOrder !== null &&
        requestedTotal > event.maxTicketsPerOrder
    ) {
        throw new AppError(ERROR_CODES.LIMIT_EXCEEDED, {
            message: `Maksimal ${event.maxTicketsPerOrder} tiket per pesanan untuk event ini.`,
            details: {
                maxTicketsPerOrder: event.maxTicketsPerOrder,
                requestedTotal,
                reason: "ABOVE_EVENT_MAX_PER_ORDER",
            },
        });
    }

    // ── Ticket types must belong to THIS event ───────────────────────────────────
    const ticketTypes = (await prisma.ticketType.findMany({
        where: { id: { in: lines.map((line) => line.ticketTypeId) }, eventId: event.id },
        select: {
            id: true,
            name: true,
            price: true,
            currency: true,
            quota: true,
            sold: true,
            reserved: true,
            isActive: true,
            minPerOrder: true,
            maxPerOrder: true,
            salesStartAt: true,
            salesEndAt: true,
        },
    })) as PurchasableTicketType[];

    const byId = new Map(ticketTypes.map((type) => [type.id, type]));

    // A type that does not exist, or exists under a different event, is reported as not
    // found for this purchase — never as "belongs to someone else", which would confirm
    // another event's inventory.
    const unknown = lines
        .filter((line) => !byId.has(line.ticketTypeId))
        .map((line) => line.ticketTypeId);

    if (unknown.length > 0) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Jenis tiket tidak ditemukan pada event ini.",
            details: { ticketTypeIds: unknown },
        });
    }

    const eventWindow: EventSalesWindow = {
        salesStartAt: event.salesStartAt,
        salesEndAt: event.salesEndAt,
        startAt: event.startAt,
    };

    // ── Price the order from the database (design §17.2) ─────────────────────────
    const priced = lines.map((line) => {
        const type = byId.get(line.ticketTypeId) as PurchasableTicketType;

        assertPurchasable(type, line.quantity, eventWindow, now);

        const unitPrice = new Prisma.Decimal(type.price);
        const lineSubtotal = roundToRupiah(unitPrice.mul(line.quantity));

        return {
            ticketTypeId: type.id,
            name: type.name,
            quantity: line.quantity,
            unitPrice,
            lineSubtotal,
            currency: type.currency,
        };
    });

    const subtotal = priced.reduce(
        (sum, line) => sum.add(line.lineSubtotal),
        new Prisma.Decimal(0)
    );

    // §17.2 for MVP, with every undecided component at its documented value:
    //   discount   = 0      (coupons are post-MVP)
    //   platformFee= 0      (D-11: "Ship 0 (no fee) until configured — never a silent default")
    //   picFeeTotal= 0 for a non-PIC order; for a PIC order the referral resolver sets it
    //                inside the transaction and it is absorbed by the organizer (D-23),
    //                so the buyer's `total` is unchanged by its presence.
    //   gatewayFee = null   (provider-reported post-settlement, §12.1; never assumed)
    //   total      = grossAfterDisc + passToBuyer fees = subtotal
    //   organizerNetAmount = total − platformFee − picFeeTotal
    // Because the fee values are zero, D-22/D-23's pass-to-buyer-vs-absorbed choice has
    // no observable effect at creation; the fields are stored independently (§17.3), so
    // resolving those decisions later is not a migration.
    const discount = new Prisma.Decimal(0);
    const platformFee = new Prisma.Decimal(0);
    const total = subtotal.sub(discount);
    // Reassigned inside the transaction if the referral resolves to a real PIC fee.
    let picFeeTotal = new Prisma.Decimal(0);
    let organizerNetAmount = total;

    // Single-currency MVP (§36.5). All rows default to IDR and no client input can set
    // this, so a mismatch can only mean a data problem — refuse rather than mislabel.
    const currencies = new Set(priced.map((line) => line.currency));

    if (currencies.size > 1) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
            message: "Mata uang tiket tidak seragam.",
            details: { reason: "MIXED_CURRENCY" },
        });
    }

    const currency = priced[0]?.currency ?? "IDR";

    // TTL (design §11.4, LOCKED): one TTL per order, applied to every reservation and to
    // the order's own payment window.
    const ttlMinutes = await resolveReservationTtlMinutes();
    const expiresAt = computeExpiresAt(now, ttlMinutes);
    const keyExpiresAt = computeIdempotencyExpiresAt(now);

    // ── Create everything, or nothing ────────────────────────────────────────────
    let orderId: string | null = null;

    // A `orderNumber` collision rolls the whole transaction back — including the
    // idempotency key row — so retrying with a fresh number is safe and cannot leave a
    // half-recorded key. Bounded, so a pathological failure cannot loop.
    for (
        let attempt = 0;
        attempt < CHECKOUT_MAX_ATTEMPTS && orderId === null;
        attempt += 1
    ) {
        // Generated out here so the SAME number can be written into both
        // `EventOrder.orderNumber` and the key's `responseRef` inside one transaction.
        // Recording it afterwards would leave a window in which the key reads COMPLETED
        // with no order to return (§30.2).
        const orderNumber = generateOrderNumber(now);

        try {
            orderId = await prisma.$transaction(
                async (tx) => {
                    // §30.1 #1 + §30.2: the key row is written in the SAME transaction as
                    // the order. If this insert loses the race, the P2002 aborts the
                    // transaction and nothing is charged or reserved twice.
                    const keyRow = await tx.idempotencyKey.create({
                        data: {
                            userId: actor.userId,
                            scope: IDEMPOTENCY_SCOPE_CHECKOUT,
                            key: idempotencyKey,
                            requestHash,
                            status: "IN_PROGRESS",
                            expiresAt: keyExpiresAt,
                        },
                        select: { id: true },
                    });

                    // ── PIC attribution (vertical slice) ─────────────────────────────
                    // Resolve the `?pic=`/shareToken into money intent. Read-only, inside
                    // this same transaction, and FAIL-CLOSED: `null` means the sale simply
                    // continues as a normal no-PIC order. The order create below persists
                    // every snapshot the resolver returns, so settlement can REPLAY the
                    // EARNED fee rows instead of recomputing them under a possibly-changed
                    // rate (design §15.1 / D-23).
                    const referral = await resolveReferralAtCheckout(
                        {
                            shareToken: request.shareToken,
                            eventId: event.id,
                            orderSubtotal: subtotal,
                            discount,
                            lines: priced.map((line) => ({
                                ticketTypeId: line.ticketTypeId,
                                quantity: line.quantity,
                                lineSubtotal: line.lineSubtotal,
                            })),
                            buyerUserId: actor.userId,
                        },
                        tx
                    );

                    picFeeTotal = referral ? referral.picFeeTotal : new Prisma.Decimal(0);
                    // D-23: the organizer ABSORBS the PIC fee — the buyer's `total` is
                    // untouched, the organizer's net is net-of-PIC-fee.
                    organizerNetAmount = total.sub(picFeeTotal);

                    const order = await tx.eventOrder.create({
                        data: {
                            orderNumber,
                            organizerId: event.organizerId,
                            eventId: event.id,
                            userId: actor.userId,
                            buyerName: request.buyerName,
                            buyerEmail: request.buyerEmail,
                            buyerPhone: request.buyerPhone,
                            // `status`/`paymentStatus` come from the schema defaults:
                            // PENDING_PAYMENT / UNPAID (design §12.2 / §13.1).
                            subtotal: roundToRupiah(subtotal),
                            discount,
                            platformFee,
                            picFeeTotal: roundToRupiah(picFeeTotal),
                            total: roundToRupiah(total),
                            organizerNetAmount: roundToRupiah(organizerNetAmount),
                            currency,
                            expiresAt,
                            note: null,
                            picProfileId: referral?.picProfileId ?? null,
                        },
                        select: { id: true },
                    });

                    // The one-to-one attribution row (orderId UNIQUE) — the structural
                    // "duplicate attribution impossible" guarantee (design §14.6). Written
                    // in the same transaction as the order, so an order cannot exist with
                    // a fee snapshot but no attribution (or vice versa).
                    if (referral) {
                        await tx.pICAttribution.create({
                            data: {
                                orderId: order.id,
                                organizerId: event.organizerId,
                                eventId: event.id,
                                picProfileId: referral.picProfileId,
                                source: "PIC_LINK",
                                method: "LINK",
                                shareToken: request.shareToken ?? null,
                                // First and last touch are the same moment for V1: the link
                                // is only ever observable at checkout time (D-01 future).
                                firstTouchAt: now,
                                lastTouchAt: now,
                                selfReferral: referral.selfReferral,
                            },
                        });
                    }

                    const referralLineByType = new Map(
                        (referral?.lines ?? []).map((line) => [
                            line.ticketTypeId,
                            line,
                        ])
                    );

                    // `priced` is already sorted by ticketTypeId — §11.3's deterministic
                    // lock order, which is what stops two multi-line checkouts
                    // deadlocking against each other.
                    for (const line of priced) {
                        const held = await reserveQuota(
                            line.ticketTypeId,
                            line.quantity,
                            tx
                        );

                        if (!held.ok) {
                            // Throwing rolls back every earlier line's CAS, so a partial
                            // multi-line reservation is impossible and no other
                            // reservation is left orphaned (§11.3, brief §19).
                            if (held.reason === "SOLD_OUT") {
                                throw new AppError(ERROR_CODES.SOLD_OUT, {
                                    message: "Tiket sudah habis.",
                                    details: {
                                        ticketTypeId: held.ticketTypeId,
                                        quantity: held.quantity,
                                        available: held.available,
                                    },
                                });
                            }

                            if (held.reason === "INACTIVE") {
                                throw new AppError(ERROR_CODES.SALES_NOT_OPEN, {
                                    message: "Jenis tiket ini sedang tidak dijual.",
                                    details: {
                                        ticketTypeId: held.ticketTypeId,
                                        reason: "INACTIVE",
                                    },
                                });
                            }

                            throw new AppError(ERROR_CODES.NOT_FOUND, {
                                message: "Jenis tiket tidak ditemukan.",
                                details: { ticketTypeId: held.ticketTypeId },
                            });
                        }

                        const referralLine =
                            referral === null ? null : referralLineByType.get(line.ticketTypeId);

                        await tx.eventOrderItem.create({
                            data: {
                                orderId: order.id,
                                ticketTypeId: line.ticketTypeId,
                                // The historical snapshot (§12.1/§16): a later price edit
                                // cannot change this order's value.
                                nameSnapshot: line.name,
                                priceSnapshot: line.unitPrice,
                                quantity: line.quantity,
                                subtotal: line.lineSubtotal,
                                // PIC fee snapshots (frozen at checkout; §15.1). NULL for
                                // a non-PIC order, which is byte-identical to the pre-PIC
                                // shape. `feeConfig` fields repeat per item because each
                                // line's fee is per-line; the config is order-wide.
                                ...(referral
                                    ? {
                                          picFeeAmount: roundToRupiah(
                                              referralLine?.fee ?? new Prisma.Decimal(0)
                                          ),
                                          picFeeType: referral.feeConfig.feeType,
                                          basisType: referral.feeConfig.basisType,
                                          rateBp: referral.feeConfig.rateBp,
                                          fixedAmount: referral.feeConfig.fixedAmount,
                                          basisAmount: roundToRupiah(
                                              referralLine?.basisAmount ??
                                                  new Prisma.Decimal(0)
                                          ),
                                      }
                                    : {}),
                            },
                        });

                        await createReservation(tx, {
                            orderId: order.id,
                            ticketTypeId: line.ticketTypeId,
                            eventId: event.id,
                            quantity: line.quantity,
                            expiresAt,
                        });
                    }

                    // §30.2: `responseRef` is the created resource id, so a replay can
                    // return the existing order without guessing. Written in this same
                    // transaction as everything else, so the key is never COMPLETED
                    // without an order to point at.
                    await tx.idempotencyKey.update({
                        where: { id: keyRow.id },
                        data: { status: "COMPLETED", responseRef: orderNumber },
                    });

                    return order.id;
                },
                { timeout: 20_000 }
            );
        } catch (error) {
            if (isOrderNumberCollision(error)) {
                orderId = null;
                continue;
            }

            if (isIdempotencyCollision(error)) {
                const replay = await resolveIdempotentReplay({
                    userId: actor.userId,
                    key: idempotencyKey,
                    requestHash,
                });

                if (replay) {
                    return { payload: replay, replayed: true };
                }

                // The winner's transaction rolled back after all, so the key row is gone
                // and this request may proceed normally on the next attempt.
                orderId = null;
                continue;
            }

            // Lost the race for the ticket-type row (not for a seat). The transaction is
            // fully rolled back, so re-running it re-checks availability from scratch —
            // it will succeed if seats remain and report SOLD_OUT if they do not.
            if (isTransientContention(error)) {
                await contentionBackoff(attempt);
                continue;
            }

            throw error;
        }
    }

    if (orderId === null) {
        throw new AppError(ERROR_CODES.CONFLICT, {
            message: "Permintaan checkout tidak dapat diselesaikan. Silakan coba lagi.",
            details: { reason: "CHECKOUT_CONTENTION" },
        });
    }

    const row = await prisma.eventOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: ORDER_PAYLOAD_SELECT,
    });

    // Audited AFTER the transaction commits, so the trail records only orders that
    // actually exist — a rolled-back attempt leaves no audit row claiming a purchase.
    // Replays return earlier and are therefore not double-audited (design §30.2: a replay
    // has no side effects).
    await writeTicketingAudit({
        action: "order.create",
        actor,
        // The actor is a customer with no tenant; the ORDER's organizer is the tenant the
        // row belongs to. These are two different columns on purpose (design §32.2).
        actorOrganizerId: null,
        organizerId: event.organizerId,
        entityType: "EventOrder",
        entityRef: row.orderNumber,
        description: `Pesanan tiket dibuat (${lines.length} jenis tiket).`,
        // Deliberately NO buyer name / email / phone: the order row already holds the
        // contact snapshot, and brief §27 forbids unnecessary buyer PII in audit payloads.
        afterState: {
            orderNumber: row.orderNumber,
            eventId: event.id,
            ticketTypeIds: lines.map((line) => line.ticketTypeId),
            quantities: lines.map((line) => line.quantity),
            currency,
            subtotal: moneyString(subtotal),
            total: moneyString(total),
            picFeeTotal: moneyString(picFeeTotal),
            organizerNetAmount: moneyString(organizerNetAmount),
            status: "PENDING_PAYMENT",
            expiresAt: expiresAt.toISOString(),
            idempotencyKey,
        },
        request: params.httpRequest,
    });

    return { payload: await buildOrderPayload(row), replayed: false };
}

/**
 * Design §30.2's duplicate-key resolution.
 *
 *   same key + same `requestHash`      → return the existing order (no side effects)
 *   same key + DIFFERENT `requestHash` → `409 CONFLICT` (the client reused a key for a
 *                                        different payload; hiding that would hide a bug)
 *   still `IN_PROGRESS`                → `409 CONFLICT`, because a concurrent identical
 *                                        request is mid-flight and there is nothing to
 *                                        return yet
 *
 * `FAILED` is never observed in practice: because the key row is written inside the same
 * transaction as the order, a failed attempt rolls the key back with it, which is
 * precisely what makes a failed checkout retryable.
 */
async function resolveIdempotentReplay(params: {
    userId: string;
    key: string;
    requestHash: string;
}): Promise<OrderPayload | null> {
    const existing = await prisma.idempotencyKey.findUnique({
        where: {
            userId_scope_key: {
                userId: params.userId,
                scope: IDEMPOTENCY_SCOPE_CHECKOUT,
                key: params.key,
            },
        },
        select: { requestHash: true, status: true, responseRef: true },
    });

    if (!existing) {
        return null;
    }

    if (existing.requestHash !== params.requestHash) {
        throw new AppError(ERROR_CODES.CONFLICT, {
            message:
                "Idempotency-Key ini sudah dipakai untuk permintaan yang berbeda.",
            details: { reason: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" },
        });
    }

    if (existing.status !== "COMPLETED" || !existing.responseRef) {
        throw new AppError(ERROR_CODES.CONFLICT, {
            message: "Permintaan checkout yang sama sedang diproses.",
            details: { reason: "IDEMPOTENCY_REQUEST_IN_PROGRESS" },
        });
    }

    // Ownership is part of the lookup, not a check afterwards: the key is scoped to the
    // actor and the order must belong to the actor too.
    const order = await prisma.eventOrder.findFirst({
        where: { orderNumber: existing.responseRef, userId: params.userId },
        select: ORDER_PAYLOAD_SELECT,
    });

    return order ? buildOrderPayload(order) : null;
}
