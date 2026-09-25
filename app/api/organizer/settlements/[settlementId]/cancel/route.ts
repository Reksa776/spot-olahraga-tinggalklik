import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { cancelSettlement } from "@/lib/ticketing/settlement/service";
import { settlementIdParamSchema } from "@/lib/ticketing/settlement/validation";

/**
 * /api/organizer/settlements/[settlementId]/cancel — `DRAFT | PENDING_APPROVAL → CANCELLED`.
 *
 * The non-financial way out: the payout has not been approved, no money moved and (for
 * DRAFT) no evidence can exist. Requires `settlement.prepare` against the row's own
 * tenant. The claim lines are released like a fail, so the window can be prepared again.
 * `APPROVED` and `PAID` cannot be cancelled (approved ones must fail; paid ones are
 * done).
 */

export const runtime = "nodejs";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ settlementId: string }> }
) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();

        const { settlementId } = await params;
        const parsedId = parseOrThrow(settlementIdParamSchema, settlementId);

        const payload = await cancelSettlement(parsedId, scope);

        return ok(payload);
    });
}