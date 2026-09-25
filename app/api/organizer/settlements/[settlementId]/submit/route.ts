import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { submitSettlement } from "@/lib/ticketing/settlement/service";
import {
    settlementIdParamSchema,
    submitSettlementSchema,
} from "@/lib/ticketing/settlement/validation";

/**
 * /api/organizer/settlements/[settlementId]/submit — `DRAFT → PENDING_APPROVAL`.
 *
 * The tenancy and the `settlement.prepare` permission are resolved against the row's own
 * `organizerId` inside the service. A prepared settlement may be submitted even by the
 * same person who prepared it — the separation of duties (D-25) in V1 sits on the
 * FINANCIAL actions (approve + paid), not on the request for approval.
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

        parseOrThrow(submitSettlementSchema, body);

        const payload = await submitSettlement(parsedId, scope);

        return ok(payload);
    });
}