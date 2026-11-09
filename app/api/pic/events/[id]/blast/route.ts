import type { NextRequest } from "next/server";
import { z } from "zod";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { getAppOrigin } from "@/lib/app-origin";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import {
    hashDocumentToken,
    newDocumentToken,
    storeEventDocument,
} from "@/lib/events/documents/private-document";
import {
    enqueuePicEventBlast,
    listPicBlastParticipants,
    requireAssignedPicEvent,
} from "@/lib/pic/blast";
import { prisma } from "@/lib/prisma";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";

export const runtime = "nodejs";

/**
 * ==========================================
 * POST /api/pic/events/[id]/blast
 * ==========================================
 *
 * The PIC's post-event broadcast: upload one PDF + a message, enqueue it to the event's paid
 * participants over WhatsApp.
 *
 * Contract:
 *   • session (PIC) + `requireSameOrigin` on the mutation;
 *   • Zod validation of the text fields, multipart for the file;
 *   • authority from `requireAssignedPicEvent` (ACTIVE PIC + ACTIVE assignment + COMPLETED
 *     event), never from the request;
 *   • the existing notification queue is the only sender — this handler only enqueues;
 *   • an `AdminAuditLog` row records who blasted which event, how many participants and the
 *     delivery outcome counts.
 *
 * The uploaded file is stored by the existing `storeEventDocument` (PDF magic bytes, ≤10 MB,
 * private directory) and served through the existing tokenised public route. That is what makes
 * the WhatsApp attachment possible without exposing the storage path.
 */

const blastSchema = z
    .object({
        title: z
            .string()
            .trim()
            .min(1, "Judul dokumen wajib diisi.")
            .max(160),
        message: z
            .string()
            .trim()
            .min(1, "Pesan wajib diisi.")
            .max(1_000),
    })
    .strict();

const DOCUMENT_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

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

        // Authority before parsing the upload: an unassigned PIC learns nothing and spends no
        // storage.
        const context = await requireAssignedPicEvent(scope.userId, eventId);

        const form = await request.formData();
        const rawTitle = form.get("title");
        const rawMessage = form.get("message");

        const input = parseOrThrow(blastSchema, {
            title: typeof rawTitle === "string" ? rawTitle : "",
            message: typeof rawMessage === "string" ? rawMessage : "",
        });

        const file = form.get("file");

        if (!(file instanceof File) || file.size === 0) {
            throw AppError.validation("File PDF wajib diunggah.");
        }

        const origin = getAppOrigin(request);

        if (!origin || !origin.startsWith("https://")) {
            throw AppError.conflict("URL aplikasi HTTPS belum dikonfigurasi.");
        }

        let stored: Awaited<ReturnType<typeof storeEventDocument>>;

        try {
            stored = await storeEventDocument(file);
        } catch {
            throw AppError.validation("Dokumen harus berupa PDF maksimal 10MB.");
        }

        const token = newDocumentToken();
        const expiresAt = new Date(Date.now() + DOCUMENT_TTL_MS);

        const document = await prisma.eventDocument.create({
            data: {
                eventId,
                uploadedById: scope.userId,
                title: input.title,
                storageKey: stored.storageKey,
                contentType: "application/pdf",
                sizeBytes: stored.size,
                accessTokenHash: hashDocumentToken(token),
                expiresAt,
            },
            select: { id: true },
        });

        const downloadUrl = `${origin}/api/public/event-documents/${document.id}?token=${encodeURIComponent(token)}`;

        const participants = await listPicBlastParticipants(eventId);

        const delivery = await enqueuePicEventBlast({
            context,
            documentId: document.id,
            title: input.title,
            downloadUrl,
            message: input.message,
            recipients: participants.recipients,
        });

        await writeTicketingAudit({
            action: "pic.blast.send",
            actor: scope,
            actorType: "USER",
            organizerId: context.event.organizerId,
            entityType: "EventDocument",
            entityRef: document.id,
            description: `PIC blast pasca-acara untuk event ${context.event.title}`,
            afterState: {
                eventId,
                documentId: document.id,
                recipients: participants.recipients.length,
                enqueued: delivery.enqueued,
                existing: delivery.existing,
                failed: delivery.failed,
                withoutPhone: participants.withoutPhone,
                duplicatePhones: participants.duplicatePhones,
            },
            request,
        });

        return ok({
            documentId: document.id,
            eligibleRecipients: participants.recipients.length,
            scannedOrders: participants.scannedOrders,
            withoutPhone: participants.withoutPhone,
            duplicatePhones: participants.duplicatePhones,
            enqueued: delivery.enqueued,
            existing: delivery.existing,
            failed: delivery.failed,
            expiresAt: expiresAt.toISOString(),
        });
    });
}
