import { NextResponse, type NextRequest } from "next/server";

import { created, handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { getMaintenanceState } from "@/lib/app-settings";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { assertPurchasingAvailable } from "@/lib/maintenance";
import { rateLimiters } from "@/lib/rate-limit";
import { orderNumberParamSchema } from "@/lib/ticketing/checkout-validation";
import { createOrderPayment } from "@/lib/ticketing/payment/service";
import { paymentCreateRequestSchema } from "@/lib/ticketing/payment/validation";

/**
 * POST /api/ticketing/orders/[orderNumber]/pay — create or resume a payment session.
 *
 * Design §26.3 is `POST /api/orders/{orderNumber}/pay`, described as "create or resume
 * payment ... validate eligibility → re-reserve quota if it was released → create a new
 * provider session".
 *
 * ── WHY THIS PATH, AND WHAT CHANGED FROM §26.3 ───────────────────────────────────
 * The design's path was unusable at the time: `/api/orders/**` was the retail order tree
 * with a `[id]` dynamic segment, and Next.js rejects two different dynamic segment names
 * at the same position. Retail has since been deleted, but — following the precedent
 * Phase 4 set for `/api/admin/**` and Phase 6 for checkout — the ticketing surface stays
 * under `/api/ticketing/**` rather than renaming a live endpoint.
 *
 * The route is nested under the existing Phase 6 order route rather than a parallel
 * `/api/ticketing/payment/create`, because brief §26 says to "use the existing Phase 6
 * order route if already sufficient" and not to "create duplicate order routes". Nesting
 * also makes the ownership predicate structural: the resource being paid is the path's own
 * order.
 *
 * ── WHAT IS DELIBERATELY NOT IMPLEMENTED ─────────────────────────────────────────
 * The `re-reserve quota if it was released` clause. Re-reserving means reviving an order
 * that already left `PENDING_PAYMENT`, i.e. repayment, and `D-09` — whether a
 * cancelled/expired order repays at the original or the current price — is
 * `DECISION REQUIRED` in the design register and was carried forward unresolved by Phase 6.
 * Brief §4 forbids implementing repayment while that is open, so the service refuses a
 * terminal order with a machine-readable pointer to `D-09` instead of guessing a price.
 *
 * ── CLIENT-INPUT DISCIPLINE ──────────────────────────────────────────────────────
 * The body may contain a payment method and channel and nothing else. `paymentCreateRequestSchema`
 * declares no financial field, so a tampered `amount`/`total`/`currency`/`organizerId`
 * cannot reach the service (brief §7/§17) — asserted by test.
 *
 * `requireSameOrigin` is present because this is state-changing (Phase 3's D-56 control),
 * and `/api/ticketing/` is already classified as protected in `proxy.ts`, which is defence
 * in depth over the real control (`requireAuth` + the ownership predicate).
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

        /*
         * PHASE 32 — MAINTENANCE CLOSES PAYMENT INITIATION.
         *
         * Checked BEFORE the rate limiter on purpose: a closed site must not consume a
         * buyer's (or a probing client's) payment-creation budget, and more importantly a
         * 503 here must not be reported as "too many attempts". This is the second of the
         * two endpoints that can move money; both refuse while maintenance is ON.
         */
        assertPurchasingAvailable(await getMaintenanceState());

        /*
         * RATE LIMIT (the `paymentCreation` bucket).
         *
         * Opening a provider session is an outbound, credential-bearing, rate-limited call to
         * a paid third party, and this endpoint is reachable by any signed-in buyer. Without a
         * bucket, one account can drive that call as fast as it can send requests — which the
         * provider answers by throttling the MERCHANT, i.e. every other buyer. The bucket has
         * existed in `lib/rate-limit.ts` since the payment work; this is the route that uses
         * it. The limit is generous (5 per 5 minutes per user) because a buyer legitimately
         * retries after a failure, and it counts ATTEMPTS, not successful sessions: a burst of
         * failures is exactly the pattern worth stopping.
         *
         * It runs AFTER authentication so the bucket keys on the real user id rather than on a
         * spoofable IP, and it returns the registry's 429 with a Retry-After so a client can
         * back off instead of hammering.
         */
        const limit = rateLimiters.paymentCreation(scope.userId);

        if (!limit.allowed) {
            // Seconds, rounded UP, so a client that honours Retry-After is not told to come
            // back marginally too early and burn another attempt.
            const retryAfterSeconds = Math.max(
                1,
                Math.ceil(limit.retryAfterMs / 1000)
            );

            return NextResponse.json(
                {
                    success: false,
                    code: "RATE_LIMITED",
                    message:
                        "Terlalu banyak percobaan pembayaran. Coba lagi beberapa saat lagi.",
                    details: { retryAfterSeconds },
                },
                {
                    status: 429,
                    headers: { "Retry-After": String(retryAfterSeconds) },
                }
            );
        }

        // An empty body is valid: every field is optional (all of them are presentation
        // choices, none of them is financial).
        const body = await request.json().catch(() => ({}));
        const input = parseOrThrow(paymentCreateRequestSchema, body ?? {});

        const payload = await createOrderPayment({
            orderNumber: parseOrThrow(orderNumberParamSchema, orderNumber),
            actor: scope,
            request: input,
            // Required, not optional: the callback URLs are built from it through the
            // host-allowlisted `lib/app-origin.ts`.
            httpRequest: request,
        });

        // 201 when a provider session was actually created, 200 when a live one was
        // returned (design §30.1 row 2: "Returns the existing `paymentUrl` rather than
        // creating a second session").
        return payload.resumed ? ok(payload) : created(payload);
    });
}
