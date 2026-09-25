/**
 * ==========================================
 * PHASE 38 — MANAGER OPERATIONAL DASHBOARD (ADMIN-LIKE, NO SYSTEM CONTROL)
 * ==========================================
 *
 * The bug the user reported: a freshly created MANAGER opened `/dashboard` to an
 * empty standing notice ("Belum Ada Organisasi"). The map audit shows MANAGER's
 * operational capability was ALREADY complete — `PLATFORM_ROLE_ORGANIZER_PERMISSIONS
 * .MANAGER` and `MEMBERSHIP_ROLE_PERMISSIONS.MANAGER` carry the full operational set
 * — but the intersection rule (D-05) makes EVERY tenant-scoped permission require an
 * ACTIVE `OrganizerMember`, and a fresh MANAGER has none; `decideOrganizerPermission`
 * refuses before the map is even consulted. No permission-map edit can give a
 * no-membership MANAGER tenant data.
 *
 * The fix uses the EXISTING membership mechanism: creating a MANAGER account through
 * the Phase 33 surface (`createManagedUser`) now also provisions an ACTIVE MANAGER
 * membership in the platform-owned organiders, so the MANAGER logs in straight to the
 * operational dashboard — while application control (application.settings,
 * branding.manage, maintenance.manage, user.manage, role.manage, platform.config) stays
 * PLATFORM-scope and therefore ADMIN-only by the very same maps.
 *
 * This suite runs the REAL service, REAL `resolveAuthzScope`, REAL deciders and REAL
 * database: a MANAGER created through the product button behaves exactly as asserted
 * here, end to end.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { auth } from "@/auth";
import {
    createManagedUser,
} from "@/lib/admin/users";
import {
    PERMISSIONS,
    AuthzErrorCode,
    decideOrganizerPermission,
    decidePlatformPermission,
    resolveAuthzScope,
} from "@/lib/authz";
import { buildDashboardNav } from "@/components/dashboard/DashboardAppShell";
import {
    computeDashboardCapabilities,
} from "@/lib/dashboard/scope";
import { listDashboardOrders } from "@/lib/dashboard/orders";
import { prisma } from "@/lib/prisma";

jest.setTimeout(120_000);

const SUFFIX = `phase38-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const authMock = auth as jest.Mock;

let admin: { id: string };
let owner: { id: string };
let isolatedOrganizer: { id: string };
let anchorAdmin: { id: string };
let anchorOrganizer: { id: string };

async function createUser(
    tag: string,
    platformRole: "ADMIN" | "MANAGER" | "PIC" | null = null
) {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            ...(platformRole ? { platformRole } : {}),
        },
        select: { id: true },
    });
}

/** The operational destinations whose MANAGER visibility this phase pins. */
const OPERATIONAL_MENU = [
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
];

/** The ADMIN-only destinations a MANAGER must never see or reach. */
const SYSTEM_MENU = [
    "/dashboard/users",
    "/dashboard/settings/application",
    "/dashboard/settings/branding",
    "/dashboard/settings/maintenance",
];

function menuHrefsFor(
    scope: NonNullable<Awaited<ReturnType<typeof resolveAuthzScope>>>
) {
    return buildDashboardNav(computeDashboardCapabilities(scope))
        .flatMap((group) => group.items)
        .map((item) => item.href);
}

function actAs(userId: string) {
    authMock.mockResolvedValue({ user: { id: userId } });
}

beforeAll(async () => {
    admin = await createUser("admin", "ADMIN");
    owner = await createUser("owner");
    anchorAdmin = await createUser("anchor-admin", "ADMIN");

    isolatedOrganizer = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `Phase38 Isolated ${SUFFIX}`,
            slug: `phase38-isolated-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.create({
        data: {
            organizerId: isolatedOrganizer.id,
            userId: owner.id,
            role: "OWNER",
            status: "ACTIVE",
        },
    });

    // The platform-owned organizer anchor: the same relationship the bootstrap
    // seed (`prisma/seed-organizer.ts`) establishes for the single-organizer
    // launch — a platform ADMIN holding an ACTIVE OWNER membership. Tests run
    // against `<db>_test`, which has no seeded organizer, so the fixture stands
    // in for that bootstrap state.
    anchorOrganizer = await prisma.organizer.create({
        data: {
            ownerUserId: anchorAdmin.id,
            name: `Phase38 Platform ${SUFFIX}`,
            slug: `phase38-platform-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.create({
        data: {
            organizerId: anchorOrganizer.id,
            userId: anchorAdmin.id,
            role: "OWNER",
            status: "ACTIVE",
        },
    });
});

