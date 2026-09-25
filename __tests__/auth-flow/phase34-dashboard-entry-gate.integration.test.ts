/**
 * ==========================================
 * PHASE 34 — DASHBOARD ENTRY GATE (MANAGER + PIC)
 * ==========================================
 *
 * The bug: after Phase 33, a freshly created MANAGER (with no OrganizerMember yet) and a
 * freshly created PIC (whose PICProfile is PENDING) could not enter `/dashboard`, because
 * `canEnterDashboard` admitted only `hasTenantAccess || hasPlatformSurface ||
 * hasActivePicProfile` — and both accounts hold none of those at creation time.
 *
 * The fix separates three concepts that were conflated:
 *
 *   DASHBOARD ENTRY      — the platform role itself (`hasPlatformRoleEntry`)
 *   TENANT DATA ACCESS   — still requires an ACTIVE OrganizerMember
 *   PIC SELF-SERVICE     — still requires an ACTIVE PICProfile
 *
 * This suite runs the REAL `resolveAuthzScope` against the REAL database and then the pure
 * `computeDashboardCapabilities` / `canEnterDashboard`, so it pins the end-to-end mapping
 * the layout applies. Nothing about authorization is stubbed; `@/auth` is mocked only so
 * `requireAuth` can resolve to `undefined` (no test here reads a session).
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

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
    AccountStandingNotice,
    picStandingNotice,
} from "@/components/dashboard/AccountStandingNotice";
import { AuthzErrorCode, resolveAuthzScope } from "@/lib/authz";
import { isAppError } from "@/lib/api/errors";
import { listDashboardOrders } from "@/lib/dashboard/orders";
import {
    canEnterDashboard,
    computeDashboardCapabilities,
} from "@/lib/dashboard/scope";
import { findPicProfileStanding } from "@/lib/pic/self-service";
import { prisma } from "@/lib/prisma";

jest.setTimeout(120_000);

const SUFFIX = `phase34-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Seeded = { id: string };

let admin: Seeded;
let managerNoMember: Seeded;
let picPending: Seeded;
let picActive: Seeded;
let picSuspended: Seeded;
let picRejected: Seeded;
let customer: Seeded;
let organizer: Seeded;

async function createUser(
    tag: string,
    platformRole: "ADMIN" | "MANAGER" | "PIC" | null = null
) {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            // The LEGACY retail column stays CUSTOMER for everyone: authority must come from
            // `platformRole`, never from this dormant field.
            role: "CUSTOMER",
            ...(platformRole ? { platformRole } : {}),
        },
        select: { id: true },
    });
}

async function createProfile(
    userId: string,
    status: "ACTIVE" | "PENDING" | "SUSPENDED" | "REJECTED"
) {
    return prisma.pICProfile.create({
        data: {
            userId,
            picCode: `P34-${SUFFIX}-${userId.slice(-8)}`,
            displayName: `Fixture ${userId.slice(0, 6)}`,
            status,
        },
        select: { id: true },
    });
}

async function caps(userId: string) {
    const scope = await resolveAuthzScope(userId);

    if (!scope) {
        throw new Error(`no scope resolved for ${userId}`);
    }

    return {
        scope,
        capabilities: computeDashboardCapabilities(scope),
    };
}

beforeAll(async () => {
    admin = await createUser("admin", "ADMIN");
    managerNoMember = await createUser("manager-nomember", "MANAGER");
    picPending = await createUser("pic-pending", "PIC");
    picActive = await createUser("pic-active", "PIC");
    picSuspended = await createUser("pic-suspended", "PIC");
    picRejected = await createUser("pic-rejected", "PIC");
    customer = await createUser("customer");

    organizer = await prisma.organizer.create({
        data: {
            ownerUserId: customer.id, // unused, only an isolation target
            name: `Phase34 Organizer ${SUFFIX}`,
            slug: `phase34-organizer-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await createProfile(picPending.id, "PENDING");
    await createProfile(picActive.id, "ACTIVE");
    await createProfile(picSuspended.id, "SUSPENDED");
    await createProfile(picRejected.id, "REJECTED");
});

afterAll(async () => {
    const userIds = [
        admin,
        managerNoMember,
        picPending,
        picActive,
        picSuspended,
        picRejected,
        customer,
    ]
        .filter(Boolean)
        .map((user) => user.id);

    await prisma.pICProfile.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.organizer.deleteMany({ where: { id: organizer?.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

/* ==================================================================================
 * 1–3. ADMIN / MANAGER ENTRY
 * ================================================================================== */

describe("ADMIN and MANAGER entry", () => {
    test("an ADMIN may enter on the platform surface (unchanged)", async () => {
        const { capabilities } = await caps(admin.id);

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasPlatformRoleEntry).toBe(true);
        expect(capabilities.canManageSports).toBe(true);
    });

    test("a MANAGER with NO OrganizerMember may enter, with no tenant or platform surface", async () => {
        const { capabilities } = await caps(managerNoMember.id);

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasPlatformRoleEntry).toBe(true);

        // No tenant data, no user management, no system settings.
        expect(capabilities.hasTenantAccess).toBe(false);
        expect(capabilities.canReadOrders).toBe(false);
        expect(capabilities.canManageUsers).toBe(false);
        expect(capabilities.canManageApplicationSettings).toBe(false);
        expect(capabilities.canManageMaintenance).toBe(false);
        expect(capabilities.canManageBranding).toBe(false);
    });

    test("a MANAGER with no membership cannot read an arbitrary organizer (isolation preserved)", async () => {
        const scope = await resolveAuthzScope(managerNoMember.id);

        await expect(
            listDashboardOrders(scope!, { organizerId: organizer.id })
        ).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });

    test("ADMIN with no membership still cannot read a named tenant", async () => {
        const scope = await resolveAuthzScope(admin.id);

        await expect(
            listDashboardOrders(scope!, { organizerId: organizer.id })
        ).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });

    test("the refusal is a real AppError, not a crash and not an empty page", async () => {
        const scope = await resolveAuthzScope(managerNoMember.id);

        try {
            await listDashboardOrders(scope!, { organizerId: organizer.id });
            throw new Error("expected a refusal");
        } catch (error) {
            expect(isAppError(error)).toBe(true);
        }
    });
});

