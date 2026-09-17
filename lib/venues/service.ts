import { Prisma } from "@prisma/client";

import { AppError } from "@/lib/api/errors";
import {
    PERMISSIONS,
    decideOrganizerPermission,
    type AuthzScope,
} from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";

import { requirePlatformPermission } from "@/lib/authz";
import { requireVenueCreate, requireVenueManage, requireVenueRead } from "@/lib/events/access";

import type { CreateVenueInput, UpdateVenueInput } from "./validation";

/**
 * ==========================================
 * VENUE SERVICE (decision D-64)
 * ==========================================
 *
 * D-64 (LOCKED) = **BOTH** ownership classes:
 *
 *   global  (`organizerId: null`)  — canonical/shared platform venues. Creating or
 *                                    mutating one requires the platform-scope
 *                                    `venue.manage.global` permission, which only
 *                                    `ADMIN` holds. No ordinary organizer member can
 *                                    touch one.
 *   private (`organizerId: <id>`)  — owned by one organizer, subject to full tenant
 *                                    isolation through `requireOrganizerAccess`.
 *
 * "Do NOT make all venues globally editable. Do NOT make all venues
 * organizer-private." — both classes are therefore reachable through different
 * authorization paths, and neither path can perform the other's work.
 */

const VENUE_SELECT = {
    id: true,
    organizerId: true,
    name: true,
    address: true,
    city: true,
    province: true,
    latitude: true,
    longitude: true,
    capacity: true,
    createdAt: true,
    updatedAt: true,
    _count: { select: { events: true } },
} satisfies Prisma.VenueSelect;

/**
 * List venues visible to an actor.
 *
 * Always includes the platform-global set (shared by definition — see
 * `requireVenueRead`) plus the private venues of every organizer the actor can read.
 * The private half is derived from the authorization decisions, never from a request
 * parameter, so the list cannot be widened by editing a URL.
 */
export async function listVenues(
    scope: AuthzScope,
    params: { organizerId?: string | null; q?: string | null } = {}
) {
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
        organizerIds = scope.organizerScopes
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

    const where: Prisma.VenueWhereInput = {
        ...(params.q ? { name: { contains: params.q } } : {}),
        OR:
            organizerIds.length > 0
                ? [{ organizerId: null }, { organizerId: { in: organizerIds } }]
                : [{ organizerId: null }],
    };

    const items = await prisma.venue.findMany({
        where,
        select: VENUE_SELECT,
        orderBy: [{ name: "asc" }],
    });

    return {
        items: items.map((venue) => ({
            ...venue,
            isGlobal: venue.organizerId === null,
            eventCount: venue._count.events,
        })),
    };
}

/**
 * List the platform-global venues only (`organizerId: null`).
 *
 * This is the D-64 platform surface. It requires the platform-scope
 * `venue.manage.global` permission, so an organizer member — who can read global
 * venues through the shared catalog — cannot enumerate or manage them here.
 */
export async function listGlobalVenues(
    scope: AuthzScope,
    params: { q?: string | null } = {}
) {
    await requirePlatformPermission(PERMISSIONS.VENUE_MANAGE_GLOBAL);

    const items = await prisma.venue.findMany({
        where: {
            organizerId: null,
            ...(params.q ? { name: { contains: params.q } } : {}),
        },
        select: VENUE_SELECT,
        orderBy: [{ name: "asc" }],
    });

    return {
        items: items.map((venue) => ({
            ...venue,
            isGlobal: true as const,
            eventCount: venue._count.events,
        })),
    };
}

/**
 * Create a platform-global venue.
 *
 * A thin, explicit wrapper over `createVenue(scope, null, ...)`. It exists so the
 * global path is named at the call site: the admin route cannot accidentally pass a
 * tenant id, and a reader cannot mistake this for tenant venue creation.
 */
export async function createGlobalVenue(
    scope: AuthzScope,
    input: CreateVenueInput,
    request?: Request
) {
    return createVenue(scope, null, input, request);
}

export async function getVenue(venueId: string) {
    const access = await requireVenueRead(venueId);

    const venue = await prisma.venue.findUniqueOrThrow({
        where: { id: access.venue.id },
        select: VENUE_SELECT,
    });

    return { ...venue, isGlobal: venue.organizerId === null };
}

