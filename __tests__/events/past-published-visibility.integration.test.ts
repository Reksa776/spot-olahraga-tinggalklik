/**
 * ==========================================
 * PHASE B — A PUBLISHED EVENT IS NEVER HIDDEN BY THE CLOCK (INTEGRATION)
 * ==========================================
 *
 * The landing page, `/events` and the public API all read `listPublicEvents`, so the
 * question "does a passed PUBLISHED event still appear?" is really "does
 * `publicVisibilityWhere` still return it?" — and that is what this suite pins against the
 * real database.
 *
 * WHAT IT PROVES, IN ORDER OF IMPORTANCE
 * -------------------------------------
 *   1. The old date filter is gone FOR `PUBLISHED` rows: an event whose schedule has passed
 *      is listed, and reports `hasEnded: true` so the card can say "Ditutup" instead of
 *      silently disappearing.
 *   2. `hasEnded` is NOT a copy of `salesState`. The `passedOpenSales` fixture keeps an
 *      explicit future `salesEndAt`, so its sales state is still `OPEN` — exactly the case
 *      where deriving "closed" from the sales window alone would offer a purchase for a
 *      finished event. `hasEnded` says otherwise, and the server agrees.
 *   3. The date ordering leads with what has not happened yet. An `Event terdekat` row whose
 *      first card is a month-old event is broken, so upcoming precedes ended.
 *   4. `DRAFT` / `CANCELLED` / `ARCHIVED` keep their existing visibility rules.
 *   5. The checkout service REFUSES an order for a passed event even though its sales window
 *      is open — the guard is server-side, so a manipulated client buys nothing.
 *
 * Fixtures are created directly through Prisma (like `catalog.integration.test.ts`), are
 * PUBLIC on purpose, and are deleted in `afterAll`. Every assertion filters by this suite's
 * own sport slug, so another suite's fixtures can neither satisfy nor break a test here.
 */

/*
 * `@/lib/authz` reaches `auth.ts` (and therefore `next-auth`, which ships ESM) through its guards.
 * The scope this suite needs is resolved from the DATABASE by `resolveAuthzScope`, so the session
 * layer is stubbed exactly as the sibling checkout suite stubs it — nothing here reads a session.
 */
jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { AppError } from "@/lib/api/errors";
import { parseOrThrow } from "@/lib/api/validation";
import { resolveAuthzScope } from "@/lib/authz";
import { getPublicEventBySlug, listPublicEvents } from "@/lib/events/catalog";
import { isEventEnded } from "@/lib/events/sales-state";
import { catalogQuerySchema } from "@/lib/events/validation";
import { prisma } from "@/lib/prisma";
import { createTicketOrder } from "@/lib/ticketing/checkout";
import {
    checkoutRequestSchema,
    type CheckoutRequest,
} from "@/lib/ticketing/checkout-validation";

jest.setTimeout(120_000);

