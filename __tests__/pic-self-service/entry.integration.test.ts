/**
 * ==========================================
 * PIC SELF-SERVICE — ENTRY GATE (INTEGRATION, REAL DATABASE)
 * ==========================================
 *
 * TESTS 1–4 + 18–20: whether a PIC can enter the dashboard AT ALL, and under what
 * exact predicate.
 *
 * The pure `computeDashboardCapabilities(scope)` cannot see a `PICProfile` — that is the
 * defect PIC SELF-SERVICE DASHBOARD V1 fixes. These tests pin BOTH sides of the fix:
 *
 *   - the FIRST-PASS shape stays denied for a pure PIC (single-argument capabilities are
 *     byte-identical to before, so the role-matrix suite stays honest), and
 *   - the layout's optional `{ hasActivePicProfile }` context admits exactly the actors
 *     with an ACTIVE profile and nobody else.
 *
 * `findActivePicProfile` is asserted as the layout's exact predicate: ACTIVE returns the
 * profile, every other status and every other user returns `null` — so a SUSPENDED or
 * REJECTED profile can never flip the gate.
 *
 * Everything here reads the database by user id (`resolveAuthzScope`, `findActivePicProfile`)
 * and the pure scope combinator — no server session is needed, so nothing is mocked at runtime.
 *
 * The `@/auth` jest.mock is STRUCTURAL, not behavioral: importing `@/lib/authz` transitively
 * loads `auth.ts`, which imports `next-auth` (a pure-ESM package Jest cannot parse). Mocking the
 * module up front makes `requireAuth` resolve to `undefined` instead — harmless here, because no
 * test calls a function that reads the session.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { resolveAuthzScope } from "@/lib/authz";
import {
    canEnterDashboard,
    computeDashboardCapabilities,
} from "@/lib/dashboard/scope";
import {
    findActivePicProfile,
    findPicProfileStanding,
} from "@/lib/pic/self-service";
import { prisma } from "@/lib/prisma";

jest.setTimeout(180_000);

const SUFFIX = `picss-entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let picUser: { id: string };
let picWithoutRole: { id: string };
let suspendedUser: { id: string };
let pendingUser: { id: string };
let customer: { id: string };
let admin: { id: string };

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

async function createProfile(
    userId: string,
    status: "ACTIVE" | "SUSPENDED" | "PENDING" | "REJECTED"
) {
    return prisma.pICProfile.create({
        data: {
            userId,
            picCode: `PICSS-${SUFFIX}-${userId}`,
            displayName: `Fixture ${userId.slice(0, 8)}`,
            status,
        },
        select: { id: true, userId: true },
    });
}

beforeAll(async () => {
    picUser = await createUser("pic-user", "PIC");
    picWithoutRole = await createUser("pic-no-role");
    suspendedUser = await createUser("pic-suspended", "PIC");
    pendingUser = await createUser("pic-pending", "PIC");
    customer = await createUser("customer");
    admin = await createUser("admin", "ADMIN");

    await createProfile(picUser.id, "ACTIVE");
    await createProfile(picWithoutRole.id, "ACTIVE");
    await createProfile(suspendedUser.id, "SUSPENDED");
    await createProfile(pendingUser.id, "PENDING");
});

afterAll(async () => {
    const userIds = [
        picUser,
        picWithoutRole,
        suspendedUser,
        pendingUser,
        customer,
        admin,
    ]
        .filter(Boolean)
        .map((user) => user.id);

    await prisma.pICProfile.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

/* ==================================================================================
 * TEST 1 — the first-pass shape refuses, the flagged shape admits (exactly the fix)
 * ================================================================================== */

describe("TEST 1 — a PIC with an ACTIVE profile enters on the flagged capability", () => {
    test("PHASE 34 — single-argument capabilities admit a PIC on its platform role, with no self-service flag yet", async () => {
        const scope = await resolveAuthzScope(picUser.id);
        expect(scope).not.toBeNull();

        const plain = computeDashboardCapabilities(scope!);

        // Entry is role-derived (Phase 34); the self-service flag is profile-derived and
        // therefore false until the layout's probe sets it.
        expect(canEnterDashboard(plain)).toBe(true);
        expect(plain.hasPlatformRoleEntry).toBe(true);
        expect(plain.hasActivePicProfile).toBe(false);
        expect(plain.hasTenantAccess).toBe(false);
    });

    test("the layout's probe-then-flag shape admits the same PIC", async () => {
        const scope = await resolveAuthzScope(picUser.id);
        expect(scope).not.toBeNull();

        const flagged = computeDashboardCapabilities(scope!, {
            hasActivePicProfile:
                (await findActivePicProfile(scope!.userId)) !== null,
        });

        expect(canEnterDashboard(flagged)).toBe(true);
        expect(flagged.hasActivePicProfile).toBe(true);
        // Admission is profile-only: the PIC still holds NOTHING at the tenant or platform
        // level, so the menu stays PIC-only and every data read re-checks authority.
        expect(flagged.hasTenantAccess).toBe(false);
        expect(flagged.canManagePlatformPic).toBe(false);
        expect(flagged.canManageSports).toBe(false);
        expect(flagged.canReadEvents).toBe(false);
    });
});

/* ==================================================================================
 * TEST 2 — the flag is about the PROFILE, not the platform role
 * ================================================================================== */

