import { redirect } from "next/navigation";

import { getAuthzScope, type AuthzScope } from "@/lib/authz";
import { readableOrganizerIds } from "@/lib/events/service";
import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * ORGANIZER PAGE CONTEXT
 * ==========================================
 *
 * Server components have no `NextRequest`, so the back office cannot reuse the API
 * guards verbatim. What it must NOT do is re-implement authorization — so this helper
 * resolves the actor through the same `getAuthzScope()` the guards use and derives the
 * organizer list through the same `readableOrganizerIds()` the event service uses.
 * There is exactly one definition of "which organizers may this actor read".
 *
 * Fail-closed behaviour:
 *
 *   no session              → redirect to /login
 *   no readable organizer   → renders an explicit "no access" state (NOT a redirect
 *                             loop, and NOT an unscoped page)
 *
 * Note that `organizerIds` is derived from database memberships and never from a
 * cookie, a query parameter or a client-supplied value.
 */

export type OrganizerPageContext = {
    scope: AuthzScope;
    organizerIds: string[];
    organizers: { id: string; name: string; slug: string }[];
    currentOrganizerId: string | null;
};

export async function getOrganizerPageContext(): Promise<OrganizerPageContext> {
    const scope = await getAuthzScope();

    if (!scope) {
        redirect("/login");
    }

    const organizerIds = readableOrganizerIds(scope);

    const organizers =
        organizerIds.length > 0
            ? await prisma.organizer.findMany({
                  where: { id: { in: organizerIds } },
                  select: { id: true, name: true, slug: true },
                  orderBy: { name: "asc" },
              })
            : [];

    return {
        scope,
        organizerIds,
        organizers,
        // D-05: single organizer at launch, so the first readable one is the working
        // context. With several memberships the operator picks the organizer through
        // the URL, and every operation is still re-authorized per request.
        currentOrganizerId: organizers[0]?.id ?? null,
    };
}
