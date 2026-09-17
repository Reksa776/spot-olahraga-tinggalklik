import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { parseOrThrow } from "@/lib/api/validation";
import { handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { deleteSport, updateSport } from "@/lib/sports/service";
import { updateSportSchema } from "@/lib/sports/validation";

/**
 * /api/admin/sports/[id] — update or retire one platform sport
 *
 * PROTECTED, CSRF-checked, and gated on the platform-scope `sport.manage` permission.
 *
 * Deletion is refused while any event references the sport, with the count reported.
 * The supported way to retire a sport is `isActive: false`, which removes it from the
 * public catalog facet (`listPublicSports`) without breaking historical events — the
 * error message says so explicitly rather than leaving the operator to guess.
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

        const input = parseOrThrow(updateSportSchema, body);

        const sport = await updateSport(scope, id, input, request);

        return ok(sport);
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

        const result = await deleteSport(scope, id, request);

        return ok(result);
    });
}
