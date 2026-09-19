import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { failRefund } from "@/lib/ticketing/refunds/service";
import {
    refundFailSchema,
    refundIdParamSchema,
} from "@/lib/ticketing/refunds/validation";

/**
 * /api/ticketing/refunds/[refundId]/fail — the manual transfer did not complete
 * (Phase 18B, D-P17-04 = B).
 *
 * PROTECTED and state-changing, so the same-origin check runs first. The service enforces
 * `refund.execute` for the refund's organizer and separation of duties.
 *
 * `PROCESSING → FAILED` moves NO money and writes no ledger row: it releases the ticket
 * claims so a corrected refund can be requested, and it frees the order's one-in-flight
 * claim so the next legitimate refund is not blocked by an attempt that never happened.
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

        const input = parseOrThrow(refundFailSchema, body);

        const payload = await failRefund(
            parseOrThrow(refundIdParamSchema, refundId),
            input,
            scope,
            request
        );

        return ok(payload);
    });
}
