import { Prisma } from "@prisma/client";

import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { prisma } from "@/lib/prisma";
import { isTicketCode } from "@/lib/ticketing/tickets/reference";

import { normalizeEmail, normalizeIndonesianPhone } from "./contacts";
import { enqueueNotification } from "./enqueue";
import { structuredLog, sanitizeErrorMessage } from "./logger";
import { readNotificationStoreContact } from "./store-contact";
import {
    TICKET_ISSUED_TEMPLATE_KEY,
    TICKET_ISSUED_VERSION,
    type TicketIssuedPayload,
} from "./ticket-issued-template";

/**
 * ==========================================
 * TICKET ISSUED — POST-ISSUANCE ENQUEUE
 * ==========================================
 *
 * This runs AFTER `issueTicketsForOrder()` has committed and only when it actually created
 * ticket rows. It never sends, never claims a delivery and never changes ticket state.
 *
 * One order-level business notification is materialised as one row per channel by the
 * existing Phase 1 enqueue contract:
 *
 *     ticket-issued:{orderNumber}:email:v1
 *     ticket-issued:{orderNumber}:whatsapp:v1
 *
 * The public code is `Ticket.ticketCode`; the scanner credential (`qrTokenHash`) is never
 * selected here. The owner chose `code_link`: the template prints public codes and an
 * authenticated wallet link, not a QR image.
 */

export const TICKET_NOTIFICATION_WINDOW_MS = 30 * 60_000;

export type TicketIssuedChannelResult =
    | "created"
    | "existing"
    | "skipped"
    | "failed";

export type TicketIssuedEnqueueResult = {
    orderNumber: string | null;
    eligible: boolean;
    reason?: string;
    email: TicketIssuedChannelResult;
    whatsapp: TicketIssuedChannelResult;
};

export type TicketIssuedOrderRow = {
    id: string;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    paidAt: Date | null;
    userId: string;
    eventId: string;
    organizerId: string;
    buyerEmail: string | null;
    buyerPhone: string | null;
    event: {
        title: string;
        startAt: Date;
        endAt: Date | null;
        timezone: string;
        status: string;
        venue: { name: string; address: string | null; city: string | null } | null;
    };
    tickets: { ticketCode: string }[];
};

export function ticketIssuedIdempotencyKey(
    orderNumber: string,
    channel: "email" | "whatsapp"
): string {
    return `ticket-issued:${orderNumber}:${channel}:${TICKET_ISSUED_VERSION}`;
}

/** The sweep and the issuance hook share this exact boundary. */
export function ticketNotificationWindowEnd(endAt: Date | null): Date | null {
    return endAt
        ? new Date(endAt.getTime() + TICKET_NOTIFICATION_WINDOW_MS)
        : null;
}

/** `endAt` is required: without it the recovery window cannot be proven safely. */
export function isWithinTicketNotificationWindow(
    endAt: Date | null,
    now: Date
): boolean {
    const deadline = ticketNotificationWindowEnd(endAt);

    return deadline !== null && now.getTime() <= deadline.getTime();
}

const TICKET_ORDER_BY: Prisma.TicketOrderByWithRelationInput[] = [
    { orderItemId: "asc" },
    { sequenceNo: "asc" },
];

const ORDER_SELECT = {
    id: true,
    orderNumber: true,
    status: true,
    paymentStatus: true,
    paidAt: true,
    userId: true,
    eventId: true,
    organizerId: true,
    buyerEmail: true,
    buyerPhone: true,
    event: {
        select: {
            title: true,
            startAt: true,
            endAt: true,
            timezone: true,
            status: true,
            venue: { select: { name: true, address: true, city: true } },
        },
    },
    // PUBLIC codes only. `qrTokenHash` is not selected and the raw token is unavailable.
    tickets: {
        where: { status: "ISSUED" },
        select: { ticketCode: true },
        orderBy: TICKET_ORDER_BY,
    },
} as const;

async function loadOrder(orderId: string): Promise<TicketIssuedOrderRow | null> {
    return prisma.eventOrder.findUnique({
        where: { id: orderId },
        select: ORDER_SELECT,
    });
}

