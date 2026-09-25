import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import {
    getApplicationSettingsForAdmin,
    updateMaintenanceSettings,
} from "@/lib/application/service";
import { maintenanceSettingsSchema } from "@/lib/application/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";

/**
 * ==========================================
 * /api/admin/settings/application — APPLICATION CONTROL (PHASE 32)
 * ==========================================
 *
 * The application's own configuration, and the maintenance switch inside it. ADMIN ONLY,
 * and enforced twice on purpose:
 *
 *   1. `/api/admin/` is in `proxy.ts`'s PROTECTED_API_PREFIXES, so an anonymous caller is
 *      answered 401 by the proxy (defence in depth, and it keeps the route classification
 *      test green rather than relying on a per-route comment);
 *   2. the service calls `requirePlatformPermission("application.settings")` for the read
 *      and `requirePlatformPermission("maintenance.manage")` for the write. Only ADMIN
 *      holds either, so a MANAGER — with a valid session, a correct CSRF token and a
 *      well-formed body — is refused with 403 by the same decider the menu consults.
 *
 * A GET is guarded too, even though it only reads: §9 says a MANAGER read must fail unless
 * the architecture safely allows it, and there is no operational need for a MANAGER to read
 * system application settings, so the stricter answer is taken. "Hidden UI is not
 * authorization" cuts both ways — the endpoint is what is protected, not the button.
 *
 * `runtime = "nodejs"` because the write reaches Prisma.
 */

export const runtime = "nodejs";

export async function GET() {
    return handleApi(async () => {
        const settings = await getApplicationSettingsForAdmin();

        return ok(settings);
    });
}

export async function PATCH(request: NextRequest) {
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

        // zod strips undeclared keys, so no field the schema does not name can reach the
        // write — including anything resembling a storage path or a logo URL.
        const input = parseOrThrow(maintenanceSettingsSchema, body);

        const settings = await updateMaintenanceSettings(scope, input, request);

        return ok(settings);
    });
}
