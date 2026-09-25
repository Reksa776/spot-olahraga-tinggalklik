/**
 * ==========================================
 * ROLE → CAPABILITY MATRIX (INTEGRATION, REAL DATABASE)
 * ==========================================
 *
 * Pins the end-to-end mapping the dashboard depends on:
 *
 *   User.platformRole  →  resolveAuthzScope()  →  computeDashboardCapabilities()
 *                      →  DashboardAppShell menu
 *
 * and, separately, the backend deciders that must NOT be weakened by any of the
 * menu booleans:
 *
 *   decidePlatformPermission / decideOrganizerPermission / decideOwnResourcePermission
 *   listDashboardOrders (cross-tenant read)
 *
 * ── WHAT THE INVESTIGATION FOUND ─────────────────────────────────────────────
 * `User.role` is the LEGACY retail enum (`ADMIN|SELLER|CUSTOMER|AFFILIATOR`) and is
 * dormant; every ticketing decision reads `User.platformRole`
 * (`CUSTOMER|ADMIN|MANAGER|PIC`). A platform role alone confers **no tenant data** —
 * tenant capability requires an ACTIVE `OrganizerMember` row (the intersection rule).
 * These tests encode exactly that, so a future change that makes a platform role
 * silently span tenants fails here.
 *
 * `@/auth` is mocked so a scope can be resolved without a browser; `next/navigation`
 * and `next-auth/react` are mocked only so the server shell can be rendered to HTML.
 * Nothing about authorization is stubbed.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

jest.mock("next/navigation", () => ({
    usePathname: () => "/dashboard",
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock("next-auth/react", () => ({ signOut: jest.fn() }));

jest.mock("@/components/dashboard/theme/theme-switcher", () => ({
    ThemeQuickToggle: () => null,
    ThemeSettingsMenu: () => null,
}));

import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import DashboardAppShell from "@/components/dashboard/DashboardAppShell";
import {
    AuthzErrorCode,
    PERMISSIONS,
    decideOrganizerPermission,
    decideOwnResourcePermission,
    decidePlatformPermission,
    type AuthzScope,
} from "@/lib/authz";
import { isAppError } from "@/lib/api/errors";
import { resolveAuthzScope } from "@/lib/authz/scope";
import { listDashboardOrders } from "@/lib/dashboard/orders";
import {
    canEnterDashboard,
    computeDashboardCapabilities,
    type DashboardCapabilities,
} from "@/lib/dashboard/scope";
import { prisma } from "@/lib/prisma";

jest.setTimeout(60000);

const SUFFIX = `role-matrix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Seeded = { id: string };

let adminNoMembership: Seeded;
let adminWithMembership: Seeded;
let managerWithMembership: Seeded;
let managerNoMembership: Seeded;
let pic: Seeded;
let customer: Seeded;
let ownerA: Seeded;
let ownerB: Seeded;

let organizerA: Seeded;
let organizerB: Seeded;

function createUser(
    tag: string,
    platformRole: "ADMIN" | "MANAGER" | "PIC" | null = null
) {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            // Deliberately the LEGACY role for everyone: authority must come from
            // `platformRole`, never from this column. A platform MANAGER is a legacy
            // CUSTOMER, which is exactly the confusing case this suite guards.
            role: "CUSTOMER",
            ...(platformRole ? { platformRole } : {}),
        },
    });
}

async function scopeFor(userId: string): Promise<AuthzScope> {
    const scope = await resolveAuthzScope(userId);
    if (!scope) throw new Error(`no scope resolved for ${userId}`);
    return scope;
}

async function capabilitiesFor(userId: string): Promise<DashboardCapabilities> {
    return computeDashboardCapabilities(await scopeFor(userId));
}

/**
 * The shell as a plain component whose `children` is supplied positionally.
 * Casting lets the test use `createElement`'s children argument, which the
 * `react/no-children-prop` rule requires, without changing the component.
 */
const Shell = DashboardAppShell as ComponentType<{
    capabilities: DashboardCapabilities;
    contextLabel: string;
}>;

