import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { getOrganizerPicFeeReport } from "@/lib/pic/tenant-reporting";

/**
 * /api/organizer/pic-fee-report — per-PIC canonical fee totals for ONE organizer.
 *
 * PROTECTED (`/api/organizer/` is in the proxy's protected list). The `organizerId` query
 * parameter selects the tenant; it is NOT authority — `getOrganizerPicFeeReport` runs
 * `requireOrganizerAccess(organizerId, pic_fee.read.all)` against the session actor, so
 * naming another tenant is a 404. Platform ADMIN behaviour is unchanged (a membership is
 * still required to act inside a tenant).
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const params = request.nextUrl.searchParams;

        const organizerId = params.get("organizerId");

        if (!organizerId) {
            throw AppError.validation("organizerId wajib diisi.", {
                fields: [{ path: "organizerId", message: "Wajib diisi." }],
            });
        }

        const report = await getOrganizerPicFeeReport(organizerId, {
            from: params.get("from"),
            to: params.get("to"),
            eventId: params.get("eventId"),
        });

        return ok(report);
    });
}
