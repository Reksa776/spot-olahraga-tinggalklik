import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { enqueueNotification } from "./enqueue";
import { normalizeEmail, normalizeIndonesianPhone } from "./contacts";
import { structuredLog, sanitizeErrorMessage } from "./logger";
import {
    PURCHASE_PROOF_TEMPLATE_KEY,
    PURCHASE_PROOF_VERSION,
    type PurchaseProofPayload,
} from "./purchase-proof-template";
import { readNotificationStoreContact } from "./store-contact";

/**
 * ==========================================
 * PURCHASE PROOF — ENQUEUE AND RECOVERY (PHASE 2)
 * ==========================================
 *
 * This is the purchase-proof caller of `enqueueNotification` from business code. It runs AFTER the
 * settlement transaction has committed (`lib/ticketing/payment/settlement.ts`), so a row here
 * describes a purchase that provably exists. It never runs inside the transaction: a
 * notification is a side effect, and the financial transaction must not be able to roll back
 * because a queue insert failed.
 *
 * ── TWO CHANNELS, TWO INDEPENDENT ROWS ────────────────────────────────────────────
 * Email and WhatsApp are enqueued separately, under the owner-approved keys:
 *
 *     purchase-proof:{orderNumber}:email:v1
 *     purchase-proof:{orderNumber}:whatsapp:v1
 *
 * One key per channel is what lets a failed email retry without touching a WhatsApp that
 * already succeeded (and vice versa). `Notification.idempotencyKey @unique` makes a replayed
 * webhook or a second operator reconciliation converge on the existing rows instead of
 * duplicating them.
 *
 * ── ONLY A SETTLED ORDER QUALIFIES ───────────────────────────────────────────────
 * `status = PAID AND paymentStatus = PAID AND paidAt IS NOT NULL` is the durable fingerprint of
 * a successful settlement CAS. `ALREADY_PAID` changed nothing and does not call this function;
 * `LATE_SETTLEMENT` leaves the order `CANCELLED`/`EXPIRED` (only `paymentStatus` becomes PAID),
 * so it is refused here as well. A settled order whose inventory conversion raised an anomaly
 * is still PAID with `fulfilmentBlockedAt` set — the money is real and the buyer is entitled to
 * a receipt, so it is included; ticket issuance remains blocked by the existing rule.
 *
 * ── THIS FUNCTION NEVER THROWS ───────────────────────────────────────────────────
 * A queue insert failure is logged with sanitized metadata and returned as a `failed` channel
 * result. The webhook has already committed the payment; turning a notification failure into a
 * 500 would ask the provider to redeliver a settlement that is already complete.
 *
 * ── CONTACT HANDLING ────────────────────────────────────────────────────────────
 * The recipient stored on the queue row is the NORMALIZED delivery address when it normalizes,
 * and the raw (non-empty) value when it does not. The worker validates again and terminally
 * skips an invalid row, which gives the failure a durable audit row instead of silently
 * dropping the channel. The order's own columns are never modified.
 */

export type PurchaseProofChannelResult =
    | "created"
    | "existing"
    | "skipped"
    | "failed";

export type PurchaseProofEnqueueResult = {
    orderNumber: string | null;
    eligible: boolean;
    reason?: string;
    email: PurchaseProofChannelResult;
    whatsapp: PurchaseProofChannelResult;
};

export type PurchaseProofOrderRow = {
    id: string;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    buyerName: string;
    buyerEmail: string | null;
    buyerPhone: string | null;
    currency: string;
    subtotal: { toFixed(digits: number): string };
    discount: { toFixed(digits: number): string };
    total: { toFixed(digits: number): string };
    paidAt: Date | null;
    createdAt: Date;
    event: {
        title: string;
        startAt: Date;
        endAt: Date | null;
        timezone: string;
        venue: { name: string; address: string | null; city: string | null } | null;
    };
    organizer: { name: string };
    items: {
        nameSnapshot: string;
        priceSnapshot: { toFixed(digits: number): string };
        quantity: number;
        subtotal: { toFixed(digits: number): string };
    }[];
    payments: { method: string; channel: string | null; status: string }[];
    tickets: { ticketCode: string }[];
};

export function purchaseProofIdempotencyKey(
    orderNumber: string,
    channel: "email" | "whatsapp"
): string {
    return `purchase-proof:${orderNumber}:${channel}:${PURCHASE_PROOF_VERSION}`;
}

/**
 * Build the immutable snapshot the template renders from.
 *
 * Pure with respect to the database: it receives the row and the store contact. Money is
 * serialized through `Decimal#toFixed(2)` — the exact stored value — and no current catalogue
 * price is read. The payment method comes from the settled payment row when one exists;
 * otherwise the snapshot records `null` and the receipt says "Tidak tercatat" rather than
 * inventing a method.
 */
