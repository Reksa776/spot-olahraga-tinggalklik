import { Prisma, type EventStatus } from "@prisma/client";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import {
    PERMISSIONS,
    decideOrganizerPermission,
    type AuthzScope,
} from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";

import { requireEventAccess, requireEventCreate, requireVenueRead } from "./access";
import { summarizeSales } from "./sales-state";
import {
    generateUniqueSlug,
    isAcceptableRequestedSlug,
} from "./slug";
import type { CreateEventInput, UpdateEventInput } from "./validation";

/**
 * ==========================================
 * ORGANIZER EVENT SERVICE
 * ==========================================
 *
 * The organizer-facing half of the event domain (design §27.1). Every function takes
 * a resolved `AuthzScope` as its **first** parameter, per design §29.3: "the scope
 * object is passed into the service function, not re-derived there. Services must
 * accept `scope` as a required parameter, so a service call without a scope cannot
 * compile." That is the mechanism, not a style preference — an unscoped call is a
 * type error rather than a data leak.
 *
 * `organizerId` is never read from a request body anywhere in this file. Where it
 * appears it comes from a guard (`requireEventAccess` returns the event's real
 * `organizerId`) or from the route's organizer segment, and it is always fed back
 * through `requireOrganizerAccess` before use.
 *
 * WHAT THIS FILE DOES NOT DO
 * --------------------------
 * No ticket type creation, no quota mutation, no reservation, no order, no payment,
 * no refund, no check-in. Phase 4 boundary (brief §5). The only place `TicketType` is
 * read is `summarizeSales`, which is a read-only display/precondition aggregation
 * whose Phase 5 seam is documented in `sales-state.ts`.
 */

/** The row shape returned to the organizer back office. */
const ORGANIZER_EVENT_SELECT = {
    id: true,
    organizerId: true,
    sportId: true,
    venueId: true,
    title: true,
    slug: true,
    eventCode: true,
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
    maxTicketsPerOrder: true,
    requiresCheckIn: true,
    contactName: true,
    contactPhone: true,
    publishedAt: true,
    cancelledAt: true,
    archivedAt: true,
    createdByUserId: true,
    createdAt: true,
    updatedAt: true,
    sport: { select: { id: true, name: true, slug: true } },
    venue: {
        select: { id: true, name: true, city: true, organizerId: true },
    },
    images: {
        select: { id: true, url: true, altText: true, sortOrder: true },
        orderBy: { sortOrder: "asc" as const },
    },
    _count: { select: { ticketTypes: true } },
} satisfies Prisma.EventSelect;

/**
 * Organizer ids in which the actor may read events.
 *
 * Built by running the *real* decision function over the actor's resolved
 * memberships rather than by inspecting `platformRole` or membership role, so the
 * list cannot drift from the authorization rules. A CHECKIN_STAFF member, for
 * example, holds no `event.read` capability and therefore contributes no id.
 */
export function readableOrganizerIds(scope: AuthzScope): string[] {
    return scope.organizerScopes
        .filter(
            (m) =>
                decideOrganizerPermission(
                    scope,
                    m.organizerId,
                    PERMISSIONS.EVENT_READ
                ).allowed
        )
        .map((m) => m.organizerId);
}

export type OrganizerEventListParams = {
    /** Optional filter. When present it is authorized, never trusted. */
    organizerId?: string | null;
    status?: EventStatus | null;
    q?: string | null;
    page?: number;
    limit?: number;
};

/**
 * List events visible to the actor.
 *
 * When `organizerId` is supplied it is passed through the permission decision, so a
 * forged value produces 404 rather than another tenant's event list. When it is
 * absent the list is restricted to organizations the actor can actually read, so
 * "list my events" cannot be widened into "list all events".
 */
