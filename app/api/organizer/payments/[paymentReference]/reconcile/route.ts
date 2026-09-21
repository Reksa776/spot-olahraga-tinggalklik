import type { NextRequest } from "next/server";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { reconcilePayment } from "@/lib/ticketing/payment/reconciliation";

/**
 * ==========================================
 * POST /api/organizer/payments/[paymentReference]/reconcile
 * ==========================================
 *
 * OPERATOR-TRIGGERED payment verification (Phase 27E). Checks one payment against the
 * provider's own transaction-status API and, if the provider's answer proves the payment
 * was made, runs the EXISTING settlement engine for it.
 *
 * ── THE BODY IS EMPTY, ON PURPOSE ───────────────────────────────────────────────
 * There is no `transactionId`, no `amount`, no `status`, and no `organizerId` input. Every
 * value that decides anything is read server-side:
 *
 *   actor      → the session (`requireAuth`)
 *   tenant     → `Payment.organizerId`, then `requireOrganizerAccess(…, PAYMENT_RECONCILE)`
 *   reference  → the URL segment, which must match a payment the actor may reconcile
 *   trx id     → `Payment.providerTransactionId`, captured from the provider at creation
 *   amount     → the provider's own answer, compared exactly against BOTH the payment and
 *                the order total
 *   paid/not   → the provider's numeric status (`1 | 6 | 7`), never a redirect state
 *
 * A caller-supplied transaction id would let an operator point the provider query at
 * somebody else's transaction; a caller-supplied amount would let them satisfy their own
 * check. Neither is accepted, and the schema has no place to put them.
 *
 * A payment in another tenant is refused by the authorization layer with the platform's
 * usual cross-tenant answer (404 rather than 403, design §7.4), so this route does not
 * confirm the existence of a reference the caller may not touch.
 *
 * ── WHY A PROVIDER OUTAGE IS A 503 AND NOT A 200 ─────────────────────────────────
 * `PROVIDER_ERROR` means "no trustworthy evidence was obtained — retry", which is the
 * platform's existing `PROVIDER_UNAVAILABLE` contract (503) that the buyer-facing payment
 * path already uses. Returning 200 for it would tell monitoring that verification
 * succeeded when nothing was verified. The four business verdicts — reconciled, already
 * settled, provider says not yet, blocked — are 200 with an explicit `data.result`, because
 * each is a legitimate answer with an operator-readable message.
 *
 * ── WHAT THIS ROUTE CANNOT DO ───────────────────────────────────────────────────
 * It cannot mark a payment PAID directly, cannot settle a terminal order (`D-P19-04`), and
 * cannot issue tickets: settlement's own CAS decides, exactly as it does for the webhook.
 */

export const runtime = "nodejs";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ paymentReference: string }> }
) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();
        const { paymentReference } = await params;

        const result = await reconcilePayment(scope, paymentReference, {
            request,
        });

        if (result.result === "PROVIDER_ERROR") {
            // The audit row is already written by the service, so the failed attempt is
            // recorded even though this response carries no `result` field.
            throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, {
                message: result.message,
            });
        }

        return ok(result);
    });
}
