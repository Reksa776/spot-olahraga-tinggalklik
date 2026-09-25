import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { handleApi } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { readRefundEvidenceForOrganizer } from "@/lib/ticketing/refunds/service";
import {
    refundEvidenceFileNameSchema,
    refundIdParamSchema,
} from "@/lib/ticketing/refunds/validation";

/**
 * /api/organizer/refunds/[refundId]/evidence/[fileName] — SERVE the stored evidence to staff.
 *
 * NOT a static file endpoint. Every request re-checks the refund's OWN organizer and the
 * caller's `REFUND_EXECUTE` inside the service (the same rails `settleRefund` runs under),
 * and the requested `fileName` must be EXACTLY the key the refund row names. A mismatch, a
 * missing row or a missing file is an ordinary 404.
 *
 * The response is the raw bytes with `X-Content-Type-Options: nosniff` and an inline
 * `Content-Disposition`, so the stored (sniffed) content type stays the verdict.
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ refundId: string; fileName: string }> }
) {
    return handleApi(async () => {
        await requireAuth();

        const { refundId, fileName } = await params;

        const parsedId = parseOrThrow(refundIdParamSchema, refundId);
        const parsedName = parseOrThrow(refundEvidenceFileNameSchema, fileName);

        const evidence = await readRefundEvidenceForOrganizer(parsedId, parsedName);

        if (!evidence) {
            throw new AppError(ERROR_CODES.NOT_FOUND, {
                message: "Bukti transfer tidak ditemukan.",
            });
        }

        return new NextResponse(new Uint8Array(evidence.buffer), {
            status: 200,
            headers: {
                "Content-Type": evidence.contentType,
                "Content-Disposition": "inline",
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, no-store",
            },
        });
    });
}