function validTicketCodes(
    tickets: readonly { ticketCode: string }[]
): string[] {
    const seen = new Set<string>();
    const codes: string[] = [];

    for (const ticket of tickets) {
        if (isTicketCode(ticket.ticketCode) && !seen.has(ticket.ticketCode)) {
            seen.add(ticket.ticketCode);
            codes.push(ticket.ticketCode);
        }
    }

    return codes;
}

export function buildTicketIssuedPayload(params: {
    order: TicketIssuedOrderRow;
    store: TicketIssuedPayload["store"];
    walletUrl: string | null;
}): TicketIssuedPayload {
    const { order, store, walletUrl } = params;
    const codes = validTicketCodes(order.tickets);

    return {
        version: TICKET_ISSUED_VERSION,
        orderNumber: order.orderNumber,
        event: {
            title: order.event.title,
            startAt: order.event.startAt.toISOString(),
            endAt: order.event.endAt?.toISOString() ?? null,
            timezone: order.event.timezone,
            venueName: order.event.venue?.name ?? null,
            venueAddress: order.event.venue?.address ?? null,
            venueCity: order.event.venue?.city ?? null,
        },
        ticketCount: codes.length,
        tickets: codes.map((ticketCode) => ({ ticketCode })),
        walletUrl,
        store,
    };
}

/** The wallet is authenticated and ownership-scoped; only a trusted configured origin is used. */
export function walletUrlForTicketNotification(
    appOrigin: string | null = null
): string | null {
    const origin = (appOrigin ?? getConfiguredAppOrigin()).trim();

    if (!origin) {
        return null;
    }

    return `${origin.replace(/\/+$/, "")}/ticketing/tickets`;
}

type ChannelPlan = {
    channel: "EMAIL" | "WHATSAPP";
    key: "email" | "whatsapp";
    raw: string | null;
    normalized: string | null;
};

