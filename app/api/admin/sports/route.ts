import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { created, handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { createSport, listSportsForAdmin } from "@/lib/sports/service";
import { createSportSchema } from "@/lib/sports/validation";

/**
 * /api/admin/sports — platform sport master data (requirement brief §15)
 *
 * PROTECTED (`/api/admin/` is already in the proxy's protected list) and additionally
 * guarded by `sport.manage`, which is a **platform-scope** permission held only by
 * `ADMIN`. No organizer membership confers it, so an organizer OWNER or MANAGER cannot
 * edit the platform taxonomy from inside their tenant.
 *
 * This route never seeds. The canonical taxonomy stays in `prisma/seed-sports.ts`
 * (deterministic and idempotent, per the brief), so there is exactly one source of
 * truth for sports and the 14 seeded rows cannot be duplicated by an API call that
 * reuses a name — a duplicate name is refused by `resolveSportSlug` on the slug.
 */

export const runtime = "nodejs";

export async function GET() {
    return handleApi(async () => {
        const scope = await requireAuth();

        const result = await listSportsForAdmin(scope);

        return ok(result.items);
    });
}

export async function POST(request: NextRequest) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();

        const body = await request.json().catch(() => null);

        if (!body || typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const input = parseOrThrow(createSportSchema, body);

        const sport = await createSport(scope, input, request);

        return created(sport);
    });
}
