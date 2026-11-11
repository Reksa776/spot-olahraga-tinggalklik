import type { TicketStatus } from "@prisma/client";

import { AppError } from "@/lib/api/errors";
import { normalizeIndonesianPhone } from "@/lib/notifications/contacts";
import { enqueueNotification } from "@/lib/notifications/enqueue";
import { POST_EVENT_DOCUMENT_TEMPLATE_KEY } from "@/lib/notifications/post-event-document-template";
import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * PIC POST-EVENT BLAST
 * ==========================================
 *
 * The service behind `POST /api/pic/events/[eventId]/blast`. It is NOT a new delivery system:
 * every recipient becomes one ordinary `Notification` + `NotificationDelivery` row through the
 * existing `enqueueNotification`, and the existing worker sends it through the existing
 * Baileys gateway. That is what keeps the daily cap, the per-send delay, the retry backoff and
 * the gateway ledger in force for a blast.
 *
 * ── WHO MAY BLAST ───────────────────────────────────────────────────────────────
 * The session user's own ACTIVE `PICProfile` plus an ACTIVE, non-revoked `PICEventAssignment`
 * for the exact event. Attribution (`PICAttribution`) is per ORDER, not per event, so it cannot
 * answer "may this PIC blast this event"; using it would also grant the capability to a PIC who
 * referred a single sale without being responsible for the event. Assignment is the correct,
 * already-established ownership rule (the same one the PIC scanner uses).
 *
 * ── WHO RECEIVES IT ─────────────────────────────────────────────────────────────
 * Buyers of PAID orders on the event that have at least one active ISSUED/CHECKED_IN ticket.
 * Check-in is not required. VOID and REFUNDED tickets are excluded. The WhatsApp number
 * entered on the order at checkout is used; a profile phone is never substituted.
 * Numbers are normalized to `62…`; an order without a valid mobile is counted and skipped.
 * Duplicate numbers receive one message.
 *
 * ── RATE ────────────────────────────────────────────────────────────────────────
 * Enqueueing is a local INSERT and is capped at `MAX_BLAST_RECIPIENTS`. The actual pacing is
 * the worker's single-socket cadence (`WHATSAPP_SEND_DELAY_MS`), so a blast cannot exceed one
 * message at a time and is subject to the daily cap. No sleep is added to the request handler:
 * a 500-recipient blast must not hold an HTTP connection for minutes.
 */

/** One request may enqueue this many recipients. */
export const MAX_BLAST_RECIPIENTS = 500;

/** Active paid tickets qualify whether or not the attendee has checked in. */
const PARTICIPANT_TICKET_STATUSES: TicketStatus[] = ["ISSUED", "CHECKED_IN"];

/** Accept only secure Google Drive or Google Docs share URLs; the server never fetches them. */
export function isGoogleDriveShareUrl(value: string): boolean {
    try {
        const url = new URL(value);
        const hasResourceId =
            /\/(?:file|document|spreadsheets|presentation|forms|drawings)\/d\/[^/]+/.test(
                url.pathname
            ) ||
            /\/drive\/(?:u\/\d+\/)?folders\/[^/]+/.test(url.pathname) ||
            (["/open", "/uc"].includes(url.pathname) &&
                Boolean(url.searchParams.get("id")));

        return (
            url.protocol === "https:" &&
            (url.hostname === "drive.google.com" ||
                url.hostname === "docs.google.com") &&
            url.port.length === 0 &&
            url.username.length === 0 &&
            url.password.length === 0 &&
            hasResourceId
        );
    } catch {
        return false;
    }
}

export type PicBlastContext = {
    profileId: string;
    event: {
        id: string;
        title: string;
        status: string;
        organizerId: string;
    };
};

/** Resolve the PIC's authority for one event, or throw a masked 404. */
export async function requireAssignedPicEvent(
    userId: string,
    eventId: string
): Promise<PicBlastContext> {
    const profile = await prisma.pICProfile.findUnique({
        where: { userId },
        select: { id: true, status: true },
    });

    if (!profile || profile.status !== "ACTIVE") {
        throw AppError.notFound();
    }

    const assignment = await prisma.pICEventAssignment.findUnique({
        where: {
            picProfileId_eventId: {
                picProfileId: profile.id,
                eventId,
            },
        },
        select: { isActive: true, revokedAt: true },
    });

    if (!assignment || !assignment.isActive || assignment.revokedAt !== null) {
        // Same masking as the scanner: an unassigned event is indistinguishable from a
        // non-existent one.
        throw AppError.notFound();
    }

    const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { id: true, title: true, status: true, organizerId: true },
    });

    if (!event) {
        throw AppError.notFound();
    }

    if (event.status !== "COMPLETED") {
        throw AppError.conflict(
            "Blast pasca-acara hanya dapat dikirim setelah acara selesai."
        );
    }

    return { profileId: profile.id, event };
}

