import type { NextRequest } from "next/server";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { created, handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { addEventImage, listEventImages } from "@/lib/events/images";
import { rateLimiters } from "@/lib/rate-limit";

/**
 * /api/organizer/events/[id]/images — event imagery (design §10.4, decision D-55)
 *
 * PROTECTED + CSRF-checked. Requires `event.banner.upload` in the event's own tenant,
 * which is a distinct capability from `event.write`.
 *
 * THE ORDER IS THE SECURITY PROPERTY (brief §31):
 *
 *   upload → validate → process → strip EXIF → store processed output → serve
 *
 * `addEventImage` delegates the whole validate/process/store step to
 * `processAndStoreEventImage`, and this handler never touches the filesystem. There is
 * therefore no code path that can persist an unprocessed file, so the original is
 * never written to a servable location (brief §17).
 *
 * The client-supplied MIME type and filename are both ignored for every decision: the
 * container is detected from magic bytes, and the stored name is generated server-side.
 *
 * UPLOAD RATE LIMIT (brief §16): the repository's existing `rateLimiters.upload` bucket
 * (20/minute, keyed by user) is applied *before the body is parsed*, so a flood is
 * rejected without a multipart body ever being read into memory. The limiter is reused
 * rather than re-tuned — a second, differently-scaled upload limit for events would
 * have been a new policy nobody asked for.
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return handleApi(async () => {
        const scope = await requireAuth();
        const { id } = await params;

        const result = await listEventImages(scope, id);

        return ok(result);
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
        const { id } = await params;

        // Checked before parsing the multipart body: the point of an upload limit is to
        // avoid doing the expensive work, not to reject after it.
        const limit = rateLimiters.upload(scope.userId);

        if (!limit.allowed) {
            throw new AppError(ERROR_CODES.RATE_LIMITED, {
                details: { retryAfterMs: limit.retryAfterMs },
            });
        }

        const formData = await request.formData().catch(() => null);

        if (!formData) {
            throw AppError.validation("Form data tidak valid.");
        }

        const file = formData.get("file");

        if (!(file instanceof File)) {
            throw AppError.validation("File gambar wajib diupload.");
        }

        const rawAltText = formData.get("altText");
        const altText =
            typeof rawAltText === "string" && rawAltText.trim().length > 0
                ? rawAltText.trim().slice(0, 200)
                : null;

        const image = await addEventImage(scope, id, file, {
            altText,
            request,
        });

        return created(image);
    });
}
