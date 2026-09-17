import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { parseOrThrow } from "@/lib/api/validation";
import { handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { deleteEvent, getOrganizerEvent, updateEvent } from "@/lib/events/service";
import { updateEventSchema } from "@/lib/events/validation";

/**
 * /api/organizer/events/[id] — read, update and delete one event
 *
 * PROTECTED. Every handler resolves the event's real `organizerId` from the database
 * and authorizes against the actor's memberships (`requireEventAccess`), so an id
 * belonging to another organizer yields **404**, not 403 — the denial must not confirm
 * that the event exists (design §7.4).
 *
 * The `:id` in the URL is always a resource identifier, never a permission: nothing in
 * this route reads an organizer id from the request.
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return handleApi(async () => {
        const scope = await requireAuth();
        const { id } = await params;

        const event = await getOrganizerEvent(scope, id);

        return ok(event);
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

        // Strict schema: `organizerId`, `status`, `publishedAt` and `id` are not
        // accepted at all, so an update cannot reassign ownership or forge a
        // publication. Publication is reachable only through the publish endpoints.
        const input = parseOrThrow(updateEventSchema, body);

        const event = await updateEvent(scope, id, input, request);

        return ok(event);
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

        const result = await deleteEvent(scope, id, request);

        return ok(result);
    });
}
