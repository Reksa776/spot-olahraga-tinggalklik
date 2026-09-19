import type { NextRequest } from "next/server";

import { handleApi, paginated } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { listOwnTickets } from "@/lib/ticketing/tickets/service";
import { ticketWalletQuerySchema } from "@/lib/ticketing/tickets/validation";

/**
 * GET /api/ticketing/tickets — the buyer's own tickets (design §26.5).
 *
 * PROTECTED. `/api/ticketing/` is in `proxy.ts`'s PROTECTED_API_PREFIXES, and this route
 * also resolves the session itself — the proxy is defence in depth, not the control.
 *
 * WHY NOT `/api/tickets` (the design's §26.5 path): the retail tree owned `/api/orders/**`
 * when this was built, and the ticketing surface is namespaced under `/api/ticketing/**`
 * for consistency with every other ticketing route. See
 * `app/api/ticketing/checkout/route.ts` for the full collision analysis.
 *
 * Read-only, so no `requireSameOrigin`: the Phase 3 origin check applies to state-changing
 * methods (D-56), and requiring an `Origin` header on a plain read would break the
 * server-rendered wallet page that fetches it.
 *
 * THE WALLET IS PRIVATE. Brief §37: "Never make `/api/ticketing/tickets/[ticketCode]` public
 * merely because ticketCode is opaque." The same holds for the list. Ownership is applied as
 * a predicate inside the query (`holderUserId = session.user.id`), so there is no code path
 * that can return another buyer's ticket regardless of what the query string says.
 *
 * NO QR IN THE LIST — design §26.5: "The QR token is not returned by the list endpoint —
 * only by the single-ticket endpoint, so a list response cached or logged anywhere cannot
 * leak scannable credentials." The list payload therefore omits `qr` entirely.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const scope = await requireAuth();

        const query = parseOrThrow(
            ticketWalletQuerySchema,
            Object.fromEntries(request.nextUrl.searchParams.entries())
        );

        const result = await listOwnTickets(query, scope);

        return paginated(result.items, result.pagination);
    });
}
