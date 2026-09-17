import { prisma } from "@/lib/prisma";

import type { AuthzScope } from "./permissions";

/**
 * ==========================================
 * PHASE 3 — AUTHORIZATION SCOPE RESOLUTION
 * ==========================================
 *
 * Turns a trusted server-side user id into the authorization scope that
 * `lib/authz/permissions.ts` then makes decisions against.
 *
 * The ONLY input is a user id that came from the session (or from a test that
 * constructed it deliberately). No part of a scope is ever built from a request
 * body, query string, path segment, header or cookie value supplied by a client.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * D-48 — SCOPE STALENESS (approved: ≤60 s cache with invalidation on revocation)
 * ─────────────────────────────────────────────────────────────────────────────
 * `AUTHZ_SCOPE_TTL_MS` is the approved staleness bound. `auth.ts` caches the
 * resolved scope in the JWT and refreshes it from this function when the cached
 * copy is older than the TTL. The trade-off is explicit and bounded: a
 * revocation (membership revoked, grant withdrawn) takes effect within at most
 * this window for a session that is already open, and immediately for any new
 * session or any request that triggers a refresh.
 *
 * The TTL lives here, next to resolution, so the bound cannot drift between the
 * resolver and the consumer.
 */
export const AUTHZ_SCOPE_TTL_MS = 60_000;

/**
 * Resolve the scope for a user.
 *
 * Returns `null` when the user does not exist — the caller must treat that as
 * unauthenticated (fail closed), never as "no restrictions".
 *
 * Note on `platformRole`: `User.platformRole` is nullable (Phase 2 left it
 * nullable so the retail `role` column was untouched). A null value resolves to
 * `CUSTOMER`, which holds no platform-wide capability. There is deliberately **no
 * implicit bridge** from the legacy retail role (`Role.ADMIN`) to a platform
 * role: deriving `ADMIN` from a legacy column would be a hidden privilege grant,
 * which the phase 3 brief §21 forbids. `platformRole` is assigned explicitly by
 * an auditable operation.
 */
export async function resolveAuthzScope(
    userId: string
): Promise<AuthzScope | null> {
    const [user, memberships, grants] = await Promise.all([
        prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, platformRole: true },
        }),

        // Every membership is fetched, including non-ACTIVE ones. The ACTIVE
        // requirement is enforced in ONE place (`decideOrganizerPermission` and
        // `hasActiveMembership`) rather than by a WHERE clause here, so a
        // suspended or revoked membership is visible to the decision function
        // and cannot become authorization through a resolver change.
        prisma.organizerMember.findMany({
            where: { userId },
            select: {
                organizerId: true,
                role: true,
                status: true,
            },
        }),

        prisma.permissionGrant.findMany({
            where: { userId, revokedAt: null },
            select: {
                organizerId: true,
                permission: true,
            },
        }),
    ]);

    if (!user) {
        return null;
    }

    return {
        userId: user.id,
        platformRole: user.platformRole ?? "CUSTOMER",
        organizerScopes: memberships.map((m) => ({
            organizerId: m.organizerId,
            role: m.role,
            status: m.status,
        })),
        grants: grants.map((g) => ({
            organizerId: g.organizerId,
            permission: g.permission,
        })),
    };
}

/**
 * Has the cached scope outlived the approved staleness bound?
 * `undefined` (a legacy token issued before Phase 3) is always stale.
 */
export function isScopeStale(
    refreshedAt: number | undefined,
    now: number = Date.now()
): boolean {
    if (typeof refreshedAt !== "number" || !Number.isFinite(refreshedAt)) {
        return true;
    }
    return now - refreshedAt >= AUTHZ_SCOPE_TTL_MS;
}
