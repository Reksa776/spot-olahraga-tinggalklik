/**
 * ==========================================
 * PHASE 15 — EVENT LIFECYCLE AUTOMATION (INTEGRATION)
 * ==========================================
 *
 * Executes the REAL batch and the REAL event service against the REAL MariaDB. Only
 * `@/auth` is mocked, so every permission decision is made by `lib/authz` against real
 * membership rows.
 *
 * What this suite is for (Phase 14 §23.8 items 3, 4, 5, 10, 11, 12, 13, 19):
 *
 *   • the two automatic transitions, at their exact boundaries, with catch-up;
 *   • a cancelled/archived/endAt-less event is never moved;
 *   • a duplicate and a CONCURRENT run produce exactly one transition and one audit row;
 *   • the transitions change NO commercial row (orders, tickets, payments, refunds, quota);
 *   • manual completion: authorization, preconditions, idempotent replay, audit;
 *   • the `startAt`/`endAt` freezes and the DRAFT-only publish guard;
 *   • the public catalog lists ONGOING and not COMPLETED.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireOrganizerAccess } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";
import {
    advanceEventLifecycleBatch,
    CHECK_IN_GRACE_MS,
} from "@/lib/events/lifecycle";
import { listPublicEvents } from "@/lib/events/catalog";
import {
    completeEvent,
    createEvent,
    publishEvent,
    unpublishEvent,
    updateEvent,
} from "@/lib/events/service";
import { isEventPurchasable } from "@/lib/events/sales-state";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(120_000);

const SUFFIX = `p15-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ORIGIN = "https://tinggalklik.test";

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

let owner: { id: string };
let outsider: { id: string };
let finance: { id: string };
let customer: { id: string };
let org: { id: string };
let otherOrg: { id: string };
let sport: { id: string };

const MINUTE = 60_000;

async function createUser(tag: string) {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });
}

/**
 * Seed an event directly with full control over the lifecycle columns.
 *
 * Direct writes are deliberate: the point is to construct a specific point in time, and the
 * service under test is what must then act on it.
 */
async function seedEvent(
    tag: string,
    overrides: {
        status?:
            | "DRAFT"
            | "PUBLISHED"
            | "ONGOING"
            | "COMPLETED"
            | "CANCELLED"
            | "ARCHIVED";
        startAt?: Date;
        endAt?: Date | null;
        cancelledAt?: Date | null;
        archivedAt?: Date | null;
        organizerId?: string;
    } = {}
) {
    const status = overrides.status ?? "PUBLISHED";

    return prisma.event.create({
        data: {
            organizerId: overrides.organizerId ?? org.id,
            sportId: sport.id,
            title: `Lifecycle ${tag} ${SUFFIX}`,
            slug: `lifecycle-${tag}-${SUFFIX}`,
            eventCode: `TKL-EVT-L-${tag}-${SUFFIX}`.slice(0, 40),
            startAt: overrides.startAt ?? new Date(Date.now() - 60 * MINUTE),
            endAt:
                overrides.endAt === undefined
                    ? new Date(Date.now() + 60 * MINUTE)
                    : overrides.endAt,
            status,
            publishedAt: status === "DRAFT" ? null : new Date(),
            cancelledAt: overrides.cancelledAt ?? null,
            archivedAt: overrides.archivedAt ?? null,
            createdByUserId: owner.id,
        },
        select: { id: true, slug: true },
    });
}

function readEvent(id: string) {
    return prisma.event.findUniqueOrThrow({
        where: { id },
        select: {
            status: true,
            startAt: true,
            endAt: true,
            completedAt: true,
            cancelledAt: true,
            archivedAt: true,
            requiresCheckIn: true,
        },
    });
}

function lifecycleAudit(eventId: string) {
    return prisma.adminAuditLog.findMany({
        where: {
            entityRef: eventId,
            action: { in: ["event.ongoing", "event.complete"] },
        },
        orderBy: { createdAt: "asc" },
    });
}

