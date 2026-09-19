import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { approveRefund } from "@/lib/ticketing/refunds/service";
import {
    refundApproveSchema,
    refundIdParamSchema,
} from "@/lib/ticketing/refunds/validation";

/**
 * /api/ticketing/refunds/[refundId]/approve — staff approve a pending refund (D-R02).
 *
 * PROTECTED (via `/api/ticketing/`), state-changing, so the same-origin check runs first.
 * The service enforces `refund.approve` for the refund's organizer AND separation of
 * duties: the requester may not approve their own request. `[refundId]` is data; the
 * capability and tenancy are checked against the resolved row.
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

        const body = await request.json().catch(() => ({}));

        const input = parseOrThrow(refundApproveSchema, body ?? {});

        const payload = await approveRefund(
            parseOrThrow(refundIdParamSchema, refundId),
            scope,
            input,
            request
        );

        return ok(payload);
    });
}
