import { Prisma } from "@prisma/client";

import { AppError } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";

import { summarizeSales, type SalesState } from "./sales-state";
import type { CatalogQuery } from "./validation";

/**
 * ==========================================
 * PUBLIC EVENT CATALOG (design §25.2, §25.3)
 * ==========================================
 *
 * The read-only public surface. Requirements enforced here (brief §11, §12):
 *
 *   • only PUBLISHED events are discoverable;
 *   • DRAFT (unpublished) events are excluded from listings but still resolve for a
 *     direct link, in the read-only unavailable state D-14 requires;
 *   • ARCHIVED events resolve to nothing at all — design §10.3: "soft delete; hidden
 *     from all public surfaces";
 *   • availability is expressed only as `isSoldOut` / `salesState`; raw `quota`,
 *     `sold` and `reserved` are never returned (design §10.5);
 *   • no internal authorization data, membership data, audit fields, financial
 *     fields, or cross-tenant identifiers leave this module.
 *
 * WHAT IS NOT EXPOSED, AND WHY
 * ----------------------------
 * The payloads below are built by explicit mapping from narrow `select`s — not by
 * spreading a Prisma row. A spread would silently publish any column added to `Event`
 * in a later phase (the same failure mode that leaks a column the day it is added).
 * `eventCode`, `id`, `organizerId`, `createdByUserId`, `venue.organizerId`,
 * `returnQuotaOnRefund`, `maxTicketsPerOrder`, `requiresCheckIn` and every
 * status/audit timestamp other than `publishedAt` are deliberately absent:
 * `eventCode` is a support reference, and `id` is replaced by the public `slug` as
 * the identifier of record.
 *
 * "Past event" rule (design §25.2 filters "past events hidden by default")
 * ----------------------------------------------------------------------
 * §25.2 mentions a grace window but specifies no numeric value, and inventing one
 * would be a business decision. Instead an event is treated as past when its own end
 * has passed — `endAt` when set, otherwise `startAt`, matching design §10.2 where a
 * null `endAt` means a running/road event with no fixed end. That needs no magic
 * constant and no arbitrary tolerance.
 */

/** `remaining` is always null while D-15 is undecided (see sales-state.ts). */
const REMAINING_HIDDEN: number | null = null;

type TicketTypeRow = {
    isActive: boolean;
    price: unknown;
    quota: number;
    sold: number;
    reserved: number;
    salesStartAt: Date | null;
    salesEndAt: Date | null;
};

/** Columns needed to build a catalog card. Deliberately narrow. */
const CARD_SELECT = {
    // `id` is selected for internal ordering only — `toCard` maps fields explicitly,
    // so it never reaches the public payload, which identifies events by `slug`.
    id: true,
    slug: true,
    title: true,
    bannerUrl: true,
    timezone: true,
    startAt: true,
    endAt: true,
    salesStartAt: true,
    salesEndAt: true,
    sport: { select: { name: true, slug: true } },
    venue: { select: { name: true, city: true } },
    images: {
        select: { url: true },
        orderBy: { sortOrder: "asc" as const },
        take: 1,
    },
    ticketTypes: {
        select: {
            isActive: true,
            price: true,
            quota: true,
            sold: true,
            reserved: true,
            salesStartAt: true,
            salesEndAt: true,
        },
    },
} satisfies Prisma.EventSelect;

type CardRow = Prisma.EventGetPayload<{ select: typeof CARD_SELECT }>;

export type PublicEventCard = {
    slug: string;
    title: string;
    bannerUrl: string | null;
    sportName: string;
    sportSlug: string;
    startAt: string;
    endAt: string | null;
    timezone: string;
    venueName: string | null;
    venueCity: string | null;
    priceFrom: number | null;
    priceTo: number | null;
    salesState: SalesState;
    isSoldOut: boolean;
    remaining: number | null;
    shareUrl: string;
};

function canonicalShareUrl(origin: string, slug: string): string {
    // Design §10.6: the single canonical form. `?ref=`/`?pic=` tracking variants are
    // built by the caller and never become the canonical URL.
    return `${origin.replace(/\/+$/, "")}/e/${slug}`;
}

function toCard(row: CardRow, origin: string): PublicEventCard {
    const summary = summarizeSales(row.ticketTypes as TicketTypeRow[], {
        salesStartAt: row.salesStartAt,
        salesEndAt: row.salesEndAt,
        startAt: row.startAt,
    });

    return {
        slug: row.slug,
        title: row.title,
        bannerUrl: row.bannerUrl ?? row.images[0]?.url ?? null,
        sportName: row.sport.name,
        sportSlug: row.sport.slug,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt?.toISOString() ?? null,
        timezone: row.timezone,
        venueName: row.venue?.name ?? null,
        venueCity: row.venue?.city ?? null,
        priceFrom: summary.priceFrom,
        priceTo: summary.priceTo,
        salesState: summary.salesState,
        isSoldOut: summary.isSoldOut,
        remaining: REMAINING_HIDDEN,
        shareUrl: canonicalShareUrl(origin, row.slug),
    };
}

