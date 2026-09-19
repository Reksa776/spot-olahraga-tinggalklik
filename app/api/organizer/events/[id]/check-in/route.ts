import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import {
    checkInTicket,
    listEventCheckIns,
} from "@/lib/ticketing/checkin/service";
import {
    checkInListQuerySchema,
    checkInRequestSchema,
} from "@/lib/ticketing/checkin/validation";

/**
 * /api/organizer/events/[id]/check-in — the gate for one event.
 *
 * PROTECTED + CSRF-checked. `/api/organizer/` is already in `proxy.ts`'s
 * PROTECTED_API_PREFIXES, so this subtree is classified without a new entry; the guards
 * inside the service are the real control and the proxy entry is defence in depth.
 *
 *   POST — admit the ticket a presented code names.
 *   GET  — the event's recent admissions (the attendance view).
 *
 * WHAT THE CLIENT MAY NOT SEND
 * ----------------------------
 * Neither handler accepts an `organizerId`, an `eventId`, a `ticketId`, a status, a
 * `checkedInAt` or a `checkedInBy*` field. The event comes from the ROUTE and is
 * authorized against the actor's database-resolved memberships; the tenant, the ticket
 * and every state value are read server-side. Both schemas are strict, so a body that
 * carries any of those is a validation error rather than a silent override.
 *
 * WHY `requireAuth()` IS CALLED HERE *AND* INSIDE THE SERVICE
 * -----------------------------------------------------------
 * The service's `requireEventCheckInAccess` calls `requireOrganizerAccess`, which needs
 * an authenticated session. Calling `requireAuth()` first keeps the route's own shape
 * identical to every other organizer route (a 401 before any body parsing) and gives the
 * route a `scope` it does not otherwise use for the GET — which resolves the attendance
 * list's own permission (`checkin.log.read`) inside the service.
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return handleApi(async () => {
        await requireAuth();
        const { id } = await params;

        const query = parseOrThrow(checkInListQuerySchema, {
            limit: request.nextUrl.searchParams.get("limit") ?? undefined,
        });

        const result = await listEventCheckIns(id, query.limit);

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

        await requireAuth();
        const { id } = await params;

        const body = await request.json().catch(() => null);

        if (body !== null && typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const input = parseOrThrow(checkInRequestSchema, body ?? {});

        const result = await checkInTicket({
            eventId: id,
            input,
            request,
        });

        return ok(result);
    });
}
