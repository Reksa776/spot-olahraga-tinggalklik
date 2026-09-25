import type { NextRequest } from "next/server";

import { handleApi, paginated } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { orderListQuerySchema } from "@/lib/ticketing/checkout-validation";
import { listOwnOrders } from "@/lib/ticketing/orders";

/**
 * /api/ticketing/orders — the buyer's own orders (design §26.1).
 *
 * PROTECTED. `/api/ticketing/` is in `proxy.ts`'s PROTECTED_API_PREFIXES, and
 * `requireAuth()` below is the real session control; the prefix entry is defence in depth.
 *
 * WHY NOT `/api/orders` (the design's §26.1 path): the same substitution the detail route
 * documents — when this surface was built, the retail tree owned `/api/orders/**`, and
 * ticketing has stayed namespaced under `/api/ticketing/**` since rather than renaming a
 * live endpoint. See `app/api/ticketing/orders/[orderNumber]/route.ts`.
 *
 * Read-only, so no `requireSameOrigin` — the Phase 3 origin check applies to
 * state-changing methods.
 *
 * NOTHING IN THE QUERY IS AUTHORITY. `status`, `dateFrom`, `dateTo`, `eventId`, `page` and
 * `limit` narrow the caller's own set; the ownership predicate (`userId = session.user.id`)
 * and the `order.read.own` capability are applied inside `listOwnOrders`, against the
 * session, and a client-supplied user identifier is not read at all. Enumerating another
 * buyer's orders is therefore not possible — their rows are not in the result set, and the
 * response carries no count that would reveal them either (the total counts only the
 * caller's own rows).
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const scope = await requireAuth();

        const query = parseOrThrow(
            orderListQuerySchema,
            Object.fromEntries(request.nextUrl.searchParams.entries())
        );

        const result = await listOwnOrders(
            {
                status: query.status,
                dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
                dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
                eventId: query.eventId,
                page: query.page,
                limit: query.limit,
            },
            scope
        );

        return paginated(result.items, {
            page: result.page,
            limit: result.limit,
            total: result.total,
        });
    });
}
