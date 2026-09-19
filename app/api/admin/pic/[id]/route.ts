import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { getPicDetail, updatePicStatus } from "@/lib/pic/service";
import { updatePicStatusSchema } from "@/lib/pic/validation";

/**
 * /api/admin/pic/[id] — one PIC profile: detail, and status transitions.
 *
 * PROTECTED + CSRF-checked. `pic.manage` is enforced inside both service calls, so this route adds
 * no authority of its own.
 *
 * PATCH is deliberately limited to a STATUS change. The fee rate, the assigned events and the
 * payout details are not editable through this route: the first encodes a commercial decision the
 * platform has not made (the schema default `0` means "inherit"), and the other two belong to the
 * assignment and settlement surfaces.
 */

export const runtime = "nodejs";

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return handleApi(async () => {
        const scope = await requireAuth();
        const { id } = await params;

        const result = await getPicDetail(scope, id);

        return ok(result);
    });
}

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();
        const { id } = await params;

        const body = await request.json().catch(() => null);

        if (!body || typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const input = parseOrThrow(updatePicStatusSchema, body);

        const pic = await updatePicStatus(scope, id, input, request);

        return ok(pic);
    });
}
