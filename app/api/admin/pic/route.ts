import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { created, handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { createPic, listPicsForAdmin } from "@/lib/pic/service";
import { createPicSchema } from "@/lib/pic/validation";

/**
 * /api/admin/pic — platform PIC (referrer) management.
 *
 * PROTECTED (`/api/admin/` is in the proxy's protected list) and additionally guarded by
 * `pic.manage`, a **platform-scope** permission held only by the platform ADMIN role. No organizer
 * membership confers it, so an organizer OWNER or MANAGER cannot create or approve a PIC.
 *
 * This is the management surface for the ticketing PIC concept that replaces the retired retail
 * affiliate programme — it operates on the pre-existing `PICProfile` model and does not create
 * accounts (the profile is linked to an existing one by e-mail).
 */

export const runtime = "nodejs";

export async function GET() {
    return handleApi(async () => {
        const scope = await requireAuth();

        const result = await listPicsForAdmin(scope);

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

        const input = parseOrThrow(createPicSchema, body);

        const pic = await createPic(scope, input, request);

        return created(pic);
    });
}
