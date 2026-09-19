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
    archiveEvent,
    cancelEvent,
    createEvent,
    deleteEvent,
    getOrganizerEvent,
    listOrganizerEvents,
    publishEvent,
    unpublishEvent,
    updateEvent,
} from "@/lib/events/service";
import { getPublicEventBySlug } from "@/lib/events/catalog";

const ORIGIN = "https://tinggalklik.test";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(120000);

const SUFFIX = `p4e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
/**
 * PHASE 20B (D-P19-05 = A): `publishEvent` refuses an event with no `endAt`, so every fixture
 * that publishes carries a real end time. Fixtures that stay DRAFT keep no end time on
 * purpose — a draft may still be saved before the schedule is settled, which is exactly why
 * the requirement lives at publish rather than at create.
 */
const FUTURE_END = new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000);

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
    /*
     * PHASE 20B (D-P19-05 = A) — `endAt` IS REQUIRED BEFORE PUBLICATION.
     *
     * The rule exists because an event without an end time can never complete: not
     * automatically (`P14-D22`) and not manually (`completeEventManually`). It would therefore
     * stay live forever, and its gate — which under D-P19-03 Option A has no start-time term —
     * would stay open forever too. The two tests below pin both halves: the refusal is real and
     * server-side, and the requirement is deliberately NOT imposed at create time, so a draft
     * can still be saved before the schedule is settled.
     */
    test("refuses to publish an event with no endAt, naming the precondition", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `No End ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
            // No `endAt` on purpose — this is the whole scenario.
        } as never);

        // Give it a sellable type so the end time is the ONLY unmet precondition.
        await prisma.ticketType.create({
            data: { eventId: event.id, name: "Reguler", price: 100000, quota: 10 },
        });

        try {
            await publishEvent(scope!, event.id);
            throw new Error("publish should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            const appError = error as AppError;
            expect(appError.code).toBe("CONFLICT");
            expect(appError.httpStatus).toBe(409);
            expect(appError.details?.preconditions).toEqual(
                expect.arrayContaining([expect.stringContaining("Waktu selesai")])
            );
        }

        // Nothing was published: the row is still a DRAFT with no publishedAt.
        const fresh = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { status: true, publishedAt: true },
        });

        expect(fresh.status).toBe("DRAFT");
        expect(fresh.publishedAt).toBeNull();
    });

    test("still saves a DRAFT with no endAt — the requirement is at publish, not create", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        // Create and update both succeed without an end time, because requiring it at create
        // would force an organizer to guess a schedule before they know one. `endAt` stays
        // editable through DRAFT, PUBLISHED and ONGOING (P14-D12), so the value only has to
        // be right by the time the event goes live.
        const draft = await createEvent(scope!, orgA.id, {
            title: `Incomplete Draft ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        expect(draft.endAt).toBeNull();

        const updated = await updateEvent(scope!, draft.id, {
            description: "Schedule still being decided",
        } as never);

        expect(updated.endAt).toBeNull();
        expect(updated.status).toBe("DRAFT");

        // …and supplying the end time later is what unblocks publication.
        await prisma.ticketType.create({
            data: { eventId: draft.id, name: "Reguler", price: 100000, quota: 10 },
        });

        await updateEvent(scope!, draft.id, { endAt: FUTURE_END } as never);

        const published = await publishEvent(scope!, draft.id);

        expect(published.event.status).toBe("PUBLISHED");
    });

    test("refuses to publish an event with no active ticket type, naming the precondition", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `No Tickets ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
            // Present so the ONLY unmet precondition is the missing ticket type — otherwise
            // this test would pass for the wrong reason.
            endAt: FUTURE_END,
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
                // Set so the ONLY unmet precondition is the past start time.
                endAt: new Date(PAST.getTime() + 3 * 60 * 60 * 1000),
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
            endAt: FUTURE_END,
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
            endAt: FUTURE_END,
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
            endAt: FUTURE_END,
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
            endAt: FUTURE_END,
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
            endAt: FUTURE_END,
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
            endAt: FUTURE_END,
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

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 12 — ARCHIVE (design §10.2/§10.3 soft delete)
// ─────────────────────────────────────────────────────────────────────────────

/** A PUBLISHED event with one sellable ticket type, seeded directly. */
async function seedPublishedEvent(tag: string, quota = 10) {
    const event = await prisma.event.create({
        data: {
            organizerId: orgA.id,
            sportId: sport.id,
            title: `Lifecycle ${tag} ${SUFFIX}`,
            slug: `lifecycle-${tag}-${SUFFIX}`,
            eventCode: `TKL-EVT-L-${tag}-${SUFFIX}`.slice(0, 40),
            startAt: FUTURE,
            status: "PUBLISHED",
            publishedAt: new Date(),
            createdByUserId: userA.id,
        },
        select: { id: true, slug: true },
    });

    const ticketType = await prisma.ticketType.create({
        data: { eventId: event.id, name: "Reguler", price: 100000, quota },
        select: { id: true },
    });

    return { event, ticketType };
}

/** A settled order with one issued ticket — the commercial history archive/cancel must not disturb. */
async function seedPaidOrder(
    eventId: string,
    ticketTypeId: string,
    tag: string
) {
    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: `EVT-L-${tag}-${SUFFIX}`.slice(0, 40),
            organizerId: orgA.id,
            eventId,
            userId: userA.id,
            buyerName: `Buyer ${tag}`,
            status: "PAID",
            paymentStatus: "PAID",
            paidAt: new Date(),
            subtotal: 100000,
            total: 100000,
            organizerNetAmount: 100000,
        },
        select: { id: true },
    });

    const item = await prisma.eventOrderItem.create({
        data: {
            orderId: order.id,
            ticketTypeId,
            nameSnapshot: "Reguler",
            priceSnapshot: 100000,
            quantity: 1,
            subtotal: 100000,
        },
        select: { id: true },
    });

    const ticket = await prisma.ticket.create({
        data: {
            ticketCode: `TCK-L-${tag}-${SUFFIX}`.slice(0, 40),
            qrTokenHash: `hash-L-${tag}-${SUFFIX}`,
            orderId: order.id,
            orderItemId: item.id,
            sequenceNo: 1,
            ticketTypeId,
            eventId,
            organizerId: orgA.id,
            holderUserId: userA.id,
            status: "ISSUED",
            issuedAt: new Date(),
        },
        select: { id: true },
    });

    return { order, item, ticket };
}