/* ==================================================================================
 * 4–6. PIC ENTRY BY PROFILE STANDING
 * ================================================================================== */

describe("PIC entry and self-service depend on profile standing", () => {
    test("PENDING PIC may enter the shell but gets NO self-service capability", async () => {
        const { capabilities } = await caps(picPending.id);

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasPlatformRoleEntry).toBe(true);

        // The self-service flag is profile-derived and therefore OFF while PENDING; the
        // menu offers no PIC data rows, and every read re-checks `requireMyPic`.
        expect(capabilities.hasActivePicProfile).toBe(false);
        expect(capabilities.hasTenantAccess).toBe(false);
        expect(capabilities.canManagePlatformPic).toBe(false);
    });

    test("the PENDING standing is resolvable for the entry UX", async () => {
        expect(await findPicProfileStanding(picPending.id)).toBe("PENDING");
    });

    test("ACTIVE PIC may enter and gets the self-service flag when probed", async () => {
        const scope = await resolveAuthzScope(picActive.id);
        const capabilities = computeDashboardCapabilities(scope!, {
            hasActivePicProfile: true,
        });

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasActivePicProfile).toBe(true);
        expect(capabilities.hasTenantAccess).toBe(false);
    });

    test("SUSPENDED PIC may enter but self-service stays off", async () => {
        const scope = await resolveAuthzScope(picSuspended.id);
        const capabilities = computeDashboardCapabilities(scope!, {
            hasActivePicProfile: false,
        });

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasActivePicProfile).toBe(false);
        expect(await findPicProfileStanding(picSuspended.id)).toBe("SUSPENDED");
    });

    test("REJECTED PIC may enter but self-service stays off, and the standing is REJECTED", async () => {
        const scope = await resolveAuthzScope(picRejected.id);
        const capabilities = computeDashboardCapabilities(scope!, {
            hasActivePicProfile: false,
        });

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasActivePicProfile).toBe(false);
        expect(await findPicProfileStanding(picRejected.id)).toBe("REJECTED");
    });
});

/* ==================================================================================
 * 7. CUSTOMER
 * ================================================================================== */

describe("a CUSTOMER is the one role refused", () => {
    test("the entry gate is false and no role-derived entry exists", async () => {
        const { capabilities } = await caps(customer.id);

        expect(canEnterDashboard(capabilities)).toBe(false);
        expect(capabilities.hasPlatformRoleEntry).toBe(false);
        expect(capabilities.hasTenantAccess).toBe(false);
    });
});

/* ==================================================================================
 * 8–9. DISABLED ACCOUNTS (DB-backed, never stale JWT claims)
 * ================================================================================== */

describe("a disabled account cannot enter", () => {
    test("a disabled MANAGER resolves to a null scope, so the layout redirects to login", async () => {
        const disabled = await createUser("disabled-manager", "MANAGER");

        try {
            await prisma.user.update({
                where: { id: disabled.id },
                data: { disabledAt: new Date() },
            });

            expect(await resolveAuthzScope(disabled.id)).toBeNull();
        } finally {
            await prisma.user.delete({ where: { id: disabled.id } });
        }
    });

    test("a disabled PIC resolves to a null scope and its profile standing no longer admits", async () => {
        const disabled = await createUser("disabled-pic", "PIC");

        try {
            await createProfile(disabled.id, "ACTIVE");
            expect(await resolveAuthzScope(disabled.id)).not.toBeNull();

            await prisma.user.update({
                where: { id: disabled.id },
                data: { disabledAt: new Date() },
            });

            expect(await resolveAuthzScope(disabled.id)).toBeNull();
        } finally {
            await prisma.pICProfile.deleteMany({ where: { userId: disabled.id } });
            await prisma.user.delete({ where: { id: disabled.id } });
        }
    });
});

/* ==================================================================================
 * 10. THE STANDING UI STATES (exact copy, no generic denial)
 * ================================================================================== */

describe("the standing notices", () => {
    test("the standing mapper covers every profile status", () => {
        expect(picStandingNotice("PENDING")).toBe("pic-pending");
        expect(picStandingNotice("SUSPENDED")).toBe("pic-suspended");
        expect(picStandingNotice("REJECTED")).toBe("pic-rejected");
        expect(picStandingNotice(null)).toBe("pic-missing");
    });

    test("the MANAGER onboarding state reads as 'Belum Ada Organisasi'", () => {
        const html = renderToStaticMarkup(
            createElement(AccountStandingNotice, {
                standing: "manager-no-organizer",
            })
        );

        expect(html).toContain("Belum Ada Organisasi");
        expect(html).toContain("belum ditugaskan ke organisasi");
        // Never the generic refused panel.
        expect(html).not.toContain("Akses dashboard ditolak");
    });

    test("the PENDING PIC state reads as 'Profil PIC Menunggu Persetujuan'", () => {
        const html = renderToStaticMarkup(
            createElement(AccountStandingNotice, {
                standing: picStandingNotice("PENDING"),
            })
        );

        expect(html).toContain("Profil PIC Menunggu Persetujuan");
        expect(html).toContain("masih menunggu persetujuan admin");
        expect(html).not.toContain("Akses dashboard ditolak");
    });
});
