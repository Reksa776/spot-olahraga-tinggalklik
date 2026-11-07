/**
 * ==========================================
 * PHASE 4 — H-36 WHATSAPP REMINDER (ENQUEUE ONLY)
 * ==========================================
 *
 * The scheduler job that materialises "this event starts in 36 hours" into the EXISTING
 * notification outbox. It does not render, claim, send or retry — the notification worker owns
 * delivery through the configured transport.
 *
 * ── WHY ENQUEUE AT DUE TIME (AND NO NEW COLUMN) ─────────────────────────────────────
 * `Notification.idempotencyKey` is unique. A reminder occurrence is fully identified by
 * (event, ticket, start instant, channel), so the key IS the occurrence record. A job run that
 * is late catches up because the window stays open until the event starts; a job run that
 * repeats is a no-op because the key exists. No `scheduledFor` column is needed.
 *
 * ── THE KEY CARRIES THE START INSTANT ───────────────────────────────────────────────
 * `reminder.h36:{eventId}:{ticketId}:{startAtMs}:{channel}:v1`
 *
 * A reschedule therefore creates a NEW occurrence rather than silently reusing a row that
 * describes the old time. Queued rows for the old instant are retired by reconciliation before
 * the enqueue pass, so a stale time can never be sent.
 *
 * ── CANCELLATION ────────────────────────────────────────────────────────────────────
 * The enqueue query excludes cancelled/archived events. A row queued before a cancellation but
 * not yet sent is retired here, because the generic worker must not learn event rules.
 *
 * ── ELIGIBILITY IS DERIVED, NOT INVENTED ────────────────────────────────────────────
 * Paid order: `status = PAID`, `paymentStatus = PAID`, `paidAt != null` — the same rule the
 * ticket-issued notification already uses. Ticket: `ISSUED`. Event: `PUBLISHED`, not cancelled
 * or archived, `startAt` in `(now, now + 36h]`. Recipient: attendee phone, else holder phone.
 */

import type { NotificationCategory } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { normalizeIndonesianPhone } from "./contacts";
import {
    enqueueNotification,
    MAX_IDEMPOTENCY_KEY_LENGTH,
} from "./enqueue";
import {
    buildH36ReminderPayload,
    H36_REMINDER_TEMPLATE_KEY,
} from "./h36-reminder-template";
import { sanitizeErrorMessage, structuredLog } from "./logger";

/** Exactly thirty-six hours. The product rule, named once. */
export const H36_OFFSET_MS = 36 * 60 * 60 * 1000;

/** Bounded batch: a single tick must not scan an unbounded catalogue. */
export const H36_MAX_EVENTS = 25;
export const H36_MAX_TICKETS_PER_EVENT = 500;
export const H36_MAX_RECONCILE = 200;

export type H36SweepResult = {
    scannedEvents: number;
    scannedTickets: number;
    enqueued: number;
    existing: number;
    skippedNoContact: number;
    skippedInvalidContact: number;
    skippedDuplicateRecipient: number;
    skippedIneligible: number;
    superseded: number;
    failed: number;
};

/** The H-36 target instant for one start time. Pure. */
export function h36ReminderTargetAt(startAt: Date): Date {
    return new Date(startAt.getTime() - H36_OFFSET_MS);
}

/**
 * Is the reminder due?
 *
 * Inclusive at the target (the boundary itself is "36 hours before"), exclusive at the start
 * (a started event is never reminded). Pure, so both boundaries are tested without a clock.
 */
export function isH36ReminderDue(startAt: Date, now: Date): boolean {
    const target = h36ReminderTargetAt(startAt);

    return (
        now.getTime() >= target.getTime() && now.getTime() < startAt.getTime()
    );
}

/**
 * The occurrence key. Includes the start instant so a reschedule is a new occurrence.
 *
 * Throws rather than truncating if an id ever makes the key exceed the outbox limit: a
 * truncated key could collide with another occurrence, which is the one thing this key exists
 * to prevent.
 */
export function h36ReminderIdempotencyKey(input: {
    eventId: string;
    ticketId: string;
    startAt: Date;
    channel?: "whatsapp" | "email";
}): string {
    const channel = input.channel ?? "whatsapp";
    const key = `reminder.h36:${input.eventId}:${input.ticketId}:${input.startAt.getTime()}:${channel}:v1`;

    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw new Error(
            `H-36 reminder key exceeds ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`
        );
    }

    return key;
}

