import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { rejectRefund } from "@/lib/ticketing/refunds/service";
import {
    refundIdParamSchema,
    refundRejectSchema,
} from "@/lib/ticketing/refunds/validation";

/**
 * /api/ticketing/refunds/[refundId]/reject — staff decline a pending refund (D-R02/D-R13).
 *
 * PROTECTED and state-changing. A rejection REQUIRES a reason (D-R13 persists it; the
 * schema fails with `VALIDATION_ERROR` otherwise). The service enforces `refund.approve`
 * for the organizer and separation of duties. Releasing the ticket claims that a rejection
 * causes happens inside the service's transaction.
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

        const input = parseOrThrow(refundRejectSchema, body);

        const payload = await rejectRefund(
            parseOrThrow(refundIdParamSchema, refundId),
            scope,
            input,
            request
        );

        return ok(payload);
    });
}
