import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { PERMISSIONS, requireOrganizerAccess, requirePlatformPermission } from "@/lib/authz";
import { getPicFeeReconciliation } from "@/lib/pic/reconciliation";

/**
 * /api/reports/pic-fee-reconciliation — the operational reconciliation breakdown.
 *
 * PROTECTED. Read-only inspectability for the EARNED → REVERSAL → PAYOUT and
 * settlement-consumption relationships. Two authority paths, neither trusting a client id:
 *
 *   • with `organizerId`  → organizer tenant: `pic_fee.read.all` on that organizer, and the
 *     breakdown is scoped to the same tenant;
 *   • without it          → platform `pic.manage` (ADMIN), reading across tenants.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const params = request.nextUrl.searchParams;
        const picProfileId = params.get("picProfileId");
        const organizerId = params.get("organizerId");

        if (!picProfileId) {
            throw AppError.validation("picProfileId wajib diisi.", {
                fields: [{ path: "picProfileId", message: "Wajib diisi." }],
            });
        }

        if (organizerId) {
            await requireOrganizerAccess(organizerId, PERMISSIONS.PIC_FEE_READ_ALL);
        } else {
            await requirePlatformPermission(PERMISSIONS.PIC_MANAGE);
        }

        const reconciliation = await getPicFeeReconciliation(picProfileId, organizerId);

        return ok(reconciliation);
    });
}
