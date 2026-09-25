import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { getSettlement } from "@/lib/ticketing/settlement/service";
import { settlementIdParamSchema } from "@/lib/ticketing/settlement/validation";

/**
 * /api/organizer/settlements/[settlementId] — one payout, detail with items.
 *
 * Read-only; the tenant is the settlement's OWN `organizerId`, resolved and re-guarded
 * inside `getSettlement` (`requireOrganizerAccess` with `settlement.prepare` against the
 * row, so a cross-tenant detail request is a 404). Money details are masked: the payee's
 * account number renders as `••••` + last four.
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ settlementId: string }> }
) {
    return handleApi(async () => {
        const scope = await requireAuth();

        const { settlementId } = await params;

        const parsed = parseOrThrow(settlementIdParamSchema, settlementId);

        const payload = await getSettlement(parsed, scope);

        return ok(payload);
    });
}