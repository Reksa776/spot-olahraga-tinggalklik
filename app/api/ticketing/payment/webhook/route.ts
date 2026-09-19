import type { NextRequest } from "next/server";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { getClientIp } from "@/lib/rate-limit";
import { handleGatewayWebhook } from "@/lib/ticketing/payment/webhook";

/**
 * POST /api/ticketing/payment/webhook — the provider's settlement notification.
 *
 * ── THIS ROUTE IS NOT CUSTOMER-AUTHENTICATED, AND MUST NOT BE ────────────────────
 * Brief §25 is explicit: the webhook "is NOT a customer-authenticated route; it MUST be
 * protected by gateway signature verification; it MUST NOT use customer session
 * authentication as its trust boundary". iPaymu cannot hold a session, so the trust
 * boundary is the HMAC signature over the exact raw bytes — verified fail-closed inside
 * `handleGatewayWebhook` before anything is parsed or resolved.
 *
 * For that reason the route is listed in `proxy.ts`'s `PUBLIC_API_PREFIXES`. The proxy
 * checks public prefixes BEFORE protected ones, so this single path is reachable without a
 * session even though its parent `/api/ticketing/` prefix is protected. The route-
 * classification test keeps that explicit: every route must be classified one way or the
 * other, and "public because a provider posts to it" is a classification, not an omission.
 *
 * ── WHY THIS IS THE ONLY SETTLEMENT TRIGGER ──────────────────────────────────────
 * Design §31.5 rule 3: "The webhook is the **only** trigger for settlement and issuance.
 * The browser redirect and the polling endpoint never mutate state." This handler is the
 * whole trigger; nothing in the order page or in the pay route can mark an order paid.
 *
 * ── THE RAW BODY IS READ, NEVER RE-PARSED ────────────────────────────────────────
 * `request.text()` is what the signature covers. The body is not read as JSON first and
 * re-serialized (which would change the bytes and break verification), and the parsed
 * fields are treated as untrusted claims until the signature has been checked.
 *
 * `runtime = "nodejs"` because the handler needs Node's `crypto` for HMAC — this cannot run
 * on the Edge runtime.
 */

export const runtime = "nodejs";

/**
 * Header carrying the provider's HMAC, when it sends one. Lookup is case-insensitive by HTTP
 * spec.
 *
 * It is NOT the only accepted location: iPaymu documents its signature as a `signature` FIELD in
 * the callback body, so `verifyCallbackSignature` reads the header first and falls back to that
 * field. Exactly one of the two is ever checked, so this is a widened source, not a weaker check.
 */
const SIGNATURE_HEADER = "x-signature";

export async function POST(request: NextRequest) {
    return handleApi(async () => {
        const rawBody = await request.text();

        const result = await handleGatewayWebhook({
            rawBody,
            signatureHeader: request.headers.get(SIGNATURE_HEADER),
            remoteIp: getClientIp(request),
        });

        // The provider only reads the status code, but the body stays inside the platform's
        // single error/success envelope (brief §23) so an operator grepping logs sees one
        // shape. `result.outcome` is an internal marker and is never returned.
        if (result.httpStatus >= 500) {
            throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
                message: result.message,
                // Logged server-side with a correlation id; the provider retries.
                expose: true,
            });
        }

        if (result.httpStatus >= 400) {
            throw new AppError(
                result.httpStatus === 401
                    ? ERROR_CODES.UNAUTHORIZED
                    : ERROR_CODES.INVALID_WEBHOOK,
                {
                    message: result.message,
                    // Preserves 413 for an oversized body, which the registry has no code
                    // for; the envelope shape is what matters, not the code's spelling.
                    status: result.httpStatus,
                }
            );
        }

        return ok({ message: result.message }, result.httpStatus);
    });
}
