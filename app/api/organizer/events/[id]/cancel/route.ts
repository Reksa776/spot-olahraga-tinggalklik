import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { cancelEvent } from "@/lib/events/service";
import { cancelEventSchema } from "@/lib/events/validation";

/**
 * POST /api/organizer/events/[id]/cancel
 *
 * PROTECTED + CSRF-checked. Requires `event.publish` in the event's own tenant.
 *
 * Implements design §10.3's `PUBLISHED → CANCELLED` transition. What it does and does
 * not do is documented on `cancelEvent`: sales stop immediately and unpaid orders
 * auto-expire, but **no money moves** — no refund is triggered, no payment is marked
 * `REFUNDED`, and no issued ticket is voided, because those parts of the design's
 * effect list depend on the post-MVP refund automation and on a product decision.
 *
 * Idempotent for an already-cancelled event. An optional `reason` is recorded for the
 * buyer-facing message and the audit trail; nothing else is accepted from the client.
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

        const input = parseOrThrow(cancelEventSchema, body ?? {});

        const result = await cancelEvent(scope, id, input, request);

        return ok(result);
    });
}
