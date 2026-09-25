import { NextResponse, type NextRequest } from "next/server";

import { handleApi } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import {
    exportDashboardReport,
    parseDashboardReportExportFormat,
} from "@/lib/dashboard/export";
import { resolveDashboardReportFilters } from "@/lib/dashboard/reports";

/**
 * /api/organizer/reports/export — the tenant transaction report as a download.
 *
 * PROTECTED (the `/api/organizer/` prefix in `proxy.ts` is defence in depth; the real controls are
 * below). `requireAuth()` resolves the session, then the service asks the real decider for BOTH
 * `report.transaction.read` and `report.export.transaction` and refuses with a 403 when either is
 * missing — never an empty file, which an operator would reasonably read as "no sales".
 *
 * The filters are parsed by the SAME `resolveDashboardReportFilters` the reports page uses, in
 * `strict` mode: this is an API, so an unrecognised status or an impossible range is a 400 rather
 * than silently ignored, and `resolveOrganizerFilter` re-decides every organizer id that came from
 * the query string. A forged `organizerId` is a refusal, not a wider export.
 *
 * `format=csv` returns the order-level transaction rows with a UTF-8 BOM. `format=xlsx` returns the
 * multi-sheet workbook (Ringkasan / Pesanan / Penjualan Tiket / Refund / Pencairan). Both are built
 * from the same dataset the reports page renders, so the download and the screen cannot disagree.
 *
 * `runtime = "nodejs"`: the xlsx archive is deflated with `node:zlib`, which the Edge runtime does
 * not provide.
 */

export const runtime = "nodejs";

/**
 * Narrow the export body to something `Response` accepts.
 *
 * A `Uint8Array` is not assignable to `BodyInit` under this project's TypeScript settings (the
 * buffer is typed `ArrayBufferLike`, which admits `SharedArrayBuffer`), so the archive is copied
 * into a plain `ArrayBuffer`. The copy is also what keeps the socket write independent of any
 * later mutation of the buffer the xlsx builder returned.
 */
function toBody(body: string | Uint8Array): BodyInit {
    if (typeof body === "string") {
        return body;
    }

    const copy = new ArrayBuffer(body.byteLength);
    new Uint8Array(copy).set(body);

    return copy;
}

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const scope = await requireAuth();
        const params = request.nextUrl.searchParams;

        const format = parseDashboardReportExportFormat(params.get("format"));

        const filters = resolveDashboardReportFilters(
            {
                organizerId: params.get("organizerId"),
                from: params.get("from"),
                to: params.get("to"),
                period: params.get("period"),
                eventId: params.get("eventId"),
                status: params.get("status"),
            },
            { strict: true }
        );

        const result = await exportDashboardReport(scope, filters, format);

        return new NextResponse(toBody(result.body), {
            status: 200,
            headers: {
                "Content-Type": result.contentType,
                "Content-Disposition": `attachment; filename="${result.fileName}"`,
                "Cache-Control": "no-store",
                // A download carries attacker-influencable text (an event title, a buyer name).
                // With the type pinned and sniffing off, a browser cannot be talked into treating
                // the bytes as anything other than what this route says they are.
                "X-Content-Type-Options": "nosniff",
            },
        });
    });
}
