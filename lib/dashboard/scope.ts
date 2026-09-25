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
    /**
     * `settlement.prepare` in any tenant — drives the "Pencairan PIC" menu row and the
     * settlement surfaces. The same permission gates list + detail reads; the financial
     * FINAL steps are re-guarded with `settlement.approve` / `settlement.proof.upload`
     * inside the API service.
     */
    canManageSettlements: boolean;
    /** `checkin.scan` in any tenant — drives the "Scan Tiket" gate surface. */
    canCheckIn: boolean;
    /** True when the actor can read no tenant at all (drives the empty state). */
    hasTenantAccess: boolean;
    /**
     * True when the actor owns an ACTIVE `PICProfile` (PIC SELF-SERVICE DASHBOARD V1).
     *
     * A pure PIC holds no tenant membership and no platform surface, so without this flag
     * `canEnterDashboard` refuses them — which was the whole defect this feature fixes.
     * It is computed as an OPTIONAL second argument rather than a field the permission
     * deciders can produce, because the flag lives on a `PICProfile` row that the pure
     * `computeDashboardCapabilities(scope)` cannot know about. Defaulting it to `false`
     * keeps every existing single-argument caller byte-identical.
     *
     * PHASE 34 — this flag no longer governs DASHBOARD ENTRY on its own: a PIC account
     * now enters via `hasPlatformRoleEntry`, and this flag decides only whether the
     * PIC SELF-SERVICE rows (`Ringkasan PIC` / `Event Saya` / `Referral` / `Pendapatan`)
     * are offered. A PENDING/SUSPENDED/REJECTED profile therefore enters the shell but
     * gets no self-service, and every self-service read re-checks `requireMyPic`.
     */
    hasActivePicProfile: boolean;
    /**
     * ── PHASE 34 — PLATFORM-ROLE DASHBOARD ENTRY ────────────────────────────────
     *
     * True when the account's PLATFORM ROLE itself admits the back-office shell, with
     * no tenant membership and no platform capability required. It is derived from the
     * authoritative `AuthzScope.platformRole` — every real platform role (ADMIN,
     * MANAGER, PIC) qualifies; a CUSTOMER does not.
     *
     * Phase 33 creates MANAGER and PIC accounts independently of organizer membership,
     * so a MANAGER may exist before any OrganizerMember row and a PIC account exists
     * while its profile is still PENDING. Both must be able to open the dashboard shell.
     * That is DASHBOARD ENTRY, not tenant data access:
     *
     *   - it confers NO tenant authority — `hasTenantAccess` stays false until an ACTIVE
     *     OrganizerMember exists, and every tenant read re-decides in its own service;
     *   - it confers NO platform capability — MANAGER keeps `audit_log.read` only;
     *   - a PIC's self-service still requires an ACTIVE PICProfile (`hasActivePicProfile`).
     */
    hasPlatformRoleEntry: boolean;
    /**
     * ── PHASE 32 — APPLICATION CONTROL (ADMIN ONLY) ──────────────────────────────
     *
     * Three PLATFORM-scope booleans that together are the ADMIN/MANAGER separation on the
     * dashboard: a MANAGER holds full operational capability and NONE of these, an ADMIN
     * holds all of them. They are computed from the same `decidePlatformPermission` the API
     * guards call, so the menu and the endpoints cannot disagree — and the endpoints are the
     * real control (hiding a row is a courtesy, never an authorization).
     *
     * They are separate fields rather than one `isSystemOwner` boolean because each gates a
     * different surface (`/dashboard/settings/application`, `.../maintenance`, `.../branding`)
     * and the role matrix pins them independently: a change that leaked one of the three to
     * MANAGER must fail a named assertion rather than collapse into a single flag.
     */
    canManageApplicationSettings: boolean;
    canManageMaintenance: boolean;
    canManageBranding: boolean;
    /**
     * ── PHASE 33 — USER MANAGEMENT (ADMIN ONLY) ────────────────────────────
     *
     * `user.manage` in the platform map — held by ADMIN alone, never grantable to another
     * role (`user.manage` is absent from `ADMIN_GRANT_REQUIRED`, and a grant cannot
     * elevate anyway). Gates the Pengguna menu row and the `/dashboard/users` surface;
     * the service re-decides every read and mutation.
     */
    canManageUsers: boolean;
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
 * A PIC with an ACTIVE profile is admitted even though the permission maps grant them no
 * tenant or platform capability — their own-scope dashboard is the whole point of the PIC
 * self-service surface. The flag is server-resolved from the database (never from the
 * request), and admission is profile-only: it confers no membership and no platform power,
 * and every self-service read still re-checks authority in the service layer.
 *
 * PHASE 34 — the gate also admits on the PLATFORM ROLE alone (`hasPlatformRoleEntry`): a
 * MANAGER with no membership yet and a PIC whose profile is still PENDING are real accounts
 * Phase 33 provisions separately from any organizer, and refusing them the shell was the
 * defect this phase fixes. The entry right is deliberately decoupled from data access —
 * tenant reads still require an ACTIVE membership and platform reads still require the
 * platform permission map, so admitting these accounts leaks nothing.
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

    return (
        capabilities.hasTenantAccess ||
        hasPlatformSurface ||
        capabilities.hasActivePicProfile ||
        capabilities.hasPlatformRoleEntry
    );
}

export function computeDashboardCapabilities(
    scope: AuthzScope,
    context: { hasActivePicProfile?: boolean } = {}
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
        canManageSettlements: hasOrganizerPermission(
            scope,
            PERMISSIONS.SETTLEMENT_PREPARE
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
            hasOrganizerPermission(scope, PERMISSIONS.SETTLEMENT_PREPARE) ||
            hasOrganizerPermission(scope, PERMISSIONS.CHECKIN_SCAN),
        hasActivePicProfile: context.hasActivePicProfile ?? false,
        // PHASE 34 — the account's platform role is itself a dashboard-entry right. A
        // CUSTOMER holds none; every real platform role (ADMIN, MANAGER, PIC) does. This is
        // the authoritative `AuthzScope.platformRole`, resolved from the `User` row.
        hasPlatformRoleEntry: scope.platformRole !== "CUSTOMER",
        // PHASE 32 — application control, platform-scope, ADMIN-only by the map. Reset by
        // nothing else, so an actor cannot acquire them through a membership or a grant.
        canManageApplicationSettings: hasPlatformPermission(
            scope,
            PERMISSIONS.APPLICATION_SETTINGS
        ),
        canManageMaintenance: hasPlatformPermission(
            scope,
            PERMISSIONS.MAINTENANCE_MANAGE
        ),
        canManageBranding: hasPlatformPermission(
            scope,
            PERMISSIONS.BRANDING_MANAGE
        ),
        // PHASE 33 — user management joins the ADMIN-only family, resolved by the same
        // platform decider the endpoint calls.
        canManageUsers: hasPlatformPermission(scope, PERMISSIONS.USER_MANAGE),
    };
}