/**
 * The hard-coded public filter.
 *
 * Deliberately a single constant with no branch: design §29.5 bans "a 'no filter'
 * branch in a list query", because one forgotten branch leaks the platform. A caller
 * cannot influence `status`, `visibility` or `archivedAt` — only the documented
 * filter parameters are merged in.
 */
function publicVisibilityWhere(now: Date): Prisma.EventWhereInput {
    return {
        // PHASE 15 (P14-D11): `ONGOING` is now a reachable, REAL state (the scheduler moves
        // `PUBLISHED → ONGOING` at `startAt`), so a filter of `status: "PUBLISHED"` would
        // make every live event vanish from the catalog the moment it started.
        //
        // `COMPLETED` is deliberately absent: completion means the event is over, and the
        // existing past-event filter below already hides an event whose end has passed.
        // `DRAFT` / `PENDING_REVIEW` / `CANCELLED` / `ARCHIVED` stay excluded.
        status: { in: ["PUBLISHED", "ONGOING"] },
        visibility: "PUBLIC",
        archivedAt: null,
        // Not yet past: endAt when set, otherwise startAt.
        OR: [
            { endAt: { gte: now } },
            { AND: [{ endAt: null }, { startAt: { gte: now } }] },
        ],
    };
}

function buildFilterWhere(
    query: CatalogQuery,
    now: Date
): Prisma.EventWhereInput {
    const filters: Prisma.EventWhereInput[] = [publicVisibilityWhere(now)];

    if (query.q) {
        filters.push({
            OR: [
                { title: { contains: query.q } },
                { description: { contains: query.q } },
                { venue: { is: { name: { contains: query.q } } } },
            ],
        });
    }

    if (query.sport) {
        filters.push({ sport: { is: { slug: query.sport } } });
    }

    if (query.city) {
        filters.push({ venue: { is: { city: query.city } } });
    }

    if (query.dateFrom) {
        filters.push({ startAt: { gte: query.dateFrom } });
    }

    if (query.dateTo) {
        filters.push({ startAt: { lte: query.dateTo } });
    }

    if (query.hasTickets) {
        filters.push({ ticketTypes: { some: { isActive: true } } });
    }

    if (query.priceMax !== undefined) {
        filters.push({
            ticketTypes: {
                some: { isActive: true, price: { lte: query.priceMax } },
            },
        });
    }

    return { AND: filters };
}