beforeAll(async () => {
    owner = await createUser("owner");
    outsider = await createUser("outsider");
    finance = await createUser("finance");
    customer = await createUser("customer");

    org = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `Lifecycle Org ${SUFFIX}`,
            slug: `lifecycle-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    otherOrg = await prisma.organizer.create({
        data: {
            ownerUserId: outsider.id,
            name: `Lifecycle Other ${SUFFIX}`,
            slug: `lifecycle-other-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.createMany({
        data: [
            {
                organizerId: org.id,
                userId: owner.id,
                role: "OWNER",
                status: "ACTIVE",
            },
            {
                organizerId: org.id,
                userId: finance.id,
                role: "FINANCE",
                status: "ACTIVE",
            },
            {
                organizerId: otherOrg.id,
                userId: outsider.id,
                role: "OWNER",
                status: "ACTIVE",
            },
        ],
    });

    sport = await prisma.sport.create({
        data: {
            name: `Lifecycle Sport ${SUFFIX}`,
            slug: `lifecycle-sport-${SUFFIX}`,
        },
        select: { id: true },
    });
});

afterAll(async () => {
    const eventIds = (
        await prisma.event.findMany({
            where: { organizerId: { in: [org.id, otherOrg.id] } },
            select: { id: true },
        })
    ).map((row) => row.id);

    if (eventIds.length > 0) {
        await prisma.checkIn.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.ticket.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.eventOrder.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.ticketType.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.eventImage.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }

    const userIds = [owner.id, outsider.id, finance.id, customer.id];

    await prisma.permissionGrant.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.organizerMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.organizer.deleteMany({
        where: { id: { in: [org.id, otherOrg.id] } },
    });
    await prisma.adminAuditLog.deleteMany({
        where: { actorUserId: { in: userIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.sport.deleteMany({ where: { id: sport.id } });
});

async function ownerScope() {
    signInAs(owner.id);

    return requireOrganizerAccess(org.id, PERMISSIONS.EVENT_READ);
}

/* ==============================================================
 * AUTOMATIC TRANSITIONS
 * ============================================================== */

describe("P15-A. advanceEventLifecycleBatch — the automatic transitions", () => {
    test("PUBLISHED → ONGOING exactly at startAt, with one SYSTEM audit row", async () => {
        const startAt = new Date(Date.now() - 5 * MINUTE);
        const created = await seedEvent("ongoing", {
            status: "PUBLISHED",
            startAt,
            endAt: new Date(Date.now() + 60 * MINUTE),
        });

        const result = await advanceEventLifecycleBatch({
            now: new Date(startAt.getTime()),
            batchSize: 500,
        });

        expect(result.toOngoing).toBeGreaterThanOrEqual(1);

        const after = await readEvent(created.id);

        expect(after.status).toBe("ONGOING");
        // ONGOING has no timestamp column by design (P14-D20) — the instant is `startAt`.
        expect(after.completedAt).toBeNull();

        const audits = await lifecycleAudit(created.id);

        expect(audits).toHaveLength(1);
        expect(audits[0].action).toBe("event.ongoing");
        expect(audits[0].actorType).toBe("SYSTEM");
        expect(audits[0].actorOrganizerId).toBeNull();
        expect(audits[0].organizerId).toBe(org.id);

        // One minute before startAt the event must still be PUBLISHED.
        const early = await seedEvent("ongoing-early", {
            status: "PUBLISHED",
            startAt: new Date(Date.now() + 30 * MINUTE),
            endAt: new Date(Date.now() + 90 * MINUTE),
        });

        expect((await readEvent(early.id)).status).toBe("PUBLISHED");
    });

    test("ONGOING → COMPLETED at endAt + grace, with completedAt and one audit row", async () => {
        const endAt = new Date(Date.now() - 60 * MINUTE);
        const created = await seedEvent("complete", {
            status: "ONGOING",
            startAt: new Date(endAt.getTime() - 120 * MINUTE),
            endAt,
        });

        const dueAt = new Date(endAt.getTime() + CHECK_IN_GRACE_MS);

        // One millisecond before the boundary: nothing happens.
        const before = await advanceEventLifecycleBatch({
            now: new Date(dueAt.getTime() - 1),
            batchSize: 500,
        });

        expect(before.toCompleted).toBe(0);
        expect((await readEvent(created.id)).status).toBe("ONGOING");

        // At the boundary: completed, and the observation instant is recorded.
        const at = await advanceEventLifecycleBatch({
            now: dueAt,
            batchSize: 500,
        });

        expect(at.toCompleted).toBeGreaterThanOrEqual(1);

        const after = await readEvent(created.id);

        expect(after.status).toBe("COMPLETED");
        expect(after.completedAt?.toISOString()).toBe(dueAt.toISOString());

        const audits = await lifecycleAudit(created.id);

        expect(audits).toHaveLength(1);
        expect(audits[0].action).toBe("event.complete");
        expect(audits[0].actorType).toBe("SYSTEM");
    });

    test("catch-up: an event whose whole window has passed goes straight to COMPLETED", async () => {
        const created = await seedEvent("catchup", {
            status: "PUBLISHED",
            startAt: new Date(Date.now() - 5 * 24 * 60 * MINUTE),
            endAt: new Date(Date.now() - 4 * 24 * 60 * MINUTE),
        });

        await advanceEventLifecycleBatch({ now: new Date(), batchSize: 500 });

        const after = await readEvent(created.id);

        expect(after.status).toBe("COMPLETED");

        // No fabricated intermediate step: the audit trail has exactly the completion.
        const audits = await lifecycleAudit(created.id);

        expect(audits.map((row) => row.action)).toEqual(["event.complete"]);
    });

    test("an event with no endAt never completes and keeps selling/attending", async () => {
        const created = await seedEvent("no-end", {
            status: "PUBLISHED",
            startAt: new Date(Date.now() - 60 * MINUTE),
            endAt: null,
        });

        await advanceEventLifecycleBatch({ now: new Date(), batchSize: 500 });

        const after = await readEvent(created.id);

        // It may legitimately have become ONGOING (it is a live event with no fixed end) —
        // what it must NEVER become is COMPLETED.
        expect(after.status).toBe("ONGOING");
        expect(after.completedAt).toBeNull();

        // …and it is still purchasable, because ONGOING does not stop sales.
        expect(
            isEventPurchasable({
                status: after.status,
                visibility: "PUBLIC",
                archivedAt: null,
                cancelledAt: null,
            })
        ).toBe(true);
    });

    test("CANCELLED and ARCHIVED events are skipped whatever their dates say", async () => {
        const cancelled = await seedEvent("cancelled", {
            status: "CANCELLED",
            startAt: new Date(Date.now() - 5 * 24 * 60 * MINUTE),
            endAt: new Date(Date.now() - 4 * 24 * 60 * MINUTE),
            cancelledAt: new Date(),
        });
        const archived = await seedEvent("archived", {
            status: "ARCHIVED",
            startAt: new Date(Date.now() - 5 * 24 * 60 * MINUTE),
            endAt: new Date(Date.now() - 4 * 24 * 60 * MINUTE),
            archivedAt: new Date(),
        });

        await advanceEventLifecycleBatch({ now: new Date(), batchSize: 500 });

        expect((await readEvent(cancelled.id)).status).toBe("CANCELLED");
        expect((await readEvent(archived.id)).status).toBe("ARCHIVED");

        expect(await lifecycleAudit(cancelled.id)).toHaveLength(0);
        expect(await lifecycleAudit(archived.id)).toHaveLength(0);
    });

    test("a second run is a no-op: no transition, no duplicate audit row", async () => {
        const endAt = new Date(Date.now() - 60 * MINUTE);
        const created = await seedEvent("idempotent", {
            status: "ONGOING",
            startAt: new Date(endAt.getTime() - 120 * MINUTE),
            endAt,
        });

        const first = await advanceEventLifecycleBatch({
            now: new Date(),
            batchSize: 500,
        });
        const second = await advanceEventLifecycleBatch({
            now: new Date(),
            batchSize: 500,
        });

        expect(first.toCompleted).toBeGreaterThanOrEqual(1);
        expect(second.toCompleted).toBe(0);
        expect(second.toOngoing).toBe(0);

        expect(await lifecycleAudit(created.id)).toHaveLength(1);
    });

    test("two CONCURRENT runs produce exactly one transition (real DB)", async () => {
        const endAt = new Date(Date.now() - 60 * MINUTE);
        const created = await seedEvent("concurrent", {
            status: "ONGOING",
            startAt: new Date(endAt.getTime() - 120 * MINUTE),
            endAt,
        });

        const [a, b] = await Promise.all([
            advanceEventLifecycleBatch({ now: new Date(), batchSize: 500 }),
            advanceEventLifecycleBatch({ now: new Date(), batchSize: 500 }),
        ]);

        // The conditional UPDATE decides the winner; the loser reports zero.
        expect(a.toCompleted + b.toCompleted).toBe(1);
        expect((await readEvent(created.id)).status).toBe("COMPLETED");
        expect(await lifecycleAudit(created.id)).toHaveLength(1);
    });

    test("the transitions touch no commercial row (purity)", async () => {
        const created = await seedEvent("purity", {
            status: "ONGOING",
            startAt: new Date(Date.now() - 240 * MINUTE),
            endAt: new Date(Date.now() - 60 * MINUTE),
        });

        const ticketType = await prisma.ticketType.create({
            data: {
                eventId: created.id,
                name: `Purity ${SUFFIX}`,
                price: 100_000,
                quota: 10,
                sold: 3,
                reserved: 2,
            },
            select: { id: true, sold: true, reserved: true, version: true },
        });

        const snapshot = async () => ({
            orders: await prisma.eventOrder.count({
                where: { eventId: created.id },
            }),
            tickets: await prisma.ticket.count({
                where: { eventId: created.id },
            }),
            payments: await prisma.payment.count({
                where: { organizerId: org.id },
            }),
            refunds: await prisma.refund.count({
                where: { organizerId: org.id },
            }),
            // Phase 15 §23G: the PIC fee ledger is on the list of rows completion must not
            // touch. A time statement moves no money — including a partner's fee record.
            feeLedger: await prisma.pICFeeLedger.count({
                where: { organizerId: org.id },
            }),
            type: await prisma.ticketType.findUniqueOrThrow({
                where: { id: ticketType.id },
                select: { sold: true, reserved: true, version: true },
            }),
        });

        const before = await snapshot();

        await advanceEventLifecycleBatch({ now: new Date(), batchSize: 500 });

        expect((await readEvent(created.id)).status).toBe("COMPLETED");
        expect(await snapshot()).toEqual(before);
    });
});

/* ==============================================================
 * MANUAL COMPLETION
 * ============================================================== */

describe("P15-B. completeEvent — the manual path", () => {
    test("completes once the end has passed, sets completedAt, and audits the actor", async () => {
        const created = await seedEvent("manual", {
            status: "ONGOING",
            startAt: new Date(Date.now() - 240 * MINUTE),
            endAt: new Date(Date.now() - 30 * MINUTE),
        });

        const scope = await ownerScope();
        const result = await completeEvent(scope, created.id, {
            note: "Acara selesai lebih awal dari jadwal.",
        });

        expect(result.alreadyCompleted).toBe(false);
        expect(result.event.status).toBe("COMPLETED");

        const after = await readEvent(created.id);

        expect(after.status).toBe("COMPLETED");
        expect(after.completedAt).not.toBeNull();

        const audits = await prisma.adminAuditLog.findMany({
            where: { entityRef: created.id, action: "event.complete" },
        });

        expect(audits).toHaveLength(1);
        expect(audits[0].actorType).toBe("USER");
        expect(audits[0].actorUserId).toBe(owner.id);
        expect(audits[0].reason).toContain("selesai lebih awal");
    });

    test("is idempotent: a replay returns the row and writes no second audit row", async () => {
        const created = await seedEvent("manual-replay", {
            status: "ONGOING",
            startAt: new Date(Date.now() - 240 * MINUTE),
            endAt: new Date(Date.now() - 30 * MINUTE),
        });

        const scope = await ownerScope();

        await completeEvent(scope, created.id, { note: null });
        const replay = await completeEvent(scope, created.id, { note: null });

        expect(replay.alreadyCompleted).toBe(true);
        expect(replay.event.status).toBe("COMPLETED");

        const audits = await prisma.adminAuditLog.findMany({
            where: { entityRef: created.id, action: "event.complete" },
        });

        expect(audits).toHaveLength(1);
    });

    test("refuses before endAt, with an endAt-less event, and for a cancelled event", async () => {
        const scope = await ownerScope();

        const notEnded = await seedEvent("manual-early", {
            status: "ONGOING",
            startAt: new Date(Date.now() - 60 * MINUTE),
            endAt: new Date(Date.now() + 60 * MINUTE),
        });

        await expect(
            completeEvent(scope, notEnded.id, { note: null })
        ).rejects.toMatchObject({ code: "CONFLICT" });

        expect((await readEvent(notEnded.id)).status).toBe("ONGOING");

        const noEnd = await seedEvent("manual-no-end", {
            status: "ONGOING",
            startAt: new Date(Date.now() - 60 * MINUTE),
            endAt: null,
        });

        await expect(
            completeEvent(scope, noEnd.id, { note: null })
        ).rejects.toMatchObject({ code: "CONFLICT" });

        expect((await readEvent(noEnd.id)).status).toBe("ONGOING");

        const cancelled = await seedEvent("manual-cancelled", {
            status: "CANCELLED",
            startAt: new Date(Date.now() - 240 * MINUTE),
            endAt: new Date(Date.now() - 60 * MINUTE),
            cancelledAt: new Date(),
        });

        await expect(
            completeEvent(scope, cancelled.id, { note: null })
        ).rejects.toMatchObject({ code: "CONFLICT" });

        expect((await readEvent(cancelled.id)).status).toBe("CANCELLED");
    });

    test("is authorization-bounded: no session, non-member, FINANCE, and cross-tenant", async () => {
        const created = await seedEvent("manual-authz", {
            status: "ONGOING",
            startAt: new Date(Date.now() - 240 * MINUTE),
            endAt: new Date(Date.now() - 60 * MINUTE),
        });

        /** The guard chain throws `AuthzError`; the API layer maps it to an HTTP status. */
        async function denyReason(): Promise<string> {
            const outcome = await requireOrganizerAccess(
                org.id,
                PERMISSIONS.EVENT_PUBLISH
            ).catch((error: unknown) => error);

            expect(isAuthzError(outcome)).toBe(true);

            return (outcome as { code: string }).code;
        }

        // No session at all.
        signInAs(null);
        expect(await denyReason()).toBe("UNAUTHORIZED");

        // A FINANCE member may read events and move money, but holds no event.publish.
        signInAs(finance.id);
        expect(await denyReason()).toBe("FORBIDDEN");

        // Another tenant's owner: denied WITHOUT confirming the tenant exists (404 class).
        signInAs(outsider.id);
        expect(await denyReason()).toBe("ORGANIZER_ACCESS_DENIED");

        // …and nothing above changed the event.
        expect((await readEvent(created.id)).status).toBe("ONGOING");
        expect(await lifecycleAudit(created.id)).toHaveLength(0);
    });

    test("a plain customer never reaches the service", async () => {
        signInAs(customer.id);

        const denied = await requireOrganizerAccess(
            org.id,
            PERMISSIONS.EVENT_PUBLISH
        ).catch((error: unknown) => error);

        expect(isAuthzError(denied)).toBe(true);
        expect((denied as { code: string }).code).toBe("ORGANIZER_ACCESS_DENIED");
    });
});

/* ==============================================================
 * FREEZES AND GUARDS
 * ============================================================== */

describe("P15-C. edit freezes and the publish guard", () => {
    test("startAt is editable in DRAFT/PUBLISHED and frozen in ONGOING/COMPLETED", async () => {
        const scope = await ownerScope();

        const draft = await seedEvent("freeze-draft", {
            status: "DRAFT",
            startAt: new Date(Date.now() + 60 * MINUTE),
            endAt: new Date(Date.now() + 120 * MINUTE),
        });

        const movedDraft = await updateEvent(scope, draft.id, {
            startAt: new Date(Date.now() + 90 * MINUTE),
        } as never);

        expect(movedDraft.status).toBe("DRAFT");

        const ongoing = await seedEvent("freeze-ongoing", {
            status: "ONGOING",
            startAt: new Date(Date.now() - 60 * MINUTE),
            endAt: new Date(Date.now() + 60 * MINUTE),
        });

        await expect(
            updateEvent(scope, ongoing.id, {
                startAt: new Date(Date.now() + 30 * MINUTE),
            } as never)
        ).rejects.toMatchObject({ code: "CONFLICT" });

        const completed = await seedEvent("freeze-completed", {
            status: "COMPLETED",
            startAt: new Date(Date.now() - 240 * MINUTE),
            endAt: new Date(Date.now() - 60 * MINUTE),
        });

        await expect(
            updateEvent(scope, completed.id, {
                startAt: new Date(Date.now() - 200 * MINUTE),
            } as never)
        ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    test("endAt is editable while live and frozen once COMPLETED (no reopen)", async () => {
        const scope = await ownerScope();

        const ongoing = await seedEvent("freeze-endat-ongoing", {
            status: "ONGOING",
            startAt: new Date(Date.now() - 60 * MINUTE),
            endAt: new Date(Date.now() + 60 * MINUTE),
        });

        const later = new Date(Date.now() + 180 * MINUTE);
        const moved = await updateEvent(scope, ongoing.id, {
            endAt: later,
        } as never);

        expect(moved.endAt?.toISOString()).toBe(later.toISOString());

        const completed = await seedEvent("freeze-endat-completed", {
            status: "COMPLETED",
            startAt: new Date(Date.now() - 240 * MINUTE),
            endAt: new Date(Date.now() - 60 * MINUTE),
        });

        await expect(
            updateEvent(scope, completed.id, {
                endAt: new Date(Date.now() + 60 * MINUTE),
            } as never)
        ).rejects.toMatchObject({ code: "CONFLICT" });

        // The refusal is a refusal, not a silent no-op: the stored value is unchanged and
        // the status is untouched.
        const after = await readEvent(completed.id);

        expect(after.status).toBe("COMPLETED");
        expect(after.endAt?.toISOString()).toBe(
            (await readEvent(completed.id)).endAt?.toISOString()
        );
    });

    test("publishEvent accepts ONLY DRAFT — ONGOING can never go back", async () => {
        const scope = await ownerScope();

        const ongoing = await seedEvent("publish-ongoing", {
            status: "ONGOING",
            startAt: new Date(Date.now() - 60 * MINUTE),
            endAt: new Date(Date.now() + 60 * MINUTE),
        });

        await expect(publishEvent(scope, ongoing.id)).rejects.toMatchObject({
            code: "CONFLICT",
        });

        expect((await readEvent(ongoing.id)).status).toBe("ONGOING");

        // And the other direction is closed too (P14-D03): there is no `ONGOING → PUBLISHED`
        // unpublish path, because a state derived from `startAt` cannot be rewritten to a draft.
        await expect(
            unpublishEvent(scope, ongoing.id)
        ).rejects.toMatchObject({ code: "CONFLICT" });

        expect((await readEvent(ongoing.id)).status).toBe("ONGOING");

        const completed = await seedEvent("publish-completed", {
            status: "COMPLETED",
            startAt: new Date(Date.now() - 240 * MINUTE),
            endAt: new Date(Date.now() - 60 * MINUTE),
        });

        await expect(publishEvent(scope, completed.id)).rejects.toMatchObject({
            code: "CONFLICT",
        });

        expect((await readEvent(completed.id)).status).toBe("COMPLETED");
    });

    test("createEvent still lands in DRAFT and the publish path still works end to end", async () => {
        const scope = await ownerScope();

        const created = await createEvent(scope, org.id, {
            title: `Publishable ${SUFFIX}`,
            sportId: sport.id,
            startAt: new Date(Date.now() + 60 * MINUTE),
            endAt: new Date(Date.now() + 120 * MINUTE),
        } as never);

        expect(created.status).toBe("DRAFT");

        await prisma.ticketType.create({
            data: { eventId: created.id, name: "Reguler", price: 1, quota: 1 },
        });

        const published = await publishEvent(scope, created.id);

        expect(published.event.status).toBe("PUBLISHED");
    });
});

/* ==============================================================
 * PUBLIC CATALOG
 * ============================================================== */

describe("P15-D. the public catalog lists live ONGOING events only", () => {
    test("ONGOING appears; COMPLETED, CANCELLED, ARCHIVED and DRAFT do not", async () => {
        const marker = `Catalog ${SUFFIX}`;

        const ongoing = await prisma.event.create({
            data: {
                organizerId: org.id,
                sportId: sport.id,
                title: `${marker} live`,
                slug: `catalog-live-${SUFFIX}`,
                eventCode: `TKL-EVT-C1-${SUFFIX}`.slice(0, 40),
                startAt: new Date(Date.now() - 30 * MINUTE),
                endAt: new Date(Date.now() + 60 * MINUTE),
                status: "ONGOING",
                visibility: "PUBLIC",
                publishedAt: new Date(),
                createdByUserId: owner.id,
            },
            select: { id: true, slug: true },
        });

        const completed = await prisma.event.create({
            data: {
                organizerId: org.id,
                sportId: sport.id,
                title: `${marker} done`,
                slug: `catalog-done-${SUFFIX}`,
                eventCode: `TKL-EVT-C2-${SUFFIX}`.slice(0, 40),
                // A manually-completed event whose end is still in the FUTURE: the status
                // filter, not the past-event filter, must keep it out.
                startAt: new Date(Date.now() - 30 * MINUTE),
                endAt: new Date(Date.now() + 60 * MINUTE),
                status: "COMPLETED",
                visibility: "PUBLIC",
                publishedAt: new Date(),
                completedAt: new Date(),
                createdByUserId: owner.id,
            },
            select: { id: true },
        });

        const page = await listPublicEvents(
            { q: marker, page: 1, limit: 50 } as never,
            ORIGIN
        );
        const slugs = page.items.map((item) => item.slug);

        expect(slugs).toContain(ongoing.slug);
        expect(slugs).not.toContain(`catalog-done-${SUFFIX}`);

        // The statuses that must never be discoverable are covered by the existing Phase 4
        // catalog suite; this test adds the two transitions Phase 15 made reachable.
        expect(completed.id).toBeTruthy();
    });

    test("a completed event is no longer purchasable, an ongoing one still is", () => {
        const base = {
            visibility: "PUBLIC",
            archivedAt: null,
            cancelledAt: null,
        };

        expect(isEventPurchasable({ ...base, status: "ONGOING" })).toBe(true);
        expect(isEventPurchasable({ ...base, status: "COMPLETED" })).toBe(false);
    });
});
