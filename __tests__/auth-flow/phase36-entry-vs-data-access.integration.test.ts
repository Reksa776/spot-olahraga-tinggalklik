/**
 * ==========================================
 * PHASE 36 — DASHBOARD ENTRY ≠ DATA ACCESS (INTEGRATION, REAL DATABASE)
 * ==========================================
 *
 * The Phase 34 contract separates three concepts:
 *
 *   DASHBOARD ENTRY      — the platform role itself (`hasPlatformRoleEntry`)
 *   TENANT DATA ACCESS   — requires an ACTIVE OrganizerMember
 *   PIC SELF-SERVICE     — requires an ACTIVE PICProfile
 *
 * Phase 34 pinned the entry rows for ADMIN / MANAGER / PENDING-PIC / SUSPENDED-PIC /
 * REJECTED-PIC (phase34-dashboard-entry-gate) and the tenant rows (role-matrix,
 * dashboard-access). This suite closes the remaining gaps so the three concepts cannot
 * drift apart again:
 *
 *   - the ADMITTED actors (entry = true) are still DENIED a named tenant read —
 *     entry confers no tenant resource access (the isolation guarantee),
 *   - a PENDING/SUSPENDED/REJECTED profile is NOT_FOUND to `requireMyPic` although the
 *     account enters the shell — the self-service surface is ACTIVE-only,
 *   - a PIC naming another user's id in the self-service guard is refused — identity cannot
 *     be routed around (cross-PIC denial).
 *
 * Everything runs the REAL `resolveAuthzScope` / `requireMyPic` / `listDashboardOrders`
 * against the REAL database. `@/auth` is mocked only so a session identity can be set; the
 * authorization decisions themselves are never stubbed.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { AuthzErrorCode, resolveAuthzScope } from "@/lib/authz";
import { listDashboardOrders } from "@/lib/dashboard/orders";
import {
    canEnterDashboard,
    computeDashboardCapabilities,
    type DashboardCapabilities,
} from "@/lib/dashboard/scope";
import { requireMyPic } from "@/lib/pic/self-service";
import { prisma } from "@/lib/prisma";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(120_000);

const SUFFIX = `p36-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Seeded = { id: string };

let managerNoMember: Seeded;
let picPending: Seeded;
let picActive: Seeded;
let picSuspended: Seeded;
let picRejected: Seeded;
let organizer: Seeded;

async function createUser(
    tag: string,
    platformRole: "MANAGER" | "PIC" | null = null
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

async function createProfile(
    userId: string,
    status: "ACTIVE" | "PENDING" | "SUSPENDED" | "REJECTED"
) {
    await prisma.pICProfile.create({
        data: {
            userId,
            picCode: `P36-${SUFFIX}-${userId.slice(-8)}`,
            displayName: `Fixture ${userId.slice(0, 6)}`,
            status,
        },
        select: { id: true },
    });
}

function signInAs(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: { id: userId },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

beforeAll(async () => {
    managerNoMember = await createUser("manager-nomember", "MANAGER");
    picPending = await createUser("pic-pending", "PIC");
    picActive = await createUser("pic-active", "PIC");
    picSuspended = await createUser("pic-suspended", "PIC");
    picRejected = await createUser("pic-rejected", "PIC");

    organizer = await prisma.organizer.create({
        data: {
            ownerUserId: picActive.id, // unused — an isolation target only
            name: `P36 Organizer ${SUFFIX}`,
            slug: `p36-organizer-${SUFFIX}`,
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
        managerNoMember,
        picPending,
        picActive,
        picSuspended,
        picRejected,
    ]
        .filter(Boolean)
        .map((user) => user.id);

    await prisma.pICProfile.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.organizer.deleteMany({ where: { id: organizer?.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

async function capsFor(userId: string): Promise<DashboardCapabilities> {
    const scope = await resolveAuthzScope(userId);
    expect(scope).not.toBeNull();
    return computeDashboardCapabilities(scope!);
}

/* ==================================================================================
 * 1. ENTRY DOES NOT CONFER TENANT READ — every admitted shape is denied the org read
 * ================================================================================== */

