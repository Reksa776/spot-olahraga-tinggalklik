import { AppError } from "@/lib/api/errors";
import {
    PERMISSIONS,
    decideOrganizerPermission,
    decidePlatformPermission,
    type AuthzScope,
} from "@/lib/authz";

/**
 * ==========================================
 * DASHBOARD SCOPE — ONE DEFINITION OF "WHICH TENANTS"
 * ==========================================
 *
 * Every back-office read in `lib/dashboard/**` starts here. The lesson of the rest of
 * this codebase is that "which organizer may this actor read" must have exactly one
 * answer, or two surfaces diverge and one of them leaks. `lib/events/service.ts`
 * already owns that answer for events (`readableOrganizerIds`); this module generalises
 * it to any permission string using the SAME decision function the API guards use, so a
 * dashboard list cannot be scoped more loosely than the API behind it.
 *
 * Nothing here trusts a client value. `requested` (an organizer id from a URL) is put
 * through `decideOrganizerPermission` and a refusal throws — it is never used as the
 * filter directly.
 */

/** Organizer ids in which the actor holds `permission`, per the real decider. */
export function organizerIdsWith(
    scope: AuthzScope,
    permission: string
): string[] {
    return scope.organizerScopes
        .filter(
            (membership) =>
                decideOrganizerPermission(
                    scope,
                    membership.organizerId,
                    permission
                ).allowed
        )
        .map((membership) => membership.organizerId);
}

/** Does the actor hold `permission` in ANY organizer? */
export function hasOrganizerPermission(
    scope: AuthzScope,
    permission: string
): boolean {
    return organizerIdsWith(scope, permission).length > 0;
}

/** Does the actor hold a platform-scope `permission`? */
export function hasPlatformPermission(
    scope: AuthzScope,
    permission: string
): boolean {
    return decidePlatformPermission(scope, permission).allowed;
}

/**
 * Resolve the organizer-id filter for a list.
 *
 * With `requested` absent the filter is every organizer the actor may read — never an
 * unscoped query. With `requested` present it is that one organizer, but only after the
 * decider allows it; a forged value is a refusal, not a wider filter.
 *
 * A refusal throws `AppError` carrying the decider's own code (so a cross-tenant attempt
 * stays a 404 for `ORGANIZER_ACCESS_DENIED` rather than degrading to a generic 403) —
 * the same shape `listOrganizerEvents` uses.
 */
export function resolveOrganizerFilter(
    scope: AuthzScope,
    permission: string,
    requested?: string | null
): string[] {
    if (requested) {
        const decision = decideOrganizerPermission(
            scope,
            requested,
            permission
        );

        if (!decision.allowed) {
            throw new AppError(decision.code, { message: "Akses ditolak." });
        }

        return [requested];
    }

    return organizerIdsWith(scope, permission);
}

/**
 * The capability set the dashboard shell renders its menu from.
 *
 * Computed on the SERVER from the permission map and passed to the client shell, which
 * only draws rows. A menu item is not an access control — every one of these booleans is
 * mirrored by a service check — but computing them in one place is what stops the menu
 * and the services from disagreeing about who sees what.
 */
export type DashboardCapabilities = {
    /** Platform-scope master data and settings. */
    canManageSports: boolean;
    canManageGlobalVenues: boolean;
    canManagePlatformPic: boolean;
    /** Tenant-scoped ticketing surfaces. */
    canReadEvents: boolean;
    canManageEvents: boolean;
    canReadOrders: boolean;
    canReadPayments: boolean;
    canAssignPic: boolean;
    canManageVenues: boolean;
    canReadReports: boolean;
    /** `checkin.scan` in any tenant — drives the "Scan Tiket" gate surface. */
    canCheckIn: boolean;
    /** True when the actor can read no tenant at all (drives the empty state). */
    hasTenantAccess: boolean;
};

/**
 * May this actor enter the back office at all?
 *
 * TRUE when they hold EITHER a tenant capability (an organizer membership with a dashboard
 * permission) OR a platform capability (sports / global venues / PIC). A platform ADMIN with
 * no membership must be able to open the dashboard; an organizer OWNER with no platform role
 * must be able to open it too. A plain CUSTOMER holds neither and is the only actor refused.
 *
 * This is the entry gate, NOT the data boundary — every page re-decides its own read, so an
 * actor here can still be shown a denial by the page they open.
 *
 * It lives beside the capability computation so the layout and its tests cannot disagree
 * about what "has access" means.
 */
export function canEnterDashboard(
    capabilities: DashboardCapabilities
): boolean {
    const hasPlatformSurface =
        capabilities.canManageSports ||
        capabilities.canManageGlobalVenues ||
        capabilities.canManagePlatformPic;

    return capabilities.hasTenantAccess || hasPlatformSurface;
}

export function computeDashboardCapabilities(
    scope: AuthzScope
): DashboardCapabilities {
    const canReadEvents = hasOrganizerPermission(scope, PERMISSIONS.EVENT_READ);
    const canReadOrders = hasOrganizerPermission(
        scope,
        PERMISSIONS.ORDER_READ_TENANT
    );

    return {
        canManageSports: hasPlatformPermission(
            scope,
            PERMISSIONS.SPORT_MANAGE
        ),
        canManageGlobalVenues: hasPlatformPermission(
            scope,
            PERMISSIONS.VENUE_MANAGE_GLOBAL
        ),
        canManagePlatformPic: hasPlatformPermission(
            scope,
            PERMISSIONS.PIC_MANAGE
        ),
        canReadEvents,
        canManageEvents: hasOrganizerPermission(
            scope,
            PERMISSIONS.EVENT_WRITE
        ),
        canReadOrders,
        canReadPayments: hasOrganizerPermission(
            scope,
            PERMISSIONS.PAYMENT_READ_TENANT
        ),
        canAssignPic: hasOrganizerPermission(scope, PERMISSIONS.PIC_ASSIGN),
        canManageVenues: hasOrganizerPermission(
            scope,
            PERMISSIONS.VENUE_MANAGE
        ),
        canReadReports:
            hasOrganizerPermission(scope, PERMISSIONS.REPORT_TRANSACTION_READ) ||
            hasOrganizerPermission(scope, PERMISSIONS.REPORT_EVENT_SALES_READ),
        canCheckIn: hasOrganizerPermission(scope, PERMISSIONS.CHECKIN_SCAN),
        hasTenantAccess:
            canReadEvents ||
            canReadOrders ||
            hasOrganizerPermission(scope, PERMISSIONS.PAYMENT_READ_TENANT) ||
            hasOrganizerPermission(scope, PERMISSIONS.PIC_ASSIGN) ||
            hasOrganizerPermission(scope, PERMISSIONS.VENUE_MANAGE) ||
            hasOrganizerPermission(scope, PERMISSIONS.CHECKIN_SCAN),
    };
}