afterAll(async () => {
    const created = await prisma.user.findMany({
        where: { email: { contains: SUFFIX } },
        select: { id: true },
    });
    const ids = [
        admin?.id,
        owner?.id,
        anchorAdmin?.id,
        ...created.map((u) => u.id),
    ].filter(Boolean) as string[];

    await prisma.adminAuditLog.deleteMany({
        where: { entityRef: { in: ids }, action: { in: ["user.created", "pic.user.created"] } },
    });
    await prisma.pICProfile.deleteMany({ where: { userId: { in: ids } } });
    // Memberships first — `OrganizerMember.user` is onDelete Restrict.
    await prisma.organizerMember.deleteMany({ where: { userId: { in: ids } } });
    await prisma.organizer.deleteMany({
        where: { id: { in: [isolatedOrganizer?.id, anchorOrganizer?.id].filter(Boolean) as string[] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

/* ==================================================================================
 * 1. A MANAGER CREATED THROUGH THE PRODUCT SURFACE IS IMMEDIATELY OPERATIONAL
 * ================================================================================== */

describe("MANAGER creation provisions the operational scope (Phase 38)", () => {
    test("createManagedUser for MANAGER also creates an ACTIVE MANAGER membership", async () => {
        actAs(admin.id);
        const adminScope = (await resolveAuthzScope(admin.id))!;

        const result = (await createManagedUser(adminScope, {
            name: "Manager Operasional",
            email: `manager-operational-${SUFFIX}@example.test`,
            password: "PasswordRahasia1",
            role: "MANAGER",
        })) as { id: string };

        const memberships = await prisma.organizerMember.findMany({
            where: { userId: result.id },
            select: { organizerId: true, role: true, status: true },
        });

        // The newly created MANAGER joined the platform-owned organizer that
        // stands in for the bootstrap state.
        expect(memberships.some((m) => m.organizerId === anchorOrganizer.id)).toBe(true);
        for (const membership of memberships) {
            expect(membership.role).toBe("MANAGER");
            expect(membership.status).toBe("ACTIVE");
        }

        try {
            const scope = (await resolveAuthzScope(result.id))!;
            const capabilities = computeDashboardCapabilities(scope);
            const anchor = anchorOrganizer.id;

            // ── operational surfaces ────────────────────────────────────────────
            expect(capabilities.hasTenantAccess).toBe(true);
            for (const key of [
                "canReadEvents",
                "canManageEvents",
                "canReadOrders",
                "canReadPayments",
                "canAssignPic",
                "canManageVenues",
                "canReadReports",
                "canManageSettlements",
                "canCheckIn",
            ] as const) {
                expect({ key, value: capabilities[key] }).toEqual({ key, value: true });
            }

            // ── the dashboard shell entry is open (PHASE 34 preserved) ─────────
            expect(capabilities.hasPlatformRoleEntry).toBe(true);

            // ── the OPERATIONAL menu is exactly an ADMIN's ─────────────────────
            const hrefs = menuHrefsFor(scope);
            for (const href of OPERATIONAL_MENU) {
                expect(hrefs).toContain(href);
            }

            // ── zero system control, on the OBJECT and the menu ────────────────
            for (const key of [
                "canManageUsers",
                "canManageApplicationSettings",
                "canManageMaintenance",
                "canManageBranding",
                "canManageSports",
                "canManageGlobalVenues",
                "canManagePlatformPic",
            ] as const) {
                expect({ key, value: capabilities[key] }).toEqual({ key, value: false });
            }
            for (const href of SYSTEM_MENU) {
                expect(hrefs).not.toContain(href);
            }

            // ── backend deciders mirror the menu (direct-URL denial) ───────────
            for (const permission of [
                PERMISSIONS.USER_MANAGE,
                PERMISSIONS.ROLE_MANAGE,
                PERMISSIONS.PLATFORM_CONFIG,
                PERMISSIONS.APPLICATION_SETTINGS,
                PERMISSIONS.MAINTENANCE_MANAGE,
                PERMISSIONS.BRANDING_MANAGE,
            ]) {
                expect(decidePlatformPermission(scope, permission).allowed).toBe(false);
            }

            expect(
                decideOrganizerPermission(scope, anchor, PERMISSIONS.EVENT_READ).allowed
            ).toBe(true);
            expect(
                decideOrganizerPermission(scope, anchor, PERMISSIONS.ORDER_CANCEL).allowed
            ).toBe(true);
        } finally {
            await prisma.organizerMember.deleteMany({ where: { userId: result.id } });
            await prisma.user.delete({ where: { id: result.id } });
        }
    });

    test("tenant isolation is preserved: a MANAGER cannot reach an organizer it does not hold", async () => {
        actAs(admin.id);
        const adminScope = (await resolveAuthzScope(admin.id))!;

        const result = (await createManagedUser(adminScope, {
            name: "Manager Terisolasi",
            email: `manager-isolated-${SUFFIX}@example.test`,
            password: "PasswordRahasia1",
            role: "MANAGER",
        })) as { id: string };

        try {
            const scope = (await resolveAuthzScope(result.id))!;

            expect(
                decideOrganizerPermission(
                    scope,
                    isolatedOrganizer.id,
                    PERMISSIONS.EVENT_READ
                )
            ).toMatchObject({
                allowed: false,
                code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            });

            await expect(
                listDashboardOrders(scope, { organizerId: isolatedOrganizer.id })
            ).rejects.toMatchObject({
                code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            });
        } finally {
            await prisma.organizerMember.deleteMany({ where: { userId: result.id } });
            await prisma.user.delete({ where: { id: result.id } });
        }
    });

    test("PIC creation is untouched: no membership is ever created", async () => {
        actAs(admin.id);
        const adminScope = (await resolveAuthzScope(admin.id))!;

        const result = (await createManagedUser(adminScope, {
            name: "Pic Tetap Self-Service",
            email: `pic-untouched-${SUFFIX}@example.test`,
            password: "PasswordRahasia1",
            role: "PIC",
            pic: { displayName: "Pic Tetap" },
        })) as { id: string };

        try {
            const memberships = await prisma.organizerMember.findMany({
                where: { userId: result.id },
            });
            expect(memberships).toHaveLength(0);

            const scope = (await resolveAuthzScope(result.id))!;
            const capabilities = computeDashboardCapabilities(scope);

            // A PIC has no tenant surface regardless of the anchor organizer —
            // the self-service PIC flow is BY DESIGN separate from MANAGER.
            expect(capabilities.hasTenantAccess).toBe(false);
            expect(capabilities.hasPlatformRoleEntry).toBe(true);
        } finally {
            await prisma.pICProfile.deleteMany({ where: { userId: result.id } });
            await prisma.organizerMember.deleteMany({ where: { userId: result.id } });
            await prisma.user.delete({ where: { id: result.id } });
        }
    });
});

/* ==================================================================================
 * 2. THE UNCHANGED RAW STATE — a MANAGER WITHOUT A MEMBERSHIP STAYS HONEST
 * ================================================================================== */

describe("Phase 34 contract preserved for a membership-less MANAGER", () => {
    test("a raw MANAGER (no membership) enters the shell with NO operative surface", async () => {
        const managerNoMember = await createUser("manager-nomember", "MANAGER");

        try {
            const scope = (await resolveAuthzScope(managerNoMember.id))!;
            const capabilities = computeDashboardCapabilities(scope);

            expect(capabilities.hasPlatformRoleEntry).toBe(true);
            expect(capabilities.hasTenantAccess).toBe(false);
            expect(capabilities.canManageUsers).toBe(false);
            expect(capabilities.canManageApplicationSettings).toBe(false);
            expect(capabilities.canManageMaintenance).toBe(false);
            expect(capabilities.canManageBranding).toBe(false);

            const hrefs = menuHrefsFor(scope);
            expect(hrefs).toEqual(["/dashboard"]);
        } finally {
            await prisma.user.delete({ where: { id: managerNoMember.id } });
        }
    });
});