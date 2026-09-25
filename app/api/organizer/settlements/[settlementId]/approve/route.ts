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
 * /api/organizer/settlements/[settlementId]/approve — `PENDING_APPROVAL|REQUESTED → APPROVED`.
 *
 * A FINANCIAL action. The service requires `settlement.approve` against the settlement's
 * OWN tenant AND that the approver is not the person who prepared the payout
 * (`SEPARATION_OF_DUTIES`).
 *
 * Who holds `settlement.approve` (CURRENT map — `lib/authz/permissions.ts`):
 *   * MANAGER — held BY ROLE (platform role MANAGER, and the membership roles
 *     OWNER / MANAGER / FINANCE). A MANAGER therefore CAN approve. The previous wording
 *     here claimed a MANAGER could prepare but not approve, which was wrong.
 *   * ADMIN — NOT held by role. It is grant-required (D-19), so an ADMIN needs BOTH an
 *     ACTIVE `OrganizerMember` row for the settlement's tenant AND an explicit, non-revoked
 *     `PermissionGrant { permission: "settlement.approve" }` scoped to that organizer (or
 *     platform-wide). Without the membership the answer is the never-confirming 404;
 *     without the grant it is 403.
 *
 * This route also serves the PIC-initiated `REQUESTED` state (PHASE 21): the PIC requests a
 * payout and an operator approves it here. The author is the PIC, who holds no `settlement.*`
 * capability, so the separation of duties is satisfied by construction.
 *
 * Approval makes the payout ready for the manual transfer evidence (`proof`) and `paid`.
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