const SUPERSEDE_MESSAGES: Record<string, string> = {
    REMINDER_EVENT_MISSING:
        "Event for this queued reminder no longer exists; the reminder was not sent.",
    REMINDER_EVENT_CANCELLED:
        "Event is cancelled, archived or no longer published; the reminder was not sent.",
    REMINDER_SUPERSEDED:
        "Event start time changed after this reminder was queued; it was replaced by the new occurrence.",
    REMINDER_WINDOW_PASSED:
        "Event already started before this reminder was sent; the window has passed.",
};

type QueuedReminderNotification = {
    payload: string | null;
    event: {
        status: string;
        startAt: Date;
        cancelledAt: Date | null;
        archivedAt: Date | null;
    } | null;
};

function payloadStartAtMs(payloadJson: string | null): number | null {
    if (payloadJson === null || payloadJson.trim().length === 0) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(payloadJson);

        if (typeof parsed !== "object" || parsed === null) {
            return null;
        }

        const event = (parsed as { event?: unknown }).event;

        if (typeof event !== "object" || event === null) {
            return null;
        }

        const startAt = (event as { startAt?: unknown }).startAt;

        if (typeof startAt !== "string") {
            return null;
        }

        const parsedDate = Date.parse(startAt);

        return Number.isNaN(parsedDate) ? null : parsedDate;
    } catch {
        return null;
    }
}

/**
 * Retire queued reminders whose event is gone, cancelled, rescheduled or already started.
 *
 * CAS on `status = QUEUED`: a delivery already claimed or sent is never rewritten. Returns the
 * number actually retired.
 */
async function reconcileQueuedReminders(now: Date): Promise<number> {
    const queued = await prisma.notificationDelivery.findMany({
        where: {
            status: "QUEUED",
            channel: "WHATSAPP",
            notification: { templateKey: H36_REMINDER_TEMPLATE_KEY },
        },
        orderBy: [{ queuedAt: "asc" }],
        take: H36_MAX_RECONCILE,
        select: {
            id: true,
            notification: {
                select: {
                    payload: true,
                    event: {
                        select: {
                            status: true,
                            startAt: true,
                            cancelledAt: true,
                            archivedAt: true,
                        },
                    },
                },
            },
        },
    });

    let retired = 0;

    for (const row of queued) {
        const notification: QueuedReminderNotification = row.notification;
        const event = notification.event;
        const payloadStart = payloadStartAtMs(notification.payload);

        let code: string | null = null;

        if (!event) {
            code = "REMINDER_EVENT_MISSING";
        } else if (
            event.cancelledAt !== null ||
            event.archivedAt !== null ||
            event.status !== "PUBLISHED"
        ) {
            code = "REMINDER_EVENT_CANCELLED";
        } else if (payloadStart === null || event.startAt.getTime() !== payloadStart) {
            code = "REMINDER_SUPERSEDED";
        } else if (event.startAt.getTime() <= now.getTime()) {
            code = "REMINDER_WINDOW_PASSED";
        }

        if (code === null) {
            continue;
        }

        const update = await prisma.notificationDelivery.updateMany({
            where: { id: row.id, status: "QUEUED" },
            data: {
                status: "SKIPPED",
                errorCode: code,
                errorMessage: SUPERSEDE_MESSAGES[code],
                nextRetryAt: null,
            },
        });

        retired += update.count;
    }

    return retired;
}

type ReminderTicket = {
    id: string;
    orderId: string;
    holderUserId: string | null;
    attendeePhone: string | null;
    holder: { phone: string | null } | null;
};

type ReminderEvent = {
    id: string;
    title: string;
    startAt: Date;
    timezone: string;
    organizerId: string;
    venue: { name: string; address: string | null; city: string | null } | null;
    tickets: ReminderTicket[];
};

/**
 * Enqueue every due H-36 reminder for the current tick.
 *
 * Non-throwing per ticket; a database failure still propagates so the leased job records a
 * failed run instead of pretending it completed.
 */
