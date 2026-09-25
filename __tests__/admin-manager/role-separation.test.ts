/**
 * ==========================================
 * PHASE 32 — ADMIN vs MANAGER (PURE ROLE SEPARATION)
 * ==========================================
 *
 * The executable statement of the phase's business model:
 *
 *   ADMIN   = full operational access PLUS application control
 *   MANAGER = full operational access, NO application control
 *
 * Pure by construction — no database, no NextAuth, no HTTP. It imports the deciders
 * directly (not the `@/lib/authz` barrel, which re-exports `guards.ts` → `@/auth` →
 * next-auth), so every assertion below is about the permission maps themselves.
 *
 * ── WHAT "APPLICATION CONTROL" MEANS HERE ───────────────────────────────────────
 * Three platform-scope permissions:
 *
 *   `application.settings`  read/write the application's own configuration
 *   `maintenance.manage`    switch the application's availability
 *   `branding.manage`       upload/replace/remove the application logo
 *
 * They are the ONLY authority this phase adds. Everything else is a claim that the
 * separation did not cost MANAGER an operational capability — which is asserted, not
 * assumed, because "give the admin more" is trivially achievable by taking something
 * away from the operator, and that would be the wrong change.
 */

import type { OrganizerMemberRole } from "@prisma/client";

import {
    ALL_PERMISSIONS,
    PERMISSIONS,
    PERMISSION_SCOPE,
    decideOrganizerPermission,
    decideOwnResourcePermission,
    decidePlatformPermission,
    type AuthzScope,
    type GrantEntry,
    type OrganizerScopeEntry,
} from "@/lib/authz/permissions";

const ORG_A = "organizer-a";
const ORG_B = "organizer-b";
const USER_1 = "user-1";

/** The three PHASE 32 capabilities, in one place so no test can forget one. */
const APPLICATION_CONTROL = [
    PERMISSIONS.APPLICATION_SETTINGS,
    PERMISSIONS.MAINTENANCE_MANAGE,
    PERMISSIONS.BRANDING_MANAGE,
] as const;

/** Every operational capability a fully operational role must hold in its own tenant. */
const OPERATIONAL_TENANT_PERMISSIONS = [
    PERMISSIONS.EVENT_READ,
    PERMISSIONS.EVENT_WRITE,
    PERMISSIONS.EVENT_PUBLISH,
    PERMISSIONS.EVENT_BANNER_UPLOAD,
    PERMISSIONS.VENUE_MANAGE,
    PERMISSIONS.TICKET_TYPE_WRITE,
    PERMISSIONS.TICKET_TYPE_QUOTA_CHANGE,
    PERMISSIONS.TICKET_TYPE_PRICE_CHANGE,
    PERMISSIONS.ORDER_READ_TENANT,
    PERMISSIONS.ORDER_CANCEL,
    PERMISSIONS.PAYMENT_READ_TENANT,
    PERMISSIONS.PAYMENT_RECONCILE,
    PERMISSIONS.REFUND_REQUEST,
    PERMISSIONS.REFUND_APPROVE,
    PERMISSIONS.REFUND_EXECUTE,
    PERMISSIONS.PIC_ASSIGN,
    PERMISSIONS.PIC_ATTRIBUTION_READ_ALL,
    PERMISSIONS.PIC_FEE_READ_ALL,
    PERMISSIONS.FEE_RATE_CHANGE,
    PERMISSIONS.FEE_ADJUST,
    PERMISSIONS.FEE_MARK_PAID,
    PERMISSIONS.SETTLEMENT_PREPARE,
    PERMISSIONS.SETTLEMENT_APPROVE,
    PERMISSIONS.SETTLEMENT_PROOF_UPLOAD,
    PERMISSIONS.CHECKIN_SCAN,
    PERMISSIONS.CHECKIN_OVERRIDE,
    PERMISSIONS.CHECKIN_LOG_READ,
    PERMISSIONS.REPORT_TRANSACTION_READ,
    PERMISSIONS.REPORT_EVENT_SALES_READ,
] as const;

/** Platform authority a MANAGER must never hold (§5 exclusions 5-7). */
const PLATFORM_GOVERNANCE = [
    PERMISSIONS.USER_MANAGE,
    PERMISSIONS.ROLE_MANAGE,
    PERMISSIONS.PLATFORM_CONFIG,
    PERMISSIONS.SPORT_MANAGE,
    PERMISSIONS.VENUE_MANAGE_GLOBAL,
    PERMISSIONS.PIC_MANAGE,
] as const;

