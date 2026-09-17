import type { PlatformRole } from "@prisma/client";

import { auth } from "@/auth";

import { AuthzError, AuthzErrorCode } from "./errors";
import {
    decideOrganizerPermission,
    decideOwnResourcePermission,
    decidePlatformPermission,
    hasActiveMembership,
    type AuthzScope,
    type Permission,
} from "./permissions";
import { resolveAuthzScope } from "./scope";

/**
 * ==========================================
 * PHASE 3 — SERVER-SIDE AUTHORIZATION GUARDS
 * ==========================================
 *
 * The single enforcement point for ticketing authorization. Every guard:
 *
 *   1. reads the actor's identity from the **server-side session** (`auth()`);
 *   2. resolves authority from the **database**, not from the session payload
 *      alone and never from the request;
 *   3. **throws** on failure. It does not return a boolean that a caller could
 *      forget to check.
 *
 * FAIL-CLOSED: if the session is missing, the user row is gone, or the requested
 * action resolves to anything other than an explicit allow, the guard throws.
 *
 * WHY THROW-ON-DENY AND NOT A RESPONSE OBJECT
 * -------------------------------------------
 * The current codebase has two shapes: `lib/admin.ts` throws bare `Error("FORBIDDEN")`
 * strings, and `lib/csrf.ts` returns `{ error: NextResponse }`. The returning
 * shape is easy to ignore — a caller that only destructures `userId` silently
 * proceeds. Throwing cannot be ignored: the request fails. Route handlers convert
 * with `authzErrorResponse()` in one catch block.
 *
 * USAGE
 * -----
 *   try {
 *       const scope = await requireOrganizerAccess(organizerId, "event.write");
 *   } catch (error) {
 *       if (isAuthzError(error)) return authzErrorResponse(error);
 *       throw error;
 *   }
 *
 * or, for an entire handler:
 *
 *   return withAuthz(async (scope) => { ... });
 */

/**
 * Resolve the current actor's scope, or `null` when unauthenticated.
 *
 * Prefer the `require*` guards. This exists for callers that legitimately need to
 * branch on "logged in or not" (for example rendering a public page), and it is
 * named so that returning `null` is obviously "no authority" rather than "no
 * restrictions".
 */
export async function getAuthzScope(): Promise<AuthzScope | null> {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
        return null;
    }

    return resolveAuthzScope(userId);
}

/** Require any authenticated actor. */
export async function requireAuth(): Promise<AuthzScope> {
    const scope = await getAuthzScope();

    if (!scope) {
        throw new AuthzError(
            AuthzErrorCode.UNAUTHORIZED,
            "no authenticated session"
        );
    }

    return scope;
}

/**
 * Require a platform-scope permission (`user.manage`, `role.manage`,
 * `platform.config`, `sport.manage`, `pic.manage`, `audit_log.read`).
 */
export async function requirePlatformPermission(
    permission: Permission
): Promise<AuthzScope> {
    const scope = await requireAuth();
    const decision = decidePlatformPermission(scope, permission);

    if (!decision.allowed) {
        throw new AuthzError(decision.code, decision.reason);
    }

    return scope;
}

/**
 * Require a specific platform role, e.g. `requirePlatformRole("ADMIN")`.
 *
 * This answers "who are you on the platform?", never "may you touch this
 * organizer?" — it confers no tenant access whatsoever.
 */
export async function requirePlatformRole(
    ...roles: readonly PlatformRole[]
): Promise<AuthzScope> {
    const scope = await requireAuth();

    if (!roles.includes(scope.platformRole)) {
        throw new AuthzError(
            AuthzErrorCode.FORBIDDEN,
            `platform role ${scope.platformRole} is not one of ${roles.join(", ")}`
        );
    }

    return scope;
}

/**
 * Require an organizer-scoped permission against a target organizer.
 *
 * `organizerId` may come from anywhere — a path segment, a query parameter, a
 * request body. That is safe by construction: this function never treats its
 * presence as authority. Authority comes from the actor's ACTIVE membership in
 * that organizer. Passing an organizer the actor is not a member of fails, and
 * fails as `ORGANIZER_ACCESS_DENIED` (HTTP 404), so the caller cannot use the
 * response to probe which organizers exist.
 */
export async function requireOrganizerAccess(
    organizerId: string,
    permission: Permission
): Promise<AuthzScope> {
    const scope = await requireAuth();

    if (!organizerId || typeof organizerId !== "string") {
        throw new AuthzError(
            AuthzErrorCode.NOT_FOUND,
            "organizerId missing"
        );
    }

    const decision = decideOrganizerPermission(scope, organizerId, permission);

    if (!decision.allowed) {
        throw new AuthzError(decision.code, decision.reason);
    }

    return scope;
}

/**
 * Require an ACTIVE membership in the organizer, optionally restricted to a set
 * of membership roles. Use this when the action has no dedicated permission
 * string (for example "list the members of my own organizer").
 */
export async function requireOrganizerMember(
    organizerId: string,
    roles?: readonly string[]
): Promise<AuthzScope> {
    const scope = await requireAuth();

    if (!organizerId || typeof organizerId !== "string") {
        throw new AuthzError(
            AuthzErrorCode.NOT_FOUND,
            "organizerId missing"
        );
    }

    if (!hasActiveMembership(scope, organizerId)) {
        throw new AuthzError(
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            `no active membership for organizer ${organizerId}`
        );
    }

    if (roles && roles.length > 0) {
        const membership = scope.organizerScopes.find(
            (m) => m.organizerId === organizerId && m.status === "ACTIVE"
        );

        if (!membership || !roles.includes(membership.role)) {
            throw new AuthzError(
                AuthzErrorCode.FORBIDDEN,
                `membership role ${membership?.role ?? "none"} is not one of ${roles.join(", ")}`
            );
        }
    }

    return scope;
}

/**
 * Require an own-scope permission against a record whose owning user is known.
 * A tenant membership confers nothing here: a membership MANAGER reading another
 * PIC's fee fails with `PIC_ACCESS_DENIED`.
 */
export async function requireOwnResource(
    permission: Permission,
    ownerUserId: string | null | undefined
): Promise<AuthzScope> {
    const scope = await requireAuth();

    if (!ownerUserId) {
        throw new AuthzError(
            AuthzErrorCode.PIC_ACCESS_DENIED,
            `own-scope permission "${permission}" requested for an unowned record`
        );
    }

    const decision = decideOwnResourcePermission(
        scope,
        permission,
        ownerUserId
    );

    if (!decision.allowed) {
        throw new AuthzError(decision.code, decision.reason);
    }

    return scope;
}
