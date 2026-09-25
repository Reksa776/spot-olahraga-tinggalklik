import type { NextRequest } from "next/server";

import { setManagedUserDisabled } from "@/lib/admin/users";
import { updateManagedUserSchema } from "@/lib/admin/users-validation";
import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";

/**
 * /api/admin/users/[id] — one managed account: enable / disable (PHASE 33, V1).
 *
 * PROTECTED + CSRF-checked. `user.manage` is enforced inside the service, which also
 * restricts the TARGET to MANAGER and PIC rows — an ADMIN account cannot be disabled
 * through this route, by anyone, including another ADMIN. There is no DELETE: user
 * deactivation is reversible (`disabledAt`), and the phase forbids deleting users or
 * business data.
 *
 * PATCH is deliberately limited to the status flag. Editing names/emails/passwords of
 * other accounts, and re-defining roles, are out of V1 scope by design (brief §M/§U).
 */
export const runtime = "nodejs";

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();
        const { id } = await params;

        const body = await request.json().catch(() => null);

        if (!body || typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const input = parseOrThrow(updateManagedUserSchema, body);

        const user = await setManagedUserDisabled(scope, id, input.disabled, request);

        return ok(user);
    });
}
