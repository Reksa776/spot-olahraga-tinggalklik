import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { handleApi } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { readRefundEvidenceForBuyer } from "@/lib/ticketing/refunds/service";
import {
    refundEvidenceFileNameSchema,
    refundIdParamSchema,
} from "@/lib/ticketing/refunds/validation";

/**
 * /api/ticketing/refunds/[refundId]/evidence/[fileName] — SERVE the evidence to the OWNING
 * CUSTOMER of the refunded order.
 *
 * The buyer twin of the staff serve route, and the only surface that exists so a customer
 * can see what the organizer uploaded. It is own-scope end to end: the service checks that
 * the refund's order belongs to the actor and re-checks `ORDER_READ_OWN` against that
 * owner id. A refund for another customer's order, a cross-tenant id, and a MANAGER or
 * referral-PIC caller who is not the buyer all fail as an ordinary 404 — there is no tenant
 * branch in the service, so a membership confers nothing here.
 *
 * No `Content-Length` is set: `NextResponse` computes it from the body, and the bytes are
 * the sniffed ones the writer stored.
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ refundId: string; fileName: string }> }
) {
    return handleApi(async () => {
        const scope = await requireAuth();

        const { refundId, fileName } = await params;

        const parsedId = parseOrThrow(refundIdParamSchema, refundId);
        const parsedName = parseOrThrow(refundEvidenceFileNameSchema, fileName);

        const evidence = await readRefundEvidenceForBuyer(parsedId, parsedName, scope);

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