const SUFFIX = `phaseb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ORIGIN = "https://tinggalklik.test";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/*
 * Relative dates, like every other integration suite here: the catalog reads the real clock, so
 * the fixtures are positioned around it rather than around a pinned instant. The BOUNDARY itself
 * is asserted exactly, with an injected clock, in `sales-state.test.ts`.
 */
const PAST_START = new Date(Date.now() - 20 * DAY);
const PAST_END = new Date(PAST_START.getTime() + 3 * HOUR);
const FUTURE_START = new Date(Date.now() + 20 * DAY);
const FUTURE_END = new Date(FUTURE_START.getTime() + 3 * HOUR);
/** An explicit sales window that outlives the event — the case `salesState` cannot catch. */
const OPEN_SALES_END = new Date(Date.now() + 40 * DAY);

let owner: { id: string };
let buyer: { id: string };
let org: { id: string };
let sport: { id: string };
let venue: { id: string };

type Seeded = { id: string; slug: string; ticketTypeId: string };

const seeded: Record<string, Seeded> = {};
const createdEventIds: string[] = [];
const createdTicketTypeIds: string[] = [];

async function seedEvent(params: {
    key: string;
    title: string;
    slug: string;
    status: "DRAFT" | "PUBLISHED" | "CANCELLED" | "ARCHIVED";
    startAt: Date;
    endAt: Date;
    salesEndAt?: Date | null;
    /** `null` means "no ceiling"; a number is an event-level per-order cap. */
    maxTicketsPerOrder?: number | null;
    withTicket?: boolean;
}): Promise<{ id: string; slug: string }> {
    const event = await prisma.event.create({
        data: {
            organizerId: org.id,
            sportId: sport.id,
            venueId: venue.id,
            title: params.title,
            slug: params.slug,
            eventCode: `TKL-B-${params.key}-${SUFFIX}`.slice(0, 40),
            status: params.status,
            visibility: "PUBLIC",
            startAt: params.startAt,
            endAt: params.endAt,
            salesEndAt: params.salesEndAt ?? null,
            maxTicketsPerOrder: params.maxTicketsPerOrder ?? null,
            publishedAt: params.status === "PUBLISHED" ? new Date() : null,
            archivedAt: params.status === "ARCHIVED" ? new Date() : null,
            cancelledAt: params.status === "CANCELLED" ? new Date() : null,
            cancelReason: params.status === "CANCELLED" ? "Cuaca buruk" : null,
            createdByUserId: owner.id,
        },
        select: { id: true, slug: true },
    });

    createdEventIds.push(event.id);

    const type = params.withTicket
        ? await prisma.ticketType.create({
              data: {
                  eventId: event.id,
                  name: "Reguler",
                  price: 100000,
                  quota: 50,
                  isActive: true,
              },
              select: { id: true },
          })
        : null;

    if (type) {
        createdTicketTypeIds.push(type.id);
    }

    seeded[params.key] = {
        id: event.id,
        slug: event.slug,
        ticketTypeId: type?.id ?? "",
    };

    return event;
}

/** Only this suite's events are in scope: the sport slug is unique to the run. */
async function listMine(query: Record<string, unknown> = {}) {
    const parsed = parseOrThrow(catalogQuerySchema, {
        sport: `phaseb-sport-${SUFFIX}`,
        limit: 50,
        ...query,
    });

    return listPublicEvents(parsed, ORIGIN);
}

const slugsOf = (items: { slug: string }[]) => items.map((item) => item.slug);

beforeAll(async () => {
    owner = await prisma.user.create({
        data: {
            name: `PhaseB Owner ${SUFFIX}`,
            email: `phaseb-owner-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    buyer = await prisma.user.create({
        data: {
            name: `PhaseB Buyer ${SUFFIX}`,
            email: `phaseb-buyer-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    org = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `PhaseB Organizer ${SUFFIX}`,
            slug: `phaseb-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    sport = await prisma.sport.create({
        data: {
            name: `PhaseB Sport ${SUFFIX}`,
            slug: `phaseb-sport-${SUFFIX}`,
        },
        select: { id: true },
    });

    venue = await prisma.venue.create({
        data: {
            organizerId: org.id,
            name: `PhaseB Venue ${SUFFIX}`,
            city: "Jakarta",
        },
        select: { id: true },
    });

    await seedEvent({
        key: "upcoming",
        title: `Upcoming ${SUFFIX}`,
        slug: `phaseb-upcoming-${SUFFIX}`,
        status: "PUBLISHED",
        startAt: FUTURE_START,
        endAt: FUTURE_END,
        maxTicketsPerOrder: 1,
        withTicket: true,
    });

    /*
     * THE INTERESTING ONE: the event is over, but its sales window is deliberately still open
     * (`salesEndAt` a month after the end). Its per-ticket-type classifier therefore reports
     * `OPEN` — an "on sale" event by the sales rule — which is exactly why "has it ended?"
     * cannot be answered from `salesState` and needs its own verdict.
     */
    await seedEvent({
        key: "passedOpenSales",
        title: `Passed Open Sales ${SUFFIX}`,
        slug: `phaseb-passed-open-${SUFFIX}`,
        status: "PUBLISHED",
        startAt: PAST_START,
        endAt: PAST_END,
        salesEndAt: OPEN_SALES_END,
        withTicket: true,
    });

    await seedEvent({
        key: "passedDefaultWindow",
        title: `Passed Default Window ${SUFFIX}`,
        slug: `phaseb-passed-default-${SUFFIX}`,
        status: "PUBLISHED",
        startAt: PAST_START,
        endAt: PAST_END,
        withTicket: true,
    });

    await seedEvent({
        key: "draft",
        title: `Draft ${SUFFIX}`,
        slug: `phaseb-draft-${SUFFIX}`,
        status: "DRAFT",
        startAt: FUTURE_START,
        endAt: FUTURE_END,
        withTicket: true,
    });

    await seedEvent({
        key: "cancelled",
        title: `Cancelled ${SUFFIX}`,
        slug: `phaseb-cancelled-${SUFFIX}`,
        status: "CANCELLED",
        startAt: PAST_START,
        endAt: PAST_END,
        withTicket: true,
    });

    await seedEvent({
        key: "archived",
        title: `Archived ${SUFFIX}`,
        slug: `phaseb-archived-${SUFFIX}`,
        status: "ARCHIVED",
        startAt: PAST_START,
        endAt: PAST_END,
        withTicket: true,
    });
});

afterAll(async () => {
    if (createdTicketTypeIds.length > 0) {
        await prisma.ticketType.deleteMany({ where: { id: { in: createdTicketTypeIds } } });
    }

    /*
     * No order rows to sweep: both checkout attempts in this suite are refused BEFORE the
     * transaction opens (the clock guard, then the per-order ceiling), which is itself asserted
     * above. `event.deleteMany` would fail loudly if that ever stopped being true, so the
     * invariant is enforced rather than assumed away.
     */
    if (createdEventIds.length > 0) {
        await prisma.eventImage.deleteMany({ where: { eventId: { in: createdEventIds } } });
        await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    }

    await prisma.venue.deleteMany({ where: { id: venue.id } });
    await prisma.organizer.deleteMany({ where: { id: org.id } });
    await prisma.sport.deleteMany({ where: { id: sport.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, buyer.id] } } });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. PUBLISHED + not yet ended → listed normally
// ─────────────────────────────────────────────────────────────────────────────

describe("A. a PUBLISHED event that has not happened yet", () => {
    test("appears in the listing, marked as not ended", async () => {
        const result = await listMine();

        expect(slugsOf(result.items)).toContain(seeded.upcoming.slug);

        const card = result.items.find((item) => item.slug === seeded.upcoming.slug);

        expect(card?.hasEnded).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. PUBLISHED + already ended → STILL listed
// ─────────────────────────────────────────────────────────────────────────────

describe("B. a PUBLISHED event that has already ended", () => {
    test("is still listed — the clock must not delete it from the landing page", async () => {
        const result = await listMine();
        const slugs = slugsOf(result.items);

        expect(slugs).toContain(seeded.passedOpenSales.slug);
        expect(slugs).toContain(seeded.passedDefaultWindow.slug);
    });

    test("reports hasEnded: true on the card", async () => {
        const result = await listMine();

        for (const key of ["passedOpenSales", "passedDefaultWindow"] as const) {
            const card = result.items.find((item) => item.slug === seeded[key].slug);

            expect(card).toBeDefined();
            expect(card?.hasEnded).toBe(true);
            // And the catalog's own verdict agrees with the shared predicate.
            expect(
                isEventEnded(
                    { startAt: new Date(card!.startAt), endAt: card!.endAt ? new Date(card!.endAt) : null },
                    new Date()
                )
            ).toBe(true);
        }
    });

    test("hasEnded is NOT salesState: an open sales window stays OPEN on a finished event", async () => {
        /*
         * This is the gap the phase fixes. `classifyType`'s window end is `salesEndAt` when it is
         * set, so a finished event with a still-open window classifies as OPEN — and anything that
         * derived "closed" from `salesState` alone would keep offering a purchase. The two signals
         * must therefore be read separately.
         */
        const result = await listMine();
        const card = result.items.find((item) => item.slug === seeded.passedOpenSales.slug);

        expect(card?.salesState).toBe("OPEN");
        expect(card?.isSoldOut).toBe(false);
        expect(card?.hasEnded).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordering — upcoming first, ended after
// ─────────────────────────────────────────────────────────────────────────────

describe("the date ordering keeps the section's promise", () => {
    test("every not-yet-ended event precedes every ended one", async () => {
        const result = await listMine({ sort: "startAt_asc" });
        const indexOfUpcoming = slugsOf(result.items).indexOf(seeded.upcoming.slug);
        const firstEndedIndex = result.items.findIndex((item) => item.hasEnded);

        expect(indexOfUpcoming).toBeGreaterThanOrEqual(0);
        expect(firstEndedIndex).toBeGreaterThanOrEqual(0);
        expect(firstEndedIndex).toBeGreaterThan(indexOfUpcoming);

        // And nothing un-ended appears after an ended card.
        for (const [index, item] of result.items.entries()) {
            if (!item.hasEnded) {
                expect(index).toBeLessThan(firstEndedIndex);
            }
        }
    });

    test("upcoming events stay ascending among themselves", async () => {
        const result = await listMine({ sort: "startAt_asc" });
        const upcomingTimes = result.items
            .filter((item) => !item.hasEnded)
            .map((item) => new Date(item.startAt).getTime());

        expect(upcomingTimes).toEqual([...upcomingTimes].sort((a, b) => a - b));
    });

    test("the ended block is ordered most-recent-first", async () => {
        const result = await listMine({ sort: "startAt_asc" });
        const endedTimes = result.items
            .filter((item) => item.hasEnded)
            .map((item) => new Date(item.startAt).getTime());

        expect(endedTimes).toEqual([...endedTimes].sort((a, b) => b - a));
    });

    test("the total still counts every visible row, ended included", async () => {
        const result = await listMine();

        expect(result.pagination.total).toBe(result.items.length);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// E/F/G. The other lifecycle states keep their existing rules
// ─────────────────────────────────────────────────────────────────────────────

describe("the rest of the visibility matrix is unchanged", () => {
    test("E. a DRAFT event does not appear", async () => {
        const result = await listMine();

        expect(slugsOf(result.items)).not.toContain(seeded.draft.slug);
    });

    test("F. a CANCELLED event does not appear", async () => {
        const result = await listMine();

        expect(slugsOf(result.items)).not.toContain(seeded.cancelled.slug);
    });

    test("G. an ARCHIVED event does not appear", async () => {
        const result = await listMine();

        expect(slugsOf(result.items)).not.toContain(seeded.archived.slug);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The detail payload — the same verdict, on the second public surface
// ─────────────────────────────────────────────────────────────────────────────

describe("the detail payload carries the same verdict", () => {
    test("a passed PUBLISHED event resolves, stays 'available', and reports hasEnded", async () => {
        // D-14's availability is a STATUS question and is untouched: the page still renders
        // (the event happened). What changes is that the page must not offer to sell it.
        const detail = await getPublicEventBySlug(seeded.passedOpenSales.slug, ORIGIN);

        expect(detail.status).toBe("PUBLISHED");
        expect(detail.isAvailable).toBe(true);
        expect(detail.hasEnded).toBe(true);
    });

    test("an upcoming event reports hasEnded: false", async () => {
        const detail = await getPublicEventBySlug(seeded.upcoming.slug, ORIGIN);

        expect(detail.hasEnded).toBe(false);
    });

    test("the verdict follows the caller's clock exactly, at the boundary", async () => {
        // The end instant itself is still live (the boundary is inclusive at the end, matching
        // the catalog's `gte`); one millisecond later the event has ended. An injected clock is
        // what makes this exact instead of a race against the real one.
        const end = PAST_END;

        const justBefore = await getPublicEventBySlug(
            seeded.passedOpenSales.slug,
            ORIGIN,
            new Date(end.getTime() - 1)
        );
        const atEnd = await getPublicEventBySlug(
            seeded.passedOpenSales.slug,
            ORIGIN,
            end
        );
        const justAfter = await getPublicEventBySlug(
            seeded.passedOpenSales.slug,
            ORIGIN,
            new Date(end.getTime() + 1)
        );

        expect(justBefore.hasEnded).toBe(false);
        expect(atEnd.hasEnded).toBe(false);
        expect(justAfter.hasEnded).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// J. The server refuses a new order for a passed event
// ─────────────────────────────────────────────────────────────────────────────

describe("J. checkout refuses a passed event, whatever the client believes", () => {
    async function attempt(eventId: string, ticketTypeId: string, quantity: number) {
        const request = checkoutRequestSchema.parse({
            eventId,
            items: [{ ticketTypeId, quantity }],
            buyerName: "PhaseB Buyer",
            buyerEmail: `phaseb-buyer-${SUFFIX}@example.test`,
            buyerPhone: "081234567890",
        }) as CheckoutRequest;

        const actor = await resolveAuthzScope(buyer.id);

        if (!actor) {
            throw new Error("Fixture error: no authz scope for the buyer");
        }

        return createTicketOrder({
            request,
            actor,
            idempotencyKey: `phaseb-${SUFFIX}-${eventId}-${quantity}`,
        });
    }

    test("an event whose schedule has passed is refused with SALES_NOT_OPEN", async () => {
        const error = await attempt(
            seeded.passedOpenSales.id,
            seeded.passedOpenSales.ticketTypeId,
            1
        ).then(
            () => null,
            (caught) => caught as AppError
        );

        expect(error).toBeInstanceOf(AppError);
        expect(error?.code).toBe("SALES_NOT_OPEN");
        expect(error?.details).toMatchObject({ reason: "EVENT_ENDED" });
    });

    test("no order row is written for the refused attempt", async () => {
        const count = await prisma.eventOrder.count({
            where: { eventId: seeded.passedOpenSales.id },
        });

        expect(count).toBe(0);
    });

    test("the guard does not overreach: an upcoming event passes it", async () => {
        /*
         * The upcoming fixture has `maxTicketsPerOrder: 1`, so asking for 2 is refused by the
         * NEXT guard in `createTicketOrder`. Reaching that ceiling is the proof that the clock
         * guard let the request through — and it keeps this suite free of order rows.
         */
        const error = await attempt(
            seeded.upcoming.id,
            seeded.upcoming.ticketTypeId,
            2
        ).then(
            () => null,
            (caught) => caught as AppError
        );

        expect(error).toBeInstanceOf(AppError);
        expect(error?.code).toBe("LIMIT_EXCEEDED");
        expect(error?.details).toMatchObject({ reason: "ABOVE_EVENT_MAX_PER_ORDER" });
    });
});
