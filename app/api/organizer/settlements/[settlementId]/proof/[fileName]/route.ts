import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { ERROR_CODES, AppError } from "@/lib/api/errors";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { readSettlementProof } from "@/lib/ticketing/settlement/service";
import { settlementIdParamSchema } from "@/lib/ticketing/settlement/validation";

/**
 * /api/organizer/settlements/[settlementId]/proof/[fileName] — serve a stored proof.
 *
 * NOT a static file endpoint: every request re-checks the settlement's tenancy and the
 * caller's `settlement.proof.upload` against the row's OWN organizer, then requires the
 * requested `fileName` to be EXACTLY the stored `proofFilePath` (a basename guard in
 * `proof.ts` also strips any path prefix). A mismatched or missing file is an ordinary
 * 404, same as any API miss.
 *
 * Responses are bytes with `X-Content-Type-Options: nosniff` and an inline
 * `Content-Disposition` so the trust verdict stays with the caller.
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ settlementId: string; fileName: string }> }
) {
    await requireAuth();

    const { settlementId, fileName } = await params;

    const parsedId = parseOrThrow(settlementIdParamSchema, settlementId);
    const parsedName = parseOrThrow(settlementIdParamSchema, fileName);

    const proof = await readSettlementProof(parsedId, parsedName);

    if (!proof) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Bukti transfer tidak ditemukan.",
        });
    }

    return new NextResponse(new Uint8Array(proof.buffer), {
        status: 200,
        headers: {
            "Content-Type": proof.contentType,
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    });
}