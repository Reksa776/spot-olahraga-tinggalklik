import {
    PERMISSIONS,
    decideOrganizerPermission,
    getAuthzScope,
    type AuthzScope,
    type Permission,
} from "@/lib/authz";
import { findActivePicProfile } from "@/lib/pic/self-service";

import type { RealtimeAudience } from "./taxonomy";

/**
 * ==========================================
 * REALTIME AUDIENCE RESOLUTION — SERVER-SIDE, FROM THE SESSION
 * ==========================================
 *
 * A stream may deliver an event only when the caller's own authority intersects the event's
 * audience. This module computes the caller's half, and it does so from the SESSION and the
 * DATABASE only:
 *
 *   • no `userId`, `organizerId`, `picProfileId` or `tenantId` is read from the request — the
 *     query string carries nothing but the fact that this is a stream request (`/api/realtime/stream`
 *     takes no parameters at all);
 *   • the platform dimension comes from `scope.platformRole`, resolved server-side from the
 *     database by `resolveAuthzScope`;
 *   • the tenant dimension comes from running the REAL permission decider over the actor's
 *     resolved memberships, exactly like `readableOrganizerIds`, so the audience cannot drift
 *     from the authorization rules it mirrors;
 *   • the own-scope dimensions (buyer, PIC) are the actor's OWN identity — the session user id
 *     for the buyer side, and the ACTIVE `PICProfile` already resolved for them (`findActivePicProfile`,
 *     the same unguarded probe the dashboard shell uses) for the PIC side.
 *
 * ── WHY THE TENANT DIMENSION USES PERMISSIONS RATHER THAN MEMBERSHIP ────────────
 * Membership alone would tell a suspended or revoked member that something changed in a tenant
 * they can no longer read, because the membership row exists either way. Running the decision
 * function removes that leak by construction: an actor holding no realtime-relevant capability in
 * a tenant is not an audience of that tenant's events.
 *
 * ── WHAT THIS IS *NOT* ──────────────────────────────────────────────────────────
 * It is not an authorization decision for any operation. It only decides which invalidation
 * signals a connection may receive; every page still authorizes its own reads through the usual
 * guards when the client refreshes. A wrong audience can therefore cause a redundant refresh or a
 * missing one — never a data leak, because no data travels on this channel at all.
 */

/**
 * The tenant capabilities that make a membership "realtime-relevant".
 *
 * Any ONE of these means the actor can already read some of that tenant's business data, which is
 * precisely the condition under which learning "something in your tenant changed" is not a
 * disclosure. Deliberately read-shaped: a member whose only capability is, say, `event.banner.upload`
 * is not added by this list.
 */
const TENANT_REALTIME_PERMISSIONS: readonly Permission[] = [
    PERMISSIONS.EVENT_READ,
    PERMISSIONS.ORDER_READ_TENANT,
    PERMISSIONS.PAYMENT_READ_TENANT,
    PERMISSIONS.CHECKIN_LOG_READ,
    PERMISSIONS.PIC_ATTRIBUTION_READ_ALL,
    PERMISSIONS.PIC_FEE_READ_ALL,
    PERMISSIONS.REPORT_TRANSACTION_READ,
    PERMISSIONS.REPORT_EVENT_SALES_READ,
];

/** Tenants the actor may receive invalidation from, decided by the real permission function. */
export function realtimeOrganizerIds(scope: AuthzScope): string[] {
    return scope.organizerScopes
        .filter((membership) =>
            TENANT_REALTIME_PERMISSIONS.some(
                (permission) =>
                    decideOrganizerPermission(scope, membership.organizerId, permission).allowed
            )
        )
        .map((membership) => membership.organizerId);
}

/**
 * The caller's audience set, or `[]` for an anonymous request.
 *
 * `[]` intersects nothing (`audiencesIntersect`), so an unauthenticated connection is mute by
 * construction rather than by a separate check at the delivery site.
 */
export async function resolveRealtimeAudience(): Promise<RealtimeAudience[]> {
    const scope = await getAuthzScope();

    if (!scope) {
        return [];
    }

    const audiences: RealtimeAudience[] = [];

    // Platform operators see every tenant through the existing platform decision function, so the
    // platform audience adds no reach — it mirrors `platformRole === "ADMIN"` and nothing else.
    // MANAGER and PIC are tenant/own-scoped roles and are deliberately NOT platform audiences.
    if (scope.platformRole === "ADMIN") {
        audiences.push({ kind: "platform" });
    }

    for (const organizerId of realtimeOrganizerIds(scope)) {
        audiences.push({ kind: "organizer", organizerId });
    }

    // Own-scope: the session user is the buyer dimension of their own orders. This is the session
    // id, never a request value.
    audiences.push({ kind: "customer", userId: scope.userId });

    // Own-scope: the caller's ACTIVE PIC profile, if any. Unguarded by design (it is the same
    // probe the dashboard layout uses) and returns null for a suspended or absent profile, so a
    // suspended PIC receives nothing on this dimension.
    const picProfile = await findActivePicProfile(scope.userId);

    if (picProfile) {
        audiences.push({ kind: "pic", picProfileId: picProfile.id });
    }

    return audiences;
}
