import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { attachRefundEvidence } from "@/lib/ticketing/refunds/service";
import { refundIdParamSchema } from "@/lib/ticketing/refunds/validation";

/**
 * /api/organizer/refunds/[refundId]/evidence — ATTACH the refund's transfer-evidence file.
 *
 * FILE-POST rail, the sibling of the settlement proof POST (csrf → requireAuth →
 * paramSchema → formData → the service). The service re-reads the refund row, runs the
 * settle rail's gates (organizer's OWN tenant + `REFUND_EXECUTE` + separation of duties),
 * stores the bytes via `storeRefundEvidence` (magic-sniffed, server-generated name, 5MB
 * cap on the real bytes) and pins the key with a CAS.
 *
 * Nothing is settled here: the refund stays in its current financial state, and
 * `settleRefund` remains the only way a refund reaches `REFUNDED`.
 */

export const runtime = "nodejs";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ refundId: string }> }
) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();

        const { refundId } = await params;
        const parsedId = parseOrThrow(refundIdParamSchema, refundId);

        const formData = await request.formData().catch(() => null);
        if (!formData) {
            throw AppError.validation("Form data tidak valid.");
        }

        const file = formData.get("file");
        if (!(file instanceof File) || file.size === 0) {
            throw AppError.validation("File bukti transfer wajib diisi.", {
                fields: [{ path: "file", message: "Wajib berupa file." }],
            });
        }

        const payload = await attachRefundEvidence(parsedId, file, scope, request);

        return ok(payload);
    });
}