export async function listOrganizerEvents(
    scope: AuthzScope,
    params: OrganizerEventListParams = {}
) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));

    let organizerIds: string[];

    if (params.organizerId) {
        const decision = decideOrganizerPermission(
            scope,
            params.organizerId,
            PERMISSIONS.EVENT_READ
        );

        if (!decision.allowed) {
            throw new AppError(decision.code, { message: "Akses ditolak." });
        }

        organizerIds = [params.organizerId];
    } else {
        organizerIds = readableOrganizerIds(scope);
    }

    if (organizerIds.length === 0) {
        // No readable tenant: an empty page, never an unscoped one.
        return {
            items: [],
            pagination: {
                page,
                limit,
                total: 0,
                totalPages: 0,
            },
        };
    }

    const where: Prisma.EventWhereInput = {
        organizerId: { in: organizerIds },
        ...(params.status ? { status: params.status } : {}),
        ...(params.q
            ? {
                  OR: [
                      { title: { contains: params.q } },
                      { eventCode: { contains: params.q } },
                      { slug: { contains: params.q } },
                  ],
              }
            : {}),
    };

    const [items, total] = await Promise.all([
        prisma.event.findMany({
            where,
            select: ORGANIZER_EVENT_SELECT,
            orderBy: [{ startAt: "desc" }, { createdAt: "desc" }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.event.count({ where }),
    ]);

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

/** One event, with its images and a read-only sales summary. */
export async function getOrganizerEvent(
    scope: AuthzScope,
    eventId: string
) {
    const { event } = await requireEventAccess(eventId, PERMISSIONS.EVENT_READ);

    const row = await prisma.event.findUniqueOrThrow({
        where: { id: event.id },
        select: {
            ...ORGANIZER_EVENT_SELECT,
            ticketTypes: {
                select: {
                    id: true,
                    name: true,
                    price: true,
                    quota: true,
                    sold: true,
                    reserved: true,
                    isActive: true,
                    salesStartAt: true,
                    salesEndAt: true,
                    sortOrder: true,
                },
                orderBy: { sortOrder: "asc" },
            },
        },
    });

    return {
        ...row,
        sales: summarizeSales(row.ticketTypes, {
            salesStartAt: row.salesStartAt,
            salesEndAt: row.salesEndAt,
            startAt: row.startAt,
        }),
    };
}

/**
 * Generate a human-readable event reference, e.g. `TKL-EVT-2026-000123`.
 *
 * The shape follows the comment on the `eventCode` column. Uniqueness is retried a
 * bounded number of times; the column's `@unique` constraint is the real guarantee.
 */
async function generateEventCode(): Promise<string> {
    const year = new Date().getFullYear();

    for (let attempt = 0; attempt < 8; attempt++) {
        const serial = String(Math.floor(Math.random() * 1_000_000)).padStart(
            6,
            "0"
        );
        const candidate = `TKL-EVT-${year}-${serial}`;

        const existing = await prisma.event.findUnique({
            where: { eventCode: candidate },
            select: { id: true },
        });

        if (!existing) {
            return candidate;
        }
    }

    // Extremely unlikely. Fall through to a timestamp-unique value rather than
    // looping; the unique constraint still protects the table.
    return `TKL-EVT-${year}-${Date.now().toString().slice(-6)}`;
}

/** Verify a sport exists and is selectable. */
async function assertSportUsable(sportId: string): Promise<void> {
    const sport = await prisma.sport.findUnique({
        where: { id: sportId },
        select: { id: true, isActive: true },
    });

    if (!sport) {
        throw AppError.validation("Cabang olahraga tidak ditemukan.", {
            fields: [{ path: "sportId", message: "Cabang olahraga tidak ditemukan." }],
        });
    }

    if (!sport.isActive) {
        throw AppError.validation("Cabang olahraga tidak aktif.", {
            fields: [{ path: "sportId", message: "Cabang olahraga tidak aktif." }],
        });
    }
}

/**
 * Verify a venue may be attached by this actor.
 *
 * Delegates to `requireVenueRead`, which enforces D-64: a global venue is readable,
 * and another organizer's private venue resolves to 404. Without this an organizer
 * could attach (and thereby disclose the name and city of) a competitor's private
 * venue by guessing its id.
 */
async function assertVenueAttachable(venueId: string): Promise<void> {
    await requireVenueRead(venueId);
}

export async function createEvent(
    scope: AuthzScope,
    organizerId: string,
    input: CreateEventInput,
    request?: Request
) {
    const authorized = await requireEventCreate(organizerId);

    await assertSportUsable(input.sportId);

    if (input.venueId) {
        await assertVenueAttachable(input.venueId);
    }

    if (input.endAt && input.endAt.getTime() <= input.startAt.getTime()) {
        throw AppError.validation("Waktu selesai harus setelah waktu mulai.", {
            fields: [
                { path: "endAt", message: "Harus setelah waktu mulai." },
            ],
        });
    }

    if (input.startAt.getTime() <= Date.now()) {
        throw AppError.validation("Waktu mulai harus di masa depan.", {
            fields: [{ path: "startAt", message: "Harus di masa depan." }],
        });
    }

    const slug = await generateUniqueSlug(input.title, async (candidate) => {
        const clash = await prisma.event.findUnique({
            where: { slug: candidate },
            select: { id: true },
        });

        return clash !== null;
    });

    const eventCode = await generateEventCode();

    const created = await prisma.event.create({
        data: {
            organizerId,
            sportId: input.sportId,
            venueId: input.venueId ?? null,
            title: input.title,
            slug,
            eventCode,
            description: input.description ?? null,
            rules: input.rules ?? null,
            bannerUrl: input.bannerUrl ?? null,
            startAt: input.startAt,
            endAt: input.endAt ?? null,
            salesStartAt: input.salesStartAt ?? null,
            salesEndAt: input.salesEndAt ?? null,
            ...(input.timezone ? { timezone: input.timezone } : {}),
            maxTicketsPerOrder: input.maxTicketsPerOrder ?? null,
            ...(input.requiresCheckIn === undefined
                ? {}
                : { requiresCheckIn: input.requiresCheckIn }),
            ...(input.visibility ? { visibility: input.visibility } : {}),
            contactName: input.contactName ?? null,
            contactPhone: input.contactPhone ?? null,
            // Status is never client-controlled: a new event is always a draft.
            status: "DRAFT",
            createdByUserId: scope.userId,
        },
        select: ORGANIZER_EVENT_SELECT,
    });

    await writeTicketingAudit({
        action: "event.create",
        actor: authorized,
        actorOrganizerId: organizerId,
        organizerId,
        entityType: "Event",
        entityRef: created.id,
        description: `Event dibuat: ${created.title} (${created.eventCode})`,
        afterState: {
            title: created.title,
            slug: created.slug,
            status: created.status,
            startAt: created.startAt.toISOString(),
            visibility: created.visibility,
        },
        request,
    });

    return created;
}

/** Fields an update is allowed to change, mapped to their audit key. */
const UPDATABLE_KEYS = [
    "title",
    "sportId",
    "venueId",
    "description",
    "rules",
    "bannerUrl",
    "startAt",
    "endAt",
    "salesStartAt",
    "salesEndAt",
    "timezone",
    "maxTicketsPerOrder",
    "requiresCheckIn",
    "visibility",
    "contactName",
    "contactPhone",
] as const;

export async function updateEvent(
    scope: AuthzScope,
    eventId: string,
    input: UpdateEventInput,
    request?: Request
) {
    const { scope: authorized, event } = await requireEventAccess(
        eventId,
        PERMISSIONS.EVENT_WRITE
    );

    const current = await prisma.event.findUniqueOrThrow({
        where: { id: event.id },
        select: {
            id: true,
            organizerId: true,
            title: true,
            slug: true,
            sportId: true,
            venueId: true,
            status: true,
            startAt: true,
            endAt: true,
            archivedAt: true,
        },
    });

    if (current.archivedAt) {
        throw AppError.conflict("Event sudah diarsipkan.");
    }

    if (input.sportId && input.sportId !== current.sportId) {
        await assertSportUsable(input.sportId);
    }

    if (input.venueId && input.venueId !== current.venueId) {
        await assertVenueAttachable(input.venueId);
    }

    // Date invariants. The future-start rule is only applied when `startAt` is
    // actually being changed, so editing the description of an event that has
    // already begun does not fail an unrelated validation.
    const effectiveStart = input.startAt ?? current.startAt;
    const effectiveEnd =
        input.endAt === undefined ? current.endAt : input.endAt;

    if (effectiveEnd && effectiveEnd.getTime() <= effectiveStart.getTime()) {
        throw AppError.validation("Waktu selesai harus setelah waktu mulai.", {
            fields: [{ path: "endAt", message: "Harus setelah waktu mulai." }],
        });
    }

    if (
        input.startAt &&
        input.startAt.getTime() !== current.startAt.getTime() &&
        input.startAt.getTime() <= Date.now()
    ) {
        throw AppError.validation("Waktu mulai harus di masa depan.", {
            fields: [{ path: "startAt", message: "Harus di masa depan." }],
        });
    }

    // Slug change: structural validation here, uniqueness against the database
    // EXCLUDING this event. On collision the change is refused rather than
    // auto-suffixed, because a silently different URL than the operator typed is
    // worse than an explicit conflict — and never stealing a slug is what stops a
    // slug change from exposing or shadowing another event (brief §9).
    let nextSlug: string | undefined;

    if (input.slug !== undefined) {
        if (!isAcceptableRequestedSlug(input.slug)) {
            throw AppError.validation("Slug tidak valid.", {
                fields: [{ path: "slug", message: "Slug tidak valid." }],
            });
        }

        if (input.slug !== current.slug) {
            const clash = await prisma.event.findUnique({
                where: { slug: input.slug },
                select: { id: true },
            });

            if (clash && clash.id !== current.id) {
                throw AppError.conflict("Slug sudah digunakan event lain.", {
                    fields: [{ path: "slug", message: "Sudah digunakan." }],
                });
            }

            nextSlug = input.slug;
        }
    }

    const data: Prisma.EventUpdateInput = {};

    for (const key of UPDATABLE_KEYS) {
        const value = (input as Record<string, unknown>)[key];

        if (value === undefined) {
            continue;
        }

        (data as Record<string, unknown>)[key] = value;
    }

    if (nextSlug !== undefined) {
        data.slug = nextSlug;
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    for (const key of [...UPDATABLE_KEYS, "slug" as const]) {
        const next = (data as Record<string, unknown>)[key];

        if (next === undefined) {
            continue;
        }

        const prev = (current as Record<string, unknown>)[key];
        const normalize = (v: unknown) =>
            v instanceof Date ? v.toISOString() : v;

        if (normalize(prev) !== normalize(next)) {
            before[key] = normalize(prev) ?? null;
            after[key] = normalize(next) ?? null;
        }
    }

    if (Object.keys(after).length === 0) {
        throw AppError.validation("Tidak ada perubahan yang terkirim.");
    }

    const updated = await prisma.event.update({
        where: { id: current.id },
        data,
        select: ORGANIZER_EVENT_SELECT,
    });

    await writeTicketingAudit({
        action: "event.update",
        actor: authorized,
        actorOrganizerId: current.organizerId,
        organizerId: current.organizerId,
        entityType: "Event",
        entityRef: current.id,
        description: `Event diperbarui: ${updated.title}`,
        beforeState: before,
        afterState: after,
        request,
    });

    return updated;
}

/**
 * Publish an event (design §10.3, decision D-13).
 *
 * D-13 is LOCKED as **self-publish**: TinggalKlik.Co runs its own events at launch, so
 * there is no approval queue and no `PENDING_REVIEW` state is introduced. An
 * authorized actor publishes directly.
 *
 * PRECONDITIONS (design §10.3):
 *   1. at least one active `TicketType` with `quota > 0`   — enforced
 *   2. `startAt` in the future                            — enforced
 *   3. banner present                                     — recommended only, NOT enforced
 *
 * PHASE 5 DEPENDENCY, HANDLED WITHOUT COUPLING
 * --------------------------------------------
 * The first precondition is stated against `TicketType`, whose CRUD belongs to
 * Phase 5. The phase 4 brief §8 anticipates exactly this: "If the existing schema
 * already contains the required relationship, handle the publish precondition without
 * implementing ticketing workflows." The table exists from Phase 2, so the check is a
 * **read-only count** — no ticket type is created, no quota mutated, no reservation
 * made. The consequence is deliberate and stated plainly: until Phase 5 can create
 * ticket types, no event can pass this gate in production. That is the design's
 * intended invariant ("never publish something with nothing to sell"), not a
 * limitation introduced here, and it is recorded in the Phase 4 report as a hard
 * dependency rather than bypassed with an override flag.
 *
 * Failure is reported as `CONFLICT` with `details.preconditions` naming every unmet
 * item, so the UI can show precisely what is missing rather than a generic error.
 * No new error code is invented, per §25.1's rule.
 */
export async function publishEvent(
    scope: AuthzScope,
    eventId: string,
    request?: Request
) {
    const { scope: authorized, event } = await requireEventAccess(
        eventId,
        PERMISSIONS.EVENT_PUBLISH
    );

    const current = await prisma.event.findUniqueOrThrow({
        where: { id: event.id },
        select: {
            id: true,
            organizerId: true,
            title: true,
            status: true,
            startAt: true,
            publishedAt: true,
            archivedAt: true,
            bannerUrl: true,
            ticketTypes: {
                select: {
                    isActive: true,
                    quota: true,
                    sold: true,
                    reserved: true,
                    price: true,
                    salesStartAt: true,
                    salesEndAt: true,
                },
            },
        },
    });

    if (current.archivedAt) {
        throw AppError.conflict("Event sudah diarsipkan.");
    }

    if (current.status === "PUBLISHED") {
        throw AppError.conflict("Event sudah dipublikasikan.");
    }

    if (current.status === "CANCELLED" || current.status === "COMPLETED") {
        throw AppError.conflict(
            "Event yang sudah dibatalkan atau selesai tidak dapat dipublikasikan."
        );
    }

    const summary = summarizeSales(current.ticketTypes, {
        salesStartAt: null,
        salesEndAt: null,
        startAt: current.startAt,
    });

    const unmet: string[] = [];

    if (!summary.hasSellableQuota) {
        unmet.push(
            "Minimal satu jenis tiket aktif dengan kuota lebih dari 0 wajib ada."
        );
    }

    if (current.startAt.getTime() <= Date.now()) {
        unmet.push("Waktu mulai event harus di masa depan.");
    }

    if (unmet.length > 0) {
        throw AppError.conflict("Event belum memenuhi syarat publikasi.", {
            preconditions: unmet,
            // Banner is documented as recommended, so its absence is surfaced as a
            // non-blocking hint and never added to `preconditions`.
            bannerRecommended: !current.bannerUrl,
        });
    }

    const updated = await prisma.event.update({
        where: { id: current.id },
        data: {
            status: "PUBLISHED",
            // Set on FIRST publish only, so a later republish does not rewrite the
            // original publication time.
            publishedAt: current.publishedAt ?? new Date(),
        },
        select: ORGANIZER_EVENT_SELECT,
    });

    await writeTicketingAudit({
        action: "event.publish",
        actor: authorized,
        actorOrganizerId: current.organizerId,
        organizerId: current.organizerId,
        entityType: "Event",
        entityRef: current.id,
        description: `Event dipublikasikan: ${current.title}`,
        beforeState: { status: current.status },
        afterState: {
            status: updated.status,
            publishedAt: updated.publishedAt?.toISOString() ?? null,
        },
        request,
    });

    return {
        event: updated,
        bannerRecommended: !current.bannerUrl,
    };
}

/**
 * Unpublish an event (decision D-14, LOCKED).
 *
 * D-14 requires: the event leaves normal public listings; the direct public detail may
 * still resolve, showing a clearly unavailable state; existing buyers keep historical
 * access; **no** data is deleted; no order is cancelled; no ticket is voided; no
 * refund logic runs.
 *
 * That is exactly what this function does — it changes one status column and writes
 * one audit row. The absence of order/ticket/payment writes is the implementation of
 * D-14, not an omission. Ticket-holder-specific access belongs to the ticket and order
 * phases and will read `Event.status` to render its own messaging.
 */
export async function unpublishEvent(
    scope: AuthzScope,
    eventId: string,
    request?: Request
) {
    const { scope: authorized, event } = await requireEventAccess(
        eventId,
        PERMISSIONS.EVENT_PUBLISH
    );

    const current = await prisma.event.findUniqueOrThrow({
        where: { id: event.id },
        select: {
            id: true,
            organizerId: true,
            title: true,
            status: true,
            archivedAt: true,
        },
    });

    if (current.archivedAt) {
        throw AppError.conflict("Event sudah diarsipkan.");
    }

    if (current.status !== "PUBLISHED") {
        throw AppError.conflict(
            "Hanya event yang sudah dipublikasikan dapat dibatalkan publikasinya."
        );
    }

    const updated = await prisma.event.update({
        where: { id: current.id },
        data: { status: "DRAFT" },
        select: ORGANIZER_EVENT_SELECT,
    });

    await writeTicketingAudit({
        action: "event.unpublish",
        actor: authorized,
        actorOrganizerId: current.organizerId,
        organizerId: current.organizerId,
        entityType: "Event",
        entityRef: current.id,
        description: `Publikasi event dibatalkan: ${current.title}`,
        beforeState: { status: current.status },
        afterState: { status: updated.status },
        request,
    });

    return updated;
}

/**
 * Hard-delete a DRAFT event with no commercial history (design §10.3:
 * "Hard delete allowed only for a draft with no commercial history").
 *
 * Orders and tickets are counted first; either one blocks the delete, so a published
 * event, a sold event, or a cancelled event can never be removed this way. Ticket
 * types and reservations are removed inside the same transaction purely to satisfy
 * foreign keys (`TicketType.event` is `onDelete: Restrict`) — this is referential
 * cleanup for a draft that provably has no sales, not a ticket-type workflow. The
 * `EventImage` rows cascade with the event.
 */
export async function deleteEvent(
    scope: AuthzScope,
    eventId: string,
    request?: Request
) {
    const { scope: authorized, event } = await requireEventAccess(
        eventId,
        PERMISSIONS.EVENT_WRITE
    );

    const current = await prisma.event.findUniqueOrThrow({
        where: { id: event.id },
        select: {
            id: true,
            organizerId: true,
            title: true,
            slug: true,
            eventCode: true,
            status: true,
        },
    });

    if (current.status !== "DRAFT") {
        throw AppError.conflict(
            "Hanya event berstatus draft yang dapat dihapus."
        );
    }

    const [orderCount, ticketCount] = await Promise.all([
        prisma.eventOrder.count({ where: { eventId: current.id } }),
        prisma.ticket.count({ where: { eventId: current.id } }),
    ]);

    if (orderCount > 0 || ticketCount > 0) {
        throw AppError.conflict(
            "Event yang sudah memiliki pesanan atau tiket tidak dapat dihapus."
        );
    }

    await prisma.$transaction(async (tx) => {
        await tx.ticketReservation.deleteMany({ where: { eventId: current.id } });
        await tx.ticketType.deleteMany({ where: { eventId: current.id } });
        await tx.event.delete({ where: { id: current.id } });
    });

    await writeTicketingAudit({
        action: "event.delete",
        actor: authorized,
        actorOrganizerId: current.organizerId,
        organizerId: current.organizerId,
        entityType: "Event",
        entityRef: current.id,
        description: `Event draft dihapus: ${current.title} (${current.eventCode})`,
        beforeState: {
            title: current.title,
            slug: current.slug,
            eventCode: current.eventCode,
            status: current.status,
        },
        request,
    });

    return { id: current.id };
}

/** Re-exported so route handlers can build consistent error bodies. */
export { ERROR_CODES };
