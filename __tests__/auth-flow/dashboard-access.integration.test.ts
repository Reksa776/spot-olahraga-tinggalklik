/**
 * ==========================================
 * DASHBOARD ACCESS (INTEGRATION, REAL DATABASE)
 * ==========================================
 *
 * These tests execute the REAL resolvers and deciders against the REAL MariaDB database:
 *
 *   resolveAuthzScope(userId)                      → the actor's authority, from the DB
 *   computeDashboardCapabilities(scope)            → what the dashboard offers them
 *   canEnterDashboard(capabilities)                → the entry gate the layout applies
 *   listDashboardOrders(scope, { organizerId })    → a scoped read, for the isolation case
 *
 * `@/auth` is mocked so a session can be established without a browser — as in the Phase 3
 * suite — and that is the only thing mocked. Nothing about authorization is stubbed.
 *
 * Covers the scenarios the task lists:
 *   TEST 2  a valid organizer login has dashboard access
 *   TEST 3  a valid platform-user login has dashboard access
 *   TEST 4  an authenticated customer without any back-office capability is REFUSED
 *   TEST 8  an organizer opening another organizer's data is still refused
 *   and the "platform role alone is not enough" rule (no spanning without a membership).
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { isAppError } from "@/lib/api/errors";
import { AuthzErrorCode } from "@/lib/authz";
import { resolveAuthzScope } from "@/lib/authz/scope";
import { listDashboardOrders } from "@/lib/dashboard/orders";
import {
    canEnterDashboard,
    computeDashboardCapabilities,
} from "@/lib/dashboard/scope";
import { prisma } from "@/lib/prisma";

jest.setTimeout(60000);

const SUFFIX = `auth-flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Seeded = { id: string };

let ownerA: Seeded;
let ownerB: Seeded;
let plainCustomer: Seeded;
let platformAdmin: Seeded;
let platformManager: Seeded;

let organizerA: Seeded;
let organizerB: Seeded;

function createUser(tag: string, platformRole: "ADMIN" | "MANAGER" | null = null) {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            ...(platformRole ? { platformRole } : {}),
        },
    });
}

/** Capabilities as the dashboard layout would compute them for this user. */
async function capabilitiesFor(userId: string) {
    const scope = await resolveAuthzScope(userId);

    if (!scope) {
        throw new Error(`no scope resolved for ${userId}`);
    }

    return computeDashboardCapabilities(scope);
}

beforeAll(async () => {
    ownerA = await createUser("owner-a");
    ownerB = await createUser("owner-b");
    plainCustomer = await createUser("customer");
    platformAdmin = await createUser("platform-admin", "ADMIN");
    platformManager = await createUser("platform-manager", "MANAGER");

    organizerA = await prisma.organizer.create({
        data: {
            ownerUserId: ownerA.id,
            name: `Auth Flow A ${SUFFIX}`,
            slug: `auth-flow-a-${SUFFIX}`,
            status: "ACTIVE",
        },
    });

    organizerB = await prisma.organizer.create({
        data: {
            ownerUserId: ownerB.id,
            name: `Auth Flow B ${SUFFIX}`,
            slug: `auth-flow-b-${SUFFIX}`,
            status: "ACTIVE",
        },
    });

    await prisma.organizerMember.createMany({
        data: [
            {
                organizerId: organizerA.id,
                userId: ownerA.id,
                role: "OWNER",
                status: "ACTIVE",
            },
            {
                organizerId: organizerB.id,
                userId: ownerB.id,
                role: "OWNER",
                status: "ACTIVE",
            },
        ],
    });
});

afterAll(async () => {
    const users = [ownerA, ownerB, plainCustomer, platformAdmin, platformManager]
        .filter(Boolean)
        .map((user) => user.id);

    await prisma.organizerMember.deleteMany({ where: { userId: { in: users } } });
    await prisma.organizer.deleteMany({
        where: {
            id: { in: [organizerA?.id, organizerB?.id].filter(Boolean) as string[] },
        },
    });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
});

/* ==================================================================================
 * TEST 2 — a valid organizer has dashboard access
 * ================================================================================== */

describe("TEST 2 — an organizer with a membership may enter the dashboard", () => {
    test("the owner is admitted, and the tenant surfaces are offered", async () => {
        const capabilities = await capabilitiesFor(ownerA.id);

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.hasTenantAccess).toBe(true);
        expect(capabilities.canReadEvents).toBe(true);
        expect(capabilities.canReadOrders).toBe(true);
        expect(capabilities.canReadPayments).toBe(true);
        expect(capabilities.canManageEvents).toBe(true);
        expect(capabilities.canAssignPic).toBe(true);
        expect(capabilities.canReadReports).toBe(true);
    });

    test("an organizer with no platform role gets no platform surface", async () => {
        const capabilities = await capabilitiesFor(ownerA.id);

        expect(capabilities.canManageSports).toBe(false);
        expect(capabilities.canManageGlobalVenues).toBe(false);
        expect(capabilities.canManagePlatformPic).toBe(false);
    });
});