/**
 * Create a venue in a given ownership class.
 *
 * `organizerId === null` creates a platform-global venue and therefore requires the
 * platform permission; any other value requires tenant `venue.manage` for *that*
 * organizer. The ownership class is decided by the caller's route, and the permission
 * for that class is checked here — so a member of organizer A cannot create a venue
 * owned by organizer B, nor a global one.
 */
export async function createVenue(
    scope: AuthzScope,
    organizerId: string | null,
    input: CreateVenueInput,
    request?: Request
) {
    const authorized = await requireVenueCreate(organizerId);

    const venue = await prisma.venue.create({
        data: {
            organizerId,
            name: input.name,
            address: input.address ?? null,
            city: input.city ?? null,
            province: input.province ?? null,
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
            capacity: input.capacity ?? null,
        },
        select: VENUE_SELECT,
    });

    await writeTicketingAudit({
        action: "venue.create",
        actor: authorized,
        actorOrganizerId: organizerId,
        organizerId,
        entityType: "Venue",
        entityRef: venue.id,
        description:
            organizerId === null
                ? `Venue global dibuat: ${venue.name}`
                : `Venue dibuat: ${venue.name}`,
        afterState: {
            name: venue.name,
            city: venue.city,
            isGlobal: organizerId === null,
        },
        request,
    });

    return { ...venue, isGlobal: organizerId === null };
}

export async function updateVenue(
    scope: AuthzScope,
    venueId: string,
    input: UpdateVenueInput,
    request?: Request
) {
    const access = await requireVenueManage(venueId);
    const authorized = access.scope;

    const before = await prisma.venue.findUniqueOrThrow({
        where: { id: access.venue.id },
        select: VENUE_SELECT,
    });

    const data: Prisma.VenueUpdateInput = {};

    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) {
            (data as Record<string, unknown>)[key] = value;
        }
    }

    const updated = await prisma.venue.update({
        where: { id: before.id },
        data,
        select: VENUE_SELECT,
    });

    await writeTicketingAudit({
        action: "venue.update",
        actor: authorized,
        actorOrganizerId: before.organizerId,
        organizerId: before.organizerId,
        entityType: "Venue",
        entityRef: before.id,
        description: `Venue diperbarui: ${updated.name}`,
        beforeState: {
            name: before.name,
            city: before.city,
            address: before.address,
            capacity: before.capacity,
        },
        afterState: {
            name: updated.name,
            city: updated.city,
            address: updated.address,
            capacity: updated.capacity,
        },
        request,
    });

    return { ...updated, isGlobal: updated.organizerId === null };
}

/**
 * Delete a venue, refusing when it is still referenced by an event.
 *
 * Brief §14: "Do not delete a venue if doing so would violate event history or
 * foreign-key integrity... prefer safe archival/deactivation semantics if supported by
 * the design; do not cascade-delete commercial event history; do not introduce
 * destructive cascades."
 *
 * The FK on `Event.venue` is `onDelete: SetNull`, so the database would happily
 * delete the venue and blank the venue on every event that used it. That is silent
 * loss of event history — an event that took place at "Istora Senayan" would become an
 * event with no location. So deletion is refused while any event references the venue,
 * with the count reported so the operator knows what is blocking it.
 *
 * ARCHIVAL IS NOT IMPLEMENTED: `Venue` has no status or `archivedAt` column, and the
 * design does not define venue archival. Inventing one would be a schema change the
 * design did not authorise, so the safe supported behaviour is refusal. Recorded in
 * the Phase 4 report as a required schema addition before venue retirement is possible
 * without breaking history.
 */
export async function deleteVenue(
    scope: AuthzScope,
    venueId: string,
    request?: Request
) {
    const access = await requireVenueManage(venueId);
    const authorized = access.scope;

    const venue = await prisma.venue.findUniqueOrThrow({
        where: { id: access.venue.id },
        select: VENUE_SELECT,
    });

    if (venue._count.events > 0) {
        throw AppError.conflict(
            `Venue tidak dapat dihapus karena masih digunakan oleh ${venue._count.events} event.`,
            { eventCount: venue._count.events }
        );
    }

    await prisma.venue.delete({ where: { id: venue.id } });

    await writeTicketingAudit({
        action: "venue.delete",
        actor: authorized,
        actorOrganizerId: venue.organizerId,
        organizerId: venue.organizerId,
        entityType: "Venue",
        entityRef: venue.id,
        description: `Venue dihapus: ${venue.name}`,
        beforeState: {
            name: venue.name,
            city: venue.city,
            isGlobal: venue.organizerId === null,
        },
        request,
    });

    return { id: venue.id };
}
