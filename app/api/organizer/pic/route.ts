import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { created, handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { assignPicToEvent, listOrganizerPicAssignments } from "@/lib/pic/service";
import { assignPicSchema } from "@/lib/pic/validation";

/**
 * /api/organizer/pic — PIC assignment for one organizer's events.
 *
 * PROTECTED (the proxy covers `/api/organizer/`), CSRF-checked on writes, and authorized by the
 * tenant-scope `pic.assign` permission against the organizer that OWNS the named event. The
 * `organizerId` query parameter selects which tenant to LIST; it is never treated as authority —
 * `listOrganizerPicAssignments` runs `requireOrganizerAccess` on it, so passing another tenant's id
 * is a 404, not a peek.
 *
 * POST takes an `eventId`, not an `organizerId`: the service loads the event and authorizes against
 * the tenant that owns it, which is what stops an assignment being written against one organizer
 * while naming another organizer's event.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const scope = await requireAuth();

        const organizerId = request.nextUrl.searchParams.get("organizerId");

        if (!organizerId) {
            throw AppError.validation("organizerId wajib diisi.", {
                fields: [{ path: "organizerId", message: "Wajib diisi." }],
            });
        }

        const result = await listOrganizerPicAssignments(scope, organizerId);

        return ok(result);
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

        const input = parseOrThrow(assignPicSchema, body);

        const assignment = await assignPicToEvent(scope, input, request);

        return created(assignment);
    });
}
