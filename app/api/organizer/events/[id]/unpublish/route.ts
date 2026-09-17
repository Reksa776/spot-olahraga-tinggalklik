import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { unpublishEvent } from "@/lib/events/service";

/**
 * POST /api/organizer/events/[id]/unpublish
 *
 * PROTECTED + CSRF-checked. Requires `event.publish` in the event's own tenant.
 *
 * Decision D-14 is LOCKED: unpublishing **hides the event from public listings while
 * preserving a read-only page**, and must not delete data, cancel orders, void tickets
 * or trigger refunds. This endpoint therefore changes exactly one column
 * (`Event.status` → `DRAFT`) and writes one audit row. The absence of any order,
 * ticket, payment or refund write is the implementation of D-14 — not an oversight.
 *
 * Ticket-holder-specific messaging belongs to the ticket and order phases, which will
 * read the status this endpoint sets.
 */

export const runtime = "nodejs";

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

        const event = await unpublishEvent(scope, id, request);

        return ok(event);
    });
}
