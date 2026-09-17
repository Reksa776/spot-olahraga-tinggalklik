import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { parseOrThrow } from "@/lib/api/validation";
import { handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { updateVenueSchema } from "@/lib/venues/validation";
import { deleteVenue, getVenue, updateVenue } from "@/lib/venues/service";

/**
 * /api/organizer/venues/[id] — read, update and delete one venue
 *
 * PROTECTED + CSRF-checked on mutations.
 *
 * D-64 ENFORCEMENT ON THIS ROUTE
 * ------------------------------
 * `updateVenue` and `deleteVenue` resolve the venue's ownership class from the
 * database first:
 *
 *   global venue (`organizerId: null`)  → requires platform `venue.manage.global`.
 *                                         An ordinary organizer member is denied even
 *                                         though the venue is readable.
 *   private venue (`organizerId: X`)    → requires tenant `venue.manage` for X.
 *                                         Another organizer gets 404.
 *
 * So an organizer cannot mutate a shared venue, and cannot reach a competitor's
 * private venue by id. Deletion is additionally refused while any event references the
 * venue, because `Event.venue` is `onDelete: SetNull` and the database would otherwise
 * silently blank the location of historical events.
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return handleApi(async () => {
        await requireAuth();
        const { id } = await params;

        const venue = await getVenue(id);

        return ok(venue);
    });
}

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

        // Strict schema — `organizerId` is not accepted, so a venue cannot be
        // reassigned between ownership classes by an update.
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