describe("archiveEvent — soft delete", () => {
    test("hides the event from public surfaces, keeps every commercial row, and audits", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const { event, ticketType } = await seedPublishedEvent("arch1");
        const seed = await seedPaidOrder(event.id, ticketType.id, "arch1");

        const result = await archiveEvent(scope!, event.id);

        expect(result.alreadyArchived).toBe(false);
        expect(result.event.status).toBe("ARCHIVED");
        expect(result.event.archivedAt).not.toBeNull();

        // Retained, not deleted.
        const fresh = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { status: true, archivedAt: true, title: true },
        });
        expect(fresh.title).toContain("Lifecycle arch1");

        // Gone from the public detail (and therefore the catalog).
        await expect(
            getPublicEventBySlug(event.slug, ORIGIN)
        ).rejects.toMatchObject({ code: "NOT_FOUND" });

        // No financial row moved.
        const orderRow = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: seed.order.id },
            select: { status: true, paymentStatus: true, refundedAmount: true },
        });
        expect(orderRow.status).toBe("PAID");
        expect(orderRow.paymentStatus).toBe("PAID");
        expect(Number(orderRow.refundedAmount)).toBe(0);

        const ticketRow = await prisma.ticket.findUniqueOrThrow({
            where: { id: seed.ticket.id },
            select: { status: true, voidedAt: true },
        });
        expect(ticketRow.status).toBe("ISSUED");
        expect(ticketRow.voidedAt).toBeNull();

        const audit = await prisma.adminAuditLog.findFirst({
            where: { entityRef: event.id, action: "event.archive" },
            select: { actorUserId: true, organizerId: true },
        });
        expect(audit?.actorUserId).toBe(userA.id);
        expect(audit?.organizerId).toBe(orgA.id);
    });

    test("is idempotent: a second archive keeps the first timestamp and writes no second audit row", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const { event } = await seedPublishedEvent("arch2");

        const first = await archiveEvent(scope!, event.id);
        const second = await archiveEvent(scope!, event.id);

        expect(second.alreadyArchived).toBe(true);
        expect(second.event.archivedAt?.toISOString()).toBe(
            first.event.archivedAt?.toISOString()
        );

        const auditRows = await prisma.adminAuditLog.count({
            where: { entityRef: event.id, action: "event.archive" },
        });
        expect(auditRows).toBe(1);
    });

    test("refuses while an open refund is still moving money, then allows it", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const { event } = await seedPublishedEvent("arch3");

        const order = await prisma.eventOrder.create({
            data: {
                orderNumber: `EVT-L-arch3-${SUFFIX}`.slice(0, 40),
                organizerId: orgA.id,
                eventId: event.id,
                userId: userA.id,
                buyerName: `Buyer arch3`,
                subtotal: 100000,
                total: 100000,
                organizerNetAmount: 100000,
            },
            select: { id: true },
        });

        const refund = await prisma.refund.create({
            data: {
                eventOrderId: order.id,
                organizerId: orgA.id,
                status: "PENDING",
            },
            select: { id: true },
        });

        try {
            await expect(
                archiveEvent(scope!, event.id)
            ).rejects.toMatchObject({ code: "CONFLICT" });

            await prisma.refund.update({
                where: { id: refund.id },
                data: { status: "REJECTED" },
            });

            const ok = await archiveEvent(scope!, event.id);
            expect(ok.event.status).toBe("ARCHIVED");
        } finally {
            await prisma.refund.delete({ where: { id: refund.id } });
        }
    });

    test("denies cross-tenant, staff and unauthenticated callers", async () => {
        signInAs(userA.id);
        const scopeA = await scopeFor(userA.id);

        const foreign = await seedEvent(orgB.id, "arch-foreign");

        await expect(archiveEvent(scopeA!, foreign.id)).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });

        const { event } = await seedPublishedEvent("arch4");

        // A CHECKIN_STAFF member holds no `event.publish` capability.
        signInAs(staffUser.id);
        await expect(
            archiveEvent(
                {
                    userId: staffUser.id,
                    platformRole: "CUSTOMER",
                    organizerScopes: [],
                    grants: [],
                },
                event.id
            )
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        signInAs(null);
        await expect(archiveEvent(scopeA!, event.id)).rejects.toMatchObject({
            code: AuthzErrorCode.UNAUTHORIZED,
        });

        // Nothing was archived by any denied caller.
        const row = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { status: true, archivedAt: true },
        });
        expect(row.status).toBe("PUBLISHED");
        expect(row.archivedAt).toBeNull();
    });

    test("an archived event can no longer be published, unpublished or updated", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const { event } = await seedPublishedEvent("arch5");
        await archiveEvent(scope!, event.id);

        await expect(publishEvent(scope!, event.id)).rejects.toMatchObject({
            code: "CONFLICT",
        });
        await expect(unpublishEvent(scope!, event.id)).rejects.toMatchObject({
            code: "CONFLICT",
        });
        await expect(
            updateEvent(scope!, event.id, { title: "Nope" } as never)
        ).rejects.toMatchObject({ code: "CONFLICT" });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 12 — CANCEL (design §10.3 PUBLISHED → CANCELLED)
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelEvent — sales stop, no money moves", () => {
    test("cancels a published event, records the reason, and writes no financial change", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const { event } = await seedPublishedEvent("can1");

        const result = await cancelEvent(scope!, event.id, {
            reason: "Cuaca buruk",
        });

        expect(result.event.status).toBe("CANCELLED");
        expect(result.event.cancelledAt).not.toBeNull();

        const row = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { status: true, cancelReason: true, publishedAt: true },
        });
        expect(row.status).toBe("CANCELLED");
        expect(row.cancelReason).toBe("Cuaca buruk");
        // Publication history is retained, not erased.
        expect(row.publishedAt).not.toBeNull();

        // The public page resolves and clearly says the event is unavailable.
        const detail = await getPublicEventBySlug(event.slug, ORIGIN);
        expect(detail.status).toBe("CANCELLED");
        expect(detail.isAvailable).toBe(false);
        expect(detail.unavailableReason).toContain("dibatalkan");

        const audit = await prisma.adminAuditLog.findFirst({
            where: { entityRef: event.id, action: "event.cancel" },
            select: { actorUserId: true, organizerId: true, reason: true },
        });
        expect(audit?.actorUserId).toBe(userA.id);
        expect(audit?.organizerId).toBe(orgA.id);
        expect(audit?.reason).toBe("Cuaca buruk");
    });

    test("is idempotent: a second cancel keeps the first timestamp and writes no second audit row", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const { event } = await seedPublishedEvent("can2");

        const first = await cancelEvent(scope!, event.id, { reason: "First" });
        const second = await cancelEvent(scope!, event.id, { reason: "Second" });

        expect(second.alreadyCancelled).toBe(true);
        expect(second.expiredOrders).toBe(0);
        expect(second.event.cancelledAt?.toISOString()).toBe(
            first.event.cancelledAt?.toISOString()
        );

        const auditRows = await prisma.adminAuditLog.count({
            where: { entityRef: event.id, action: "event.cancel" },
        });
        expect(auditRows).toBe(1);

        const row = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { cancelReason: true },
        });
        expect(row.cancelReason).toBe("First");
    });

    test("auto-expires the event's unpaid orders and returns their seats", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const { event, ticketType } = await seedPublishedEvent("can3", 10);

        const order = await prisma.eventOrder.create({
            data: {
                orderNumber: `EVT-L-can3-${SUFFIX}`.slice(0, 40),
                organizerId: orgA.id,
                eventId: event.id,
                userId: userA.id,
                buyerName: `Buyer can3`,
                subtotal: 200000,
                total: 200000,
                organizerNetAmount: 200000,
            },
            select: { id: true },
        });

        await prisma.ticketReservation.create({
            data: {
                orderId: order.id,
                ticketTypeId: ticketType.id,
                eventId: event.id,
                quantity: 2,
                expiresAt: new Date(Date.now() + 30 * 60_000),
            },
        });

        await prisma.ticketType.update({
            where: { id: ticketType.id },
            data: { reserved: 2 },
        });

        const result = await cancelEvent(scope!, event.id, {
            reason: "Force majeure",
        });

        expect(result.expiredOrders).toBe(1);

        const expiredOrder = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.id },
            select: { status: true },
        });
        expect(expiredOrder.status).toBe("EXPIRED");

        const reservation = await prisma.ticketReservation.findFirstOrThrow({
            where: { orderId: order.id },
            select: { status: true },
        });
        expect(reservation.status).toBe("EXPIRED");

        const counters = await prisma.ticketType.findUniqueOrThrow({
            where: { id: ticketType.id },
            select: { reserved: true, sold: true, quota: true },
        });
        expect(counters.reserved).toBe(0);
        // `sold` is untouched: the seat was only ever held, never sold.
        expect(counters.sold).toBe(0);
        expect(counters.quota).toBe(10);
    });

    test("does not touch a paid order, its issued ticket, or its refundedAmount", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const { event, ticketType } = await seedPublishedEvent("can4");
        const seed = await seedPaidOrder(event.id, ticketType.id, "can4");

        const result = await cancelEvent(scope!, event.id, {
            reason: "Test",
        });

        // No PENDING_PAYMENT order existed, so nothing expired.
        expect(result.expiredOrders).toBe(0);

        const order = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: seed.order.id },
            select: {
                status: true,
                paymentStatus: true,
                refundedAmount: true,
                cancelledAt: true,
            },
        });
        expect(order.status).toBe("PAID");
        expect(order.paymentStatus).toBe("PAID");
        expect(Number(order.refundedAmount)).toBe(0);
        expect(order.cancelledAt).toBeNull();

        const ticket = await prisma.ticket.findUniqueOrThrow({
            where: { id: seed.ticket.id },
            select: { status: true, voidedAt: true },
        });
        expect(ticket.status).toBe("ISSUED");
        expect(ticket.voidedAt).toBeNull();

        // PHASE 18B (D-P17-09 = A): cancellation creates NO refund rows. A refund on a
        // cancelled event is the buyer's own request through the normal workflow — the
        // platform never batches one on the buyer's behalf, and no money moves here.
        expect(
            await prisma.refund.count({
                where: { eventOrderId: seed.order.id },
            })
        ).toBe(0);
    });

    test("refuses to cancel a draft event", async () => {
        signInAs(userA.id);
        const scope = await scopeFor(userA.id);

        const event = await createEvent(scope!, orgA.id, {
            title: `Draft Cancel ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
        } as never);

        await expect(cancelEvent(scope!, event.id)).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });

    test("a member of A cannot cancel B's event", async () => {
        signInAs(userA.id);
        const scopeA = await scopeFor(userA.id);

        const foreign = await seedEvent(orgB.id, "can-foreign", "PUBLISHED");

        await expect(cancelEvent(scopeA!, foreign.id)).rejects.toMatchObject({
            code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
        });

        const row = await prisma.event.findUniqueOrThrow({
            where: { id: foreign.id },
            select: { status: true },
        });
        expect(row.status).toBe("PUBLISHED");
    });
});
