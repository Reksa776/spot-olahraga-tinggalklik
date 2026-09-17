import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { removeEventImage } from "@/lib/events/images";

/**
 * DELETE /api/organizer/events/[id]/images/[imageId]
 *
 * PROTECTED + CSRF-checked. Requires `event.banner.upload` in the event's own tenant.
 *
 * The image is looked up by **both** the event id and the image id
 * (`findFirst({ where: { id: imageId, eventId } })`), so an image id belonging to a
 * different event — even one in the same organizer — cannot be deleted through this
 * path. A mismatch returns 404 rather than a distinguishable error.
 */

export const runtime = "nodejs";

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; imageId: string }> }
) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();
        const { id, imageId } = await params;

        const result = await removeEventImage(scope, id, imageId, request);

        return ok(result);
    });
}
