import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { publishEvent } from "@/lib/events/service";

/**
 * POST /api/organizer/events/[id]/publish
 *
 * PROTECTED + CSRF-checked. Requires `event.publish` in the event's own tenant.
 *
 * Decision D-13 is LOCKED as **self-publish**: there is no approval queue and no
 * `PENDING_REVIEW` state is introduced, so this endpoint publishes immediately once the
 * design's §10.3 preconditions hold. A failure is reported as `CONFLICT` with
 * `details.preconditions` naming every unmet item, so the UI can explain exactly what
 * is missing.
 *
 * PHASE 5 DEPENDENCY: one precondition is "at least one active ticket type with
 * `quota > 0`", which is checked by a read-only count against the Phase 2 table. The
 * consequence until Phase 5 ships ticket-type creation is that this endpoint will
 * report that precondition as unmet. That is intentional (see `publishEvent`) and is
 * recorded in the Phase 4 report rather than bypassed with an override.
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

        const result = await publishEvent(scope, id, request);

        return ok(result);
    });
}
