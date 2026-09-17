import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { created, handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { createVenueSchema } from "@/lib/venues/validation";
import { createGlobalVenue, listGlobalVenues } from "@/lib/venues/service";

/**
 * /api/admin/venues — platform-global venues (decision D-64)
 *
 * PROTECTED and gated on the platform-scope `venue.manage.global` permission.
 *
 * This is the *only* namespace that can create a venue with `organizerId: null`. The
 * organizer namespace requires an `organizerId`, so the two ownership classes cannot
 * be crossed: an organizer member cannot mint a shared venue (they lack the platform
 * permission), and a platform Admin without a membership cannot alter a private one.
 *
 * The list is restricted to global venues, so this surface is not a back door around
 * tenant isolation for reading other organizers' venues.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const scope = await requireAuth();

        const result = await listGlobalVenues(scope, {
            q: request.nextUrl.searchParams.get("q"),
        });

        return ok(result.items);
    });
}

export async function POST(request: NextRequest) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();

        const body = await request.json().catch(() => null);

        if (!body || typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        // `organizerId` is not read from the body at all: ownership is decided by the
        // route (global) and cannot be influenced by the caller.
        const input = parseOrThrow(createVenueSchema, body);

        const venue = await createGlobalVenue(scope, input, request);

        return created(venue);
    });
}
