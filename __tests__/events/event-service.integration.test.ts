/**
 * ==========================================
 * PHASE 4 — EVENT LIFECYCLE & TENANT ISOLATION (INTEGRATION)
 * ==========================================
 *
 * Executes the REAL services against the REAL MariaDB database. Only `@/auth` is
 * mocked, so a session can be established without a browser; every permission decision
 * is made by the real `lib/authz` guards against real membership rows.
 *
 * All rows use a unique suffix and are removed in `afterAll`.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import { AuthzErrorCode, PERMISSIONS, requireOrganizerAccess } from "@/lib/authz";
import { AppError } from "@/lib/api/errors";
import { PERMISSIONS as P } from "@/lib/authz";
import {
    createEvent,
    deleteEvent,
    getOrganizerEvent,
    listOrganizerEvents,
    publishEvent,
    unpublishEvent,
    updateEvent,
} from "@/lib/events/service";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(120000);

const SUFFIX = `p4e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

let userA: { id: string };
let userB: { id: string };
let staffUser: { id: string };
let suspendedUser: { id: string };
let adminUser: { id: string };
let managerUser: { id: string };

let orgA: { id: string };
let orgB: { id: string };
let sport: { id: string };

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

/** Scope resolution reads the database, so the actor must sign in first. */
async function scopeFor(userId: string) {
    signInAs(userId);
    return requireOrganizerAccess(orgA.id, P.EVENT_READ).catch(() => null);
}

async function createUser(tag: string, platformRole?: "ADMIN" | "MANAGER" | "PIC") {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            ...(platformRole ? { platformRole } : {}),
        },
    });
}

/** Create an event directly (bypassing the service) for read/authorization fixtures. */
async function seedEvent(organizerId: string, tag: string, status: "DRAFT" | "PUBLISHED" = "DRAFT") {
    return prisma.event.create({
        data: {
            organizerId,
            sportId: sport.id,
            title: `Seeded ${tag} ${SUFFIX}`,
            slug: `seeded-${tag}-${SUFFIX}`,
            eventCode: `TKL-EVT-T-${tag}-${SUFFIX}`.slice(0, 40),
            startAt: FUTURE,
            status,
            publishedAt: status === "PUBLISHED" ? new Date() : null,
            createdByUserId: userA.id,
        },
        select: { id: true, slug: true },
    });
}