export type PicBlastRecipient = {
    orderId: string;
    orderNumber: string;
    buyerName: string;
    phone: string;
};

export type PicBlastParticipantResult = {
    recipients: PicBlastRecipient[];
    scannedOrders: number;
    /**
     * Every PAID order on the event that has an ISSUED/CHECKED_IN ticket, before the
     * `MAX_BLAST_RECIPIENTS` window. The list itself is bounded, so `recipients.length`
     * alone cannot tell the page that more participants exist.
     */
    eligibleOrders: number;
    /** True when the eligible set is larger than the window this call returned. */
    hasMore: boolean;
    withoutPhone: number;
    duplicatePhones: number;
};

/**
 * Resolve the participants of one event. Read-only, bounded, and de-duplicated by phone.
 */
export async function listPicBlastParticipants(
    eventId: string,
    limit: number = MAX_BLAST_RECIPIENTS
): Promise<PicBlastParticipantResult> {
    const take = Math.min(
        Math.max(Math.trunc(limit), 1),
        MAX_BLAST_RECIPIENTS
    );

    const where = {
        eventId,
        status: "PAID" as const,
        paymentStatus: "PAID" as const,
        tickets: { some: { status: { in: PARTICIPANT_TICKET_STATUSES } } },
    };

    const [orders, eligibleOrders] = await Promise.all([
        prisma.eventOrder.findMany({
            where,
            orderBy: [{ paidAt: "asc" }],
            take,
            select: {
                id: true,
                orderNumber: true,
                buyerName: true,
                buyerPhone: true,
            },
        }),
        // A count, not a second page: it only decides whether the form shows the
        // "more than the window" warning. It reads no recipient data.
        prisma.eventOrder.count({ where }),
    ]);

    const seen = new Set<string>();
    const recipients: PicBlastRecipient[] = [];
    let withoutPhone = 0;
    let duplicatePhones = 0;

    for (const order of orders) {
        const raw = order.buyerPhone?.trim() || "";
        const phone = normalizeIndonesianPhone(raw);

        if (!phone) {
            withoutPhone += 1;
            continue;
        }

        if (seen.has(phone)) {
            duplicatePhones += 1;
            continue;
        }

        seen.add(phone);
        recipients.push({
            orderId: order.id,
            orderNumber: order.orderNumber,
            buyerName: order.buyerName,
            phone,
        });
    }

    return {
        recipients,
        scannedOrders: orders.length,
        eligibleOrders,
        hasMore: eligibleOrders > take,
        withoutPhone,
        duplicatePhones,
    };
}

export type PicBlastEnqueueResult = {
    enqueued: number;
    existing: number;
    failed: number;
};

/**
 * Enqueue one WhatsApp notification per eligible ticket buyer, idempotently.
 *
 * Every deliberate blast has its own UUID. Retrying the same HTTP operation with that UUID is
 * idempotent; an explicit resend uses a fresh UUID and can reuse the same Drive link.
 */
export async function enqueuePicEventBlast(input: {
    context: PicBlastContext;
    blastId: string;
    driveUrl: string;
    recipients: readonly PicBlastRecipient[];
}): Promise<PicBlastEnqueueResult> {
    let enqueued = 0;
    let existing = 0;
    let failed = 0;

    for (const recipient of input.recipients) {
        try {
            const result = await enqueueNotification({
                idempotencyKey: `pic-blast:${input.blastId}:${recipient.orderId}:whatsapp:v1`,
                channel: "WHATSAPP",
                recipient: recipient.phone,
                category: "SYSTEM",
                recipientType: "CUSTOMER",
                templateKey: POST_EVENT_DOCUMENT_TEMPLATE_KEY,
                payload: {
                    title: "Dokumen pasca-acara",
                    eventTitle: input.context.event.title,
                    driveUrl: input.driveUrl,
                },
                priority: 40,
                maxAttempts: 3,
                eventOrderId: recipient.orderId,
                eventId: input.context.event.id,
                organizerId: input.context.event.organizerId,
                picProfileId: input.context.profileId,
            });

            if (result.created) {
                enqueued += 1;
            } else {
                existing += 1;
            }
        } catch {
            failed += 1;
        }
    }

    return { enqueued, existing, failed };
}
