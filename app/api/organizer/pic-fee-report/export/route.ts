import { NextResponse, type NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi } from "@/lib/api/response";
import { withUtf8Bom } from "@/lib/csv";
import { exportOrganizerPicFeeCsv } from "@/lib/pic/tenant-reporting";

/**
 * /api/organizer/pic-fee-report/export — per-PIC fee CSV for ONE organizer.
 *
 * PROTECTED. Authority: `report.export.pic_fee` (and, in the shared read path,
 * `pic_fee.read.all`) against the tenant named by `organizerId`, resolved from the session.
 * Money is the exact `Decimal(14,2)` string; the PIC display name is a neutralised text
 * column; UTF-8 with BOM.
 */

export const runtime = "nodejs";

function csvResponse(csv: string): NextResponse {
    return new NextResponse(withUtf8Bom(csv), {
        status: 200,
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="pic-fee-summary.csv"',
            "Cache-Control": "no-store",
        },
    });
}

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const params = request.nextUrl.searchParams;

        const organizerId = params.get("organizerId");

        if (!organizerId) {
            throw AppError.validation("organizerId wajib diisi.", {
                fields: [{ path: "organizerId", message: "Wajib diisi." }],
            });
        }

        const csv = await exportOrganizerPicFeeCsv(organizerId, {
            from: params.get("from"),
            to: params.get("to"),
            eventId: params.get("eventId"),
        });

        return csvResponse(csv);
    });
}
