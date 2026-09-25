import type { NextRequest } from "next/server";

import { createManagedUser, listManagedUsers } from "@/lib/admin/users";
import {
    createManagedUserSchema,
    listManagedUsersQuerySchema,
} from "@/lib/admin/users-validation";
import { AppError } from "@/lib/api/errors";
import { created, handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";

/**
 * /api/admin/users — ADMIN user management (PHASE 33, V1).
 *
 * PROTECTED (`/api/admin/` is in the proxy's protected list) and additionally guarded by
 * `user.manage`, a PLATFORM-scope permission held only by the platform ADMIN role. A
 * MANAGER, PIC or CUSTOMER calling either verb is refused by the service before any query
 * runs — the menu row hiding the page is a courtesy, this is the control.
 *
 * GET  — the managed-role list (MANAGER | PIC), filterable by role/search.
 * POST — create a MANAGER or PIC account. The role arrives through a two-value Zod enum,
 *        so a body asking for ADMIN is a VALIDATION_ERROR, never a created row. Mutations
 *        are same-origin checked (CSRF), validated with Zod, written in one transaction
 *        (User + PICProfile together for a PIC), audited without credentials, and never
 *        return a password or its hash.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const scope = await requireAuth();

        const params = new URL(request.url).searchParams;

        const query = parseOrThrow(listManagedUsersQuerySchema, {
            role: params.get("role") ?? undefined,
            search: params.get("search") ?? undefined,
            page: params.get("page") ?? undefined,
        });

        const result = await listManagedUsers(scope, query);

        return ok(result);
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

        const input = parseOrThrow(createManagedUserSchema, body);

        const user = await createManagedUser(scope, input, request);

        return created(user);
    });
}
