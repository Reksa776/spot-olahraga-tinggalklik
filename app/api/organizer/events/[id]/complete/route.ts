import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { completeEvent } from "@/lib/events/service";
import { completeEventSchema } from "@/lib/events/validation";

/**
 * POST /api/organizer/events/[id]/complete
 *
 * PROTECTED + CSRF-checked. Requires `event.publish` in the event's own tenant — the same
 * capability the design's lifecycle table names as the manual completion authority
 * ("System (job, after `endAt`) or Manager"), so no new permission key is introduced
 * (P14-D25).
 *
 * This is the HUMAN half of `PUBLISHED|ONGOING → COMPLETED`; the automatic half is the
 * scheduler tick. Preconditions, idempotency and — importantly — the absence of any money,
 * order, payment, ticket or quota mutation are documented on `completeEvent`.
 *
 * An optional `note` is recorded in the audit trail as the reason a human closed the event.
 * Nothing else is accepted from the client: the actor comes from the session, the tenant
 * from the event row, and `completedAt` from the server clock.
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

        const body = await request.json().catch(() => null);

        if (body !== null && typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const input = parseOrThrow(completeEventSchema, body ?? {});

        const result = await completeEvent(scope, id, input, request);

        return ok(result);
    });
}
