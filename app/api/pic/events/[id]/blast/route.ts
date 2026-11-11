import type { NextRequest } from "next/server";
import { z } from "zod";

import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import {
    enqueuePicEventBlast,
    getPicBlastRetryRecipients,
    isGoogleDriveShareUrl,
    listPicBlastHistory,
    listPicBlastParticipants,
    requireAssignedPicEvent,
} from "@/lib/pic/blast";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";

export const runtime = "nodejs";

/**
 * ==========================================
 * POST /api/pic/events/[id]/blast
 * ==========================================
 *
 * The PIC's post-event broadcast: submit a Google Drive link, then enqueue it to buyers whose
 * paid tickets were checked in.
 *
 * Contract:
 *   • session (PIC) + `requireSameOrigin` on the mutation;
 *   • JSON and Google Drive URL validation;
 *   • authority from `requireAssignedPicEvent` (ACTIVE PIC + ACTIVE assignment + COMPLETED
 *     event), never from the request;
 *   • the existing notification queue is the only sender — this handler only enqueues;
 *   • an `AdminAuditLog` row records who blasted which event, how many participants and the
 *     delivery outcome counts.
 *
 * The supplied link is included in the WhatsApp message. The server does not fetch the URL;
 * the PIC must grant the intended attendees permission to view it in Google Drive.
 */

const blastSchema = z
    .object({
        blastId: z.string().uuid(),
        sendOnlyUnsent: z.boolean().optional().default(false),
        driveUrl: z
            .string()
            .trim()
            .url("Masukkan tautan Google Drive yang valid.")
            .max(2_048)
            .refine(isGoogleDriveShareUrl, "Gunakan tautan HTTPS dari drive.google.com atau docs.google.com."),
    })
    .strict();

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return handleApi(async () => {
        const scope = await requireAuth();
        const { id: eventId } = await params;
        await requireAssignedPicEvent(scope.userId, eventId);
        return ok(await listPicBlastHistory(eventId));
    });
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();
        const { id: eventId } = await params;

        // Authority before parsing input: an unassigned PIC learns nothing and cannot blast.
        const context = await requireAssignedPicEvent(scope.userId, eventId);

        const body = await request.json().catch(() => null);
        const input = parseOrThrow(blastSchema, body);

        const history = input.sendOnlyUnsent ? await listPicBlastHistory(eventId) : null;
        const participants = input.sendOnlyUnsent && history
            ? {
                  recipients: getPicBlastRetryRecipients(history),
                  eligibleOrders: history.eligibleOrders,
                  scannedOrders: history.scannedOrders,
                  withoutPhone: history.withoutPhone,
                  duplicatePhones: history.duplicatePhones,
              }
            : await listPicBlastParticipants(eventId);

        if (input.sendOnlyUnsent && participants.recipients.length === 0) {
            return ok({
                eligibleRecipients: 0,
                eligibleOrders: participants.eligibleOrders,
                scannedOrders: participants.scannedOrders,
                withoutPhone: participants.withoutPhone,
                duplicatePhones: participants.duplicatePhones,
                enqueued: 0,
                existing: 0,
                failed: 0,
            });
        }

        const delivery = await enqueuePicEventBlast({
            context,
            blastId: input.blastId,
            driveUrl: input.driveUrl,
            recipients: participants.recipients,
        });

        await writeTicketingAudit({
            action: "pic.blast.send",
            actor: scope,
            actorType: "USER",
            organizerId: context.event.organizerId,
            entityType: "Event",
            entityRef: eventId,
            description: `PIC blast pasca-acara untuk event ${context.event.title}`,
            afterState: {
                eventId,
                blastId: input.blastId,
                sendOnlyUnsent: input.sendOnlyUnsent,
                driveHost: new URL(input.driveUrl).hostname,
                recipients: participants.recipients.length,
                eligibleOrders: participants.eligibleOrders,
                enqueued: delivery.enqueued,
                existing: delivery.existing,
                failed: delivery.failed,
                withoutPhone: participants.withoutPhone,
                duplicatePhones: participants.duplicatePhones,
            },
            request,
        });

        return ok({
            eligibleRecipients: participants.recipients.length,
            eligibleOrders: participants.eligibleOrders,
            scannedOrders: participants.scannedOrders,
            withoutPhone: participants.withoutPhone,
            duplicatePhones: participants.duplicatePhones,
            enqueued: delivery.enqueued,
            existing: delivery.existing,
            failed: delivery.failed,
        });
    });
}