async function enqueueOneChannel(params: {
    order: TicketIssuedOrderRow;
    payload: TicketIssuedPayload;
    plan: ChannelPlan;
}): Promise<TicketIssuedChannelResult> {
    const { order, payload, plan } = params;
    const raw = plan.raw?.trim() ?? "";

    // No address at all: nothing can be queued, and inventing one would be worse than a skip.
    // A non-empty but invalid address is queued and terminally skipped by the worker.
    if (raw.length === 0) {
        return "skipped";
    }

    try {
        const result = await enqueueNotification({
            idempotencyKey: ticketIssuedIdempotencyKey(
                order.orderNumber,
                plan.key
            ),
            channel: plan.channel,
            recipient: plan.normalized ?? raw,
            category: "TICKET",
            recipientType: "CUSTOMER",
            templateKey: TICKET_ISSUED_TEMPLATE_KEY,
            payload: payload as unknown as Record<string, unknown>,
            priority: 20,
            maxAttempts: 3,
            userId: order.userId,
            eventOrderId: order.id,
            ticketId: null,
            eventId: order.eventId,
            organizerId: order.organizerId,
        });

        return result.created ? "created" : "existing";
    } catch (error) {
        structuredLog("error", "notification.ticket_issued.enqueue_failed", {
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

function skipped(
    reason: string,
    orderNumber: string | null = null
): TicketIssuedEnqueueResult {
    return {
        orderNumber,
        eligible: false,
        reason,
        email: "skipped",
        whatsapp: "skipped",
    };
}

/**
 * Enqueue the ticket-issued notification for one order.
 *
 * Non-throwing by contract. Called by the issuance service only after commit and only when
 * `created.length > 0`; the sweep can call it for an order whose post-commit enqueue was lost.
 */
export async function enqueueTicketIssued(
    orderId: string,
    options: { now?: Date; appOrigin?: string | null } = {}
): Promise<TicketIssuedEnqueueResult> {
    try {
        const now = options.now ?? new Date();
        const order = await loadOrder(orderId);

        if (!order) {
            return skipped("ORDER_NOT_FOUND");
        }

        if (
            order.status !== "PAID" ||
            order.paymentStatus !== "PAID" ||
            order.paidAt === null
        ) {
            return skipped("NOT_PAID", order.orderNumber);
        }

        if (order.event.status === "CANCELLED" || order.event.status === "ARCHIVED") {
            return skipped("EVENT_NOT_NOTIFIABLE", order.orderNumber);
        }

        if (!isWithinTicketNotificationWindow(order.event.endAt, now)) {
            return skipped(
                order.event.endAt === null ? "END_AT_UNKNOWN" : "WINDOW_CLOSED",
                order.orderNumber
            );
        }

        if (validTicketCodes(order.tickets).length === 0) {
            return skipped("NO_ISSUED_TICKETS", order.orderNumber);
        }

        const store = await readNotificationStoreContact();
        const walletUrl = walletUrlForTicketNotification(
            options.appOrigin ?? null
        );
        const payload = buildTicketIssuedPayload({ order, store, walletUrl });

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

        const email = await enqueueOneChannel({
            order,
            payload,
            plan: plans[0],
        });
        const whatsapp = await enqueueOneChannel({
            order,
            payload,
            plan: plans[1],
        });

        if (email === "failed" || whatsapp === "failed") {
            structuredLog("warn", "notification.ticket_issued.partial", {
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
    } catch (error) {
        structuredLog("error", "notification.ticket_issued.helper_failed", {
            orderId,
            error: sanitizeErrorMessage(error),
        });

        return skipped("HELPER_FAILED");
    }
}

export type TicketIssuedSweepResult = {
    scanned: number;
    eligible: number;
    emailCreated: number;
    whatsappCreated: number;
    skipped: number;
    failed: number;
};

/**
 * Recover a lost post-commit enqueue without a migration or an outbox table.
 *
 * The idempotency key is the outbox: an order with issued tickets and no ticket-issued row
 * for a channel is an enqueue that did not complete. Per-channel `none` clauses are used so
 * an order with email present and WhatsApp missing is still a candidate.
 *
 * Enqueue-only: it never claims a delivery and never sends.
 */
export async function sweepMissingTicketNotifications(
    options: {
        limit?: number;
        now?: Date;
        minAgeMs?: number;
        /** Narrow to specific orders for targeted operator recovery and deterministic tests. */
        orderIds?: readonly string[];
        appOrigin?: string | null;
    } = {}
): Promise<TicketIssuedSweepResult> {
    const now = options.now ?? new Date();
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
    const minAgeMs = Math.max(0, options.minAgeMs ?? 120_000);
    const cutoff = new Date(now.getTime() - minAgeMs);
    const windowStart = new Date(now.getTime() - TICKET_NOTIFICATION_WINDOW_MS);

    const candidates = await prisma.eventOrder.findMany({
        where: {
            ...(options.orderIds && options.orderIds.length > 0
                ? { id: { in: [...options.orderIds] } }
                : {}),
            status: "PAID",
            paymentStatus: "PAID",
            paidAt: { not: null, lte: cutoff },
            tickets: { some: { status: "ISSUED" } },
            event: {
                status: { notIn: ["CANCELLED", "ARCHIVED"] },
                // `null` endAt is excluded, so an unprovable window is skipped.
                endAt: { gte: windowStart },
            },
            OR: [
                {
                    notifications: {
                        none: {
                            templateKey: TICKET_ISSUED_TEMPLATE_KEY,
                            channel: "email",
                        },
                    },
                },
                {
                    notifications: {
                        none: {
                            templateKey: TICKET_ISSUED_TEMPLATE_KEY,
                            channel: "whatsapp",
                        },
                    },
                },
            ],
        },
        orderBy: [{ paidAt: "asc" }],
        take: limit,
        select: { id: true, orderNumber: true },
    });

    const result: TicketIssuedSweepResult = {
        scanned: candidates.length,
        eligible: 0,
        emailCreated: 0,
        whatsappCreated: 0,
        skipped: 0,
        failed: 0,
    };

    for (const candidate of candidates) {
        const outcome = await enqueueTicketIssued(candidate.id, {
            now,
            appOrigin: options.appOrigin,
        });

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

    structuredLog("info", "notification.ticket_issued.sweep_complete", {
        ...result,
        limit,
        minAgeMs,
    });

    return result;
}
