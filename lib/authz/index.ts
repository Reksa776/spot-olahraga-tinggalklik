/**
 * ==========================================
 * PHASE 3 — AUTHORIZATION FOUNDATION
 * ==========================================
 *
 * Public surface of the ticketing authorization layer.
 *
 *   errors.ts       — `AuthzError` + fail-closed HTTP mapping
 *   permissions.ts  — permission vocabulary, capability maps, pure decisions
 *   scope.ts        — database-backed scope resolution + D-48 staleness bound
 *   guards.ts       — the `require*` enforcement points used by routes
 *
 * Typical route usage:
 *
 *   import {
 *       authzErrorResponse,
 *       isAuthzError,
 *       requireOrganizerAccess,
 *   } from "@/lib/authz";
 *
 *   try {
 *       await requireOrganizerAccess(organizerId, "event.write");
 *   } catch (error) {
 *       if (isAuthzError(error)) return authzErrorResponse(error);
 *       throw error;
 *   }
 *
 * Nothing in this module trusts a client-supplied `role`, `platformRole`,
 * `organizerId`, `memberId`, `permission` or `userId` as authority. Identity comes
 * from the server-side session; authority comes from the database.
 */

export {
    AuthzError,
    AuthzErrorCode,
    authzErrorResponse,
    isAuthzError,
} from "./errors";

export {
    ADMIN_GRANT_REQUIRED,
    ALL_PERMISSIONS,
    ORGANIZER_SPANNING_PLATFORM_ROLES,
    PERMISSIONS,
    PERMISSION_SCOPE,
    decideOrganizerPermission,
    decideOwnResourcePermission,
    decidePlatformPermission,
    hasActiveMembership,
    type AuthzDecision,
    type AuthzScope,
    type GrantEntry,
    type OrganizerScopeEntry,
    type Permission,
    type PermissionScope,
} from "./permissions";

export {
    AUTHZ_SCOPE_TTL_MS,
    isScopeStale,
    resolveAuthzScope,
} from "./scope";

export {
    getAuthzScope,
    requireAuth,
    requireOrganizerAccess,
    requireOrganizerMember,
    requireOwnResource,
    requirePlatformPermission,
    requirePlatformRole,
} from "./guards";
