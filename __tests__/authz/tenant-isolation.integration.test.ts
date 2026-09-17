/**
 * ==========================================
 * PHASE 3 — TENANT ISOLATION (INTEGRATION)
 * ==========================================
 *
 * These tests EXECUTE THE REAL GUARDS against the REAL MariaDB database. They are
 * not source-matching tests and they are not mocks of the decision logic.
 *
 * `@/auth` is mocked so a session can be established without a browser. That is
 * the ONLY thing mocked: `lib/authz` resolves every actor's authority from the
 * database through the real Prisma client.
 *
 * Covers the six cases the phase 3 brief §16 requires:
 *   A. same organizer      — allowed according to role/permission
 *   B. different organizer — denied
 *   C. manipulated organizerId — denied
 *   D. role escalation     — cannot be obtained from client/session values
 *   E. unauthenticated     — rejected
 *   F. inactive membership — rejected
 *
 * All seeded rows use a unique suffix and are removed in afterAll.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import {
    AuthzErrorCode,
    PERMISSIONS,
    authzErrorResponse,
    getAuthzScope,
    isAuthzError,
    requireAuth,
    requireOrganizerAccess,
    requireOrganizerMember,
    requirePlatformPermission,
    requireOwnResource,
} from "@/lib/authz";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(60000);

const SUFFIX = `p3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Seeded = { id: string };

let ownerA: Seeded;
let ownerB: Seeded;
let picUser: Seeded;
let staffUser: Seeded;
let adminUser: Seeded;
let suspendedUser: Seeded;
let memberA: Seeded;
let memberB: Seeded;

/** Point the mocked session at a user id (or at nobody). */
function signInAs(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: {
                      id: userId,
                      email: `${userId}@${SUFFIX}.test`,
                      name: "Test",
                  },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

function createUser(tag: string, platformRole?: "ADMIN" | "MANAGER" | "PIC") {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            ...(platformRole ? { platformRole } : {}),
        },
    });
}

beforeAll(async () => {
    ownerA = await createUser("owner-a");
    ownerB = await createUser("owner-b");
    picUser = await createUser("pic", "PIC");
    staffUser = await createUser("staff");
    adminUser = await createUser("admin", "ADMIN");
    suspendedUser = await createUser("suspended");

    memberA = await prisma.organizer.create({
        data: {
            ownerUserId: ownerA.id,
            name: `Organizer A ${SUFFIX}`,
            slug: `org-a-${SUFFIX}`,
            status: "ACTIVE",
        },
    });

    memberB = await prisma.organizer.create({
        data: {
            ownerUserId: ownerB.id,
            name: `Organizer B ${SUFFIX}`,
            slug: `org-b-${SUFFIX}`,
            status: "ACTIVE",
        },
    });

    await prisma.organizerMember.createMany({
        data: [
            {
                organizerId: memberA.id,
                userId: ownerA.id,
                role: "OWNER",
                status: "ACTIVE",
            },
            {
                organizerId: memberB.id,
                userId: ownerB.id,
                role: "OWNER",
                status: "ACTIVE",
            },
            {
                organizerId: memberA.id,
                userId: picUser.id,
                role: "PIC",
                status: "ACTIVE",
            },
            {
                organizerId: memberA.id,
                userId: staffUser.id,
                role: "CHECKIN_STAFF",
                status: "ACTIVE",
            },
            {
                organizerId: memberA.id,
                userId: adminUser.id,
                role: "OWNER",
                status: "ACTIVE",
            },
            {
                organizerId: memberA.id,
                userId: suspendedUser.id,
                role: "MANAGER",
                status: "SUSPENDED",
            },
        ],
    });
});