export type PublicCatalogResult = {
    items: PublicEventCard[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
};

export async function listPublicEvents(
    query: CatalogQuery,
    origin: string
): Promise<PublicCatalogResult> {
    const now = new Date();
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sort = query.sort ?? "startAt_asc";

    const where = buildFilterWhere(query, now);

    // `total` is the unfiltered-by-sort count, so pagination stays correct.
    const total = await prisma.event.count({ where });

    const skip = (page - 1) * limit;

    // Price sorting needs an aggregate across `TicketType`, which Prisma cannot
    // express as an `orderBy` on `Event`. A `groupBy` over the relation yields the
    // ordered, paginated event ids without raw SQL — the allow-listed `sort` value
    // is mapped to a fixed object literal, never interpolated into a query string
    // (the Phase 0 S-8 class of bug).
    if (sort === "price_asc" || sort === "price_desc") {
        const direction = sort === "price_asc" ? "asc" : "desc";

        const grouped = await prisma.ticketType.groupBy({
            by: ["eventId"],
            where: { isActive: true, event: { is: where } },
            _min: { price: true },
            orderBy: { _min: { price: direction } },
            skip,
            take: limit,
        });

        const orderedIds = grouped.map((g) => g.eventId);

        if (orderedIds.length === 0) {
            return {
                items: [],
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            };
        }

        // Restore the aggregate ordering: `findMany` does not preserve `in` order.
        const rows = await prisma.event.findMany({
            where: { id: { in: orderedIds } },
            select: CARD_SELECT,
        });

        const byId = new Map(rows.map((row) => [row.id, row]));

        const items = orderedIds
            .map((id) => byId.get(id))
            .filter((row): row is CardRow => row !== undefined)
            .map((row) => toCard(row, origin));

        return {
            items,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    const orderBy: Prisma.EventOrderByWithRelationInput[] =
        sort === "newest"
            ? [{ createdAt: "desc" }]
            : [{ startAt: "asc" }, { createdAt: "asc" }];

    const rows = await prisma.event.findMany({
        where,
        select: CARD_SELECT,
        orderBy,
        skip,
        take: limit,
    });

    return {
        items: rows.map((row) => toCard(row, origin)),
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}

/**
 * PHASE 9 — additive read helper: how many discoverable events each sport currently has.
 *
 * Added for the discovery homepage's sport grid, which needs a real count per sport. The
 * alternative was to omit the number (the grid then says "Lihat event" on all 14 tiles) or to
 * invent one, and neither is acceptable: an invented count is fabricated data, and a count computed
 * in the page would be a second, drifting copy of the visibility rule.
 *
 * It reuses `publicVisibilityWhere`, so a sport's count can only ever include PUBLISHED + PUBLIC,
 * non-archived, not-yet-past events — exactly the set `/events?sport=<slug>` will return. Keyed by
 * slug because that is what the links use.
 *
 * Read-only and additive: no existing query, payload or rule changes.
 */
export async function countPublicEventsBySport(): Promise<Record<string, number>> {
    const rows = await prisma.sport.findMany({
        where: { isActive: true },
        select: {
            slug: true,
            _count: {
                select: { events: { where: publicVisibilityWhere(new Date()) } },
            },
        },
    });

    const counts: Record<string, number> = {};

    for (const row of rows) {
        counts[row.slug] = row._count.events;
    }

    return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail
// ─────────────────────────────────────────────────────────────────────────────

const DETAIL_SELECT = {
    /**
     * PHASE 6 — additive. Design §25.5 fixes the checkout request as
     * `{ eventId, items: [...] }`, so the buyer's page must know the id to submit one.
     * The identifier is the same kind of cuid the payload already exposes for every
     * `ticketType` (`PublicTicketType.id`), and brief §24 permits exposing an internal
     * identifier when the public contract requires it — which here it explicitly does.
     * No other detail field changes, and the catalog's visibility rules are untouched.
     */
    id: true,
    slug: true,
    title: true,
    description: true,
    rules: true,
    bannerUrl: true,
    status: true,
    visibility: true,
    startAt: true,
    endAt: true,
    salesStartAt: true,
    salesEndAt: true,
    timezone: true,
    publishedAt: true,
    cancelledAt: true,
    cancelReason: true,
    sport: { select: { name: true, slug: true } },
    // `organizerId` is intentionally NOT selected: only the public display name and
    // slug are needed, and the tenant id is an internal join key.
    organizer: { select: { name: true, slug: true, logoUrl: true } },
    // `organizerId` on the venue is likewise not selected — exposing it would
    // reveal which private venues belong to which organizer.
    venue: {
        select: {
            name: true,
            address: true,
            city: true,
            province: true,
            latitude: true,
            longitude: true,
        },
    },
    images: {
        select: { url: true, altText: true, sortOrder: true },
        orderBy: { sortOrder: "asc" as const },
    },
    ticketTypes: {
        select: {
            id: true,
            name: true,
            description: true,
            price: true,
            currency: true,
            minPerOrder: true,
            maxPerOrder: true,
            isActive: true,
            quota: true,
            sold: true,
            reserved: true,
            salesStartAt: true,
            salesEndAt: true,
            sortOrder: true,
        },
        orderBy: { sortOrder: "asc" as const },
    },
} satisfies Prisma.EventSelect;

type DetailRow = Prisma.EventGetPayload<{ select: typeof DETAIL_SELECT }>;

export type PublicTicketType = {
    id: string;
    name: string;
    description: string | null;
    price: number;
    currency: string;
    minPerOrder: number;
    maxPerOrder: number | null;
    salesState: SalesState;
    isSoldOut: boolean;
    remaining: number | null;
};

export type PublicEventDetail = {
    /** Required by the checkout request shape (design §25.5) — see `DETAIL_SELECT`. */
    id: string;
    slug: string;
    title: string;
    description: string | null;
    rules: string | null;
    bannerUrl: string | null;
    status: string;
    /** D-14: false means "show a clearly unavailable read-only state". */
    isAvailable: boolean;
    unavailableReason: string | null;
    startAt: string;
    endAt: string | null;
    timezone: string;
    publishedAt: string | null;
    cancelledAt: string | null;
    sport: { name: string; slug: string };
    organizer: { name: string; slug: string; logoUrl: string | null };
    venue: {
        name: string;
        address: string | null;
        city: string | null;
        province: string | null;
        latitude: number | null;
        longitude: number | null;
    } | null;
    images: { url: string; altText: string | null; sortOrder: number }[];
    ticketTypes: PublicTicketType[];
    sales: {
        salesState: SalesState;
        isSoldOut: boolean;
        priceFrom: number | null;
        priceTo: number | null;
    };
    shareUrl: string;
};

function toDetail(row: DetailRow, origin: string): PublicEventDetail {
    const summary = summarizeSales(row.ticketTypes as TicketTypeRow[], {
        salesStartAt: row.salesStartAt,
        salesEndAt: row.salesEndAt,
        startAt: row.startAt,
    });

    const isAvailable = row.status === "PUBLISHED" || row.status === "ONGOING" || row.status === "COMPLETED";

    let unavailableReason: string | null = null;

    if (row.status === "CANCELLED") {
        unavailableReason = "Event ini telah dibatalkan.";
    } else if (row.status === "DRAFT") {
        unavailableReason = "Event ini sedang tidak dipublikasikan.";
    }

    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        description: row.description,
        rules: row.rules,
        bannerUrl: row.bannerUrl ?? row.images[0]?.url ?? null,
        status: row.status,
        isAvailable,
        unavailableReason,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt?.toISOString() ?? null,
        timezone: row.timezone,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
        sport: { name: row.sport.name, slug: row.sport.slug },
        organizer: {
            name: row.organizer.name,
            slug: row.organizer.slug,
            logoUrl: row.organizer.logoUrl,
        },
        venue: row.venue
            ? {
                  name: row.venue.name,
                  address: row.venue.address,
                  city: row.venue.city,
                  province: row.venue.province,
                  latitude:
                      row.venue.latitude === null
                          ? null
                          : Number(row.venue.latitude),
                  longitude:
                      row.venue.longitude === null
                          ? null
                          : Number(row.venue.longitude),
              }
            : null,
        images: row.images.map((image) => ({
            url: image.url,
            altText: image.altText,
            sortOrder: image.sortOrder,
        })),
        // Only ACTIVE types are published. An inactive type is an internal draft of
        // a tier and must not appear as a purchasable option.
        ticketTypes: row.ticketTypes
            .filter((type) => type.isActive)
            .map((type) => {
                const typeSummary = summarizeSales(
                    [type as TicketTypeRow],
                    {
                        salesStartAt: row.salesStartAt,
                        salesEndAt: row.salesEndAt,
                        startAt: row.startAt,
                    }
                );

                return {
                    id: type.id,
                    name: type.name,
                    description: type.description,
                    price: Number(type.price),
                    currency: type.currency,
                    minPerOrder: type.minPerOrder,
                    maxPerOrder: type.maxPerOrder,
                    salesState: typeSummary.salesState,
                    isSoldOut: typeSummary.isSoldOut,
                    remaining: REMAINING_HIDDEN,
                };
            }),
        sales: {
            salesState: summary.salesState,
            isSoldOut: summary.isSoldOut,
            priceFrom: summary.priceFrom,
            priceTo: summary.priceTo,
        },
        shareUrl: canonicalShareUrl(origin, row.slug),
    };
}

/**
 * Resolve one event for the public detail page by **slug or shareCode**
 * (design §25.3).
 *
 * Status handling implements decision D-14 (LOCKED) together with design §10.3:
 *
 *   PUBLISHED / ONGOING / COMPLETED → full payload, `isAvailable: true`
 *   CANCELLED                       → payload with `isAvailable: false` + reason
 *   DRAFT (unpublished)             → payload with `isAvailable: false` + reason
 *   ARCHIVED                        → 404, "hidden from all public surfaces"
 *
 * A DRAFT event is returned rather than hidden because D-14 says the direct detail
 * "may still resolve" and the page "must clearly show that the event is
 * unavailable/unpublished". The payload stops at the unavailable marker: callers must
 * check `isAvailable` before rendering anything purchase-related.
 */
export async function getPublicEventBySlug(
    slugOrCode: string,
    origin: string
): Promise<PublicEventDetail> {
    if (!slugOrCode || typeof slugOrCode !== "string") {
        throw AppError.notFound("Event tidak ditemukan.");
    }

    const trimmed = slugOrCode.trim();

    const row = await prisma.event.findFirst({
        where: {
            OR: [{ slug: trimmed }, { shareCode: trimmed }],
        },
        select: DETAIL_SELECT,
    });

    if (!row || row.status === "ARCHIVED") {
        throw AppError.notFound("Event tidak ditemukan.");
    }

    // `PRIVATE` is reserved and unreachable through the API (see validation.ts), so
    // it is treated defensively as not-public rather than being given invented
    // behaviour.
    if (row.visibility === ("PRIVATE" as typeof row.visibility)) {
        throw AppError.notFound("Event tidak ditemukan.");
    }

    return toDetail(row, origin);
}
