import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { orderNumberParamSchema } from "@/lib/ticketing/checkout-validation";
import { getOwnOrder } from "@/lib/ticketing/orders";

/**
 * /api/ticketing/orders/[orderNumber] — the buyer's own order (design §26.2).
 *
 * PROTECTED. `/api/ticketing/` is in `proxy.ts`'s PROTECTED_API_PREFIXES.
 *
 * WHY NOT `/api/orders/[orderNumber]` (the design's §26.2 path): when this was built the
 * retail tree owned `/api/orders/**` with a `[id]` dynamic segment, and Next.js rejects
 * two different dynamic segment names at the same position. Retail has since been
 * deleted, but the ticketing surface stays under `/api/ticketing/**` rather than moving
 * a live endpoint. See the note in `app/api/ticketing/checkout/route.ts`.
 *
 * Read-only, so no `requireSameOrigin` — the Phase 3 origin check applies to
 * state-changing methods (GET is exempt by design, and requiring an Origin header on a
 * plain navigation would break the page that fetches this).
 *
 * The `orderNumber` in the URL is DATA. Ownership comes from the session: the query
 * filters on `userId` and anything else is `NOT_FOUND`, so enumerating order numbers
 * reveals nothing (brief §14).
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ orderNumber: string }> }
) {
    return handleApi(async () => {
        const scope = await requireAuth();
        const { orderNumber } = await params;

        const payload = await getOwnOrder(
            parseOrThrow(orderNumberParamSchema, orderNumber),
            scope
        );

        return ok(payload);
    });
}