function membership(
    organizerId: string,
    role: OrganizerMemberRole
): OrganizerScopeEntry {
    return { organizerId, role, status: "ACTIVE" };
}

function scopeFor(
    platformRole: AuthzScope["platformRole"],
    over: Partial<AuthzScope> = {}
): AuthzScope {
    return {
        userId: USER_1,
        platformRole,
        organizerScopes: [],
        grants: [],
        ...over,
    };
}

const grant = (
    organizerId: string | null,
    permission: string
): GrantEntry => ({ organizerId, permission });

/* ==================================================================================
 * 1. THE THREE NEW CAPABILITIES ARE PLATFORM-SCOPE AND ADMIN-ONLY
 * ================================================================================== */

describe("application control is platform-scope and ADMIN-only", () => {
    test("each of the three permissions is declared and classified PLATFORM", () => {
        for (const permission of APPLICATION_CONTROL) {
            expect(ALL_PERMISSIONS.has(permission)).toBe(true);
            expect(PERMISSION_SCOPE.get(permission)).toBe("PLATFORM");
        }
    });

    test("ADMIN holds all three at the platform level", () => {
        const admin = scopeFor("ADMIN");

        for (const permission of APPLICATION_CONTROL) {
            expect({
                permission,
                allowed: decidePlatformPermission(admin, permission).allowed,
            }).toEqual({ permission, allowed: true });
        }
    });

    test("MANAGER holds none of them — even with a tenant membership", () => {
        // The membership is present on purpose: the exclusion must not depend on the actor
        // being a "mere" MANAGER with no tenant. An operator with every operational
        // capability still has no application control.
        const manager = scopeFor("MANAGER", {
            organizerScopes: [membership(ORG_A, "OWNER"), membership(ORG_A, "MANAGER")],
        });

        for (const permission of APPLICATION_CONTROL) {
            const decision = decidePlatformPermission(manager, permission);

            expect({ permission, allowed: decision.allowed }).toEqual({
                permission,
                allowed: false,
            });
        }
    });

    test("PIC and CUSTOMER hold none of them", () => {
        for (const role of ["PIC", "CUSTOMER"] as const) {
            const scope = scopeFor(role);

            for (const permission of APPLICATION_CONTROL) {
                expect(
                    decidePlatformPermission(scope, permission).allowed
                ).toBe(false);
            }
        }
    });

    test("no ORGANIZER path can resolve them, for any membership role", () => {
        // They are PLATFORM-scope, so the organizer decider must refuse them outright —
        // which is what makes "an organizer OWNER cannot change branding inside their own
        // tenant" structural rather than a special case.
        for (const role of [
            "OWNER",
            "ADMIN",
            "MANAGER",
            "FINANCE",
            "PIC",
            "CHECKIN_STAFF",
        ] as OrganizerMemberRole[]) {
            const scope = scopeFor("CUSTOMER", {
                organizerScopes: [membership(ORG_A, role)],
            });

            for (const permission of APPLICATION_CONTROL) {
                expect(
                    decideOrganizerPermission(scope, ORG_A, permission).allowed
                ).toBe(false);
            }
        }
    });

    test("no OWN path can resolve them", () => {
        const admin = scopeFor("ADMIN");

        for (const permission of APPLICATION_CONTROL) {
            expect(
                decideOwnResourcePermission(admin, permission, USER_1).allowed
            ).toBe(false);
        }
    });

    test("a PermissionGrant cannot manufacture application control for MANAGER", () => {
        // Grants are consulted only for `ADMIN_GRANT_REQUIRED` permissions. None of the
        // three is in that set, so a hand-written grant row changes nothing — §5.2's
        // "never the union of loose grants" holds for system control too.
        const manager = scopeFor("MANAGER", {
            organizerScopes: [membership(ORG_A, "MANAGER")],
            grants: APPLICATION_CONTROL.map((permission) =>
                grant(null, permission)
            ),
        });

        for (const permission of APPLICATION_CONTROL) {
            expect(
                decidePlatformPermission(manager, permission).allowed
            ).toBe(false);
        }
    });
});

/* ==================================================================================
 * 2. MANAGER IS FULLY OPERATIONAL
 * ================================================================================== */

