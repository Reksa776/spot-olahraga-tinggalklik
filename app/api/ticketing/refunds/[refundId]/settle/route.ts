import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { settleRefund } from "@/lib/ticketing/refunds/service";
import {
    refundIdParamSchema,
    refundSettleSchema,
} from "@/lib/ticketing/refunds/validation";

/**
 * /api/ticketing/refunds/[refundId]/settle — record the MANUAL BANK TRANSFER and settle
 * (Phase 18B, D-P17-04 = B).
 *
 * PROTECTED (via `/api/ticketing/`) and state-changing, so the same-origin check runs first,
 * exactly like approve/reject/execute. The service enforces `refund.execute` for the
 * refund's organizer AND separation of duties: the requester may not complete their own
 * request.
 *
 * This is the ONE endpoint that can move a refund to `REFUNDED`, and it can only do so from
 * `PROCESSING` and only with the operator's transfer evidence. The amount is never taken
 * from the body — the settled figure is the sum of the refund's own stored claim lines.
 */

export const runtime = "nodejs";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ refundId: string }> }
) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();
        const { refundId } = await params;

        const body = await request.json().catch(() => null);

        if (!body || typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const input = parseOrThrow(refundSettleSchema, body);

        const payload = await settleRefund(
            parseOrThrow(refundIdParamSchema, refundId),
            input,
            scope,
            request
        );

        return ok(payload);
    });
}
