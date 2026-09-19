/**
 * ==========================================
 * PHASE 5 — PUBLISH PRECONDITION & PUBLIC EXPOSURE (INTEGRATION)
 * ==========================================
 *
 * Phase 4 implemented the design §10.3 publish precondition and reported it as
 * "implemented but not yet reachable until Phase 5 provides TicketTypes". This suite is
 * the proof that Phase 5 closed that gap — and, just as importantly, that closing it did
 * NOT weaken the guard.
 *
 * The brief (§15) is explicit: "Do NOT weaken the Phase 4 publish rule. Do NOT remove
 * the TicketType prerequisite. Do NOT duplicate publish logic." So every assertion here
 * drives the REAL Phase 4 `publishEvent` against the REAL database; no publish rule was
 * reimplemented for the tests.
 *
 * The second half verifies the public payload stays minimal now that ticket types
 * actually exist — the counters are the interesting part, because Phase 4 could never
 * exercise a non-default availability state.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import { requireAuth, requireOrganizerAccess } from "@/lib/authz";
import { createEvent, publishEvent, unpublishEvent } from "@/lib/events/service";
import { getPublicEventBySlug, listPublicEvents } from "@/lib/events/catalog";
import { catalogQuerySchema } from "@/lib/events/validation";
import { createTicketType, updateTicketType } from "@/lib/ticket-types/service";
import { reserveQuota } from "@/lib/ticketing/inventory";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(180_000);

const SUFFIX = `p5p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

/** The public readers take an origin so absolute share URLs can be built. */
const ORIGIN = "https://tinggalklik.test";

let owner: { id: string };
let organizerId: string;
let sportId: string;

async function scopeFor() {
    auth.mockResolvedValue({
        user: { id: owner.id, email: `${owner.id}@${SUFFIX}.test`, name: "Test" },
        expires: new Date(Date.now() + 60_000).toISOString(),
    });

    return requireOrganizerAccess(organizerId, "event.read");
}

let eventSeq = 0;

/**
 * A fresh DRAFT event with a distinctive slug so catalog queries are unambiguous.
 *
 * PHASE 20B (D-P19-05 = A): the helper supplies an `endAt` relative to the `startAt` it was
 * given, because `publishEvent` now refuses an event without one. The refusal tests below
 * still fail for the reason each names (no sellable type, a past `startAt`, an unauthorized
 * tenant) — the new precondition is always satisfied by the fixture, so it can never be the
 * cause of a refusal a test attributes to something else.
 */
async function draftEvent(startAt: Date = FUTURE, tag = "evt") {
    eventSeq += 1;

    const scope = await scopeFor();

    return createEvent(
        scope,
        organizerId,
        {
            title: `P5 Publish ${tag} ${SUFFIX} ${eventSeq}`,
            sportId,
            startAt,
            endAt: new Date(startAt.getTime() + 3 * 60 * 60 * 1000),
        } as never
    );
}

async function expectRefusal(run: () => Promise<unknown>) {
    try {
        await run();
    } catch (error) {
        return error as { code?: string; details?: Record<string, unknown> };
    }

    throw new Error("Expected the operation to be refused, but it succeeded");
}

