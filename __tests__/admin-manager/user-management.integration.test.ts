/**
 * ==========================================
 * PHASE 33 — ADMIN USER MANAGEMENT (INTEGRATION, REAL DATABASE)
 * ==========================================
 *
 * The two verbs the new surface exposes, pinned end-to-end against the real authz
 * deciders and the real database:
 *
 *   listManagedUsers       — the ADMIN list of MANAGER/PIC accounts
 *   createManagedUser      — MANAGER creation; PIC creation (User + PICProfile together)
 *   setManagedUserDisabled — reversible deactivation, and its reach
 *
 * and the three denial faces that make the surface ADMIN-only:
 *
 *   MANAGER / PIC / CUSTOMER session → every verb refused (FORBIDDEN), before any query;
 *   the target of disable is restricted to the two managed roles (an ADMIN row can never
 *   be disabled through this surface, even by an ADMIN);
 *   the fixed role union — `user.manage` is absent from `ADMIN_GRANT_REQUIRED`, so a
 *   PermissionGrant cannot manufacture the capability for another role either.
 *
 * `@/auth` is mocked (structural: next-auth is unparseable ESM in Jest) and the session
 * is answered per test with a REAL user row, so `resolveAuthzScope` runs against the
 * database exactly as production does.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { auth } from "@/auth";
import {
    createManagedUser,
    listManagedUsers,
    setManagedUserDisabled,
    MANAGED_ROLES,
} from "@/lib/admin/users";
import { PERMISSIONS } from "@/lib/authz";
import { resolveAuthzScope } from "@/lib/authz/scope";
import { isAuthzError } from "@/lib/authz/errors";
import { isAppError } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";

jest.setTimeout(120_000);

const SUFFIX = `usermgmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const authMock = auth as jest.Mock;

let admin: { id: string };
let manager: { id: string };
let plainPic: { id: string };
let customer: { id: string };

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

/** Point the mocked session at a real user row — the identity the guards resolve from. */
function actAs(userId: string) {
    authMock.mockResolvedValue({ user: { id: userId } });
}

beforeEach(() => {
    authMock.mockReset();
});

/**
 * Jest has no `rejects.toSatisfy`; this asserts a promise REJECTS with the platform's own
 * refusal taxonomy — either an `AppError` or an `AuthzError` (the guards throw the latter;
 * the API envelope normalises it via `toAppError`). Anything else is a crash, not a denial.
 */
async function expectRefusal(promise: Promise<unknown>): Promise<void> {
    try {
        await promise;
        throw new Error("expected the call to be refused");
    } catch (error) {
        expect(isAppError(error) || isAuthzError(error)).toBe(true);
    }
}

beforeAll(async () => {
    admin = await createUser("admin", "ADMIN");
    manager = await createUser("manager", "MANAGER");
    plainPic = await createUser("pic", "PIC");
    customer = await createUser("customer");
});

