import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { archiveEvent } from "@/lib/events/service";

/**
 * POST /api/organizer/events/[id]/archive
 *
 * PROTECTED + CSRF-checked. Requires `event.publish` in the event's own tenant.
 *
 * Implements design §10.2/§10.3's soft delete: `archivedAt` is set, the status becomes
 * `ARCHIVED`, and the event disappears from every public surface (already enforced by
 * the catalog and the detail query) while its orders, tickets, payments and refunds are
 * left untouched. Refused while an open refund is still moving money.
 *
 * Idempotent for an already-archived event. Takes no body.
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

        const result = await archiveEvent(scope, id, request);

        return ok(result);
    });
}
