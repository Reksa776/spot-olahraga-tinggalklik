/**
 * ==========================================
 * PHASE 4 — VENUE OWNERSHIP (D-64) & SPORT AUTHORIZATION (INTEGRATION)
 * ==========================================
 *
 * D-64 is LOCKED as **BOTH** ownership classes:
 *   global  (`organizerId: null`) — shared platform venues, platform permission only
 *   private (`organizerId: X`)    — tenant-scoped, full isolation
 *
 * These tests exercise the real services and the real authorization layer against the
 * real database, so an "allowed" result is a real permission decision rather than a
 * mock's opinion.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { AuthzErrorCode } from "@/lib/authz";
import { AppError } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";
import { createEvent } from "@/lib/events/service";
import {
    createGlobalVenue,
    createVenue,
    deleteVenue,
    getVenue,
    listGlobalVenues,
    listVenues,
    updateVenue,
} from "@/lib/venues/service";
import {
    createSport,
    deleteSport,
    listPublicSports,
    listSportsForAdmin,
    updateSport,
} from "@/lib/sports/service";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(120000);

const SUFFIX = `p4v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let ownerA: { id: string };
let ownerB: { id: string };
let platformAdmin: { id: string };
let adminMemberA: { id: string };
let platformManager: { id: string };

let orgA: { id: string };
let orgB: { id: string };
let sport: { id: string; slug: string };

let venueA: { id: string };
let venueB: { id: string };
let globalVenue: { id: string };

function signInAs(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: { id: userId, email: `${userId}@${SUFFIX}.test`, name: "Test" },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

/**
 * Resolve the actor's scope (used as the services' first argument).
 *
 * Throws instead of returning `null`: a test that reaches a service with no scope is a
 * broken fixture, and failing loudly here is much easier to diagnose than 40 downstream
 * "AuthzScope | null is not assignable" errors.
 */
async function scopeFor(userId: string) {
    const { resolveAuthzScope } = await import("@/lib/authz");
    const scope = await resolveAuthzScope(userId);

    if (!scope) {
        throw new Error(`Fixture error: no authz scope resolved for user ${userId}`);
    }

    return scope;
}