afterAll(async () => {
    // Only rows this suite created (fixture suffix / explicit ids); never a sweep.
    const created = await prisma.user.findMany({
        where: { email: { contains: SUFFIX } },
        select: { id: true },
    });
    const ids = [
        admin?.id,
        manager?.id,
        plainPic?.id,
        customer?.id,
        ...created.map((u) => u.id),
    ].filter(Boolean) as string[];

    await prisma.adminAuditLog.deleteMany({
        where: { entityRef: { in: ids }, action: { in: ["user.created", "pic.user.created", "user.disabled", "user.enabled"] } },
    });
    await prisma.pICProfile.deleteMany({ where: { userId: { in: ids } } });
    // PHASE 38 — a MANAGER created through the service now carries an ACTIVE
    // OrganizerMember (its operational scope). The `OrganizerMember.user` FK is
    // Restrict, so the membership must be removed before the user row.
    await prisma.organizerMember.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

/* ==================================================================================
 * 1. CREATION — the happy paths
 * ================================================================================== */

describe("createManagedUser (ADMIN)", () => {
    test("creates a MANAGER account with the role set server-side and a hashed password", async () => {
        actAs(admin.id);
        const adminScope = (await resolveAuthzScope(admin.id))!;
        const result = (await createManagedUser(adminScope, {
            name: "Manager Baru",
            email: `new-manager-${SUFFIX}@example.test`,
            password: "PasswordRahasia1",
            role: "MANAGER",
        })) as { id: string; platformRole: string };

        const row = await prisma.user.findUnique({
            where: { id: result.id },
            select: { platformRole: true, role: true, password: true, disabledAt: true },
        });

        expect(row).not.toBeNull();
        expect(row!.platformRole).toBe("MANAGER");
        // The legacy retail column stays dormant.
        expect(row!.role).toBe("CUSTOMER");
        // Stored as a bcrypt hash, never the plaintext.
        expect(row!.password).not.toBeNull();
        expect(row!.password).not.toBe("PasswordRahasia1");
        expect(row!.password!.startsWith("$2")).toBe(true);
        // No PIC profile is created for a manager.
        const profile = await prisma.pICProfile.findUnique({
            where: { userId: result.id },
        });
        expect(profile).toBeNull();
    });

    test("creates a PIC account AND its PICProfile in one step, profile PENDING", async () => {
        actAs(admin.id);
        const adminScope = (await resolveAuthzScope(admin.id))!;
        const result = (await createManagedUser(adminScope, {
            name: "PIC Baru",
            email: `new-pic-${SUFFIX}@example.test`,
            password: "PasswordRahasia1",
            role: "PIC",
            pic: { displayName: "PIC Baru Display" },
        })) as { id: string; platformRole: string };

        const [row, profile] = await Promise.all([
            prisma.user.findUnique({
                where: { id: result.id },
                select: { platformRole: true },
            }),
            prisma.pICProfile.findUnique({
                where: { userId: result.id },
                select: { displayName: true, status: true, picCode: true },
            }),
        ]);

        expect(row!.platformRole).toBe("PIC");
        expect(profile).not.toBeNull();
        expect(profile!.status).toBe("PENDING");
        expect(profile!.displayName).toBe("PIC Baru Display");
        expect(profile!.picCode.startsWith("PICBARU")).toBe(true);
    });

    test("refuses a duplicate email with a conflict", async () => {
        actAs(admin.id);
        const adminScope = (await resolveAuthzScope(admin.id))!;

        await expectRefusal(
            createManagedUser(adminScope, {
                name: "Duplikat",
                email: `new-manager-${SUFFIX}@example.test`,
                password: "PasswordRahasia1",
                role: "MANAGER",
            })
        );
    });

    test("never accepts an arbitrary role from the caller (the fixed union)", async () => {
        // The service-level guard for direct callers; the route's Zod enum is the first wall.
        actAs(admin.id);
        const adminScope = (await resolveAuthzScope(admin.id))!;

        await expectRefusal(
            createManagedUser(adminScope, {
                name: "Escalation",
                email: `escalation-${SUFFIX}@example.test`,
                password: "PasswordRahasia1",
                role: "ADMIN" as never,
            })
        );

        const created = await prisma.user.findUnique({
            where: { email: `escalation-${SUFFIX}@example.test` },
            select: { id: true },
        });
        expect(created).toBeNull();
    });

    test("audits the creation without any credential material", async () => {
        const log = await prisma.adminAuditLog.findFirst({
            where: { action: "user.created", entityRef: { not: null } },
            orderBy: { createdAt: "desc" },
        });

        expect(log).not.toBeNull();
        const state = JSON.stringify(log?.afterState ?? {});
        expect(state).not.toContain("PasswordRahasia1");
        expect(state.toLowerCase()).not.toContain("password");
    });
});

/* ==================================================================================
 * 2. THE LIST
 * ================================================================================== */

describe("listManagedUsers (ADMIN)", () => {
    test("lists MANAGER and PIC accounts, never ADMIN rows", async () => {
        actAs(admin.id);
        const adminScope = (await resolveAuthzScope(admin.id))!;
        const result = (await listManagedUsers(adminScope)) as {
            items: { platformRole: string; password?: string }[]
        };

        expect(result.items.length).toBeGreaterThan(0);
        for (const item of result.items) {
            expect(MANAGED_ROLES).toContain(item.platformRole);
            // No credential field ever reaches the payload.
            expect(item).not.toHaveProperty("password");
        }
    });

    test("filters by role", async () => {
        actAs(admin.id);
        const adminScope = (await resolveAuthzScope(admin.id))!;
        const result = (await listManagedUsers(adminScope, { role: "PIC" })) as {
            items: { platformRole: string }[]
        };

        for (const item of result.items) {
            expect(item.platformRole).toBe("PIC");
        }
    });
});

/* ==================================================================================
 * 3. DISABLE / ENABLE — reversible, bounded
 * ================================================================================== */

describe("setManagedUserDisabled (ADMIN)", () => {
    test("disables and re-enables a MANAGER, and deactivation denies the dashboard scope", async () => {
        actAs(admin.id);
        const adminScope = (await resolveAuthzScope(admin.id))!;

        const result = (await setManagedUserDisabled(
            adminScope,
            manager.id,
            true
        )) as { disabled: boolean };
        expect(result.disabled).toBe(true);

        // A disabled account resolves to NO scope — the fail-closed contract every
        // server-side authorization check begins from.
        expect(await resolveAuthzScope(manager.id)).toBeNull();

        const restored = (await setManagedUserDisabled(
            adminScope,
            manager.id,
            false
        )) as { disabled: boolean };
        expect(restored.disabled).toBe(false);

        expect(await resolveAuthzScope(manager.id)).not.toBeNull();
    });

    test("refuses to disable an ADMIN row — the surface is bounded to the managed roles", async () => {
        actAs(admin.id);
        const adminScope = (await resolveAuthzScope(admin.id))!;

        await expectRefusal(setManagedUserDisabled(adminScope, admin.id, true));

        // The admin is unharmed.
        expect(await resolveAuthzScope(admin.id)).not.toBeNull();
    });
});

/* ==================================================================================
 * 4. THE DENIAL FACES — MANAGER / PIC / CUSTOMER are refused every verb
 * ================================================================================== */

describe("non-ADMIN sessions are refused every verb", () => {
    test("a MANAGER cannot list, create, or disable", async () => {
        actAs(manager.id);
        const managerScope = await resolveAuthzScope(manager.id);

        await expectRefusal(listManagedUsers(managerScope!));
        await expectRefusal(
            createManagedUser(managerScope!, {
                name: "Tidak Boleh",
                email: `manager-created-${SUFFIX}@example.test`,
                password: "PasswordRahasia1",
                role: "PIC",
            })
        );
        await expectRefusal(
            setManagedUserDisabled(managerScope!, customer.id, true)
        );

        // Nothing was created by the refused call.
        expect(
            await prisma.user.findUnique({
                where: { email: `manager-created-${SUFFIX}@example.test` },
            })
        ).toBeNull();
    });

    test("a PIC cannot create users — including itself", async () => {
        actAs(plainPic.id);
        const picScope = await resolveAuthzScope(plainPic.id);

        await expectRefusal(
            createManagedUser(picScope!, {
                name: "Tidak Boleh",
                email: `pic-created-${SUFFIX}@example.test`,
                password: "PasswordRahasia1",
                role: "PIC",
            })
        );
    });

    test("a CUSTOMER has no scope for user management", async () => {
        actAs(customer.id);
        const customerScope = await resolveAuthzScope(customer.id);

        await expectRefusal(listManagedUsers(customerScope!));
    });

    test("a PermissionGrant cannot manufacture user.manage for a MANAGER", async () => {
        const grant = await prisma.permissionGrant.create({
            data: {
                userId: manager.id,
                organizerId: null,
                permission: PERMISSIONS.USER_MANAGE,
                grantedByUserId: admin.id,
            },
            select: { id: true },
        });

        actAs(manager.id);

        try {
            const scope = await resolveAuthzScope(manager.id);
            // The grant row IS in the scope…
            expect(scope!.grants).toContainEqual({
                organizerId: null,
                permission: PERMISSIONS.USER_MANAGE,
            });
            // …and the decider still refuses, because grants only ever satisfy
            // ADMIN_GRANT_REQUIRED permissions for ADMIN.
            await expectRefusal(listManagedUsers(scope!));
        } finally {
            await prisma.permissionGrant.delete({ where: { id: grant.id } });
        }
    });
});
