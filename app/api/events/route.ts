import type { NextRequest } from "next/server";

import { parseOrThrow } from "@/lib/api/validation";
import { handleApi, paginated } from "@/lib/api/response";
import { getAppOrigin } from "@/lib/app-origin";
import { listPublicEvents } from "@/lib/events/catalog";
import { catalogQuerySchema } from "@/lib/events/validation";

/**
 * GET /api/events — public catalog (design §25.2)
 *
 * PUBLIC. No session is required and none is read: the visibility filter is
 * hard-coded in `publicVisibilityWhere` (PUBLISHED + PUBLIC + not archived + not past),
 * so nothing a caller sends can widen it. A DRAFT or UNLISTED event is unreachable
 * here regardless of query parameters.
 *
 * Classified as public in `proxy.ts` PUBLIC_API_PREFIXES; the route-classification
 * test fails if that ever stops being true.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const query = parseOrThrow(
            catalogQuerySchema,
            Object.fromEntries(request.nextUrl.searchParams.entries())
        );

        const origin = getAppOrigin(request);

        const result = await listPublicEvents(query, origin);

        return paginated(result.items, result.pagination);
    });
}