export async function runH36ReminderSweep(
    options: { now?: Date; maxEvents?: number } = {}
): Promise<H36SweepResult> {
    const now = options.now ?? new Date();
    const maxEvents = Math.min(
        100,
        Math.max(1, Math.trunc(options.maxEvents ?? H36_MAX_EVENTS))
    );
    const horizon = new Date(now.getTime() + H36_OFFSET_MS);

    const result: H36SweepResult = {
        scannedEvents: 0,
        scannedTickets: 0,
        enqueued: 0,
        existing: 0,
        skippedNoContact: 0,
        skippedInvalidContact: 0,
        skippedDuplicateRecipient: 0,
        skippedIneligible: 0,
        superseded: 0,
        failed: 0,
    };

    result.superseded = await reconcileQueuedReminders(now);

    const events: ReminderEvent[] = await prisma.event.findMany({
        where: {
            status: "PUBLISHED",
            cancelledAt: null,
            archivedAt: null,
            // Due at target, not yet started: `now >= startAt - 36h` ⇔ `startAt <= now + 36h`.
            startAt: { gt: now, lte: horizon },
        },
        orderBy: [{ startAt: "asc" }],
        take: maxEvents,
        select: {
            id: true,
            title: true,
            startAt: true,
            timezone: true,
            organizerId: true,
            venue: { select: { name: true, address: true, city: true } },
            tickets: {
                where: {
                    status: "ISSUED",
                    order: {
                        status: "PAID",
                        paymentStatus: "PAID",
                        paidAt: { not: null },
                    },
                },
                take: H36_MAX_TICKETS_PER_EVENT,
                orderBy: [{ createdAt: "asc" }],
                select: {
                    id: true,
                    orderId: true,
                    holderUserId: true,
                    attendeePhone: true,
                    holder: { select: { phone: true } },
                },
            },
        },
    });

    result.scannedEvents = events.length;

    for (const event of events) {
        // Defence in depth: the query already enforces the window, but the rule lives in one
        // tested predicate so a future query edit cannot silently widen it.
        if (!isH36ReminderDue(event.startAt, now)) {
            result.skippedIneligible += event.tickets.length;
            continue;
        }

        result.scannedTickets += event.tickets.length;

        // One message per phone per event: two tickets held by the same attendee are two
        // occurrence keys but one human. The first ticket in createdAt order owns the send.
        const seenRecipients = new Set<string>();

        const payload = buildH36ReminderPayload({
            event: {
                title: event.title,
                startAt: event.startAt,
                timezone: event.timezone,
                venue: event.venue,
            },
        });

        if (!payload) {
            // Invalid instant/zone/title: refuse to compose a message that could state a
            // wrong time. Counted, not guessed.
            result.skippedIneligible += event.tickets.length;
            continue;
        }

        for (const ticket of event.tickets) {
            const rawPhone =
                ticket.attendeePhone?.trim() ?? ticket.holder?.phone?.trim() ?? "";

            if (rawPhone.length === 0) {
                result.skippedNoContact += 1;
                continue;
            }

            const recipient = normalizeIndonesianPhone(rawPhone);

            if (!recipient) {
                result.skippedInvalidContact += 1;
                continue;
            }

            if (seenRecipients.has(recipient)) {
                result.skippedDuplicateRecipient += 1;
                continue;
            }

            seenRecipients.add(recipient);

            try {
                const enqueued = await enqueueNotification({
                    idempotencyKey: h36ReminderIdempotencyKey({
                        eventId: event.id,
                        ticketId: ticket.id,
                        startAt: event.startAt,
                    }),
                    channel: "WHATSAPP",
                    recipient,
                    category: "TICKET" as NotificationCategory,
                    recipientType: "CUSTOMER",
                    templateKey: H36_REMINDER_TEMPLATE_KEY,
                    payload: payload as unknown as Record<string, unknown>,
                    priority: 30,
                    maxAttempts: 3,
                    userId: ticket.holderUserId,
                    eventOrderId: ticket.orderId,
                    ticketId: ticket.id,
                    eventId: event.id,
                    organizerId: event.organizerId,
                });

                if (enqueued.created) {
                    result.enqueued += 1;
                } else {
                    result.existing += 1;
                }
            } catch (error) {
                result.failed += 1;

                // Never log the recipient: the queue row already holds it, and a log is a
                // second, less protected copy of a phone number.
                structuredLog("error", "notification.h36.enqueue_failed", {
                    eventId: event.id,
                    ticketId: ticket.id,
                    errorCode:
                        error && typeof error === "object" && "code" in error
                            ? String((error as { code: unknown }).code)
                            : "ENQUEUE_FAILED",
                    error: sanitizeErrorMessage(error),
                });
            }
        }
    }

    structuredLog("info", "notification.h36.sweep_complete", {
        ...result,
        maxEvents,
    });

    return result;
}
