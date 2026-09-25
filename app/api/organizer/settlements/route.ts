import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { created, handleApi, paginated } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { listSettlements, prepareSettlement } from "@/lib/ticketing/settlement/service";
import {
    prepareSettlementSchema,
    settlementListQuerySchema,
} from "@/lib/ticketing/settlement/validation";

/**
 * /api/organizer/settlements — prepare a payout (POST) and list payouts (GET).
 *
 * PIC PAYOUT / SETTLEMENT V1 — the rail is a MANUAL bank transfer with system control
 * (Option C, D-P17-04 = B). The operator is an organizer member holding
 * `settlement.prepare` (MANAGER / FINANCE by role; ADMIN/OWNER per the membership grant
 * policy D-19). Money never moves here: `POST` only DRAFTS a settlement (the payee's
 * bank is snapshotted and the EARNED fee lines are claimed). The payout itself happens
 * through `paid`, later, from `APPROVED`.
 *
 * PROTECTED via the `/api/organizer/` prefix in `proxy.ts`; `requireAuth()` is the real
 * session control and the proxy entry is defence in depth, exactly like the PIC routes.
 *
 * ── POST (prepare) ────────────────────────────────────────────────────────────────
 * The client sends the tenant (`organizerId`), the payee (`picProfileId`) and the
 * window (`periodStart` / `periodEnd`). It never sends an amount, a status or a bank:
 * the money is derived from the PIC's EARNED ledger rows in the window and the bank is
 * copied from the profile. State-changing, so the Phase 3 same-origin check runs first.
 * A window that was already prepared either replays the existing DRAFT or, if it was
 * closed (CANCELLED / FAILED), is refused (the operator must adjust the window).
 *
 * ── GET (list) ────────────────────────────────────────────────────────────────────
 * Read-only, so no `requireSameOrigin`. Without `organizerId` the caller sees every
 * organizer they hold `settlement.prepare` in; with it, `listSettlements` puts the id
 * through the same decider, so a forged tenant is a 404, never a window into someone
 * else's payouts.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const scope = await requireAuth();

        const query = parseOrThrow(
            settlementListQuerySchema,
            Object.fromEntries(request.nextUrl.searchParams.entries())
        );

        const result = await listSettlements(scope, query);

        return paginated(result.items, {
            page: query.page ?? 1,
            limit: query.limit ?? 20,
            total: result.total,
        });
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

        const input = parseOrThrow(prepareSettlementSchema, body);

        const payload = await prepareSettlement(input, scope);

        return created(payload);
    });
}