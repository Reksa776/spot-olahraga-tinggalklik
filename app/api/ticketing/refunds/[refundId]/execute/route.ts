import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { executeRefund } from "@/lib/ticketing/refunds/service";
import {
    refundExecuteSchema,
    refundIdParamSchema,
} from "@/lib/ticketing/refunds/validation";

/**
 * /api/ticketing/refunds/[refundId]/execute — staff execute an approved refund (D-R02).
 *
 * PROTECTED and state-changing. The service enforces `refund.execute` for the organizer,
 * separation of duties, and the `APPROVED → PROCESSING` CAS before it calls the provider
 * (so a duplicate execute never calls the provider twice). Under D-R17 the default provider
 * reports UNSUPPORTED, so with no real refund rail wired this path ends `FAILED` with
 * `PROVIDER_UNSUPPORTED` and moves no money.
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

        const input = parseOrThrow(refundExecuteSchema, body ?? {});

        const payload = await executeRefund(
            parseOrThrow(refundIdParamSchema, refundId),
            scope,
            input,
            request
        );

        return ok(payload);
    });
}
