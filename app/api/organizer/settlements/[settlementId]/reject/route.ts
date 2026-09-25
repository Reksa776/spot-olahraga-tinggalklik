import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { rejectSettlement } from "@/lib/ticketing/settlement/service";
import {
    rejectSettlementSchema,
    settlementIdParamSchema,
} from "@/lib/ticketing/settlement/validation";

/**
 * /api/organizer/settlements/[settlementId]/reject — refuse a PIC-initiated payout
 * request (`REQUESTED → REJECTED`, PHASE 21).
 *
 * A REVIEW action, so it requires `settlement.approve` against the settlement's OWN
 * tenant and the same separation of duties as approval: the author of the request (the
 * PIC) can never refuse it, and neither can anyone else who authored it. The reason is
 * REQUIRED and persisted on `rejectionReason`, where the PIC's own dashboard reads it.
 *
 * The claim lines are released in the same transaction, so the PIC's fees become
 * requestable again — no money moved, because a `REQUESTED` row was never approved.
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

        const input = parseOrThrow(rejectSettlementSchema, body);

        const payload = await rejectSettlement(parsedId, input, scope);

        return ok(payload);
    });
}