export function buildPurchaseProofPayload(params: {
    order: PurchaseProofOrderRow;
    store: PurchaseProofPayload["store"];
}): PurchaseProofPayload {
    const { order, store } = params;
    const paidPayment =
        order.payments.find((payment) => payment.status === "PAID") ??
        order.payments[0] ??
        null;

    return {
        version: PURCHASE_PROOF_VERSION,
        orderNumber: order.orderNumber,
        buyerName: order.buyerName,
        paidAt: (order.paidAt ?? order.createdAt).toISOString(),
        createdAt: order.createdAt.toISOString(),
        currency: order.currency,
        items: order.items.map((item) => ({
            name: item.nameSnapshot,
            quantity: item.quantity,
            unitPrice: item.priceSnapshot.toFixed(2),
            subtotal: item.subtotal.toFixed(2),
        })),
        // The number of LINES, not the number of seats: the template caps how many LINES it
        // prints, so this is what the "… dan N item lainnya" note must count from.
        itemCount: order.items.length,
        subtotal: order.subtotal.toFixed(2),
        discount: order.discount.toFixed(2),
        total: order.total.toFixed(2),
        paymentMethod: paidPayment?.method ?? null,
        paymentChannel: paidPayment?.channel ?? null,
        paymentStatus: order.paymentStatus,
        event: {
            title: order.event.title,
            startAt: order.event.startAt.toISOString(),
            endAt: order.event.endAt?.toISOString() ?? null,
            timezone: order.event.timezone,
            venueName: order.event.venue?.name ?? null,
            venueAddress: order.event.venue?.address ?? null,
            venueCity: order.event.venue?.city ?? null,
        },
        organizerName: order.organizer.name,
        store,
        tickets: order.tickets.map((ticket) => ({
            ticketCode: ticket.ticketCode,
        })),
    };
}

const PROOF_TICKET_ORDER_BY: Prisma.TicketOrderByWithRelationInput[] = [
    { orderItemId: "asc" },
    { sequenceNo: "asc" },
];

const ORDER_SELECT = {
    id: true,
    orderNumber: true,
    status: true,
    paymentStatus: true,
    buyerName: true,
    buyerEmail: true,
    buyerPhone: true,
    currency: true,
    subtotal: true,
    discount: true,
    total: true,
    paidAt: true,
    createdAt: true,
    event: {
        select: {
            title: true,
            startAt: true,
            endAt: true,
            timezone: true,
            venue: { select: { name: true, address: true, city: true } },
        },
    },
    organizer: { select: { name: true } },
    items: {
        select: {
            nameSnapshot: true,
            priceSnapshot: true,
            quantity: true,
            subtotal: true,
        },
        orderBy: { createdAt: "asc" },
    },
    payments: {
        select: { method: true, channel: true, status: true },
        orderBy: { createdAt: "desc" },
        take: 5,
    },
    // PUBLIC codes only. The scanner credential is `Ticket.qrTokenHash`, which is never
    // selected anywhere in this module; only tickets that are actually valid are listed.
    tickets: {
        where: { status: "ISSUED" },
        select: { ticketCode: true },
        orderBy: PROOF_TICKET_ORDER_BY,
    },
} as const;

async function loadOrder(orderId: string): Promise<PurchaseProofOrderRow | null> {
    return prisma.eventOrder.findUnique({
        where: { id: orderId },
        select: ORDER_SELECT,
    });
}

/** A settled order, proven from the committed columns rather than from a caller's claim. */
export function isSettledOrder(order: {
    status: string;
    paymentStatus: string;
    paidAt: Date | null;
}): boolean {
    return (
        order.status === "PAID" &&
        order.paymentStatus === "PAID" &&
        order.paidAt !== null
    );
}

type ChannelPlan = {
    channel: "EMAIL" | "WHATSAPP";
    key: "email" | "whatsapp";
    raw: string | null;
    normalized: string | null;
};

async function enqueueOneChannel(params: {
    order: PurchaseProofOrderRow;
    payload: PurchaseProofPayload;
    plan: ChannelPlan;
}): Promise<PurchaseProofChannelResult> {
    const { order, payload, plan } = params;
    const raw = plan.raw?.trim() ?? "";

    // No address at all: nothing can be queued, and inventing one would be worse than a skip.
    // A NON-EMPTY but invalid address is queued and terminally skipped by the worker, so the
    // failure has a durable row and the sweep will not keep retrying it.
    if (raw.length === 0) {
        return "skipped";
    }

    try {
        const result = await enqueueNotification({
            idempotencyKey: purchaseProofIdempotencyKey(
                order.orderNumber,
                plan.key
            ),
            channel: plan.channel,
            recipient: plan.normalized ?? raw,
            category: "ORDER",
            recipientType: "CUSTOMER",
            templateKey: PURCHASE_PROOF_TEMPLATE_KEY,
            payload: payload as unknown as Record<string, unknown>,
            priority: 10,
            maxAttempts: 3,
            userId: null,
            eventOrderId: order.id,
            eventId: null,
            organizerId: null,
        });

        return result.created ? "created" : "existing";
    } catch (error) {
        structuredLog("error", "notification.purchase_proof.enqueue_failed", {
            orderNumber: order.orderNumber,
            channel: plan.channel,
            errorCode:
                error && typeof error === "object" && "code" in error
                    ? String((error as { code: unknown }).code)
                    : "ENQUEUE_FAILED",
            error: sanitizeErrorMessage(error),
        });

        return "failed";
    }
}