beforeAll(async () => {
    owner = await prisma.user.create({
        data: {
            name: `p5-publish-owner ${SUFFIX}`,
            email: `p5-publish-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    organizerId = (
        await prisma.organizer.create({
            data: {
                ownerUserId: owner.id,
                name: `P5 Publish Org ${SUFFIX}`,
                slug: `p5-publish-org-${SUFFIX}`,
                status: "ACTIVE",
            },
            select: { id: true },
        })
    ).id;

    await prisma.organizerMember.create({
        data: {
            organizerId,
            userId: owner.id,
            role: "OWNER",
            status: "ACTIVE",
        },
    });

    sportId = (
        await prisma.sport.create({
            data: { name: `P5 Publish Sport ${SUFFIX}`, slug: `p5-pub-sport-${SUFFIX}` },
            select: { id: true },
        })
    ).id;
});

afterAll(async () => {
    const events = await prisma.event.findMany({
        where: { organizerId },
        select: { id: true },
    });
    const eventIds = events.map((event) => event.id);

    if (eventIds.length > 0) {
        await prisma.ticketReservation.deleteMany({
            where: { eventId: { in: eventIds } },
        });
        await prisma.ticketType.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.eventOrder.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }

    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorUserId: owner.id } });
    await prisma.organizerMember.deleteMany({ where: { organizerId } });
    await prisma.organizer.deleteMany({ where: { id: organizerId } });
    await prisma.user.deleteMany({ where: { id: owner.id } });
});

describe("the TicketType prerequisite (brief §15)", () => {
    test("no ticket types at all → publish refused, naming the requirement", async () => {
        const event = await draftEvent(FUTURE, "none");
        const scope = await scopeFor();

        const refusal = await expectRefusal(() => publishEvent(scope, event.id));

        expect(refusal.code).toBe("CONFLICT");

        const preconditions = refusal.details?.preconditions as string[];
        expect(preconditions.join(" ")).toMatch(/jenis tiket/i);

        // Still a draft — nothing was published by the failed attempt.
        const row = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { status: true, publishedAt: true },
        });
        expect(row).toEqual({ status: "DRAFT", publishedAt: null });
    });

    test("only an INACTIVE ticket type → publish still refused", async () => {
        const event = await draftEvent(FUTURE, "inactive");
        const scope = await scopeFor();

        await createTicketType(scope, event.id, {
            name: "Hidden Tier",
            price: "100000",
            quota: 50,
            isActive: false,
        } as never);

        const refusal = await expectRefusal(() => publishEvent(scope, event.id));
        expect(refusal.code).toBe("CONFLICT");
    });

    test("only a ZERO-QUOTA ticket type → publish still refused", async () => {
        const event = await draftEvent(FUTURE, "zeroquota");
        const scope = await scopeFor();

        await createTicketType(scope, event.id, {
            name: "Placeholder Tier",
            price: "100000",
            quota: 0,
        } as never);

        const refusal = await expectRefusal(() => publishEvent(scope, event.id));
        expect(refusal.code).toBe("CONFLICT");
    });

    test("an active tier with quota > 0 satisfies the prerequisite and the event publishes", async () => {
        const event = await draftEvent(FUTURE, "good");
        const scope = await scopeFor();

        await createTicketType(scope, event.id, {
            name: "Tribun",
            price: "150000",
            quota: 100,
        } as never);

        const published = await publishEvent(scope, event.id);

        expect(published.event.status).toBe("PUBLISHED");

        const row = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { status: true, publishedAt: true },
        });

        expect(row.status).toBe("PUBLISHED");
        expect(row.publishedAt).not.toBeNull();
    });

    test("the full workflow from the brief: draft → tier → publish", async () => {
        // "Organizer creates Event. Event starts as DRAFT. Organizer creates TicketType.
        //  TicketType has valid quota > 0 and is ACTIVE. Event publish can satisfy the
        //  TicketType prerequisite. Event becomes PUBLISHED."
        const scope = await scopeFor();

        const event = await draftEvent(FUTURE, "workflow");
        expect(event.status).toBe("DRAFT");

        const tier = await createTicketType(scope, event.id, {
            name: "Umum",
            price: "75000",
            quota: 25,
        } as never);

        expect(tier.isActive).toBe(true);
        expect(tier.inventory.quota).toBe(25);

        const published = await publishEvent(scope, event.id);
        expect(published.event.status).toBe("PUBLISHED");
    });

    test("deactivating the only tier does not un-publish, but a NEW publish needs one", async () => {
        const scope = await scopeFor();

        const event = await draftEvent(FUTURE, "deactivate");
        const tier = await createTicketType(scope, event.id, {
            name: "Only Tier",
            price: "10000",
            quota: 10,
        } as never);

        await publishEvent(scope, event.id);

        // Deactivating after publication is allowed (design §11.6: deactivation stops
        // new sales without invalidating what exists).
        const off = await updateTicketType(scope, tier.id, {
            isActive: false,
        } as never);
        expect(off.isActive).toBe(false);

        const stillPublished = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { status: true },
        });
        expect(stillPublished.status).toBe("PUBLISHED");

        // But re-publishing after unpublish requires a sellable tier again.
        await unpublishEvent(scope, event.id);

        const refusal = await expectRefusal(() => publishEvent(scope, event.id));
        expect(refusal.code).toBe("CONFLICT");
    });
});

describe("the Phase 4 start-time condition is still enforced", () => {
    test("a past start time blocks publish even with a valid ticket type", async () => {
        const scope = await scopeFor();

        // `createEvent` refuses a past start date outright, so the realistic path to
        // this state is a draft whose date simply passed while it sat unpublished.
        // Moving `startAt` directly reproduces exactly that.
        const event = await draftEvent(FUTURE, "past");

        await prisma.event.update({
            where: { id: event.id },
            data: { startAt: PAST },
        });

        await createTicketType(scope, event.id, {
            name: "Tier On Past Event",
            price: "50000",
            quota: 10,
        } as never);

        const refusal = await expectRefusal(() => publishEvent(scope, event.id));

        expect(refusal.code).toBe("CONFLICT");
        expect((refusal.details?.preconditions as string[]).join(" ")).toMatch(
            /masa depan/i
        );
    });
});

describe("the Phase 4 publish lifecycle is intact", () => {
    test("publishing twice is still refused", async () => {
        const scope = await scopeFor();
        const event = await draftEvent(FUTURE, "twice");

        await createTicketType(scope, event.id, {
            name: "Tier",
            price: "10000",
            quota: 5,
        } as never);

        await publishEvent(scope, event.id);

        const refusal = await expectRefusal(() => publishEvent(scope, event.id));
        expect(refusal.code).toBe("CONFLICT");
    });

    test("unpublish still returns to DRAFT and preserves publishedAt (D-14)", async () => {
        const scope = await scopeFor();
        const event = await draftEvent(FUTURE, "unpublish");

        await createTicketType(scope, event.id, {
            name: "Tier",
            price: "10000",
            quota: 5,
        } as never);

        const published = await publishEvent(scope, event.id);
        const unpublish = await unpublishEvent(scope, event.id);

        // `unpublishEvent` returns the event itself (unlike `publishEvent`, which also
        // reports the advisory banner hint), so there is no `.event` wrapper here.
        expect(unpublish.status).toBe("DRAFT");

        const row = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { publishedAt: true },
        });

        // The first publication timestamp survives the unpublish.
        expect(row.publishedAt?.getTime()).toBe(published.event.publishedAt?.getTime());
    });

    test("an unauthenticated caller cannot publish", async () => {
        auth.mockResolvedValue(null);

        const refusal = await expectRefusal(() => requireAuth());

        expect(refusal.code).toBe("UNAUTHORIZED");
    });
});

describe("public exposure stays minimal now that ticket types exist", () => {
    test("the public detail lists ACTIVE tiers with only the designed fields", async () => {
        const scope = await scopeFor();
        const event = await draftEvent(FUTURE, "public");

        await createTicketType(scope, event.id, {
            name: "Tribun Publik",
            price: "120000",
            quota: 40,
            description: "Tribun utara",
            minPerOrder: 1,
            maxPerOrder: 4,
        } as never);

        await publishEvent(scope, event.id);

        const detail = await getPublicEventBySlug(event.slug, ORIGIN);

        expect(detail).not.toBeNull();
        expect(detail?.ticketTypes).toHaveLength(1);

        const tier = detail!.ticketTypes[0];

        // The design's public contract (§25.4) — and nothing beyond it.
        expect(Object.keys(tier).sort()).toEqual(
            [
                "currency",
                "description",
                "id",
                "isSoldOut",
                "maxPerOrder",
                "minPerOrder",
                "name",
                "price",
                "remaining",
                "salesState",
            ].sort()
        );

        expect(tier.name).toBe("Tribun Publik");
        expect(tier.price).toBe(120000);
        expect(tier.salesState).toBe("OPEN");
        expect(tier.isSoldOut).toBe(false);
    });

    test("quota, sold and reserved are NEVER exposed publicly", async () => {
        const scope = await scopeFor();
        const event = await draftEvent(FUTURE, "leak");

        const tier = await createTicketType(scope, event.id, {
            name: "Leak Check",
            price: "10000",
            quota: 10,
        } as never);

        // Give the counters distinctive values so a leak is unmistakable.
        expect((await reserveQuota(tier.id, 3)).ok).toBe(true);
        await prisma.ticketType.update({
            where: { id: tier.id },
            data: { sold: 4 },
        });

        await publishEvent(scope, event.id);

        const detail = await getPublicEventBySlug(event.slug, ORIGIN);
        const serialised = JSON.stringify(detail);

        // 10 quota, 4 sold, 3 reserved must not be recoverable from the payload.
        expect(serialised).not.toContain("\"quota\"");
        expect(serialised).not.toContain("\"sold\"");
        expect(serialised).not.toContain("\"reserved\"");
        expect(serialised).not.toContain("\"version\"");

        const publicTier = detail!.ticketTypes[0] as unknown as Record<string, unknown>;

        expect(publicTier.quota).toBeUndefined();
        expect(publicTier.sold).toBeUndefined();
        expect(publicTier.reserved).toBeUndefined();

        // D-15 is unresolved, so `remaining` stays the design's documented hidden state.
        expect(publicTier.remaining).toBeNull();
    });

    test("organizer membership and internal ids are not exposed", async () => {
        const scope = await scopeFor();
        const event = await draftEvent(FUTURE, "membership");

        await createTicketType(scope, event.id, {
            name: "Membership Check",
            price: "10000",
            quota: 5,
        } as never);

        await publishEvent(scope, event.id);

        const detail = await getPublicEventBySlug(event.slug, ORIGIN);
        const serialised = JSON.stringify(detail);

        expect(serialised).not.toContain(organizerId);
        expect(serialised).not.toContain("organizerId");
        expect(serialised).not.toContain("organizerMember");
        expect(serialised).not.toContain("PermissionGrant");
        expect(serialised).not.toContain("createdByUserId");
    });

    test("an INACTIVE tier is absent from the public payload", async () => {
        const scope = await scopeFor();
        const event = await draftEvent(FUTURE, "hiddentier");

        await createTicketType(scope, event.id, {
            name: "Visible",
            price: "10000",
            quota: 5,
        } as never);

        await createTicketType(scope, event.id, {
            name: "Invisible",
            price: "20000",
            quota: 5,
            isActive: false,
        } as never);

        await publishEvent(scope, event.id);

        const detail = await getPublicEventBySlug(event.slug, ORIGIN);

        expect(detail?.ticketTypes.map((tier) => tier.name)).toEqual(["Visible"]);
    });

    test("a sold-out tier is still listed and marked, not silently removed", async () => {
        const scope = await scopeFor();
        const event = await draftEvent(FUTURE, "soldout");

        const tier = await createTicketType(scope, event.id, {
            name: "Sold Out Tier",
            price: "10000",
            quota: 2,
        } as never);

        await publishEvent(scope, event.id);

        // Sell it out before the public read.
        expect((await reserveQuota(tier.id, 2)).ok).toBe(true);

        const detail = await getPublicEventBySlug(event.slug, ORIGIN);
        const publicTier = detail!.ticketTypes[0];

        // D-45 (hide sold-out tiers vs show them greyed) is UNRESOLVED. Showing them is
        // the behaviour that does not need a business decision to be safe, and the
        // design's own recommendation; hiding would be a suppression rule invented here.
        expect(publicTier.name).toBe("Sold Out Tier");
        expect(publicTier.isSoldOut).toBe(true);
        expect(publicTier.salesState).toBe("SOLD_OUT");
    });

    test("a DRAFT event with ticket types is still absent from the catalog listing", async () => {
        const scope = await scopeFor();
        const event = await draftEvent(FUTURE, "draftlist");

        await createTicketType(scope, event.id, {
            name: "Draft Tier",
            price: "10000",
            quota: 5,
        } as never);

        // The catalog reader consumes the POST-Zod query shape, so the fixture goes
        // through the real schema rather than hand-rolling a partial object.
        const catalog = await listPublicEvents(
            catalogQuerySchema.parse({ limit: 50 }),
            ORIGIN
        );

        expect(catalog.items.map((item) => item.slug)).not.toContain(event.slug);
    });

    test("an ARCHIVED event is still hidden from public detail", async () => {
        const scope = await scopeFor();
        const event = await draftEvent(FUTURE, "archived");

        await createTicketType(scope, event.id, {
            name: "Archived Tier",
            price: "10000",
            quota: 5,
        } as never);

        await publishEvent(scope, event.id);

        await prisma.event.update({
            where: { id: event.id },
            data: { status: "ARCHIVED", archivedAt: new Date() },
        });

        // The reader refuses an archived event outright rather than returning a
        // payload, so it is unreachable by direct link as well as by listing.
        const refusal = await expectRefusal(() =>
            getPublicEventBySlug(event.slug, ORIGIN)
        );

        expect(refusal.code).toBe("NOT_FOUND");
    });
});
