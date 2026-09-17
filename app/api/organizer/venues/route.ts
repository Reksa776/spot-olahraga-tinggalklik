import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { created, handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { createVenueSchema } from "@/lib/venues/validation";
import { createVenue, listVenues } from "@/lib/venues/service";

/**
 * /api/organizer/venues — organizer venue management (decision D-64)
 *
 * PROTECTED. Returns the platform-global venues (shared by definition) plus the
 * private venues of every organizer the actor can read. The private half is derived
 * from resolved memberships, never from a query parameter.
 *
 * POST always creates a venue in the ownership class named by `organizerId` — and
 * because `createVenue` routes that through `requireVenueCreate`, a member of
 * organizer A cannot create a venue for organizer B. There is deliberately **no** way
 * to create a global venue from this namespace: `organizerId` is required here, and
 * global venues live under `/api/admin/venues` where the platform permission is
 * enforced. That is the D-64 split.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const scope = await requireAuth();

        const result = await listVenues(scope, {
            organizerId: request.nextUrl.searchParams.get("organizerId"),
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

        const body = (await request.json().catch(() => null)) as
            | Record<string, unknown>
            | null;

        if (!body) {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const organizerId = body.organizerId;

        if (typeof organizerId !== "string" || organizerId.length === 0) {
            throw AppError.validation("organizerId wajib diisi.", {
                fields: [{ path: "organizerId", message: "Wajib diisi." }],
            });
        }

        const { organizerId: _target, ...venueFields } = body;

        const input = parseOrThrow(createVenueSchema, venueFields);

        const venue = await createVenue(scope, organizerId, input, request);

        return created(venue);
    });
}
