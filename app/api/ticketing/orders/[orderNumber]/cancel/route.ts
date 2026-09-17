import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { orderNumberParamSchema } from "@/lib/ticketing/checkout-validation";
import { cancelOwnPendingOrder } from "@/lib/ticketing/orders";

/**
 * /api/ticketing/orders/[orderNumber]/cancel — cancel an unpaid order (design §26.4).
 *
 * PROTECTED (via the `/api/ticketing/` prefix), and state-changing, so the Phase 3
 * same-origin check runs first (D-56). Path differs from the design's
 * `/api/orders/{orderNumber}/cancel` for the collision reason documented in
 * `app/api/ticketing/checkout/route.ts`.
 * The `order.cancel.own` capability plus the ownership predicate are enforced in
 * `cancelOwnPendingOrder`; the URL's `orderNumber` is data.
 *
 * Only `PENDING_PAYMENT` orders can be cancelled. A paid order leaves the paid state
 * only through refund (design §12.3) and is refused with `ORDER_NOT_PAYABLE`.
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

        // No reason field is accepted from the client: §12.3 treats "buyer cancelled"
        // and "system/timeout" as distinct states that must not be confusable, so the
        // buyer path always records its own reason rather than a client-supplied one.
        const payload = await cancelOwnPendingOrder(
            parseOrThrow(orderNumberParamSchema, orderNumber),
            scope
        );

        return ok(payload);
    });
}
