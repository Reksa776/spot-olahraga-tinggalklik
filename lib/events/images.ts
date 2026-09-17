import { AppError } from "@/lib/api/errors";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import {
    MAX_EVENT_IMAGE_BYTES,
    deleteStoredEventImage,
    eventImageFileNameFromUrl,
    processAndStoreEventImage,
} from "@/lib/images/process";
import { prisma } from "@/lib/prisma";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";

import { requireEventAccess } from "./access";

/**
 * ==========================================
 * EVENT IMAGE SERVICE (design §10.4, decision D-55)
 * ==========================================
 *
 * Uses the `event.banner.upload` permission from the Phase 3 vocabulary, so image
 * management is a distinct capability rather than a side effect of `event.write`.
 *
 * The pipeline order is fixed (brief §31) and is enforced by delegating the whole
 * validate/process/store step to `processAndStoreEventImage`: the bytes written to
 * disk are the stripped output, and the original is never persisted anywhere. This
 * module never writes a file itself.
 */

const IMAGE_SELECT = {
    id: true,
    eventId: true,
    url: true,
    altText: true,
    sortOrder: true,
    createdAt: true,
} as const;

/** Maximum images per event, so one event cannot fill the upload volume. */
export const MAX_IMAGES_PER_EVENT = 10;

export async function listEventImages(
    scope: AuthzScope,
    eventId: string
) {
    const { event } = await requireEventAccess(eventId, PERMISSIONS.EVENT_READ);

    const items = await prisma.eventImage.findMany({
        where: { eventId: event.id },
        select: IMAGE_SELECT,
        orderBy: { sortOrder: "asc" },
    });

    return { items, maxImages: MAX_IMAGES_PER_EVENT };
}

/**
 * Validate, strip and attach one image.
 *
 * `processing` for the file happens through the shared pipeline, so this function
 * cannot accidentally bypass the EXIF strip: there is no code path here that writes
 * bytes to storage.
 */
export async function addEventImage(
    scope: AuthzScope,
    eventId: string,
    file: File,
    options: { altText?: string | null; request?: Request } = {}
) {
    const { scope: authorized, event } = await requireEventAccess(
        eventId,
        PERMISSIONS.EVENT_BANNER_UPLOAD
    );

    if (file instanceof File && file.size > MAX_EVENT_IMAGE_BYTES) {
        throw AppError.validation("Ukuran gambar maksimal 5MB.");
    }

    const existing = await prisma.eventImage.findMany({
        where: { eventId: event.id },
        select: { id: true, sortOrder: true },
        orderBy: { sortOrder: "desc" },
        take: 1,
    });

    const imageCount = await prisma.eventImage.count({
        where: { eventId: event.id },
    });

    if (imageCount >= MAX_IMAGES_PER_EVENT) {
        throw AppError.conflict(
            `Maksimal ${MAX_IMAGES_PER_EVENT} gambar per event.`
        );
    }

    // Only processed bytes are produced here; nothing is written before this returns.
    const stored = await processAndStoreEventImage(file);

    const nextSortOrder =
        existing.length > 0 ? existing[0].sortOrder + 1 : 0;

    const image = await prisma.eventImage.create({
        data: {
            eventId: event.id,
            url: stored.url,
            altText: options.altText ?? null,
            sortOrder: nextSortOrder,
        },
        select: IMAGE_SELECT,
    });

    // The audit row records that metadata was removed, which is the evidence trail for
    // D-55: it shows the pipeline ran and what it discarded.
    await writeTicketingAudit({
        action: "event.image.add",
        actor: authorized,
        actorOrganizerId: event.organizerId,
        organizerId: event.organizerId,
        entityType: "EventImage",
        entityRef: image.id,
        description: `Gambar event ditambahkan (metadata dihapus: ${
            stored.removedMetadata.join(", ") || "none"
        })`,
        afterState: {
            url: image.url,
            sortOrder: image.sortOrder,
            bytes: stored.size,
            removedMetadata: stored.removedMetadata,
        },
        request: options.request,
    });

    return image;
}

/**
 * Remove an image: the row first, then the file.
 *
 * The row is deleted first so that a filesystem failure cannot leave a database row
 * pointing at a file that no longer exists (a visible break); a missing file after the
 * row is gone is harmless, and `deleteStoredEventImage` is idempotent.
 */
export async function removeEventImage(
    scope: AuthzScope,
    eventId: string,
    imageId: string,
    request?: Request
) {
    const { scope: authorized, event } = await requireEventAccess(
        eventId,
        PERMISSIONS.EVENT_BANNER_UPLOAD
    );

    const image = await prisma.eventImage.findFirst({
        where: { id: imageId, eventId: event.id },
        select: IMAGE_SELECT,
    });

    if (!image) {
        throw AppError.notFound("Gambar tidak ditemukan.");
    }

    await prisma.eventImage.delete({ where: { id: image.id } });

    const fileName = eventImageFileNameFromUrl(image.url);

    if (fileName) {
        await deleteStoredEventImage(fileName);
    }

    await writeTicketingAudit({
        action: "event.image.remove",
        actor: authorized,
        actorOrganizerId: event.organizerId,
        organizerId: event.organizerId,
        entityType: "EventImage",
        entityRef: image.id,
        description: "Gambar event dihapus",
        beforeState: { url: image.url, sortOrder: image.sortOrder },
        request,
    });

    return { id: image.id };
}