/* ==================================================================================
 * TEST 3 — a valid platform user has dashboard access
 * ================================================================================== */

describe("TEST 3 — a platform user may enter the dashboard", () => {
    test("an ADMIN with no membership is admitted on the platform surface alone", async () => {
        const capabilities = await capabilitiesFor(platformAdmin.id);

        expect(canEnterDashboard(capabilities)).toBe(true);
        expect(capabilities.canManageSports).toBe(true);
        expect(capabilities.canManageGlobalVenues).toBe(true);
        expect(capabilities.canManagePlatformPic).toBe(true);
    });

    test("but a platform role confers NO tenant data", async () => {
        // The isolation guarantee: ADMIN without a membership reads no organizer. The entry
        // gate lets them in (they have a platform job to do), the tenant surfaces stay shut.
        const capabilities = await capabilitiesFor(platformAdmin.id);

        expect(capabilities.hasTenantAccess).toBe(false);
        expect(capabilities.canReadEvents).toBe(false);
        expect(capabilities.canReadOrders).toBe(false);
        expect(capabilities.canReadPayments).toBe(false);
        expect(capabilities.canReadReports).toBe(false);
    });

    test("a platform MANAGER with no membership is refused: audit-only is not a dashboard surface", async () => {
        // MANAGER's only platform permission is `audit_log.read`, and the dashboard has no
        // audit page, so the menu would be empty. Refusing is the honest outcome rather than
        // admitting someone to a dashboard that offers them nothing.
        const capabilities = await capabilitiesFor(platformManager.id);

        expect(canEnterDashboard(capabilities)).toBe(false);
        expect(capabilities.hasTenantAccess).toBe(false);
    });
});

/* ==================================================================================
 * TEST 4 — an authenticated customer is refused
 * ================================================================================== */

describe("TEST 4 — an authenticated customer without a back-office capability is refused", () => {
    test("the entry gate is false", async () => {
        const capabilities = await capabilitiesFor(plainCustomer.id);

        expect(canEnterDashboard(capabilities)).toBe(false);
        expect(capabilities.hasTenantAccess).toBe(false);
        expect(capabilities.canReadEvents).toBe(false);
        expect(capabilities.canReadOrders).toBe(false);
    });

    test("being authenticated is not the same as being authorized", async () => {
        // The scope RESOLVES (the account exists and is signed in) — the refusal comes from
        // the capability computation, not from a missing identity. That is the whole point:
        // login is not access.
        const scope = await resolveAuthzScope(plainCustomer.id);

        expect(scope).not.toBeNull();
        expect(scope!.userId).toBe(plainCustomer.id);
        expect(canEnterDashboard(computeDashboardCapabilities(scope!))).toBe(false);
    });
});

/* ==================================================================================
 * TEST 8 — tenant isolation on a dashboard read
 * ================================================================================== */

describe("TEST 8 — a dashboard read cannot cross tenants", () => {
    test("listing with a forged organizerId is refused", async () => {
        const scope = await resolveAuthzScope(ownerA.id);

        await expect(
            listDashboardOrders(scope!, { organizerId: organizerB.id })
        ).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });

    test("listing without an organizerId returns only the actor's own tenant", async () => {
        const scope = await resolveAuthzScope(ownerA.id);

        // No rows are seeded, so what is asserted is that the call SUCCEEDS and is scoped —
        // it resolves to organizer A, not to "everything".
        const result = await listDashboardOrders(scope!, { limit: 5 });

        expect(result.pagination.total).toBe(0);
    });

    test("an actor with no tenant capability is refused even for a well-formed request", async () => {
        const scope = await resolveAuthzScope(platformAdmin.id);

        // A platform ADMIN naming an organizer it is not a member of is denied exactly like
        // anyone else — 404-shaped, so the refusal does not confirm the organizer exists.
        await expect(
            listDashboardOrders(scope!, { organizerId: organizerA.id })
        ).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });

    test("the refusal is a real AppError, so it becomes an HTTP status not a crash", async () => {
        const scope = await resolveAuthzScope(ownerA.id);

        try {
            await listDashboardOrders(scope!, { organizerId: organizerB.id });
            throw new Error("expected a refusal");
        } catch (error) {
            expect(isAppError(error)).toBe(true);
        }
    });
});
