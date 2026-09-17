import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import {
    deleteTicketType,
    getOrganizerTicketType,
    updateTicketType,
} from "@/lib/ticket-types/service";
import { updateTicketTypeSchema } from "@/lib/ticket-types/validation";

/**
 * /api/organizer/events/[id]/ticket-types/[ticketTypeId] — read, update, delete.
 *
 * PROTECTED. Authorization resolves through the ticket type's OWN event and that
 * event's organizer (`requireTicketTypeAccess`), not through the `:id` in the URL. The
 * two ids are therefore not interchangeable: passing a `ticketTypeId` that belongs to a
 * different event than `:id` still authorizes against the ticket type's real owner, so
 * the pair cannot be used to cross a tenant boundary.
 *
 * QUOTA AND PRICE ARE SEPARATELY PERMISSIONED
 * -------------------------------------------
 * `ticket_type.write` covers the descriptive fields. A payload containing `quota`
 * additionally requires `ticket_type.quota.change`, and one containing `price`
 * additionally requires `ticket_type.price_change`. Both checks live in the service so
 * they cannot be bypassed by another entry point.
 *
 * `sold`, `reserved` and `version` are not in the update schema, so no request can move
 * inventory counters — that is the exclusive job of `lib/ticketing/inventory.ts`.
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; ticketTypeId: string }> }
) {
    return handleApi(async () => {
        const scope = await requireAuth();
        const { ticketTypeId } = await params;

        const ticketType = await getOrganizerTicketType(scope, ticketTypeId);

        return ok(ticketType);
    });
}

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; ticketTypeId: string }> }
) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();
        const { ticketTypeId } = await params;

        const body = await request.json().catch(() => null);

        if (!body || typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const input = parseOrThrow(updateTicketTypeSchema, body);

        const ticketType = await updateTicketType(
            scope,
            ticketTypeId,
            input,
            request
        );

        return ok(ticketType);
    });
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; ticketTypeId: string }> }
) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();
        const { ticketTypeId } = await params;

        const result = await deleteTicketType(scope, ticketTypeId, request);

        return ok(result);
    });
}
