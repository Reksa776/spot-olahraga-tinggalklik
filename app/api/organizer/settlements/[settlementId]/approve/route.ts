import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { approveSettlement } from "@/lib/ticketing/settlement/service";
import {
    approveSettlementSchema,
    settlementIdParamSchema,
} from "@/lib/ticketing/settlement/validation";

/**
 * /api/organizer/settlements/[settlementId]/approve — `PENDING_APPROVAL → APPROVED`.
 *
 * A FINANCIAL action: the service requires `settlement.approve` (FINANCE / ADMIN / OWNER
 * per D-19; a MANAGER may prepare but not approve) AND that the approver is not the
 * person who prepared the payout. Approval makes the payout ready for the manual
 * transfer evidence (`proof`) and finally `paid`.
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

        parseOrThrow(approveSettlementSchema, body);

        const payload = await approveSettlement(parsedId, scope);

        return ok(payload);
    });
}