describe("MANAGER keeps every operational capability", () => {
    test("all operational tenant permissions resolve inside an ACTIVE membership", () => {
        const manager = scopeFor("MANAGER", {
            organizerScopes: [membership(ORG_A, "MANAGER")],
        });

        for (const permission of OPERATIONAL_TENANT_PERMISSIONS) {
            const decision = decideOrganizerPermission(
                manager,
                ORG_A,
                permission
            );

            // Named in the failure so a regression reports WHICH capability was lost.
            expect({
                permission,
                allowed: decision.allowed,
            }).toEqual({ permission, allowed: true });
        }
    });

    test("the operational capability set is identical to a platform ADMIN's, MINUS application control", () => {
        // The precise statement of "full operational access". ADMIN also holds the
        // grant-required financial permissions by grant only (D-19) — which is a SEPARATE,
        // pre-existing control this phase deliberately does not touch — so the comparison
        // is made over the permissions a MANAGER is expected to hold and asserts that an
        // ADMIN holds each one too. A capability ADMIN alone lacks would mean the phase
        // shipped ADMIN as the weaker operator.
        const admin = scopeFor("ADMIN", {
            organizerScopes: [membership(ORG_A, "OWNER")],
        });

        const missingFromAdmin = OPERATIONAL_TENANT_PERMISSIONS.filter(
            (permission) =>
                !decideOrganizerPermission(admin, ORG_A, permission).allowed
        );

        // D-19 is the ONLY sanctioned exception, and it is named here so that if a future
        // change adds another, this test says which one.
        const D19_GRANT_REQUIRED = [
            PERMISSIONS.PAYMENT_RECONCILE,
            PERMISSIONS.REFUND_APPROVE,
            // REFUND_EXECUTE / FEE_* / SETTLEMENT_* are grant-required for ADMIN too.
            PERMISSIONS.REFUND_EXECUTE,
            PERMISSIONS.FEE_RATE_CHANGE,
            PERMISSIONS.FEE_ADJUST,
            PERMISSIONS.FEE_MARK_PAID,
            PERMISSIONS.SETTLEMENT_PREPARE,
            PERMISSIONS.SETTLEMENT_APPROVE,
            PERMISSIONS.SETTLEMENT_PROOF_UPLOAD,
        ];

        for (const permission of missingFromAdmin) {
            expect(D19_GRANT_REQUIRED).toContain(permission);
        }
    });

    test("operational authority still requires a membership — no implicit tenant spanning", () => {
        const managerNoMembership = scopeFor("MANAGER");

        expect(
            decideOrganizerPermission(
                managerNoMembership,
                ORG_A,
                PERMISSIONS.EVENT_WRITE
            ).allowed
        ).toBe(false);
    });

    test("cross-tenant access stays denied for MANAGER (tenant isolation unchanged)", () => {
        const manager = scopeFor("MANAGER", {
            organizerScopes: [membership(ORG_A, "MANAGER")],
        });

        expect(
            decideOrganizerPermission(manager, ORG_A, PERMISSIONS.EVENT_WRITE)
                .allowed
        ).toBe(true);
        expect(
            decideOrganizerPermission(manager, ORG_B, PERMISSIONS.EVENT_WRITE)
                .allowed
        ).toBe(false);
    });
});

/* ==================================================================================
 * 3. MANAGER'S EXCLUSIONS (§5) — SYSTEM-LEVEL GOVERNANCE
 * ================================================================================== */

describe("MANAGER cannot reach platform governance or system configuration", () => {
    test("none of the platform-governance permissions resolve", () => {
        const manager = scopeFor("MANAGER", {
            organizerScopes: [membership(ORG_A, "MANAGER")],
        });

        for (const permission of PLATFORM_GOVERNANCE) {
            expect({
                permission,
                allowed: decidePlatformPermission(manager, permission).allowed,
            }).toEqual({ permission, allowed: false });
        }
    });

    test("the only platform permission a MANAGER holds is the audit-log read", () => {
        // Pinned as an exact set rather than a spot check: if this phase (or a later one)
        // quietly widened MANAGER's platform surface, the extra name shows up here.
        const manager = scopeFor("MANAGER");
        const held = [...ALL_PERMISSIONS].filter(
            (permission) =>
                decidePlatformPermission(manager, permission).allowed
        );

        expect(held).toEqual([PERMISSIONS.AUDIT_LOG_READ]);
    });

    test("an organizer OWNER membership does not confer application control either", () => {
        // Guards against the tempting "make the owner an admin" shortcut: platform-scope
        // authority is not reachable from tenant membership, whatever role it carries.
        const owner = scopeFor("CUSTOMER", {
            organizerScopes: [membership(ORG_A, "OWNER")],
        });

        for (const permission of APPLICATION_CONTROL) {
            expect(
                decidePlatformPermission(owner, permission).allowed
            ).toBe(false);
        }
    });
});
