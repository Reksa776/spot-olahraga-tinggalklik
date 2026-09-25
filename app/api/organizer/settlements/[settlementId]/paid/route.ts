import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { paySettlement } from "@/lib/ticketing/settlement/service";
import { markPaidSchema, settlementIdParamSchema } from "@/lib/ticketing/settlement/validation";

/**
 * /api/organizer/settlements/[settlementId]/paid — record the MANUAL BANK TRANSFER and
 * MOVE THE MONEY.
 *
 * The single most sensitive route in the feature. It is served on the organizer prefix
 * and CSRF-checked, then the service:
 *
 *   1. requires `settlement.approve` against the row's OWN tenant — the SAME capability the
 *      approve step uses, held BY ROLE by MANAGER (platform role) and by the membership
 *      roles OWNER / MANAGER / FINANCE, and by ADMIN only with an explicit
 *      `PermissionGrant` (D-19). It deliberately does NOT require `settlement.proof.upload`:
 *      the proof is enforced as DATA rather than as a caller capability —
 *      `markSettlementPaid` refuses unless `Settlement.proofFilePath` is already set
 *      (`PROOF_REQUIRED`), and uploading it happens on the separate proof route.
 *   2. enforces the separation of duties against the person who PREPARED the payout,
 *   3. CASes `APPROVED → PAID` and, atomically, marks the claim lines SETTLED, links the
 *      offsetting REVERSAL rows and appends the one-per-item PAYOUT DEBIT ledger rows
 *      (with the audit row in the same transaction),
 *   4. refuses when a fresh REVERSAL has landed on a claimed order item since prepare
 *      (the operator must fail and re-prepare).
 *
 * `providerReference` is REQUIRED evidence of the manual transfer (min 3 chars) — a
 * payout may never reach PAID without one. It persists on `providerReference`; it is
 * never an iPaymu id.
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

        const body = await request.json().catch(() => null);

        if (!body || typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const input = parseOrThrow(markPaidSchema, body);

        const payload = await paySettlement(parsedId, input, scope);

        return ok(payload);
    });
}