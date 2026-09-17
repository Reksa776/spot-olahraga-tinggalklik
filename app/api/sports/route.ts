import { handleApi, ok } from "@/lib/api/response";
import { listPublicSports } from "@/lib/sports/service";

/**
 * GET /api/sports — public sport taxonomy
 *
 * PUBLIC. The catalog's category facet ("see sport category", requirement §3.1). Only
 * ACTIVE sports are returned, and only the fields a filter UI needs, so the admin view
 * (which includes deactivated sports and usage counts) stays behind
 * `sport.manage`.
 *
 * No mutation exists on this path: creating or editing a sport lives under
 * `/api/admin/sports` and requires the platform-scope `sport.manage` permission.
 */

export const runtime = "nodejs";

export async function GET() {
    return handleApi(async () => {
        const result = await listPublicSports();

        return ok(result.items);
    });
}
