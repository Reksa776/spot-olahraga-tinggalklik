import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { parseOrThrow } from "@/lib/api/validation";
import { handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { updateVenueSchema } from "@/lib/venues/validation";
import { deleteVenue, updateVenue } from "@/lib/venues/service";

/**
 * /api/admin/venues/[id] — update or delete one venue
 *
 * PROTECTED + CSRF-checked. Authorization is delegated to `updateVenue` /
 * `deleteVenue`, which resolve the venue's ownership class from the database:
 *
 *   global venue  → platform `venue.manage.global` required
 *   private venue → tenant `venue.manage` for its organizer required
 *
 * So although this namespace is the platform one, it does not grant a platform Admin
 * authority over a private venue: reaching this route with a private venue id is
 * denied as `ORGANIZER_ACCESS_DENIED` (404) unless the actor also holds a membership
 * in that organizer. That is the intended asymmetry — the platform Admin owns the
 * shared catalogue, not other tenants' records.
 */

export const runtime = "nodejs";

export async function PATCH(
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

        const body = await request.json().catch(() => null);

        if (!body || typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        // `organizerId` is absent from the strict schema, so a global venue cannot be
        // converted into a private one (or vice versa) through an update.
        const input = parseOrThrow(updateVenueSchema, body);

        const venue = await updateVenue(scope, id, input, request);

        return ok(venue);
    });
}

export async function DELETE(
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

        const result = await deleteVenue(scope, id, request);

        return ok(result);
    });
}
