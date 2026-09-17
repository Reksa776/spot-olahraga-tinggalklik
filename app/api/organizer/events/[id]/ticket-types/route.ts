import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { created, handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { createTicketType, listEventTicketTypes } from "@/lib/ticket-types/service";
import { createTicketTypeSchema } from "@/lib/ticket-types/validation";

/**
 * /api/organizer/events/[id]/ticket-types — manage the sellable tiers of one event.
 *
 * PROTECTED. `/api/organizer/` is already in `proxy.ts`'s PROTECTED_API_PREFIXES, so
 * this subtree is classified without a new entry; the guard below is the real control
 * and the proxy entry is defence in depth.
 *
 * WHY THIS IS `/api/organizer/...` AND NOT THE DESIGN'S `/api/admin/...`
 * --------------------------------------------------------------------
 * Design §2290 sketches `GET/POST/PATCH /api/admin/events/{id}/ticket-types`. That path
 * predates the split Phase 4 had to make: the `/admin` namespace in this repository is
 * the **legacy retail** namespace, gated on the legacy `session.user.role` column, and
 * Phase 3 deliberately wrote no bridge from that column to a platform privilege. So
 * `/admin` is unreachable for a platform ADMIN who lacks the retail role, and using it
 * would have hidden the whole ticketing back office behind an unrelated permission.
 * Phase 4 established `/api/organizer/...` for tenant-scoped ticketing operations and
 * this follows that convention, which the Phase 5 brief itself anticipates ("verify the
 * existing Phase 1 design and repository conventions before creating routes").
 *
 * `:id` IS DATA, NEVER AUTHORITY
 * ------------------------------
 * The event id comes from the URL, and the create payload has no `eventId` and no
 * `organizerId` field at all (the schema is strict). Ownership is resolved by
 * `requireEventAccess` from the database, so naming another organizer's event yields
 * 404 rather than a write.
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return handleApi(async () => {
        const scope = await requireAuth();
        const { id } = await params;

        const result = await listEventTicketTypes(scope, id);

        // Not paginated: an event has a handful of tiers, and the whole list is needed
        // to render availability together. The total is returned anyway so the client
        // can show a count without a second call.
        return ok({ items: result.items, total: result.total });
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

        const body = await request.json().catch(() => null);

        if (!body || typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        // Strict schema: `sold`, `reserved`, `version`, `currency`, `eventId` and
        // `organizerId` are all rejected if present, so a caller cannot pre-load
        // inventory, pick its own currency, or assert ownership.
        const input = parseOrThrow(createTicketTypeSchema, body);

        const ticketType = await createTicketType(scope, id, input, request);

        return created(ticketType);
    });
}