/**
 * Enqueue the purchase proof for one SETTLED order.
 *
 * Safe to call repeatedly and from both settlement paths (webhook and operator reconciliation).
 * Never throws.
 */
export async function enqueuePurchaseProof(
    orderId: string
): Promise<PurchaseProofEnqueueResult> {
    const skipped = (
        reason: string,
        orderNumber: string | null = null
    ): PurchaseProofEnqueueResult => ({
        orderNumber,
        eligible: false,
        reason,
        email: "skipped",
        whatsapp: "skipped",
    });

    let order: PurchaseProofOrderRow | null;

    try {
        order = await loadOrder(orderId);
    } catch (error) {
        structuredLog("error", "notification.purchase_proof.lookup_failed", {
            orderId,
            error: sanitizeErrorMessage(error),
        });

        return skipped("LOOKUP_FAILED");
    }

    if (!order) {
        return skipped("ORDER_NOT_FOUND");
    }

    if (!isSettledOrder(order)) {
        return skipped("NOT_SETTLED", order.orderNumber);
    }

    const store = await readNotificationStoreContact();
    const payload = buildPurchaseProofPayload({ order, store });

    const plans: ChannelPlan[] = [
        {
            channel: "EMAIL",
            key: "email",
            raw: order.buyerEmail,
            normalized: normalizeEmail(order.buyerEmail),
        },
        {
            channel: "WHATSAPP",
            key: "whatsapp",
            raw: order.buyerPhone,
            normalized: normalizeIndonesianPhone(order.buyerPhone),
        },
    ];

    // Sequential on purpose: one channel's failure must not decide the other's outcome, and a
    // two-row fan-out is not worth a parallel write.
    const email = await enqueueOneChannel({ order, payload, plan: plans[0] });
    const whatsapp = await enqueueOneChannel({ order, payload, plan: plans[1] });

    if (email === "failed" || whatsapp === "failed") {
        structuredLog("warn", "notification.purchase_proof.partial", {
            orderNumber: order.orderNumber,
            email,
            whatsapp,
        });
    }

    return {
        orderNumber: order.orderNumber,
        eligible: true,
        email,
        whatsapp,
    };
}

export type PurchaseProofSweepResult = {
    scanned: number;
    eligible: number;
    emailCreated: number;
    whatsappCreated: number;
    skipped: number;
    failed: number;
};

/**
 * Recover orders whose settlement committed but whose enqueue never completed.
 *
 * There is no outbox table in this schema, and Phase 2 may not add one. The idempotency key is
 * the outbox: a paid order that has no `purchase-proof.v1` notification for a channel is, by
 * definition, an enqueue that has not happened. The sweep finds those orders and calls the SAME
 * helper with the SAME keys, so a sweep racing a live enqueue converges on one row per channel.
 *
 * It NEVER sends: it only inserts queue rows. The worker remains the only sender.
 *
 * The `minAgeMs` grace period keeps the sweep out of the way of a settlement still in progress:
 * the normal post-commit call has seconds to finish before recovery considers the order missed.
 */
export async function sweepMissingPurchaseProofs(options: {
    limit?: number;
    now?: Date;
    minAgeMs?: number;
    /** Narrow the sweep to specific orders. Used by tests and by targeted operator recovery. */
    orderIds?: readonly string[];
} = {}): Promise<PurchaseProofSweepResult> {
    const now = options.now ?? new Date();
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
    const minAgeMs = Math.max(0, options.minAgeMs ?? 120_000);
    const cutoff = new Date(now.getTime() - minAgeMs);

    const proofSubject = {
        templateKey: PURCHASE_PROOF_TEMPLATE_KEY,
    };

    const candidates = await prisma.eventOrder.findMany({
        where: {
            ...(options.orderIds && options.orderIds.length > 0
                ? { id: { in: [...options.orderIds] } }
                : {}),
            status: "PAID",
            paymentStatus: "PAID",
            paidAt: { not: null, lte: cutoff },
            OR: [
                {
                    notifications: {
                        none: { ...proofSubject, channel: "email" },
                    },
                },
                {
                    notifications: {
                        none: { ...proofSubject, channel: "whatsapp" },
                    },
                },
            ],
        },
        orderBy: [{ paidAt: "asc" }],
        take: limit,
        select: { id: true, orderNumber: true },
    });

    const result: PurchaseProofSweepResult = {
        scanned: candidates.length,
        eligible: 0,
        emailCreated: 0,
        whatsappCreated: 0,
        skipped: 0,
        failed: 0,
    };

    for (const candidate of candidates) {
        const outcome = await enqueuePurchaseProof(candidate.id);

        if (!outcome.eligible) {
            result.skipped += 1;
            continue;
        }

        result.eligible += 1;

        if (outcome.email === "created") result.emailCreated += 1;
        if (outcome.whatsapp === "created") result.whatsappCreated += 1;
        if (outcome.email === "failed" || outcome.whatsapp === "failed") {
            result.failed += 1;
        }
    }

    structuredLog("info", "notification.purchase_proof.sweep_complete", {
        ...result,
        limit,
        minAgeMs,
    });

    return result;
}
