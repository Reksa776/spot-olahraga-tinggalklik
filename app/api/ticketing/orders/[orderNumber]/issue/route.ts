import type { NextRequest } from "next/server";

import { created, handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { orderNumberParamSchema } from "@/lib/ticketing/checkout-validation";
import { issueTicketsForOrder } from "@/lib/ticketing/tickets/issuance";

/**
 * POST /api/ticketing/orders/[orderNumber]/issue — materialise the tickets of a PAID order.
 *
 * PROTECTED and state-changing: `requireSameOrigin` (Phase 3's D-56 control) plus
 * `requireAuth`, plus the ownership predicate inside the service. `/api/ticketing/` is
 * already classified as protected in `proxy.ts`, which is defence in depth over the real
 * control.
 *
 * Nested under the Phase 6 order route for the same reason `/pay` and `/cancel` are: the
 * resource being fulfilled is the path's own order, which makes the ownership predicate
 * structural rather than a separate lookup.
 *
 * ── WHY THIS ROUTE EXISTS (and the design divergence it represents) ──────────────
 * The design's ideal is that issuance happens INSIDE the settlement transaction, triggered
 * by the verified webhook:
 *
 *   §5.1 line 201   "a server-verified webhook as the **only** issuance trigger"
 *   §11.4 line 965  "Atomic CAS settlement ... extended to also move quota and issue tickets"
 *   §31.5 line 2733 "The webhook is the **only** trigger for settlement and issuance."
 *   §21 line 2631   "Issuance additionally runs only when the settlement CAS reports
 *                    `affectedRows = 1`"
 *
 * Phase 7 built that settlement and deliberately did NOT issue tickets — issuance was out of
 * its brief — and this phase's brief forbids modifying it (brief §18: "Do NOT modify ...
 * `lib/ticketing/payment/settlement.ts` unless a proven Phase 7 bug directly blocks
 * issuance"). Brief §17 resolves the resulting gap explicitly: "If Phase 7 currently has no
 * issuance callback/hook, implement a dedicated ticket issuance service that can safely be
 * invoked after payment."
 *
 * So this endpoint is the invocation path. What it does NOT do is what the design's rule
 * actually protects: it cannot settle a payment, cannot mark an order paid, and is
 * unreachable for an order the webhook has not already settled (the eligibility gate
 * requires `status = PAID`, `paymentStatus = PAID` and a non-null `paidAt`). The buyer's
 * request materialises tickets for an already-settled order; it never makes the order paid.
 * The invariant that the webhook is the only writer of payment state is intact.
 *
 * The design's *uniqueness* invariants — §21 row 4, C-04, C-15 — are intact too, and are
 * enforced by the database rather than by the trigger's location:
 * `Ticket.(orderItemId, sequenceNo)` is unique, so a second issuance can create nothing, and
 * `Ticket` rows are the source of truth for "already issued" rather than a status flag.
 *
 * RATE / REPLAY: there is no idempotency key here, and none is needed. The operation is
 * naturally idempotent at the database level — calling it N times yields exactly
 * `SUM(quantity)` rows — so a duplicated request is a no-op rather than a second fulfilment.
 * It also returns `outcome: "ALREADY_ISSUED"` with `200` instead of `201`, so a client can
 * tell "I fulfilled this" from "it was already fulfilled".
 */

export const runtime = "nodejs";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ orderNumber: string }> }
) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();
        const { orderNumber } = await params;

        const result = await issueTicketsForOrder({
            orderNumber: parseOrThrow(orderNumberParamSchema, orderNumber),
            actor: scope,
            request,
        });

        return result.outcome === "ISSUED" ? created(result) : ok(result);
    });
}
