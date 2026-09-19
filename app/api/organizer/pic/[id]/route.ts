import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { revokePicAssignment } from "@/lib/pic/service";

/**
 * /api/organizer/pic/[id] — revoke a PIC assignment.
 *
 * PROTECTED + CSRF-checked. `revokePicAssignment` loads the assignment and authorizes against the
 * organizer recorded on it, so an actor who is not a member of that tenant cannot revoke it even by
 * guessing the id.
 *
 * Revoking is SOFT (`isActive: false` + `revokedAt`): attributions and fee ledger entries may
 * already point at the pairing, and deleting the row would orphan that history.
 */

export const runtime = "nodejs";

export async function DELETE(
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

        const result = await revokePicAssignment(scope, id, request);

        return ok(result);
    });
}
