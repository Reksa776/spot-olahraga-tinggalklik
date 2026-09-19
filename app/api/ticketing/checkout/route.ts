import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { created, handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { createTicketOrder } from "@/lib/ticketing/checkout";
import {
    checkoutRequestSchema,
    idempotencyKeySchema,
} from "@/lib/ticketing/checkout-validation";

/**
 * /api/ticketing/checkout — create a ticketing order and hold the quota (design §25.5).
 *
 * PROTECTED: `/api/ticketing/` is in `proxy.ts`'s PROTECTED_API_PREFIXES, so this
 * subtree is classified without per-route entries; `requireAuth()` below is the real
 * control and the proxy entry is defence in depth.
 *
 * ── WHY THIS IS NOT `POST /api/checkout` ─────────────────────────────────────────
 * Design §25.5 specifies `POST /api/checkout`. When this route was built, that path was
 * already taken by the retail checkout route (`app/api/checkout/route.ts`), and Phase 3
 * established that live request contracts are not silently changed, so the design's path
 * could not be used without breaking retail.
 *
 * The retail application has since been deleted outright, so the collision is gone — but
 * the ticketing path is KEPT as `/api/ticketing/**`. It is the shape every ticketing
 * route (and the proxy classification) is written against, and renaming a live endpoint
 * to chase a design sketch would break deployed clients for no functional gain.
 *
 * Note the collision was not merely cosmetic: `/api/orders/[orderNumber]` would also have
 * collided with the retail `/api/orders/[id]` tree, and Next.js rejects two different
 * dynamic segment names at the same position.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────────
 * No payment session, no iPaymu call, no ticket rows, no QR. The response is a
 * *payment-ready* order in `PENDING_PAYMENT` with `paymentUrl: null`; creating the
 * provider session is Phase 7 and the brief forbids invoking the gateway here.
 *
 * ── IDEMPOTENCY IS REQUIRED (design §25.5 / §30.1 row 1) ─────────────────────────
 * The `Idempotency-Key` header is mandatory. §30.1 lists checkout as an operation that
 * "must be idempotent" and names the mechanism exactly — a client key scoped to
 * `(userId, endpoint, key)` with a unique constraint, so a double submit returns the
 * existing order "instead of reserving quota twice". A missing header is refused rather
 * than silently treated as unique, because a client retrying after a timeout is the
 * normal case this protects, and a server-generated key would let exactly that retry
 * create a second order.
 */

export const runtime = "nodejs";

/** Header name, per §30.1. HTTP header lookup is case-insensitive by spec. */
const IDEMPOTENCY_HEADER = "idempotency-key";

export async function POST(request: NextRequest) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();

        const rawKey = request.headers.get(IDEMPOTENCY_HEADER);

        if (!rawKey) {
            throw AppError.validation(
                `Header ${IDEMPOTENCY_HEADER} wajib diisi.`,
                {
                    header: IDEMPOTENCY_HEADER,
                    reason: "IDEMPOTENCY_KEY_REQUIRED",
                }
            );
        }

        const idempotencyKey = parseOrThrow(idempotencyKeySchema, rawKey);

        const body = await request.json().catch(() => null);

        if (!body || typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        // Zod strips undeclared keys, so a client-supplied `price`, `total`, `subtotal`,
        // `currency`, `organizerId`, `userId` or `status` cannot reach the service
        // (brief §17 / §13). The parsed value is the only input the pricing code sees.
        const input = parseOrThrow(checkoutRequestSchema, body);

        const outcome = await createTicketOrder({
            request: input,
            actor: scope,
            idempotencyKey,
            // Only for the audit row's IP / user-agent (brief §27). The buyer's name,
            // email and phone are deliberately NOT copied into the audit payload.
            httpRequest: request,
        });

        // 201 for a real creation, 200 for an idempotent replay of the same request
        // (§30.1: "Returns the existing order (200/201)").
        return outcome.replayed ? ok(outcome.payload) : created(outcome.payload);
    });
}