afterAll(async () => {
    const users = [
        ownerA,
        ownerB,
        picUser,
        staffUser,
        adminUser,
        suspendedUser,
    ].filter(Boolean);

    await prisma.permissionGrant.deleteMany({
        where: { userId: { in: users.map((u) => u.id) } },
    });
    await prisma.organizerMember.deleteMany({
        where: { userId: { in: users.map((u) => u.id) } },
    });
    await prisma.organizer.deleteMany({
        where: { id: { in: [memberA?.id, memberB?.id].filter(Boolean) as string[] } },
    });
    await prisma.user.deleteMany({
        where: { id: { in: users.map((u) => u.id) } },
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case E — unauthenticated
// ─────────────────────────────────────────────────────────────────────────────

describe("Case E — unauthenticated access is rejected", () => {
    test("requireAuth fails closed with UNAUTHORIZED", async () => {
        signInAs(null);

        await expect(requireAuth()).rejects.toMatchObject({
            code: AuthzErrorCode.UNAUTHORIZED,
            status: 401,
        });
    });

    test("an organizer-scoped guard also fails as UNAUTHORIZED, not as a tenant denial", async () => {
        signInAs(null);

        await expect(
            requireOrganizerAccess(memberA.id, PERMISSIONS.EVENT_READ)
        ).rejects.toMatchObject({ code: AuthzErrorCode.UNAUTHORIZED, status: 401 });
    });

    test("an unauthenticated request maps to a 401 response body", async () => {
        signInAs(null);

        try {
            await requirePlatformPermission(PERMISSIONS.USER_MANAGE);
            throw new Error("guard should have thrown");
        } catch (error) {
            expect(isAuthzError(error)).toBe(true);
            const response = authzErrorResponse(error);
            expect(response.status).toBe(401);
            const body = await response.json();
            expect(body.success).toBe(false);
            expect(body.code).toBe(AuthzErrorCode.UNAUTHORIZED);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case A — same organizer
// ─────────────────────────────────────────────────────────────────────────────

describe("Case A — an active member acts in their own organizer", () => {
    test("owner of A can write events in A", async () => {
        signInAs(ownerA.id);

        const scope = await requireOrganizerAccess(
            memberA.id,
            PERMISSIONS.EVENT_WRITE
        );

        expect(scope.userId).toBe(ownerA.id);
        expect(scope.platformRole).toBe("CUSTOMER");
    });

    test("scope is resolved from the database, not from the session payload", async () => {
        signInAs(ownerA.id);

        const scope = await getAuthzScope();

        expect(scope).not.toBeNull();
        expect(scope!.organizerScopes.map((m) => m.organizerId)).toEqual([
            memberA.id,
        ]);
        expect(scope!.organizerScopes[0].role).toBe("OWNER");
    });

    test("CHECKIN_STAFF may scan but may not read tenant orders", async () => {
        signInAs(staffUser.id);

        await expect(
            requireOrganizerAccess(memberA.id, PERMISSIONS.CHECKIN_SCAN)
        ).resolves.toBeTruthy();

        await expect(
            requireOrganizerAccess(memberA.id, PERMISSIONS.ORDER_READ_TENANT)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });
    });

    test("requireOrganizerMember accepts an active member and rejects an outsider", async () => {
        signInAs(ownerA.id);
        await expect(requireOrganizerMember(memberA.id)).resolves.toBeTruthy();

        signInAs(ownerA.id);
        await expect(requireOrganizerMember(memberB.id)).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cases B and C — cross-organizer and manipulated organizerId
// ─────────────────────────────────────────────────────────────────────────────

describe("Case B — a member of A cannot reach organizer B", () => {
    test("denied with a 404-shaped ORGANIZER_ACCESS_DENIED", async () => {
        signInAs(ownerA.id);

        try {
            await requireOrganizerAccess(memberB.id, PERMISSIONS.EVENT_READ);
            throw new Error("guard should have thrown");
        } catch (error) {
            expect(isAuthzError(error)).toBe(true);
            expect((error as { code: string }).code).toBe(
                AuthzErrorCode.ORGANIZER_ACCESS_DENIED
            );

            // 404, not 403: the denial must not confirm that organizer B exists.
            const response = authzErrorResponse(error);
            expect(response.status).toBe(404);
        }
    });

    test("the actor's scope contains only their own organizer", async () => {
        signInAs(ownerA.id);

        const scope = await getAuthzScope();
        const ids = scope!.organizerScopes.map((m) => m.organizerId);

        expect(ids).toContain(memberA.id);
        expect(ids).not.toContain(memberB.id);
    });
});

describe("Case C — swapping organizerId does not transfer authority", () => {
    test("identical permission, two ids, opposite outcomes", async () => {
        signInAs(ownerA.id);
        await expect(
            requireOrganizerAccess(memberA.id, PERMISSIONS.EVENT_WRITE)
        ).resolves.toBeTruthy();

        signInAs(ownerA.id);
        await expect(
            requireOrganizerAccess(memberB.id, PERMISSIONS.EVENT_WRITE)
        ).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });

    test("a fabricated organizerId is denied for every role, including ADMIN", async () => {
        signInAs(adminUser.id);

        await expect(
            requireOrganizerAccess("organizer-does-not-exist", PERMISSIONS.EVENT_READ)
        ).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });

    test("an empty organizerId is rejected as not found", async () => {
        signInAs(ownerA.id);

        await expect(
            requireOrganizerAccess("", PERMISSIONS.EVENT_READ)
        ).rejects.toMatchObject({ code: AuthzErrorCode.NOT_FOUND });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case D — role escalation from client-supplied values
// ─────────────────────────────────────────────────────────────────────────────

describe("Case D — claimed roles cannot escalate privileges", () => {
    test("a PIC cannot reach event.write through its own membership", async () => {
        signInAs(picUser.id);

        await expect(
            requireOrganizerAccess(memberA.id, PERMISSIONS.EVENT_WRITE)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });
    });

    test("a session that claims platformRole ADMIN and role ADMIN is still denied", async () => {
        // This is the escalation attempt: the caller's session asserts privileges
        // the database does not grant. The guards read `platformRole` from the
        // User row, so the claim is ignored.
        auth.mockResolvedValue({
            user: {
                id: picUser.id,
                email: `${picUser.id}@${SUFFIX}.test`,
                name: "Escalation Attempt",
                role: "ADMIN",
                platformRole: "ADMIN",
            },
            expires: new Date(Date.now() + 60_000).toISOString(),
        });

        const scope = await getAuthzScope();
        expect(scope!.platformRole).toBe("PIC"); // database wins

        await expect(
            requireOrganizerAccess(memberA.id, PERMISSIONS.EVENT_WRITE)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        await expect(
            requirePlatformPermission(PERMISSIONS.USER_MANAGE)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });
    });

    test("a non-ADMIN cannot manage users or roles", async () => {
        signInAs(ownerA.id);

        await expect(
            requirePlatformPermission(PERMISSIONS.USER_MANAGE)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        await expect(
            requirePlatformPermission(PERMISSIONS.ROLE_MANAGE)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });
    });

    test("an actor with a NULL platformRole is treated as CUSTOMER, not privileged", async () => {
        signInAs(ownerA.id);

        const scope = await getAuthzScope();
        expect(scope!.platformRole).toBe("CUSTOMER");

        await expect(
            requirePlatformPermission(PERMISSIONS.PLATFORM_CONFIG)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case F — inactive membership
// ─────────────────────────────────────────────────────────────────────────────

describe("Case F — a suspended membership cannot authorize", () => {
    test("SUSPENDED membership is denied tenant access", async () => {
        signInAs(suspendedUser.id);

        await expect(
            requireOrganizerAccess(memberA.id, PERMISSIONS.EVENT_READ)
        ).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });

    test("the suspended row is still visible to the resolver (status is what denies)", async () => {
        signInAs(suspendedUser.id);

        const scope = await getAuthzScope();
        const entry = scope!.organizerScopes.find(
            (m) => m.organizerId === memberA.id
        );

        expect(entry).toBeDefined();
        expect(entry!.status).toBe("SUSPENDED");
    });

    test("requireOrganizerMember rejects a suspended membership", async () => {
        signInAs(suspendedUser.id);

        await expect(requireOrganizerMember(memberA.id)).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-19 — end-to-end grant behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("D-19 — an ADMIN needs an explicit grant for financial actions", () => {
    test("denied before the grant, allowed after, denied again once revoked", async () => {
        signInAs(adminUser.id);

        // The user is a platform ADMIN and an ACTIVE member of A, and event.write
        // works — so the denial below is about money, not about reachability.
        await expect(
            requireOrganizerAccess(memberA.id, PERMISSIONS.EVENT_WRITE)
        ).resolves.toBeTruthy();

        await expect(
            requireOrganizerAccess(memberA.id, PERMISSIONS.SETTLEMENT_APPROVE)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        const created = await prisma.permissionGrant.create({
            data: {
                userId: adminUser.id,
                organizerId: memberA.id,
                permission: PERMISSIONS.SETTLEMENT_APPROVE,
                grantedByUserId: ownerA.id,
                reason: `phase-3 test ${SUFFIX}`,
            },
        });

        await expect(
            requireOrganizerAccess(memberA.id, PERMISSIONS.SETTLEMENT_APPROVE)
        ).resolves.toBeTruthy();

        // Revoking the grant must take effect without a re-login.
        await prisma.permissionGrant.update({
            where: { id: created.id },
            data: {
                revokedAt: new Date(),
                revokedByUserId: ownerA.id,
            },
        });

        await expect(
            requireOrganizerAccess(memberA.id, PERMISSIONS.SETTLEMENT_APPROVE)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });
    });

    test("a grant does not widen into permissions it does not name", async () => {
        signInAs(adminUser.id);

        await expect(
            requireOrganizerAccess(memberA.id, PERMISSIONS.FEE_ADJUST)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// OWN-scope resolution through the guard
// ─────────────────────────────────────────────────────────────────────────────

describe("own-scope guards", () => {
    test("a PIC may read their own record but not another user's", async () => {
        signInAs(picUser.id);

        await expect(
            requireOwnResource(PERMISSIONS.PIC_FEE_READ_OWN, picUser.id)
        ).resolves.toBeTruthy();

        signInAs(picUser.id);
        await expect(
            requireOwnResource(PERMISSIONS.PIC_FEE_READ_OWN, ownerA.id)
        ).rejects.toMatchObject({ code: AuthzErrorCode.PIC_ACCESS_DENIED });
    });

    test("an unowned record is denied", async () => {
        signInAs(picUser.id);

        await expect(
            requireOwnResource(PERMISSIONS.PIC_FEE_READ_OWN, null)
        ).rejects.toMatchObject({ code: AuthzErrorCode.PIC_ACCESS_DENIED });
    });
});