async function createUser(tag: string, platformRole?: "ADMIN" | "MANAGER" | "PIC") {
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

beforeAll(async () => {
    ownerA = await createUser("owner-a");
    ownerB = await createUser("owner-b");
    platformAdmin = await createUser("platform-admin", "ADMIN");
    adminMemberA = await createUser("admin-member-a", "ADMIN");
    platformManager = await createUser("platform-manager", "MANAGER");

    orgA = await prisma.organizer.create({
        data: {
            ownerUserId: ownerA.id,
            name: `Venue Org A ${SUFFIX}`,
            slug: `venue-org-a-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    orgB = await prisma.organizer.create({
        data: {
            ownerUserId: ownerB.id,
            name: `Venue Org B ${SUFFIX}`,
            slug: `venue-org-b-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.createMany({
        data: [
            { organizerId: orgA.id, userId: ownerA.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: orgB.id, userId: ownerB.id, role: "OWNER", status: "ACTIVE" },
            // An ADMIN who IS a member of A — the control case proving the denial
            // against platformAdmin below is about membership, not about the role.
            { organizerId: orgA.id, userId: adminMemberA.id, role: "OWNER", status: "ACTIVE" },
        ],
    });

    sport = await prisma.sport.create({
        data: { name: `Venue Test Sport ${SUFFIX}`, slug: `venue-sport-${SUFFIX}` },
        select: { id: true, slug: true },
    });

    venueA = await prisma.venue.create({
        data: { organizerId: orgA.id, name: `Private A ${SUFFIX}`, city: "Jakarta" },
        select: { id: true },
    });

    venueB = await prisma.venue.create({
        data: { organizerId: orgB.id, name: `Private B ${SUFFIX}`, city: "Bandung" },
        select: { id: true },
    });

    globalVenue = await prisma.venue.create({
        data: { organizerId: null, name: `Global ${SUFFIX}`, city: "Surabaya" },
        select: { id: true },
    });
});

afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean) as string[];
    const userIds = [ownerA, ownerB, platformAdmin, adminMemberA, platformManager]
        .filter(Boolean)
        .map((u) => u.id);

    const eventIds = (
        await prisma.event.findMany({
            where: { organizerId: { in: orgIds } },
            select: { id: true },
        })
    ).map((e) => e.id);

    if (eventIds.length > 0) {
        await prisma.ticketType.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }

    await prisma.permissionGrant.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.organizerMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.venue.deleteMany({ where: { id: { in: [venueA?.id, venueB?.id, globalVenue?.id].filter(Boolean) as string[] } } });
    await prisma.venue.deleteMany({ where: { organizerId: { in: orgIds } } });
    await prisma.venue.deleteMany({ where: { name: { contains: SUFFIX } } });
    await prisma.organizer.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.event.deleteMany({ where: { sportId: sport?.id } });
    await prisma.sport.deleteMany({ where: { slug: { contains: SUFFIX } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-64 — private venues
// ─────────────────────────────────────────────────────────────────────────────

describe("D-64 — private venue ownership", () => {
    test("an organizer OWNER can create a private venue in their own tenant", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        const venue = await createVenue(scope, orgA.id, {
            name: `New Private A ${SUFFIX}`,
            city: "Depok",
        } as never);

        expect(venue.organizerId).toBe(orgA.id);
        expect(venue.isGlobal).toBe(false);
    });

    test("an organizer OWNER cannot create a venue for ANOTHER organizer", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        await expect(
            createVenue(scope, orgB.id, { name: `Trespass ${SUFFIX}` } as never)
        ).rejects.toMatchObject({ code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });
    });

    test("an organizer member can read their own private venue", async () => {
        signInAs(ownerA.id);
        const venue = await getVenue(venueA.id);

        expect(venue.id).toBe(venueA.id);
        expect(venue.isGlobal).toBe(false);
    });

    test("another organizer cannot read a private venue — 404, not 403", async () => {
        signInAs(ownerA.id);

        try {
            await getVenue(venueB.id);
            throw new Error("should have thrown");
        } catch (error) {
            const authzError = error as { code: string; status: number };
            expect(authzError.code).toBe(AuthzErrorCode.ORGANIZER_ACCESS_DENIED);
            expect(authzError.status).toBe(404);
        }
    });

    test("another organizer cannot update or delete a private venue", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        await expect(
            updateVenue(scope, venueB.id, { name: "Hijacked" } as never)
        ).rejects.toMatchObject({ code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });

        await expect(deleteVenue(scope, venueB.id)).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });

        const untouched = await prisma.venue.findUniqueOrThrow({
            where: { id: venueB.id },
            select: { name: true },
        });

        expect(untouched.name).toContain("Private B");
    });

    test("the owner can update their own private venue", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        const updated = await updateVenue(scope, venueA.id, {
            name: `Private A Renamed ${SUFFIX}`,
            capacity: 5000,
        } as never);

        expect(updated.name).toBe(`Private A Renamed ${SUFFIX}`);
        expect(updated.capacity).toBe(5000);
    });

    test("no organizer holder can reach an unowned private venue id", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        await expect(getVenue("venue-does-not-exist")).rejects.toMatchObject({
            code: "NOT_FOUND",
        });

        await expect(
            updateVenue(scope, "venue-does-not-exist", { name: "x" } as never)
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-64 — global venues
// ─────────────────────────────────────────────────────────────────────────────

describe("D-64 — platform-global venues", () => {
    test("a platform ADMIN can create a global venue", async () => {
        signInAs(platformAdmin.id);
        const scope = await scopeFor(platformAdmin.id);

        const venue = await createGlobalVenue(scope, {
            name: `Admin Global ${SUFFIX}`,
            city: "Medan",
        } as never);

        expect(venue.organizerId).toBeNull();
        expect(venue.isGlobal).toBe(true);
    });

    test("an organizer OWNER cannot create a global venue", async () => {
        // The decisive D-64 test: the same actor who just created a private venue
        // successfully is refused a global one, because global venues require a
        // platform permission no organizer membership confers.
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        await expect(
            createVenue(scope, null, { name: `Sneaky Global ${SUFFIX}` } as never)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        expect(
            await prisma.venue.count({
                where: { name: `Sneaky Global ${SUFFIX}` },
            })
        ).toBe(0);
    });

    test("a platform MANAGER cannot create a global venue", async () => {
        // `venue.manage.global` is ADMIN-only (design §6.3: venue master data is not
        // a Manager capability at platform scope).
        signInAs(platformManager.id);
        const scope = await scopeFor(platformManager.id);

        await expect(
            createVenue(scope, null, { name: `Manager Global ${SUFFIX}` } as never)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });
    });

    test("an organizer member CAN read a global venue (they are shared by design)", async () => {
        signInAs(ownerA.id);

        const venue = await getVenue(globalVenue.id);

        expect(venue.isGlobal).toBe(true);
    });

    test("an organizer member CANNOT update or delete a global venue", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        await expect(
            updateVenue(scope, globalVenue.id, { name: "Hijacked Global" } as never)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        await expect(deleteVenue(scope, globalVenue.id)).rejects.toMatchObject({
            code: AuthzErrorCode.FORBIDDEN,
        });

        const untouched = await prisma.venue.findUniqueOrThrow({
            where: { id: globalVenue.id },
            select: { name: true },
        });

        expect(untouched.name).toContain("Global");
    });

    test("a platform ADMIN manages global venues through the platform surface", async () => {
        signInAs(platformAdmin.id);
        const scope = await scopeFor(platformAdmin.id);

        const list = await listGlobalVenues(scope, { q: SUFFIX });

        expect(list.items.length).toBeGreaterThan(0);
        // The platform list is global-only: it must not become a back door to private
        // venues owned by other organizers.
        for (const item of list.items) {
            expect(item.organizerId).toBeNull();
            expect(item.isGlobal).toBe(true);
        }

        const updated = await updateVenue(scope, globalVenue.id, {
            city: "Yogyakarta",
        } as never);

        expect(updated.city).toBe("Yogyakarta");
    });

    test("a platform ADMIN WITHOUT a membership cannot touch a private venue", async () => {
        // platformAdmin holds the highest platform role but no membership in A. The
        // denial must be about membership, not about platform role — which is proven by
        // adminMemberA (same role, with a membership) succeeding in the next test.
        signInAs(platformAdmin.id);
        const scope = await scopeFor(platformAdmin.id);

        await expect(
            updateVenue(scope, venueA.id, { name: "Admin Override" } as never)
        ).rejects.toMatchObject({ code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });

        await expect(deleteVenue(scope, venueA.id)).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });

    test("the same platform ADMIN WITH a membership in A can manage A's private venue", async () => {
        signInAs(adminMemberA.id);
        const scope = await scopeFor(adminMemberA.id);

        const updated = await updateVenue(scope, venueA.id, {
            province: "DKI Jakarta",
        } as never);

        expect(updated.province).toBe("DKI Jakarta");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Venue listing scope
// ─────────────────────────────────────────────────────────────────────────────

describe("venue listing", () => {
    test("an organizer member sees global venues plus their own private ones", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        const result = await listVenues(scope);
        const ids = result.items.map((v) => v.id);

        expect(ids).toContain(globalVenue.id);
        expect(ids).toContain(venueA.id);
        // Another organizer's private venue is never listed.
        expect(ids).not.toContain(venueB.id);
    });

    test("requesting another tenant's venues is refused", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        await expect(listVenues(scope, { organizerId: orgB.id })).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });

    test("a platform ADMIN with no membership still sees only global venues", async () => {
        signInAs(platformAdmin.id);
        const scope = await scopeFor(platformAdmin.id);

        const result = await listVenues(scope);

        expect(result.items.every((v) => v.organizerId === null)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Venue deletion guard (brief §14)
// ─────────────────────────────────────────────────────────────────────────────

describe("venue deletion guard", () => {
    test("refuses to delete a venue referenced by an event, reporting the count", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        const venue = await createVenue(scope, orgA.id, {
            name: `Referenced ${SUFFIX}`,
        } as never);

        await createEvent(scope, orgA.id, {
            title: `Venue Referencing Event ${SUFFIX}`,
            sportId: sport.id,
            venueId: venue.id,
            startAt: FUTURE,
        } as never);

        try {
            await deleteVenue(scope, venue.id);
            throw new Error("should have thrown");
        } catch (error) {
            const appError = error as AppError;
            expect(appError.code).toBe("CONFLICT");
            // The count is reported so the operator knows what is blocking it.
            expect(appError.details?.eventCount).toBe(1);
        }

        // The venue survives — `Event.venue` is SetNull, so deleting it would have
        // silently blanked the location of historical events.
        expect(await prisma.venue.count({ where: { id: venue.id } })).toBe(1);
    });

    test("deletes an unreferenced venue", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        const venue = await createVenue(scope, orgA.id, {
            name: `Unused ${SUFFIX}`,
        } as never);

        await deleteVenue(scope, venue.id);

        expect(await prisma.venue.count({ where: { id: venue.id } })).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-tenant venue attachment on events
// ─────────────────────────────────────────────────────────────────────────────

describe("attaching a venue to an event", () => {
    test("an organizer cannot attach another organizer's private venue", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        await expect(
            createEvent(scope, orgA.id, {
                title: `Venue Steal ${SUFFIX}`,
                sportId: sport.id,
                venueId: venueB.id,
                startAt: FUTURE,
            } as never)
        ).rejects.toMatchObject({ code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });

        // Guards against the disclosure path: without the check, organizer A could
        // learn a competitor's private venue name and city by guessing its id.
        expect(
            await prisma.event.count({ where: { venueId: venueB.id } })
        ).toBe(0);
    });

    test("an organizer CAN attach a global venue", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        const event = await createEvent(scope, orgA.id, {
            title: `Global Venue Event ${SUFFIX}`,
            sportId: sport.id,
            venueId: globalVenue.id,
            startAt: FUTURE,
        } as never);

        expect(event.venueId).toBe(globalVenue.id);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sport master data (brief §15)
// ─────────────────────────────────────────────────────────────────────────────

describe("sport master data", () => {
    test("the public list returns active sports only", async () => {
        const inactive = await prisma.sport.create({
            data: { name: `Hidden Sport ${SUFFIX}`, slug: `hidden-sport-${SUFFIX}`, isActive: false },
            select: { id: true },
        });

        try {
            const result = await listPublicSports();

            const slugs = result.items.map((s) => s.slug);

            expect(slugs).not.toContain(`hidden-sport-${SUFFIX}`);
            // The 14 seeded sports from Phase 2 remain present and were not duplicated.
            expect(result.items.length).toBeGreaterThanOrEqual(14);
            expect(new Set(slugs).size).toBe(slugs.length);
        } finally {
            await prisma.sport.delete({ where: { id: inactive.id } });
        }
    });

    test("a platform ADMIN can create, update and delete a sport", async () => {
        signInAs(platformAdmin.id);
        const scope = await scopeFor(platformAdmin.id);

        const created = await createSport(scope, {
            name: `Sepak Takraw ${SUFFIX}`,
        } as never);

        // The slug is derived from the name when not supplied.
        expect(created.slug).toBe(`sepak-takraw-${SUFFIX.toLowerCase()}`);

        const updated = await updateSport(scope, created.id, {
            sortOrder: 99,
        } as never);

        expect(updated.sortOrder).toBe(99);

        await deleteSport(scope, created.id);

        expect(await prisma.sport.count({ where: { id: created.id } })).toBe(0);
    });

    test("an organizer OWNER cannot mutate platform sport master data", async () => {
        signInAs(ownerA.id);
        const scope = await scopeFor(ownerA.id);

        await expect(
            createSport(scope, { name: `Rogue Sport ${SUFFIX}` } as never)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        await expect(
            updateSport(scope, sport.id, { name: "Renamed" } as never)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        await expect(deleteSport(scope, sport.id)).rejects.toMatchObject({
            code: AuthzErrorCode.FORBIDDEN,
        });
    });

    test("a platform MANAGER cannot mutate sport master data", async () => {
        signInAs(platformManager.id);
        const scope = await scopeFor(platformManager.id);

        await expect(
            createSport(scope, { name: `Manager Sport ${SUFFIX}` } as never)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        await expect(listSportsForAdmin(scope)).rejects.toMatchObject({
            code: AuthzErrorCode.FORBIDDEN,
        });
    });

    test("the admin list includes inactive sports and reports usage counts", async () => {
        signInAs(platformAdmin.id);
        const scope = await scopeFor(platformAdmin.id);

        const result = await listSportsForAdmin(scope);

        expect(result.items.length).toBeGreaterThanOrEqual(1);
        for (const item of result.items) {
            expect(typeof item.eventCount).toBe("number");
        }
    });

    test("a duplicate slug is refused rather than silently suffixed", async () => {
        signInAs(platformAdmin.id);
        const scope = await scopeFor(platformAdmin.id);

        const existing = await prisma.sport.findFirstOrThrow({
            where: { slug: sport.slug },
            select: { slug: true },
        });

        await expect(
            createSport(scope, {
                name: `Duplicate ${SUFFIX}`,
                slug: existing.slug,
            } as never)
        ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    test("deleting a sport used by an event is refused, and deactivation is suggested", async () => {
        signInAs(ownerA.id);
        const ownerScope = await scopeFor(ownerA.id);

        const event = await createEvent(ownerScope, orgA.id, {
            title: `Sport Usage ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        signInAs(platformAdmin.id);
        const adminScope = await scopeFor(platformAdmin.id);

        try {
            await deleteSport(adminScope, sport.id);
            throw new Error("should have thrown");
        } catch (error) {
            const appError = error as AppError;
            expect(appError.code).toBe("CONFLICT");
            expect(appError.details?.eventCount).toBeGreaterThanOrEqual(1);
            expect(appError.message).toContain("Nonaktifkan");
        }

        // Deactivation is the supported retirement path and leaves history intact.
        const deactivated = await updateSport(adminScope, sport.id, {
            isActive: false,
        } as never);

        expect(deactivated.isActive).toBe(false);

        const stillReferenced = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { sportId: true },
        });

        expect(stillReferenced.sportId).toBe(sport.id);

        await updateSport(adminScope, sport.id, { isActive: true } as never);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unauthenticated
// ─────────────────────────────────────────────────────────────────────────────

describe("unauthenticated access", () => {
    test("venue and sport mutations are rejected as UNAUTHORIZED", async () => {
        signInAs(null);

        await expect(
            (async () => {
                const { requireVenueManage } = await import("@/lib/events/access");
                return requireVenueManage(venueA.id);
            })()
        ).rejects.toMatchObject({ code: AuthzErrorCode.UNAUTHORIZED, status: 401 });

        await expect(
            (async () => {
                const { createSport: create } = await import("@/lib/sports/service");
                const { requireAuth } = await import("@/lib/authz");
                const scope = await requireAuth();
                return create(scope, { name: "x" } as never);
            })()
        ).rejects.toMatchObject({ code: AuthzErrorCode.UNAUTHORIZED });
    });
});
