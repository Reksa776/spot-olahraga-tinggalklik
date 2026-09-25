import { NextResponse, type NextRequest } from "next/server";

import { handleApi } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { withUtf8Bom } from "@/lib/csv";
import { exportMyPicFeeCsv } from "@/lib/pic/reporting";

/**
 * /api/reports/my-pic-fee/export — the PIC's OWN fee CSV.
 *
 * PROTECTED. Own-scope authority: `pic_fee.read.own` AND `report.export.own_pic_fee`, both
 * resolved from the session's ACTIVE profile. Money is emitted as the exact `Decimal(14,2)`
 * string; untrusted text columns are neutralised against spreadsheet formula injection;
 * UTF-8 with BOM. The export is the WHOLE filtered set — never the JSON report's page.
 */

export const runtime = "nodejs";

function csvResponse(csv: string): NextResponse {
    return new NextResponse(withUtf8Bom(csv), {
        status: 200,
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="pic-fee-ledger.csv"',
            "Cache-Control": "no-store",
        },
    });
}

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const scope = await requireAuth();
        const params = request.nextUrl.searchParams;

        const csv = await exportMyPicFeeCsv(scope.userId, {
            from: params.get("from"),
            to: params.get("to"),
            eventId: params.get("eventId"),
            type: params.get("type"),
            status: params.get("status"),
        });

        return csvResponse(csv);
    });
}
