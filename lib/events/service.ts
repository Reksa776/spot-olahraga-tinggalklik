import { Prisma, type EventStatus } from "@prisma/client";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import {
    PERMISSIONS,
    decideOrganizerPermission,
    type AuthzScope,
} from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";

import { releaseOrderReservations } from "@/lib/ticketing/reservations";
import { voidOpenPayments } from "@/lib/ticketing/payment/void";

import { requireEventAccess, requireEventCreate, requireVenueRead } from "./access";
import { summarizeSales } from "./sales-state";
import {
    generateUniqueSlug,
    isAcceptableRequestedSlug,
} from "./slug";
import type {
    CancelEventInput,
    CompleteEventInput,
    CreateEventInput,
    UpdateEventInput,
} from "./validation";

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
    documentationUrl: true,
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
    // PHASE 15 — the observed completion instant, so the dashboard can explain WHEN the
    // event was closed rather than only that it is. Null for every other status.
    completedAt: true,
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
 * Refuse an inverted sales window.
 *
 * PHASE 12. Design §10.2 makes `salesStartAt` / `salesEndAt` the event-level default a
 * ticket type inherits, and the schema's pair rule mirrors the ticket-type rule
 * (`lib/ticket-types/validation.ts`): only a *contradictory* pair is wrong, because a
 * null end means "until event start" and a null start means "immediately after publish".
 *
 * The schema already refuses a bad pair inside one payload; this service-level check is
 * the authoritative one, because an update can move one end against the stored other
 * end ("start the sale next month" against an end that is tomorrow).
 */