describe("TEST 2 — an ACTIVE profile admits even without a PIC platform role", () => {
    test("an account with no platform role but an ACTIVE profile enters", async () => {
        const scope = await resolveAuthzScope(picWithoutRole.id);
        expect(scope).not.toBeNull();

        const flagged = computeDashboardCapabilities(scope!, {
            hasActivePicProfile:
                (await findActivePicProfile(scope!.userId)) !== null,
        });

        expect(canEnterDashboard(flagged)).toBe(true);
        // …and the own-scope service reads still deny the fee family (this account is a
        // CUSTOMER owner of the profile, so identity passes but the role map does not).
        expect(flagged.hasActivePicProfile).toBe(true);
    });
});

/* ==================================================================================
 * TEST 3 — an ordinary customer stays refused, on every shape
 * ================================================================================== */

describe("TEST 3 — a customer without a profile is refused on every shape", () => {
    test("the pure shape refuses", async () => {
        const scope = await resolveAuthzScope(customer.id);
        expect(scope).not.toBeNull();

        expect(canEnterDashboard(computeDashboardCapabilities(scope!))).toBe(
            false
        );
    });

    test("the probe finds no profile, so the flagged shape ALSO refuses", async () => {
        const scope = await resolveAuthzScope(customer.id);
        expect(scope).not.toBeNull();

        const flagged = computeDashboardCapabilities(scope!, {
            hasActivePicProfile:
                (await findActivePicProfile(scope!.userId)) !== null,
        });

        expect(canEnterDashboard(flagged)).toBe(false);
        expect(flagged.hasActivePicProfile).toBe(false);
    });
});

/* ==================================================================================
 * TEST 4 — a suspended profile cannot flip the gate
 * ================================================================================== */

describe("TEST 4 — a SUSPENDED profile gets entry but NO self-service", () => {
    test("the probe returns null for a suspended profile", async () => {
        expect(
            await findActivePicProfile(suspendedUser.id)
        ).toBeNull();
    });

    test("PHASE 34 — so the flagged shape enters on the platform role, with self-service OFF", async () => {
        const scope = await resolveAuthzScope(suspendedUser.id);
        expect(scope).not.toBeNull();

        const flagged = computeDashboardCapabilities(scope!, {
            hasActivePicProfile:
                (await findActivePicProfile(scope!.userId)) !== null,
        });

        // Entry is allowed (a real PIC account), but the suspended profile keeps every
        // self-service surface closed and every read re-checks `requireMyPic`.
        expect(canEnterDashboard(flagged)).toBe(true);
        expect(flagged.hasActivePicProfile).toBe(false);
        expect(flagged.hasTenantAccess).toBe(false);
    });
});

/* ==================================================================================
 * TEST 18 — first-pass-admitted actors are never marked as PICs
 * ================================================================================== */

describe("TEST 18 — a platform admin keeps a flag-free capability set", () => {
    test("an ADMIN admitted on the platform surface has hasActivePicProfile false", async () => {
        const scope = await resolveAuthzScope(admin.id);
        expect(scope).not.toBeNull();

        const plain = computeDashboardCapabilities(scope!);

        expect(canEnterDashboard(plain)).toBe(true);
        expect(plain.hasActivePicProfile).toBe(false);
    });
});

/* ==================================================================================
 * TEST 20 — `findActivePicProfile` is the layout's exact predicate
 * ================================================================================== */

describe("TEST 20 — findActivePicProfile is ACTIVE-only and user-scoped", () => {
    test("an ACTIVE profile resolves", async () => {
        const profile = await findActivePicProfile(picUser.id);
        expect(profile).not.toBeNull();
        expect(profile!.displayName.length).toBeGreaterThan(0);
        expect(profile!.picCode.length).toBeGreaterThan(0);
    });

    test("a SUSPENDED profile resolves to null", async () => {
        expect(await findActivePicProfile(suspendedUser.id)).toBeNull();
    });

    test("a user with no profile resolves to null", async () => {
        expect(await findActivePicProfile(customer.id)).toBeNull();
    });

    test("another user's id never resolves someone else's profile", async () => {
        expect(await findActivePicProfile(`${suspendedUser.id}x`)).toBeNull();
    });
});

/* ==================================================================================
 * TEST 21 (PHASE 34) — `findPicProfileStanding` is the ENTRY UX predicate
 * ================================================================================== */

describe("TEST 21 — findPicProfileStanding reports the standing, user-scoped", () => {
    test("each profile status resolves to itself", async () => {
        expect(await findPicProfileStanding(picUser.id)).toBe("ACTIVE");
        expect(await findPicProfileStanding(pendingUser.id)).toBe("PENDING");
        expect(await findPicProfileStanding(suspendedUser.id)).toBe("SUSPENDED");
    });

    test("a user with no profile resolves to null", async () => {
        expect(await findPicProfileStanding(customer.id)).toBeNull();
    });

    test("another user's id never resolves someone else's standing", async () => {
        expect(await findPicProfileStanding(`${pendingUser.id}x`)).toBeNull();
    });

    test("a PENDING PIC enters the shell but the standing is not ACTIVE, so self-service stays off", async () => {
        const scope = await resolveAuthzScope(pendingUser.id);
        expect(scope).not.toBeNull();

        const flagged = computeDashboardCapabilities(scope!, {
            hasActivePicProfile:
                (await findActivePicProfile(scope!.userId)) !== null,
        });

        expect(canEnterDashboard(flagged)).toBe(true);
        expect(flagged.hasActivePicProfile).toBe(false);
        expect(await findPicProfileStanding(pendingUser.id)).toBe("PENDING");
    });
});