describe("dashboard ENTRY never grants a tenant read", () => {
    test.each([
        ["MANAGER with no membership", "managerNoMember" as const],
        ["PENDING PIC", "picPending" as const],
        ["ACTIVE PIC", "picActive" as const],
        ["SUSPENDED PIC", "picSuspended" as const],
    ])("%s enters the shell yet cannot read a named organizer", async (_label, key) => {
        const seed = { managerNoMember, picPending, picActive, picSuspended }[key];
        const capabilities = await capsFor(seed.id);
        const scope = await resolveAuthzScope(seed.id);

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasTenantAccess).toBe(false);

        await expect(
            listDashboardOrders(scope!, { organizerId: organizer.id })
        ).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });

    test("an ACTIVE PIC holds no tenant capability in the capability object either", async () => {
        const capabilities = await capsFor(picActive.id);

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasTenantAccess).toBe(false);
        expect(capabilities.canReadEvents).toBe(false);
        expect(capabilities.canReadOrders).toBe(false);
        expect(capabilities.canManageEvents).toBe(false);
        expect(capabilities.canCheckIn).toBe(false);
    });
});

/* ==================================================================================
 * 2. THE SELF-SERVICE SURFACE IS ACTIVE-ONLY — PENDING/SUSPENDED/REJECTED are NOT_FOUND
 * ================================================================================== */

describe("requireMyPic admits ACTIVE only, whatever the shell entry says", () => {
    test("a PENDING profile is NOT_FOUND even though the account enters the shell", async () => {
        const capabilities = await capsFor(picPending.id);
        expect(canEnterDashboard(capabilities)).toBe(true);

        signInAs(picPending.id);
        await expect(requireMyPic(picPending.id, [])).rejects.toMatchObject({
            code: AuthzErrorCode.NOT_FOUND,
        });
    });

    test("a SUSPENDED profile is NOT_FOUND to the same guard", async () => {
        signInAs(picSuspended.id);
        await expect(requireMyPic(picSuspended.id, [])).rejects.toMatchObject({
            code: AuthzErrorCode.NOT_FOUND,
        });
    });

    test("a REJECTED profile is NOT_FOUND to the same guard", async () => {
        signInAs(picRejected.id);
        await expect(requireMyPic(picRejected.id, [])).rejects.toMatchObject({
            code: AuthzErrorCode.NOT_FOUND,
        });
    });

    test("an ACTIVE profile passes the profile gate", async () => {
        signInAs(picActive.id);
        const result = await requireMyPic(picActive.id, []);
        expect(result.scope.userId).toBe(picActive.id);
        expect(result.picProfileId).toBeTruthy();
    });

    test("an unauthenticated actor is refused outright", async () => {
        signInAs(null);
        await expect(requireMyPic(picActive.id, [])).rejects.toMatchObject({
            code: AuthzErrorCode.UNAUTHORIZED,
        });
    });
});

/* ==================================================================================
 * 3. CROSS-PIC DENIAL — a routing id cannot swap for session identity
 * ================================================================================== */

describe("cross-PIC denial", () => {
    test("an ACTIVE PIC naming another user's id in the guard is PIC_ACCESS_DENIED", async () => {
        signInAs(picActive.id);
        await expect(requireMyPic(managerNoMember.id, [])).rejects.toMatchObject({
            code: AuthzErrorCode.PIC_ACCESS_DENIED,
        });
    });

    test("a MANAGER (no profile) naming a PIC's id is refused by the identity check first", async () => {
        signInAs(managerNoMember.id);
        await expect(requireMyPic(picActive.id, [])).rejects.toMatchObject({
            code: AuthzErrorCode.PIC_ACCESS_DENIED,
        });
    });
});

/* ==================================================================================
 * 4. DISABLED ACCOUNTS GET NO SCOPE AT ALL — the entry gate is unreachable
 * ================================================================================== */

describe("disabled accounts cannot even reach the entry gate", () => {
    test("a disabled MANAGER resolves to a null scope", async () => {
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

    test("a disabled PIC with an ACTIVE profile resolves to a null scope", async () => {
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