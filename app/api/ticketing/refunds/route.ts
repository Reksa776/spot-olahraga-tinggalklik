import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { created, handleApi, paginated } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { listRefunds, requestRefund } from "@/lib/ticketing/refunds/service";
import {
    refundListQuerySchema,
    refundRequestSchema,
} from "@/lib/ticketing/refunds/validation";

/**
 * /api/ticketing/refunds — request a refund (POST) and list refunds (GET), Phase 10B.
 *
 * PROTECTED via the `/api/ticketing/` prefix in `proxy.ts`; `requireAuth()` below is the
 * real session control and the proxy entry is defence in depth.
 *
 * ── POST (D-R01/D-R02): a buyer requests a refund for an order they own ──────────
 * The client sends an order number and, optionally, which tickets to refund. It never
 * sends an amount: the refundable value is derived from the selected tickets' purchase
 * price snapshots (`evaluateRefundEligibility`), and the OWNERSHIP predicate plus
 * `refund.request.own` are enforced in the service. State-changing, so the Phase 3
 * same-origin check runs first (D-56).
 *
 * There is deliberately NO idempotency-key requirement here, unlike checkout: the unique
 * `RefundItem.ticketId` is the database backstop (D-R10), so a double submit cannot
 * refund the same ticket twice — the second attempt is refused as already claimed.
 *
 * ── GET (D-R02): own refunds, or a tenant's with `order.read.tenant` ────────────
 * Read-only, so no `requireSameOrigin`. Without `organizerId` the caller sees only their
 * own requests (ownership is a predicate in the query); with it, the service requires
 * `order.read.tenant` for that organizer.
 */

export const runtime = "nodejs";

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

        const input = parseOrThrow(refundRequestSchema, body);

        const payload = await requestRefund(input, scope, request);

        return created(payload);
    });
}

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const scope = await requireAuth();

        const query = parseOrThrow(
            refundListQuerySchema,
            Object.fromEntries(request.nextUrl.searchParams.entries())
        );

        const result = await listRefunds(scope, query);

        return paginated(result.items, {
            page: query.page ?? 1,
            limit: query.limit ?? 20,
            total: result.total,
        });
    });
}
