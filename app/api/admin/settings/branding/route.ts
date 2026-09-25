import type { NextRequest } from "next/server";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { created, handleApi, ok } from "@/lib/api/response";
import { getApplicationBranding } from "@/lib/app-settings";
import {
    removeBrandingLogo,
    uploadBrandingLogo,
} from "@/lib/application/service";
import { requireAuth, requirePlatformPermission } from "@/lib/authz";
import { PERMISSIONS } from "@/lib/authz/permissions";
import { requireSameOrigin } from "@/lib/csrf";
import { rateLimiters } from "@/lib/rate-limit";

/**
 * ==========================================
 * /api/admin/settings/branding — APPLICATION LOGO (PHASE 32)
 * ==========================================
 *
 * Upload, replace and remove the application logo. ADMIN ONLY, via `branding.manage`, which
 * is a platform-scope permission held exclusively by ADMIN (see `lib/authz/permissions.ts`).
 *
 *    GET    → the currently configured logo reference
 *    POST   → multipart `file`; upload and make it the configured logo
 *    DELETE → remove the configured logo (fall back to the built-in brand mark)
 *
 * ── THE UPLOAD ORDER IS THE SECURITY PROPERTY (§11 / §26) ────────────────────────
 * `uploadBrandingLogo` validates the BYTES (magic bytes, size, structure), strips metadata,
 * generates the filename server-side and only then points the database at the asset. This
 * handler never touches the filesystem and never trusts the submitted filename or MIME type,
 * which is what makes path traversal and extension spoofing structural impossibilities
 * rather than filters that have to be right.
 *
 * The upload rate limit is the repository's EXISTING `rateLimiters.upload` bucket (20/min per
 * user), applied before the multipart body is read — the same control the event-image route
 * uses, reused rather than re-tuned.
 *
 * No PATCH: "replace" is just a POST that succeeds when a logo already exists, and the audit
 * action distinguishes the two from the server-side `beforeState`. A separate replace verb
 * would be a second endpoint that does the identical thing.
 */

export const runtime = "nodejs";

export async function GET() {
    return handleApi(async () => {
        await requirePlatformPermission(PERMISSIONS.BRANDING_MANAGE);

        // Read through the same accessor the public chrome uses, so what the ADMIN sees
        // previewed is exactly what the landing page will render.
        const branding = await getApplicationBranding();

        return ok(branding);
    });
}

export async function POST(request: NextRequest) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();

        const limit = rateLimiters.upload(scope.userId);

        if (!limit.allowed) {
            throw new AppError(ERROR_CODES.RATE_LIMITED, {
                details: { retryAfterMs: limit.retryAfterMs },
            });
        }

        const formData = await request.formData().catch(() => null);

        if (!formData) {
            throw AppError.validation("Form data tidak valid.");
        }

        const file = formData.get("file");

        if (!(file instanceof File)) {
            throw AppError.validation("File logo wajib diupload.");
        }

        const result = await uploadBrandingLogo(scope, file, request);

        return created(result);
    });
}

export async function DELETE(request: NextRequest) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();

        const result = await removeBrandingLogo(scope, request);

        return ok(result);
    });
}
