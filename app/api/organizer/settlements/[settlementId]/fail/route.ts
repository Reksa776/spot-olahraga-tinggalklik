import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { failSettlement } from "@/lib/ticketing/settlement/service";
import { failSettlementSchema, settlementIdParamSchema } from "@/lib/ticketing/settlement/validation";

/**
 * /api/organizer/settlements/[settlementId]/fail — `APPROVED → FAILED`.
 *
 * For a payout whose manual transfer did NOT go through (bank detail wrong, timeout,
 * reversal arrived late). Requires `settlement.approve` against the row's own tenant and
 * a written `reason` (persisted on `failureReason`). The claim lines are released — not
 * deleted, only un-linked from the settlement — so the PIC stays entitled to them and
 * the operator re-prepares the window fresh.
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

        const body = await request.json().catch(() => null);

        if (!body || typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const input = parseOrThrow(failSettlementSchema, body);

        const payload = await failSettlement(parsedId, input, scope);

        return ok(payload);
    });
}