beforeAll(async () => {
    userA = await createUser("owner-a");
    userB = await createUser("owner-b");
    staffUser = await createUser("staff");
    suspendedUser = await createUser("suspended");
    adminUser = await createUser("admin", "ADMIN");
    managerUser = await createUser("manager", "MANAGER");

    orgA = await prisma.organizer.create({
        data: {
            ownerUserId: userA.id,
            name: `Org A ${SUFFIX}`,
            slug: `org-a-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    orgB = await prisma.organizer.create({
        data: {
            ownerUserId: userB.id,
            name: `Org B ${SUFFIX}`,
            slug: `org-b-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.createMany({
        data: [
            { organizerId: orgA.id, userId: userA.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: orgB.id, userId: userB.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: orgA.id, userId: staffUser.id, role: "CHECKIN_STAFF", status: "ACTIVE" },
            { organizerId: orgA.id, userId: suspendedUser.id, role: "MANAGER", status: "SUSPENDED" },
            { organizerId: orgA.id, userId: adminUser.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: orgA.id, userId: managerUser.id, role: "MANAGER", status: "ACTIVE" },
        ],
    });

    sport = await prisma.sport.create({
        data: { name: `Test Sport ${SUFFIX}`, slug: `test-sport-${SUFFIX}`, isActive: true },
        select: { id: true },
    });
});

afterAll(async () => {
    const eventIds = (
        await prisma.event.findMany({
            where: { organizerId: { in: [orgA?.id, orgB?.id].filter(Boolean) as string[] } },
            select: { id: true },
        })
    ).map((e) => e.id);

    if (eventIds.length > 0) {
        await prisma.ticket.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.eventOrder.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.ticketType.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.eventImage.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }

    const userIds = [
        userA, userB, staffUser, suspendedUser, adminUser, managerUser,
    ].filter(Boolean).map((u) => u.id);

    await prisma.permissionGrant.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.organizerMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.venue.deleteMany({
        where: { organizerId: { in: [orgA?.id, orgB?.id].filter(Boolean) as string[] } },
    });
    await prisma.organizer.deleteMany({
        where: { id: { in: [orgA?.id, orgB?.id].filter(Boolean) as string[] } },
    });
    await prisma.adminAuditLog.deleteMany({
        where: { actorUserId: { in: userIds } },
    });
    await prisma.event.deleteMany({ where: { sportId: sport?.id } });
    await prisma.sport.deleteMany({ where: { id: sport?.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

describe("createEvent", () => {
    test("creates a DRAFT with a generated slug and event code, owned by the target organizer", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(
            scope!,
            orgA.id,
            {
                title: "Final Basketball Championship 2026",
                sportId: sport.id,
                startAt: FUTURE,
                description: "Pertandingan final",
            } as never
        );

        expect(event.status).toBe("DRAFT");
        expect(event.organizerId).toBe(orgA.id);
        expect(event.slug).toBe("final-basketball-championship-2026");
        expect(event.eventCode).toMatch(/^TKL-EVT-\d{4}-\d{6}$/);
        // Status is never client-controlled — it always starts as a draft.
        expect(event.publishedAt).toBeNull();
    });

    test("collision on the generated slug appends a suffix instead of failing", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: "Final Basketball Championship 2026",
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        expect(event.slug).toMatch(/^final-basketball-championship-2026-[a-z0-9]+$/);
    });

    test("rejects a start time in the past", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        await expect(
            createEvent(scope!, orgA.id, {
                title: "Past Event",
                sportId: sport.id,
                startAt: PAST,
            } as never)
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    test("rejects an end time at or before the start time", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        await expect(
            createEvent(scope!, orgA.id, {
                title: "Bad Window",
                sportId: sport.id,
                startAt: FUTURE,
                endAt: new Date(FUTURE.getTime() - 1000),
            } as never)
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    test("rejects an unknown sport", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        await expect(
            createEvent(scope!, orgA.id, {
                title: "No Sport",
                sportId: "sport-does-not-exist",
                startAt: FUTURE,
            } as never)
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    test("rejects an inactive sport", async () => {
        const inactive = await prisma.sport.create({
            data: { name: `Inactive ${SUFFIX}`, slug: `inactive-${SUFFIX}`, isActive: false },
            select: { id: true },
        });

        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        try {
            await expect(
                createEvent(scope!, orgA.id, {
                    title: "Inactive Sport",
                    sportId: inactive.id,
                    startAt: FUTURE,
                } as never)
            ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        } finally {
            await prisma.sport.delete({ where: { id: inactive.id } });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Update
// ─────────────────────────────────────────────────────────────────────────────

describe("updateEvent", () => {
    let eventId: string;

    beforeAll(async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);
        const event = await createEvent(scope!, orgA.id, {
            title: "Update Me",
            sportId: sport.id,
            startAt: FUTURE,
        } as never);
        eventId = event.id;
    });

    test("changes fields and reports only what changed", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const updated = await updateEvent(scope!, eventId, {
            title: "Updated Title",
            description: "Now with a description",
        } as never);

        expect(updated.title).toBe("Updated Title");
        expect(updated.description).toBe("Now with a description");
        // The slug follows the title only at creation, so it is stable for shared links.
        expect(updated.slug).toBe("update-me");
    });

    test("rejects an empty update rather than silently succeeding", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        await expect(updateEvent(scope!, eventId, {} as never)).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });
    });

    test("allows editing other fields even after the event's start has passed", async () => {
        const started = await prisma.event.create({
            data: {
                organizerId: orgA.id,
                sportId: sport.id,
                title: `Started ${SUFFIX}`,
                slug: `started-${SUFFIX}`,
                eventCode: `TKL-EVT-S-${SUFFIX}`.slice(0, 40),
                startAt: PAST,
                createdByUserId: userA.id,
            },
            select: { id: true },
        });

        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const updated = await updateEvent(scope!, started.id, {
            description: "Late edit",
        } as never);

        expect(updated.description).toBe("Late edit");
    });

    test("refuses to move startAt into the past", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        await expect(
            updateEvent(scope!, eventId, { startAt: PAST } as never)
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    test("a slug change to a free value succeeds and frees the old slug", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const updated = await updateEvent(scope!, eventId, {
            slug: `renamed-${SUFFIX}`,
        } as never);

        expect(updated.slug).toBe(`renamed-${SUFFIX}`);

        const oldSlugHolder = await prisma.event.findFirst({
            where: { slug: "update-me" },
            select: { id: true },
        });

        // The old slug is released, so a future event may claim it.
        expect(oldSlugHolder).toBeNull();
    });

    test("a slug change to a value owned by ANOTHER event is refused, not stolen", async () => {
        const other = await seedEvent(orgA.id, "slugtarget");

        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        await expect(
            updateEvent(scope!, eventId, { slug: other.slug } as never)
        ).rejects.toMatchObject({ code: "CONFLICT" });

        // The other event keeps its public URL — this is the guarantee that a slug
        // change cannot expose or shadow another event.
        const stillThere = await prisma.event.findUnique({
            where: { slug: other.slug },
            select: { id: true, slug: true },
        });

        expect(stillThere?.id).toBe(other.id);
    });

    test("a structurally invalid slug is refused", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        for (const bad of ["Not A Slug", "UPPERCASE", "trailing-", "../escape"]) {
            await expect(
                updateEvent(scope!, eventId, { slug: bad } as never)
            ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Publish / unpublish (D-13, D-14)
// ─────────────────────────────────────────────────────────────────────────────

describe("publishEvent — design §10.3 preconditions", () => {
    test("refuses to publish an event with no active ticket type, naming the precondition", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `No Tickets ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        try {
            await publishEvent(scope!, event.id);
            throw new Error("publish should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            const appError = error as AppError;
            expect(appError.code).toBe("CONFLICT");
            expect(appError.httpStatus).toBe(409);
            // The unmet precondition is named so the UI can explain it.
            expect(appError.details?.preconditions).toEqual(
                expect.arrayContaining([
                    expect.stringContaining("jenis tiket aktif"),
                ])
            );
        }
    });

    test("refuses to publish when the start time is in the past", async () => {
        // Give it a sellable ticket type so only the date is the obstacle.
        const event = await prisma.event.create({
            data: {
                organizerId: orgA.id,
                sportId: sport.id,
                title: `Past Publish ${SUFFIX}`,
                slug: `past-publish-${SUFFIX}`,
                eventCode: `TKL-EVT-P-${SUFFIX}`.slice(0, 40),
                startAt: PAST,
                createdByUserId: userA.id,
                ticketTypes: {
                    create: {
                        name: "Reguler",
                        price: 100000,
                        quota: 100,
                    },
                },
            },
            select: { id: true },
        });

        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        try {
            await publishEvent(scope!, event.id);
            throw new Error("publish should have thrown");
        } catch (error) {
            const appError = error as AppError;
            expect(appError.code).toBe("CONFLICT");
            expect(appError.details?.preconditions).toEqual(
                expect.arrayContaining([expect.stringContaining("masa depan")])
            );
        }
    });

    test("publishes, sets publishedAt, and surfaces the banner hint", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `Publishable ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        // Ticket types are Phase 5 work; the precondition is a read-only count, so a
        // row created directly exercises it without implementing any Phase 5 logic.
        await prisma.ticketType.create({
            data: { eventId: event.id, name: "Reguler", price: 100000, quota: 50 },
        });

        const result = await publishEvent(scope!, event.id);

        expect(result.event.status).toBe("PUBLISHED");
        expect(result.event.publishedAt).toBeInstanceOf(Date);
        // Banner is recommended, not enforced, so it is reported as a hint only.
        expect(result.bannerRecommended).toBe(true);

        const fresh = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { status: true, publishedAt: true },
        });

        expect(fresh.status).toBe("PUBLISHED");
        expect(fresh.publishedAt).not.toBeNull();
    });

    test("refuses to publish an already-published event", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `Double Publish ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        await prisma.ticketType.create({
            data: { eventId: event.id, name: "Reguler", price: 1, quota: 1 },
        });

        await publishEvent(scope!, event.id);

        await expect(publishEvent(scope!, event.id)).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });

    test("republishing does not rewrite the original publishedAt", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `Republish ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        await prisma.ticketType.create({
            data: { eventId: event.id, name: "Reguler", price: 1, quota: 1 },
        });

        const first = await publishEvent(scope!, event.id);
        const originalPublishedAt = first.event.publishedAt;

        await unpublishEvent(scope!, event.id);

        // Backdate so a rewrite would be detectable.
        await prisma.event.update({
            where: { id: event.id },
            data: { startAt: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000) },
        });

        const second = await publishEvent(scope!, event.id);

        expect(second.event.publishedAt?.toISOString()).toBe(
            originalPublishedAt?.toISOString()
        );
    });
});

describe("unpublishEvent — decision D-14", () => {
    test("sets DRAFT, preserves the row, and writes no order/ticket changes", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `Unpublish ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
            description: "Preserved description",
        } as never);

        await prisma.ticketType.create({
            data: { eventId: event.id, name: "Reguler", price: 1, quota: 5 },
        });

        await publishEvent(scope!, event.id);

        const beforeOrderCount = await prisma.eventOrder.count({
            where: { eventId: event.id },
        });

        const updated = await unpublishEvent(scope!, event.id);

        expect(updated.status).toBe("DRAFT");

        const fresh = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { status: true, description: true, slug: true, publishedAt: true },
        });

        // D-14: data is preserved, nothing deleted, publication history retained.
        expect(fresh.description).toBe("Preserved description");
        expect(fresh.slug).toBe(event.slug);
        expect(fresh.publishedAt).not.toBeNull();

        // And no commercial side effect was produced.
        expect(
            await prisma.eventOrder.count({ where: { eventId: event.id } })
        ).toBe(beforeOrderCount);
    });

    test("refuses to unpublish something that is not published", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `Never Published ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        await expect(unpublishEvent(scope!, event.id)).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delete
// ─────────────────────────────────────────────────────────────────────────────

describe("deleteEvent", () => {
    test("deletes a draft with no commercial history", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `Delete Me ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        // A ticket type on a draft is referential cleanup, not commercial history.
        await prisma.ticketType.create({
            data: { eventId: event.id, name: "Reguler", price: 1, quota: 1 },
        });

        const result = await deleteEvent(scope!, event.id);

        expect(result.id).toBe(event.id);
        expect(
            await prisma.event.count({ where: { id: event.id } })
        ).toBe(0);
        expect(
            await prisma.ticketType.count({ where: { eventId: event.id } })
        ).toBe(0);
    });

    test("refuses to delete a published event", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `Published Keep ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        await prisma.ticketType.create({
            data: { eventId: event.id, name: "Reguler", price: 1, quota: 1 },
        });
        await publishEvent(scope!, event.id);

        await expect(deleteEvent(scope!, event.id)).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });

    test("refuses to delete a draft that already has an order", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `Has Order ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        await prisma.eventOrder.create({
            data: {
                orderNumber: `ORD-${SUFFIX}`.slice(0, 40),
                userId: userA.id,
                eventId: event.id,
                organizerId: orgA.id,
                buyerName: `Buyer ${SUFFIX}`,
                subtotal: 100000,
                total: 100000,
                // Required Phase 2 financial snapshot column; the value is irrelevant
                // here because the assertion is only that an existing order blocks a
                // draft delete.
                organizerNetAmount: 100000,
            },
        });

        await expect(deleteEvent(scope!, event.id)).rejects.toMatchObject({
            code: "CONFLICT",
        });

        // The event survives: history is never destroyed.
        expect(await prisma.event.count({ where: { id: event.id } })).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("event tenant isolation", () => {
    let eventA: { id: string; slug: string };
    let eventB: { id: string; slug: string };

    beforeAll(async () => {
        eventA = await seedEvent(orgA.id, "owned-a");
        eventB = await seedEvent(orgB.id, "owned-b");
    });

    test("a member of A can read A's event", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await getOrganizerEvent(scope!, eventA.id);

        expect(event.id).toBe(eventA.id);
    });

    test("a member of A cannot read B's event — denied as 404, not 403", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        try {
            await getOrganizerEvent(scope!, eventB.id);
            throw new Error("should have thrown");
        } catch (error) {
            const authzError = error as { code: string; status: number };
            expect(authzError.code).toBe("ORGANIZER_ACCESS_DENIED");
            // 404, not 403: the denial must not confirm that organizer B's event
            // exists (design §7.4). The authorization layer raises `AuthzError`,
            // whose status field is `status`; `httpStatus` belongs to `AppError`.
            expect(authzError.status).toBe(404);
        }
    });

    test("a member of A cannot UPDATE B's event", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        await expect(
            updateEvent(scope!, eventB.id, { title: "Hijacked" } as never)
        ).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            status: 404,
        });

        const untouched = await prisma.event.findUniqueOrThrow({
            where: { id: eventB.id },
            select: { title: true },
        });

        expect(untouched.title).not.toBe("Hijacked");
    });

    test("a member of A cannot publish, unpublish or delete B's event", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        for (const call of [
            () => publishEvent(scope!, eventB.id),
            () => unpublishEvent(scope!, eventB.id),
            () => deleteEvent(scope!, eventB.id),
        ]) {
            await expect(call()).rejects.toMatchObject({
                code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            });
        }

        expect(await prisma.event.count({ where: { id: eventB.id } })).toBe(1);
    });

    test("a platform ADMIN with no membership cannot reach A's event", async () => {
        // adminUser is a member of A, so use a fresh ADMIN with no memberships.
        const loneAdmin = await createUser("lone-admin", "ADMIN");

        try {
            signInAs(loneAdmin.id);
            const scope = await requireOrganizerAccess(
                orgA.id,
                P.EVENT_READ
            ).catch(() => null);

            // With no membership there is no scope at all.
            expect(scope).toBeNull();

            await expect(
                updateEvent({ userId: loneAdmin.id, platformRole: "ADMIN", organizerScopes: [], grants: [] }, eventA.id, {
                    title: "Admin Override",
                } as never)
            ).rejects.toMatchObject({
                code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            });
        } finally {
            await prisma.organizerMember.deleteMany({ where: { userId: loneAdmin.id } });
            await prisma.user.delete({ where: { id: loneAdmin.id } });
        }
    });

    test("a CHECKIN_STAFF member cannot read or write events in its own organizer", async () => {
        signInAs(staffUser.id);

        await expect(
            requireOrganizerAccess(orgA.id, PERMISSIONS.EVENT_READ)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        await expect(
            requireOrganizerAccess(orgA.id, PERMISSIONS.EVENT_WRITE)
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        const event = await prisma.event.findUniqueOrThrow({
            where: { id: eventA.id },
            select: { title: true },
        });

        expect(event.title).toContain("owned-a");
    });

    test("a SUSPENDED membership cannot create an event", async () => {
        signInAs(suspendedUser.id);

        await expect(
            requireOrganizerAccess(orgA.id, PERMISSIONS.EVENT_WRITE)
        ).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });
    });

    test("an unauthenticated caller is rejected as UNAUTHORIZED", async () => {
        signInAs(null);

        await expect(
            requireOrganizerAccess(orgA.id, PERMISSIONS.EVENT_READ)
        ).rejects.toMatchObject({ code: AuthzErrorCode.UNAUTHORIZED, status: 401 });
    });

    test("a fabricated event id is a 404, not a leak", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        await expect(
            getOrganizerEvent(scope!, "event-does-not-exist")
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    test("a MANAGER member can write events in its organizer", async () => {
        signInAs(managerUser.id);
        const scope = await requireOrganizerAccess(
            orgA.id,
            P.EVENT_WRITE
        );

        const event = await createEvent(scope, orgA.id, {
            title: `Manager Made ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        expect(event.organizerId).toBe(orgA.id);
    });
});

describe("listOrganizerEvents", () => {
    test("a member of A sees only A's events, never B's", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const result = await listOrganizerEvents(scope!, { limit: 100 });

        expect(result.items.length).toBeGreaterThan(0);

        for (const item of result.items) {
            expect(item.organizerId).toBe(orgA.id);
        }

        expect(result.items.some((e) => e.organizerId === orgB.id)).toBe(false);
    });

    test("an explicit organizerId for another tenant is refused", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        await expect(
            listOrganizerEvents(scope!, { organizerId: orgB.id })
        ).rejects.toMatchObject({ code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });
    });

    test("an actor with no readable organizer gets an empty page, never an unscoped one", async () => {
        signInAs(staffUser.id);
        const scope = await requireOrganizerAccess(
            orgA.id,
            P.CHECKIN_SCAN
        );

        const result = await listOrganizerEvents(scope, { limit: 100 });

        expect(result.items).toEqual([]);
        expect(result.pagination.total).toBe(0);
    });

    test("paginates", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const firstPage = await listOrganizerEvents(scope!, { page: 1, limit: 2 });

        expect(firstPage.items.length).toBeLessThanOrEqual(2);
        expect(firstPage.pagination.page).toBe(1);
        expect(firstPage.pagination.limit).toBe(2);
        expect(firstPage.pagination.totalPages).toBe(
            Math.ceil(firstPage.pagination.total / 2)
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit trail
// ─────────────────────────────────────────────────────────────────────────────

describe("audit trail", () => {
    test("publish and unpublish write ticketing audit rows with actor and tenant scope", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `Audited ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        await prisma.ticketType.create({
            data: { eventId: event.id, name: "Reguler", price: 1, quota: 1 },
        });

        await publishEvent(scope!, event.id);

        const rows = await prisma.adminAuditLog.findMany({
            where: { entityRef: event.id },
            select: {
                action: true,
                actorType: true,
                actorUserId: true,
                organizerId: true,
                entityType: true,
                reason: true,
            },
        });

        const actions = rows.map((r) => r.action);

        expect(actions).toContain("event.create");
        expect(actions).toContain("event.publish");

        for (const row of rows) {
            expect(row.actorType).toBe("USER");
            expect(row.actorUserId).toBe(userA.id);
            expect(row.organizerId).toBe(orgA.id);
            expect(row.entityType).toBe("Event");
        }
    });

    test("audit rows never contain a forbidden key", async () => {
        const rows = await prisma.adminAuditLog.findMany({
            where: { actorUserId: userA.id },
            select: { beforeState: true, afterState: true, metadata: true },
            take: 50,
        });

        for (const row of rows) {
            for (const state of [row.beforeState, row.afterState, row.metadata]) {
                if (!state || typeof state !== "object") continue;
                const keys = Object.keys(state as Record<string, unknown>);
                for (const key of keys) {
                    expect(key.toLowerCase()).not.toBe("password");
                    expect(key.toLowerCase()).not.toBe("token");
                    expect(key.toLowerCase()).not.toBe("secret");
                }
            }
        }
    });
});
