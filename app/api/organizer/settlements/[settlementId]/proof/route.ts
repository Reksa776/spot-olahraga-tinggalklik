import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { recordSettlementProof } from "@/lib/ticketing/settlement/service";
import { settlementIdParamSchema } from "@/lib/ticketing/settlement/validation";

/**
 * /api/organizer/settlements/[settlementId]/proof — upload the MANUAL TRANSFER evidence
 * (a bank statement / transfer screenshot, jpeg|png|webp|pdf, ≤ 5MB).
 *
 * Only an `APPROVED` settlement may take a proof. The evidence is trusted to be a real
 * file: magic bytes are sniffed (`proof.ts`), the file lands server-side under
 * `UPLOAD_DIR/settlement-proof/` with a server-generated name, and any claim rows are
 * untouched by this step. Re-uploading while `APPROVED` replaces the previous proof.
 *
 * The provided name is the session identity: `settlement.proof.upload` is checked
 * against the settlement's OWN organizer, like every other financial action here.
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

        const payload = await recordSettlementProof(parsedId, file, scope, request);

        return ok(payload);
    });
}