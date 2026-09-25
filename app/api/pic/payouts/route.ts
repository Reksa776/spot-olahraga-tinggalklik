import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { created, handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import {
    createMyPicPayoutRequest,
    listMyPicPayoutRequests,
    listMyPicSettleableOrganizers,
} from "@/lib/pic/payout";
import { picPayoutRequestSchema } from "@/lib/ticketing/settlement/validation";

/**
 * /api/pic/payouts — the PIC's OWN payout requests (PHASE 21).
 *
 * PROTECTED via the `/api/pic/` prefix in `proxy.ts`; `requireAuth()` is the real session
 * control and the proxy entry is defence in depth. Own-scope authority is resolved INSIDE
 * the service by `requireMyPic(event, pic_payout.request.own)` — the ACTIVE profile of
 * the session user, with an identity check that makes a forged caller a denial. The route
 * accepts NO `picProfileId`; the PIC's profile comes from the session only.
 *
 * ── GET (read) ───────────────────────────────────────────────────────────────────
 * Returns the caller's own requests (newest first, bank masked) AND the per-tenant
 * settleable amounts they may request. Read-only, so no same-origin check.
 *
 * ── POST (create request) ────────────────────────────────────────────────────────
 * State-changing, so the same-origin check runs first. The body names ONE `organizerId`
 * (and an optional note) and nothing else: no amount, no status, no bank. The service
 * claims the PIC's eligible ledger rows transactionally and lands the request as
 * `REQUESTED` for operator review. The PIC can never approve, pay or attach their own
 * transfer evidence.
 */

export const runtime = "nodejs";

export async function GET() {
    return handleApi(async () => {
        const scope = await requireAuth();

        const [requests, organizers] = await Promise.all([
            listMyPicPayoutRequests(scope.userId),
            listMyPicSettleableOrganizers(scope.userId),
        ]);

        return ok({ requests, organizers });
    });
}

export async function POST(request: NextRequest) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();

        const body = await request.json().catch(() => null);

        if (!body || typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const input = parseOrThrow(picPayoutRequestSchema, body);

        const payload = await createMyPicPayoutRequest(scope.userId, input);

        return created(payload);
    });
}
