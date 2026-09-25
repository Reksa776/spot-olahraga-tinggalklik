import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { getMyPicFeeReport } from "@/lib/pic/reporting";

/**
 * /api/reports/my-pic-fee — the PIC's OWN fee report (JSON).
 *
 * PROTECTED (`/api/reports/` is in the proxy's protected list). Authority is own-scope:
 * `getMyPicFeeReport` resolves the ACTIVE PIC profile from the SESSION user and requires
 * `pic_fee.read.own`; no client-supplied picProfileId is accepted. Filters are parsed and
 * validated server-side (an unknown type/status is a 400, not a silently-ignored filter).
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const scope = await requireAuth();
        const params = request.nextUrl.searchParams;

        const report = await getMyPicFeeReport(scope.userId, {
            from: params.get("from"),
            to: params.get("to"),
            eventId: params.get("eventId"),
            type: params.get("type"),
            status: params.get("status"),
            page: params.get("page"),
            pageSize: params.get("pageSize"),
        });

        return ok(report);
    });
}