/** The visible destination hrefs the shell renders for a capability set. */
function menuHrefs(capabilities: DashboardCapabilities): string[] {
    const html = renderToStaticMarkup(
        createElement(Shell, { capabilities, contextLabel: "Test" }, createElement("div", null, "body"))
    );

    const hrefs = [...html.matchAll(/href="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((href) => href.startsWith("/dashboard"));

    // De-duplicate while preserving declaration order.
    return [...new Set(hrefs)];
}

const ALL_TENANT_MENU = [
    "/dashboard/check-in",
    "/dashboard/events",
    "/dashboard/orders",
    "/dashboard/customers",
    "/dashboard/payments",
    "/dashboard/refunds",
    "/dashboard/settlements",
    "/dashboard/reports",
    "/dashboard/venues",
];

beforeAll(async () => {
    adminNoMembership = await createUser("admin-nomember", "ADMIN");
    adminWithMembership = await createUser("admin-member", "ADMIN");
    managerWithMembership = await createUser("manager-member", "MANAGER");
    managerNoMembership = await createUser("manager-nomember", "MANAGER");
    pic = await createUser("pic", "PIC");
    customer = await createUser("customer");
    ownerA = await createUser("owner-a");
    ownerB = await createUser("owner-b");

    organizerA = await prisma.organizer.create({
        data: {
            ownerUserId: ownerA.id,
            name: `Role Matrix A ${SUFFIX}`,
            slug: `role-matrix-a-${SUFFIX}`,
            status: "ACTIVE",
        },
    });

    organizerB = await prisma.organizer.create({
        data: {
            ownerUserId: ownerB.id,
            name: `Role Matrix B ${SUFFIX}`,
            slug: `role-matrix-b-${SUFFIX}`,
            status: "ACTIVE",
        },
    });

    await prisma.organizerMember.createMany({
        data: [
            { organizerId: organizerA.id, userId: ownerA.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: organizerB.id, userId: ownerB.id, role: "OWNER", status: "ACTIVE" },
            // The tested memberships: platform ADMIN gets the OWNER scope of the sole
            // organizer (the bootstrap `prisma/seed-organizer.ts` establishes this).
            { organizerId: organizerA.id, userId: adminWithMembership.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: organizerA.id, userId: managerWithMembership.id, role: "MANAGER", status: "ACTIVE" },
        ],
    });
});

afterAll(async () => {
    const userIds = [
        adminNoMembership,
        adminWithMembership,
        managerWithMembership,
        managerNoMembership,
        pic,
        customer,
        ownerA,
        ownerB,
    ]
        .filter(Boolean)
        .map((user) => user.id);

    await prisma.organizerMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.organizer.deleteMany({
        where: { id: { in: [organizerA?.id, organizerB?.id].filter(Boolean) as string[] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

/* ==================================================================================
 * 1. PLATFORM ADMIN
 * ================================================================================== */

describe("platform ADMIN", () => {
    test("with an ACTIVE OWNER membership: every tenant and platform surface is offered", async () => {
        const capabilities = await capabilitiesFor(adminWithMembership.id);

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasTenantAccess).toBe(true);

        for (const key of [
            "canReadEvents",
            "canManageEvents",
            "canReadOrders",
            "canReadPayments",
            "canAssignPic",
            "canManageVenues",
            "canReadReports",
            "canCheckIn",
            "canManageSports",
            "canManageGlobalVenues",
            "canManagePlatformPic",
            // PHASE 32 — the ADMIN/MANAGER separation: an ADMIN owns the application.
            "canManageApplicationSettings",
            "canManageMaintenance",
            "canManageBranding",
            // PHASE 33 — user management is the fourth ADMIN-only system capability.
            "canManageUsers",
        ] as const) {
            expect({ key, value: capabilities[key] }).toEqual({ key, value: true });
        }

        expect(menuHrefs(capabilities)).toEqual([
            "/dashboard",
            "/dashboard/events",
            "/dashboard/check-in",
            "/dashboard/orders",
            "/dashboard/customers",
            "/dashboard/payments",
            "/dashboard/refunds",
            "/dashboard/settlements",
            "/dashboard/pic",
            "/dashboard/reports",
            "/dashboard/venues",
            "/dashboard/settings",
            // PHASE 32/33 — the SYSTEM section, rendered last and only for an ADMIN.
            "/dashboard/users",
            "/dashboard/settings/application",
            "/dashboard/settings/branding",
            "/dashboard/settings/maintenance",
        ]);
    });

    test("without a membership: platform surfaces only, no tenant data (the isolation rule)", async () => {
        const capabilities = await capabilitiesFor(adminNoMembership.id);

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasTenantAccess).toBe(false);
        expect(capabilities.canCheckIn).toBe(false);
        expect(capabilities.canManageSports).toBe(true);
        expect(capabilities.canManageGlobalVenues).toBe(true);
        expect(capabilities.canManagePlatformPic).toBe(true);

        for (const key of ALL_TENANT_MENU) {
            expect(menuHrefs(capabilities)).not.toContain(key);
        }

        // Dashboard, PIC, Pengaturan — plus the ADMIN-only system surfaces, which an ADMIN
        // holds with or without a tenant membership (PHASE 32 application control, PHASE 33
        // user management).
        expect(menuHrefs(capabilities)).toEqual([
            "/dashboard",
            "/dashboard/pic",
            "/dashboard/settings",
            "/dashboard/users",
            "/dashboard/settings/application",
            "/dashboard/settings/branding",
            "/dashboard/settings/maintenance",
        ]);
    });

    test("an OWNER membership does NOT unlock grant-required financial power (D-19)", async () => {
        const scope = await scopeFor(adminWithMembership.id);

        for (const permission of [
            PERMISSIONS.PAYMENT_RECONCILE,
            PERMISSIONS.FEE_RATE_CHANGE,
            PERMISSIONS.FEE_ADJUST,
            PERMISSIONS.SETTLEMENT_APPROVE,
            PERMISSIONS.REPORT_EXPORT_FINANCIAL,
        ]) {
            const decision = decideOrganizerPermission(scope, organizerA.id, permission);
            expect({ permission, allowed: decision.allowed }).toEqual({
                permission,
                allowed: false,
            });
        }
    });

    test("backend: EVENT_WRITE is allowed in the member tenant, denied in a non-member tenant", async () => {
        const scope = await scopeFor(adminWithMembership.id);

        expect(
            decideOrganizerPermission(scope, organizerA.id, PERMISSIONS.EVENT_WRITE).allowed
        ).toBe(true);

        expect(
            decideOrganizerPermission(scope, organizerB.id, PERMISSIONS.EVENT_WRITE)
        ).toMatchObject({ allowed: false, code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });
    });
});

/* ==================================================================================
 * 2. PLATFORM MANAGER
 * ================================================================================== */

describe("platform MANAGER", () => {
    test("with a membership: tenant surfaces, but no platform master data", async () => {
        const capabilities = await capabilitiesFor(managerWithMembership.id);

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasTenantAccess).toBe(true);
        expect(capabilities.canReadEvents).toBe(true);
        expect(capabilities.canReadOrders).toBe(true);
        expect(capabilities.canReadPayments).toBe(true);
        expect(capabilities.canReadReports).toBe(true);

        expect(capabilities.canManageSports).toBe(false);
        expect(capabilities.canManageGlobalVenues).toBe(false);
        expect(capabilities.canManagePlatformPic).toBe(false);

        // ── PHASE 32 — FULL OPERATIONAL, ZERO APPLICATION CONTROL ──────────────────
        // The whole point of the separation, pinned here so a future map edit that leaks one
        // of the three to MANAGER fails by NAME rather than being absorbed by a broader
        // assertion. The operational surfaces below stay TRUE — MANAGER is not a lesser
        // operator, it is an operator without system ownership.
        expect(capabilities.canManageApplicationSettings).toBe(false);
        expect(capabilities.canManageMaintenance).toBe(false);
        expect(capabilities.canManageBranding).toBe(false);

        expect(capabilities.canManageEvents).toBe(true);
        expect(capabilities.canManageVenues).toBe(true);
        expect(capabilities.canManageSettlements).toBe(true);
        expect(capabilities.canCheckIn).toBe(true);
        expect(capabilities.canAssignPic).toBe(true);

        // …and the SYSTEM section is simply absent from the MANAGER menu, while every
        // operational destination remains.
        const hrefs = menuHrefs(capabilities);

        for (const systemHref of [
            "/dashboard/settings/application",
            "/dashboard/settings/branding",
            "/dashboard/settings/maintenance",
        ]) {
            expect(hrefs).not.toContain(systemHref);
        }

        for (const operationalHref of ALL_TENANT_MENU) {
            expect(hrefs).toContain(operationalHref);
        }
    });

    test("PHASE 34 — without a membership: may ENTER the shell, but gets NO tenant or platform surface", async () => {
        // Phase 33 provisions MANAGER accounts independently of organizer membership, so a
        // MANAGER may exist before any OrganizerMember row. Dashboard ENTRY is allowed on the
        // platform role alone; data access is not.
        const capabilities = await capabilitiesFor(managerNoMembership.id);

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasPlatformRoleEntry).toBe(true);

        // The entry right confers nothing: no tenant data and none of the platform surfaces.
        expect(capabilities.hasTenantAccess).toBe(false);
        expect(capabilities.canManageSports).toBe(false);
        expect(capabilities.canManageGlobalVenues).toBe(false);
        expect(capabilities.canManagePlatformPic).toBe(false);
        expect(capabilities.canManageUsers).toBe(false);
        expect(capabilities.canManageApplicationSettings).toBe(false);
        expect(capabilities.canManageMaintenance).toBe(false);
        expect(capabilities.canManageBranding).toBe(false);

        // …and the menu is exactly the generic landing row: no tenant destination and no
        // SYSTEM section. The onboarding state lives on `/dashboard`.
        const hrefs = menuHrefs(capabilities);

        expect(hrefs).toEqual(["/dashboard"]);

        for (const tenantHref of ALL_TENANT_MENU) {
            expect(hrefs).not.toContain(tenantHref);
        }

        for (const systemHref of [
            "/dashboard/users",
            "/dashboard/settings/application",
            "/dashboard/settings/branding",
            "/dashboard/settings/maintenance",
        ]) {
            expect(hrefs).not.toContain(systemHref);
        }
    });

    test("MANAGER never gets platform privilege escalation", async () => {
        const scope = await scopeFor(managerWithMembership.id);

        expect(decidePlatformPermission(scope, PERMISSIONS.USER_MANAGE).allowed).toBe(false);
        expect(decidePlatformPermission(scope, PERMISSIONS.ROLE_MANAGE).allowed).toBe(false);
        expect(decidePlatformPermission(scope, PERMISSIONS.PLATFORM_CONFIG).allowed).toBe(false);
    });

    test("PHASE 33 — a MANAGER is refused the users surface on the capability object and the menu", async () => {
        const capabilities = await capabilitiesFor(managerWithMembership.id);

        expect(capabilities.canManageUsers).toBe(false);
        expect(menuHrefs(capabilities)).not.toContain("/dashboard/users");
    });
});

/* ==================================================================================
 * 3. PIC AND CUSTOMER
 * ================================================================================== */

describe("PIC and CUSTOMER are own-scope only", () => {
    test("PHASE 34 — a PIC may ENTER the shell on its platform role, and holds no tenant or platform capability", async () => {
        const scope = await scopeFor(pic.id);
        const capabilities = computeDashboardCapabilities(scope);

        // Entry is role-derived (a PIC account exists while its profile is PENDING, and must
        // be able to open the shell). No self-service flag without an ACTIVE profile, and no
        // tenant/platform authority either way.
        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasPlatformRoleEntry).toBe(true);
        expect(capabilities.hasActivePicProfile).toBe(false);
        expect(capabilities.hasTenantAccess).toBe(false);
        expect(capabilities.canManageSports).toBe(false);
        expect(capabilities.canManageGlobalVenues).toBe(false);
        expect(capabilities.canManagePlatformPic).toBe(false);
        expect(decidePlatformPermission(scope, PERMISSIONS.PIC_MANAGE).allowed).toBe(false);
        expect(decidePlatformPermission(scope, PERMISSIONS.SPORT_MANAGE).allowed).toBe(false);

        // With no ACTIVE profile, the menu offers no self-service rows and no tenant rows:
        // just the generic landing row, which renders the pending/standing state.
        expect(menuHrefs(capabilities)).toEqual(["/dashboard"]);
    });

    test("CUSTOMER cannot enter the dashboard and holds no tenant or platform capability", async () => {
        const scope = await scopeFor(customer.id);
        const capabilities = computeDashboardCapabilities(scope);

        expect(canEnterDashboard(capabilities)).toBe(false);
        expect(capabilities.hasTenantAccess).toBe(false);
        // PHASE 34 — a CUSTOMER is the one platform role that gets NO role-derived entry.
        expect(capabilities.hasPlatformRoleEntry).toBe(false);
    });

    test("own-scope still works for the owner and is denied for anyone else", async () => {
        const scope = await scopeFor(customer.id);

        expect(
            decideOwnResourcePermission(scope, PERMISSIONS.ORDER_READ_OWN, customer.id).allowed
        ).toBe(true);
        expect(
            decideOwnResourcePermission(scope, PERMISSIONS.ORDER_READ_OWN, pic.id).allowed
        ).toBe(false);
    });
});

/* ==================================================================================
 * 4. MEMBERSHIP STATUS AND THE UNMAPPED MEMBERSHIP ROLE
 * ================================================================================== */

describe("membership status is the scope gate", () => {
    test("a SUSPENDED membership confers no tenant capability", async () => {
        const suspended = await createUser("manager-suspended", "MANAGER");
        await prisma.organizerMember.create({
            data: {
                organizerId: organizerA.id,
                userId: suspended.id,
                role: "MANAGER",
                status: "SUSPENDED",
            },
        });

        try {
            const capabilities = await capabilitiesFor(suspended.id);
            expect(capabilities.hasTenantAccess).toBe(false);
            expect(capabilities.canReadEvents).toBe(false);

            const scope = await scopeFor(suspended.id);
            expect(
                decideOrganizerPermission(scope, organizerA.id, PERMISSIONS.EVENT_READ)
            ).toMatchObject({ allowed: false, code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });
        } finally {
            await prisma.organizerMember.deleteMany({ where: { userId: suspended.id } });
            await prisma.user.delete({ where: { id: suspended.id } });
        }
    });

    test("OrganizerMemberRole.ADMIN is unmapped and grants no organizer capability (D-05)", async () => {
        // No platform role at all, so the ONLY possible capability source is the
        // membership role — which is exactly what must contribute nothing.
        const unmapped = await createUser("member-admin");
        await prisma.organizerMember.create({
            data: {
                organizerId: organizerA.id,
                userId: unmapped.id,
                role: "ADMIN",
                status: "ACTIVE",
            },
        });

        try {
            const scope = await scopeFor(unmapped.id);
            // The scope RESOLVES (the membership exists and is ACTIVE)…
            expect(scope.organizerScopes).toHaveLength(1);
            // …but the unmapped role contributes no capability, so the ACTIVE membership
            // alone does not grant tenant access.
            const decision = decideOrganizerPermission(
                scope,
                organizerA.id,
                PERMISSIONS.EVENT_WRITE
            );
            expect(decision.allowed).toBe(false);
        } finally {
            await prisma.organizerMember.deleteMany({ where: { userId: unmapped.id } });
            await prisma.user.delete({ where: { id: unmapped.id } });
        }
    });
});

/* ==================================================================================
 * 5. CROSS-TENANT DIRECT ACCESS STAYS DENIED
 * ================================================================================== */

describe("cross-tenant direct access stays denied", () => {
    test("an organizer of tenant A cannot read tenant B", async () => {
        const scope = await scopeFor(ownerA.id);

        await expect(
            listDashboardOrders(scope, { organizerId: organizerB.id })
        ).rejects.toMatchObject({ code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });
    });

    test("a platform ADMIN with no membership still cannot read a named tenant", async () => {
        const scope = await scopeFor(adminNoMembership.id);

        await expect(
            listDashboardOrders(scope, { organizerId: organizerA.id })
        ).rejects.toMatchObject({ code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });
    });

    test("the denial is a real AppError, not a crash and not an empty page", async () => {
        const scope = await scopeFor(ownerA.id);

        try {
            await listDashboardOrders(scope, { organizerId: organizerB.id });
            throw new Error("expected a refusal");
        } catch (error) {
            expect(isAppError(error)).toBe(true);
        }
    });
});