function assertSalesWindow(
    salesStartAt: Date | null | undefined,
    salesEndAt: Date | null | undefined
): void {
    if (
        salesStartAt instanceof Date &&
        salesEndAt instanceof Date &&
        salesEndAt.getTime() < salesStartAt.getTime()
    ) {
        throw AppError.validation(
            "Waktu berakhir penjualan tidak boleh sebelum waktu mulai.",
            {
                fields: [
                    {
                        path: "salesEndAt",
                        message: "Harus setelah waktu mulai penjualan.",
                    },
                ],
            }
        );
    }
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

    assertSalesWindow(input.salesStartAt, input.salesEndAt);

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
    "documentationUrl",
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
            salesStartAt: true,
            salesEndAt: true,
            bannerUrl: true,
            documentationUrl: true,
            archivedAt: true,
        },
    });

    if (current.archivedAt) {
        throw AppError.conflict("Event sudah diarsipkan.");
    }

    // ── PHASE 15 — LIFECYCLE-DERIVED FREEZES (P14-D03 / P14-D12) ─────────────────
    //
    // `startAt` and `endAt` are no longer just scheduling inputs: they are the STATE,
    // because `ONGOING` and `COMPLETED` are derived from them. Editing a derived input
    // after the state has moved would make the stored status contradict the dates.
    //
    //   startAt  frozen at ONGOING and COMPLETED (the state was derived from it)
    //   endAt    frozen at COMPLETED only (a correction is still legitimate while the
    //            event is live — the scheduler simply recomputes the next time it runs)
    //
    // A rejected edit is a CONFLICT naming the field, never a silent no-op, so the caller
    // cannot believe a change was applied when it was dropped.
    if (
        input.startAt !== undefined &&
        input.startAt.getTime() !== current.startAt.getTime() &&
        (current.status === "ONGOING" || current.status === "COMPLETED")
    ) {
        throw AppError.conflict(
            "Waktu mulai event tidak dapat diubah setelah event berjalan atau selesai.",
            { status: current.status, reason: "START_AT_FROZEN", field: "startAt" }
        );
    }

    if (
        input.endAt !== undefined &&
        current.status === "COMPLETED" &&
        (input.endAt === null
            ? current.endAt !== null
            : current.endAt === null ||
              input.endAt.getTime() !== current.endAt.getTime())
    ) {
        throw AppError.conflict(
            "Waktu selesai event tidak dapat diubah setelah event selesai.",
            { status: current.status, reason: "END_AT_FROZEN", field: "endAt" }
        );
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

    // Effective window against the STORED value: `undefined` keeps the current end,
    // `null` clears it, so a one-sided PATCH cannot leave start > end.
    assertSalesWindow(
        input.salesStartAt === undefined
            ? current.salesStartAt
            : input.salesStartAt,
        input.salesEndAt === undefined ? current.salesEndAt : input.salesEndAt
    );

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
 *   3. `endAt` present                                    — enforced (PHASE 20B, D-P19-05 = A)
 *   4. banner present                                     — recommended only, NOT enforced
 *
 * PHASE 20B — `endAt` IS REQUIRED BEFORE PUBLICATION (D-P19-05 = A)
 * ----------------------------------------------------------------
 * `Phase 20A` §8 Option A, selected by the owner. Without an `endAt` an event can never
 * complete — neither automatically (`P14-D22`) nor manually (`completeEventManually`) — so
 * it stays live forever and, under the gate contract (`isEventCheckInOpen`, Option A of
 * `D-P19-03`), its gate would never close. Requiring the value at PUBLISH rather than at
 * CREATE is the smallest possible change: a draft may still be saved incomplete, and
 * `endAt` remains editable through `DRAFT`, `PUBLISHED` and `ONGOING` (`P14-D12`), so an
 * organizer only needs a plausible value at the moment they go live.
 *
 * Nothing else changes: `startAt` is still required and still must be in the future, the
 * banner stays a non-blocking hint, and the lifecycle's automatic transitions
 * (`P14-D02`/`P14-D04`) are untouched.
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
            // PHASE 20B (D-P19-05 = A): needed for the "an end time must exist before
            // publication" precondition below.
            endAt: true,
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

    // PHASE 15 (P14-D03 / P14-D23): the ONLY source state is `DRAFT`.
    //
    // Once `ONGOING` exists as a real state, the previous guards ("refuse PUBLISHED,
    // CANCELLED, COMPLETED") left `ONGOING → PUBLISHED` reachable — a BACKWARD transition
    // that would falsify a state derived from `startAt`. The lifecycle is monotonic, so the
    // list of refusals is inverted into a single allowed source: `DRAFT`, full stop.
    if (current.status !== "DRAFT") {
        throw AppError.conflict(
            current.status === "PUBLISHED"
                ? "Event sudah dipublikasikan."
                : "Hanya event berstatus draft yang dapat dipublikasikan.",
            { status: current.status, reason: "NOT_DRAFT" }
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

    // PHASE 20B (D-P19-05 = A): an event without an end time can never complete — not
    // automatically (`P14-D22`) and not manually — so it would remain live, and its gate
    // open, indefinitely. The requirement lands here rather than on create so a draft can
    // still be saved before the schedule is settled.
    if (current.endAt === null) {
        unmet.push(
            "Waktu selesai event wajib diisi sebelum event dipublikasikan agar event dapat diselesaikan."
        );
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
 * Complete an event by hand (design §10.3's "or Manager"; P14-D05).
 *
 * The automatic path is the tick (`advanceEventLifecycleBatch`); this is the human one. It
 * exists because a manager may need to close an event the scheduler has not reached yet
 * (the event plainly ended) without waiting for the next tick, and because the design's own
 * lifecycle table names a Manager as a legitimate trigger.
 *
 * ── PRECONDITIONS (P14-D05 / P14-D22) ────────────────────────────────────────────────
 *   * `endAt IS NOT NULL` — an `endAt`-less event can never be completed, automatically or
 *     manually, because the design's precondition ("past `endAt`") cannot be satisfied.
 *     Such an event is cancelled or archived instead.
 *   * `now >= endAt` — finishing BEFORE the scheduled end is what CANCELLATION expresses.
 *     Allowing early completion would make the public record contradict the dates.
 *
 * ── WHAT IT DOES NOT DO (P14-D16) ────────────────────────────────────────────────────
 * It moves no money and voids nothing: no order is expired, no payment is voided, no ticket
 * is voided, no refund is triggered, no quota is returned and no ledger entry is written.
 * Open refunds continue to be processed exactly as before; the archive action remains the
 * one with a commercial precondition.
 *
 * Idempotent: completing an already-`COMPLETED` event returns the row unchanged and writes
 * no second audit row, mirroring `cancelEvent`/`archiveEvent`. The transition itself is a
 * conditional UPDATE carrying the current status, so two concurrent callers cannot both
 * win and a concurrent tick cannot be clobbered.
 */
export async function completeEvent(
    scope: AuthzScope,
    eventId: string,
    input: CompleteEventInput = { note: null },
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
            endAt: true,
            cancelledAt: true,
            archivedAt: true,
            completedAt: true,
        },
    });

    if (current.archivedAt) {
        throw AppError.conflict("Event sudah diarsipkan.");
    }

    if (current.cancelledAt || current.status === "CANCELLED") {
        throw AppError.conflict(
            "Event yang sudah dibatalkan tidak dapat diselesaikan.",
            { status: current.status, reason: "EVENT_CANCELLED" }
        );
    }

    // Replay: the end state already holds. Report success without a second audit row and
    // without rewriting `completedAt`.
    if (current.status === "COMPLETED") {
        const row = await prisma.event.findUniqueOrThrow({
            where: { id: current.id },
            select: ORGANIZER_EVENT_SELECT,
        });

        return { event: row, alreadyCompleted: true };
    }

    if (current.status !== "PUBLISHED" && current.status !== "ONGOING") {
        throw AppError.conflict(
            "Hanya event yang sudah dipublikasikan yang dapat diselesaikan.",
            { status: current.status, reason: "NOT_PUBLISHED" }
        );
    }

    if (current.endAt === null) {
        throw AppError.conflict(
            "Event tanpa waktu selesai tidak dapat diselesaikan secara manual. Batalkan atau arsipkan event ini sebagai gantinya.",
            { reason: "NO_END_AT" }
        );
    }

    const now = new Date();

    if (now.getTime() < current.endAt.getTime()) {
        throw AppError.conflict(
            "Event belum melewati waktu selesai. Gunakan pembatalan bila event berakhir lebih awal.",
            {
                reason: "NOT_ENDED",
                endAt: current.endAt.toISOString(),
                now: now.toISOString(),
            }
        );
    }

    // The transition IS the guard, so a losing racer (another manual caller, or the tick)
    // is a clean conflict instead of a double transition.
    const claimed = await prisma.event.updateMany({
        where: {
            id: current.id,
            status: { in: ["PUBLISHED", "ONGOING"] },
            archivedAt: null,
            cancelledAt: null,
            endAt: { not: null, lte: now },
        },
        data: { status: "COMPLETED", completedAt: now },
    });

    if (claimed.count !== 1) {
        throw AppError.conflict("Status event sudah berubah. Coba lagi.");
    }

    const updated = await prisma.event.findUniqueOrThrow({
        where: { id: current.id },
        select: ORGANIZER_EVENT_SELECT,
    });

    await writeTicketingAudit({
        action: "event.complete",
        actor: authorized,
        actorOrganizerId: current.organizerId,
        organizerId: current.organizerId,
        entityType: "Event",
        entityRef: current.id,
        description: `Event diselesaikan: ${current.title}`,
        beforeState: { status: current.status },
        afterState: {
            status: updated.status,
            completedAt: updated.completedAt?.toISOString() ?? null,
            note: input.note ?? null,
        },
        reason: input.note ?? "MANUAL_COMPLETION",
        request,
    });

    return { event: updated, alreadyCompleted: false };
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
 *
 * PHASE 15 (P14-D03/P14-D23): the source state is exactly `PUBLISHED`. `ONGOING` is
 * monotonic, so there is no `ONGOING → PUBLISHED` path — an event that has started is
 * cancelled or completed, never rewritten as an unpublished draft.
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

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 12 — cancellation and archival (design §10.2, §10.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refund states that mean "money is still moving" — archive must wait for these.
 *
 * Design §10.3's archive precondition is "no open refunds/settlements". A refund is
 * open while it is anywhere before a provider-confirmed terminal state, so the three
 * in-flight values are refused and `REFUNDED`, `REJECTED` and `FAILED` are not. The set
 * comes from the shipped `RefundStatus` enum rather than from prose.
 */
const OPEN_REFUND_STATUSES = ["PENDING", "APPROVED", "PROCESSING"] as const;

/** Statuses a manual cancellation may start from (design §10.3: `PUBLISHED → CANCELLED`). */
const CANCELLABLE_EVENT_STATUSES = ["PUBLISHED", "ONGOING"] as const;

/**
 * Cancel an event (design §10.3: `PUBLISHED → CANCELLED`).
 *
 * WHAT THIS IMPLEMENTS, AND WHAT IT DELIBERATELY DOES NOT
 * ------------------------------------------------------
 * Design §10.3 states the cancel effect as: "Sales stop immediately; unpaid orders
 * auto-expire; issued tickets become `VOID`; refund workflow engages (post-MVP
 * automation)". This function implements the two parts whose behaviour is fully
 * specified and safe:
 *
 *   1. **Sales stop immediately.** `status = CANCELLED` + `cancelledAt` set. The public
 *      detail already renders the unavailable state with a reason (`lib/events/catalog.ts`)
 *      and `isEventPurchasable` already refuses a `CANCELLED` event at checkout and at the
 *      reservation CAS — so this is the single switch those guards read, not a second rule.
 *   2. **Unpaid orders auto-expire.** Every `PENDING_PAYMENT` order of the event is moved to
 *      `EXPIRED`, its held seats are released and any open payment session is voided, using
 *      the *same* primitives and the *same* per-order transaction shape as the reservation
 *      reaper (`lib/ticketing/reservations.ts`). This is what stops a buyer from paying a
 *      dead event a moment later and landing in the "paid but ticketless" operator queue.
 *      The order CAS is `WHERE status = 'PENDING_PAYMENT'`, so a settlement that wins the
 *      race is respected and never resurrected (design §12.3's anti-resurrection rule).
 *
 * NOT implemented, on purpose, and recorded as product decisions in the Phase 12 report:
 *
 *   • **No automatic refund.** Design §10.2/§10.3 put refund automation after MVP, and the
 *     task contract is explicit that money must never move without provider confirmation.
 *     Cancelling therefore moves no money, writes no `REFUNDED` status and touches no
 *     ledger. Organizers refund through the existing refund workflow.
 *   • **Issued tickets are not voided.** "Issued tickets become VOID" is coupled to the
 *     bulk-refund workflow that is post-MVP; voiding a paid ticket with no refund rail
 *     would strand buyers. This is the one part of §10.3's declared effect that needs a
 *     product decision, so it is documented rather than invented.
 *   • **The design's "Finance approval" step is not modelled.** The Phase 3 permission
 *     vocabulary has no event-cancel-plus-approval capability, so cancellation is gated on
 *     the existing `event.publish` lifecycle permission (Manager/Admin/Owner) and the
 *     approval step is recorded as a decision to make.
 *
 * Idempotent: cancelling an already-cancelled event returns the row unchanged and writes
 * no second audit row. The status CAS is the guard, so the winner is the only writer.
 */
export async function cancelEvent(
    scope: AuthzScope,
    eventId: string,
    input: CancelEventInput = { reason: null },
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
            publishedAt: true,
            cancelledAt: true,
            archivedAt: true,
        },
    });

    if (current.archivedAt) {
        throw AppError.conflict("Event sudah diarsipkan.");
    }

    // Idempotent replay: the end state already holds, so report success without a
    // second audit row or a rewritten `cancelledAt`.
    if (current.status === "CANCELLED") {
        const row = await prisma.event.findUniqueOrThrow({
            where: { id: current.id },
            select: ORGANIZER_EVENT_SELECT,
        });

        return { event: row, expiredOrders: 0, alreadyCancelled: true };
    }

    if (
        !(CANCELLABLE_EVENT_STATUSES as readonly string[]).includes(
            current.status
        )
    ) {
        throw AppError.conflict(
            "Hanya event yang sudah dipublikasikan yang dapat dibatalkan."
        );
    }

    const cancelledAt = new Date();

    // The transition IS the guard (conditional UPDATE, never a read-then-write), so two
    // concurrent cancels cannot both win and a concurrent publish cannot be clobbered.
    const claimed = await prisma.event.updateMany({
        where: {
            id: current.id,
            status: current.status,
            archivedAt: null,
        },
        data: {
            status: "CANCELLED",
            cancelledAt,
            cancelReason: input.reason ?? null,
        },
    });

    if (claimed.count !== 1) {
        throw AppError.conflict("Status event sudah berubah. Coba lagi.");
    }

    // ── Unpaid orders auto-expire (design §10.3) ────────────────────────────────
    // One transaction per order, exactly like the reaper: the order status, the
    // reservation rows, the counters and the payment void commit together or not at all.
    // If this loop is interrupted, the remaining holds are still released by the TTL
    // reaper, so nothing is stranded by a partial run.
    const pendingOrders = await prisma.eventOrder.findMany({
        where: { eventId: current.id, status: "PENDING_PAYMENT" },
        select: { id: true },
        orderBy: { id: "asc" },
    });

    let expiredOrders = 0;

    for (const order of pendingOrders) {
        const outcome = await prisma.$transaction(
            async (tx) => {
                // Claim the decision before releasing anything (phase-7 lock ordering:
                // order row → reservations → ticket types), so a settlement that owns the
                // order is never double-released.
                const cas = await tx.eventOrder.updateMany({
                    where: { id: order.id, status: "PENDING_PAYMENT" },
                    data: { status: "EXPIRED", cancelReason: "Event dibatalkan." },
                });

                if (cas.count === 0) {
                    return null;
                }

                await releaseOrderReservations(tx, order.id, "EXPIRED");
                const paymentsVoided = await voidOpenPayments(tx, order.id);

                const parent = await tx.eventOrder.findUniqueOrThrow({
                    where: { id: order.id },
                    select: { orderNumber: true, organizerId: true },
                });

                return { ...parent, paymentsVoided };
            },
            { timeout: 15_000 }
        );

        if (!outcome) {
            continue;
        }

        expiredOrders += 1;

        await writeTicketingAudit({
            action: "order.expire",
            actorType: "SYSTEM",
            actorOrganizerId: null,
            organizerId: outcome.organizerId,
            entityType: "EventOrder",
            entityRef: outcome.orderNumber,
            description:
                "Pesanan tiket kedaluwarsa karena event dibatalkan; kursi dikembalikan ke ketersediaan.",
            beforeState: { status: "PENDING_PAYMENT" },
            afterState: { status: "EXPIRED" },
            reason: "EVENT_CANCELLED",
        });

        if (outcome.paymentsVoided > 0) {
            await writeTicketingAudit({
                action: "payment.expired",
                actorType: "SYSTEM",
                actorOrganizerId: null,
                organizerId: outcome.organizerId,
                entityType: "Payment",
                entityRef: outcome.orderNumber,
                description:
                    "Sesi pembayaran ditutup karena event dibatalkan.",
                afterState: {
                    paymentStatus: "EXPIRED",
                    attempts: outcome.paymentsVoided,
                },
                reason: "EVENT_CANCELLED",
            });
        }
    }

    const updated = await prisma.event.findUniqueOrThrow({
        where: { id: current.id },
        select: ORGANIZER_EVENT_SELECT,
    });

    await writeTicketingAudit({
        action: "event.cancel",
        actor: authorized,
        actorOrganizerId: current.organizerId,
        organizerId: current.organizerId,
        entityType: "Event",
        entityRef: current.id,
        description: `Event dibatalkan: ${current.title}`,
        beforeState: { status: current.status },
        afterState: {
            status: updated.status,
            cancelledAt: updated.cancelledAt?.toISOString() ?? null,
            expiredOrders,
            // No money moved and no ticket was voided; the audit row says so explicitly
            // so a reviewer does not have to infer it from the absence of other rows.
            refundTriggered: false,
            ticketsVoided: false,
        },
        reason: input.reason ?? null,
        request,
    });

    return { event: updated, expiredOrders, alreadyCancelled: false };
}

/**
 * Archive an event — design §10.2/§10.3's soft delete.
 *
 * "`archivedAt` — soft delete; hidden from all public surfaces", "data retained", "no
 * open refunds/settlements". Every one of those is already enforced elsewhere in the
 * codebase (public catalog 404, public detail 404, update/publish/unpublish/delete
 * guards, ticket-type terminal guard), and this function is the missing *writer* of the
 * two columns those guards read. It changes nothing else:
 *
 *   • no order, ticket, payment, refund or ledger row is touched;
 *   • no data is deleted — `deleteEvent`'s draft-only rule is untouched;
 *   • the event stays visible on the organizer dashboard (history is retained).
 *
 * SOURCE STATES
 * -------------
 * Design §10.3's diagram shows the steady-state path `COMPLETED/CANCELLED → ARCHIVED`,
 * but the schema places no constraint on the source status and no automatic
 * ONGOING/COMPLETED job exists yet (recorded as a deferred product decision), so a
 * `PUBLISHED` event that has already happened could never reach it. Archiving is
 * therefore permitted from any status that is not already archived, and the documented
 * precondition — no open refunds — is the one that is enforced. This widening is
 * recorded as an explicit product decision in the Phase 12 report rather than presented
 * as the design's original rule.
 *
 * Idempotent: archiving an archived event returns the row unchanged, keeping the first
 * `archivedAt` and writing no second audit row.
 */
export async function archiveEvent(
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
        const row = await prisma.event.findUniqueOrThrow({
            where: { id: current.id },
            select: ORGANIZER_EVENT_SELECT,
        });

        return { event: row, alreadyArchived: true };
    }

    // Open refunds still moving money must settle before the event disappears from the
    // surfaces a finance reviewer works from (design §10.3's precondition).
    const openRefunds = await prisma.refund.count({
        where: {
            eventOrder: { eventId: current.id },
            status: { in: [...OPEN_REFUND_STATUSES] },
        },
    });

    if (openRefunds > 0) {
        throw AppError.conflict(
            "Event tidak dapat diarsipkan selama masih ada refund yang belum selesai.",
            { openRefunds, preconditions: ["Selesaikan semua refund terlebih dahulu."] }
        );
    }

    const archivedAt = new Date();

    const claimed = await prisma.event.updateMany({
        where: { id: current.id, archivedAt: null },
        data: { status: "ARCHIVED", archivedAt },
    });

    if (claimed.count !== 1) {
        throw AppError.conflict("Status event sudah berubah. Coba lagi.");
    }

    const updated = await prisma.event.findUniqueOrThrow({
        where: { id: current.id },
        select: ORGANIZER_EVENT_SELECT,
    });

    await writeTicketingAudit({
        action: "event.archive",
        actor: authorized,
        actorOrganizerId: current.organizerId,
        organizerId: current.organizerId,
        entityType: "Event",
        entityRef: current.id,
        description: `Event diarsipkan: ${current.title}`,
        beforeState: { status: current.status, archivedAt: null },
        afterState: {
            status: updated.status,
            archivedAt: updated.archivedAt?.toISOString() ?? null,
            // Explicit, so the audit trail states that archival is non-destructive.
            dataDeleted: false,
        },
        request,
    });

    return { event: updated, alreadyArchived: false };
}

/** Re-exported so route handlers can build consistent error bodies. */
export { ERROR_CODES };
