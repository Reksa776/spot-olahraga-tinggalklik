import { AppError, ERROR_CODES } from "@/lib/api/errors";
import {
    PERMISSIONS,
    requireAuth,
    requireOrganizerAccess,
    requirePlatformPermission,
    type AuthzScope,
    type Permission,
} from "@/lib/authz";
import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * EVENT / VENUE RESOURCE ACCESS GUARDS
 * ==========================================
 *
 * Design §29.4 requires an `eventId`-scoped chain — `requireAuth()` +
 * `requireEventAccess(eventId, capability)` — and the phase 4 brief §18 requires that
 * "the caller-provided organizerId is NEVER itself authority".
 *
 * THE ORDERING RULE (design §29.5, banned anti-pattern)
 * ----------------------------------------------------
 * "Checking permission **after** fetching the row" is banned because the data has
 * already been read by then. So each guard below does a **narrow ownership lookup
 * first** — selecting only the id and the owning `organizerId` — then authorizes,
 * and only then does the caller fetch the full row. Nothing but the ownership columns
 * is read before the decision, so a denial cannot disclose a single business field of
 * another tenant's record.
 *
 * ISOLATION IS STRUCTURAL, NOT CONVENTIONAL
 * -----------------------------------------
 * A caller may pass any `eventId` it likes. That is safe because the id is *data*,
 * while authority comes from `requireOrganizerAccess`, which reads the actor's ACTIVE
 * memberships from the database. Passing another organizer's event id therefore fails
 * with `ORGANIZER_ACCESS_DENIED`, which the Phase 3 error mapping renders as **404**
 * (design §7.4) so the denial cannot be used to confirm that the event exists.
 */

export type EventAccess = {
    scope: AuthzScope;
    event: { id: string; organizerId: string };
};

/**
 * Require an organizer-scoped permission over one event.
 *
 * Returns the resolved scope plus the ownership stub, so the caller can use the
 * already-ver authoritative `organizerId` instead of re-reading it from a request.
 */
export async function requireEventAccess(
    eventId: string,
    permission: Permission
): Promise<EventAccess> {
    if (!eventId || typeof eventId !== "string") {
        throw AppError.notFound("Event tidak ditemukan.");
    }

    // Narrow ownership lookup ONLY. No business fields are read before the decision.
    const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { id: true, organizerId: true },
    });

    if (!event) {
        throw AppError.notFound("Event tidak ditemukan.");
    }

    const scope = await requireOrganizerAccess(event.organizerId, permission);

    return { scope, event };
}

export type VenueAccess = {
    scope: AuthzScope;
    venue: { id: string; organizerId: string | null };
    isGlobal: boolean;
};

/**
 * Require READ access to one venue.
 *
 * D-64 splits venues into two ownership classes with different rules:
 *
 *   global  (`organizerId: null`)  — canonical/shared platform venues. Readable by
 *                                    any authenticated actor, because "shared" is the
 *                                    point of the class and hiding them would make
 *                                    them unusable as a catalog of venues.
 *   private (`organizerId: <id>`)  — owned by one organizer. Readable only by an actor
 *                                    with an ACTIVE membership in that organizer, and
 *                                    denied with 404 otherwise.
 *
 * `EVENT_READ` is used as the read capability because the design's §6.4 vocabulary has
 * no `venue.read` and inventing one is exactly what brief §12 forbids ("DO NOT
 * automatically implement these names unless they are supported by the approved
 * design"). `EVENT_READ` is held by every role that can create an event — the only
 * actors who need to read a venue.
 */
export async function requireVenueRead(venueId: string): Promise<VenueAccess> {
    if (!venueId || typeof venueId !== "string") {
        throw AppError.notFound("Venue tidak ditemukan.");
    }

    const venue = await prisma.venue.findUnique({
        where: { id: venueId },
        select: { id: true, organizerId: true },
    });

    if (!venue) {
        throw AppError.notFound("Venue tidak ditemukan.");
    }

    if (venue.organizerId === null) {
        const scope = await requireAuth();

        return { scope, venue, isGlobal: true };
    }

    const scope = await requireOrganizerAccess(
        venue.organizerId,
        PERMISSIONS.EVENT_READ
    );

    return { scope, venue, isGlobal: false };
}

/**
 * Require MANAGE access to one venue.
 *
 * Global venues need a **platform** permission (D-64: "Creation of global venues is
 * restricted to the appropriate platform-level Admin permission"), while a private
 * venue needs tenant-scoped `venue.manage`. The two are separate permission strings
 * precisely so that neither ownership class can be mutated with the other's
 * authority — an organizer member cannot touch a global venue, and a platform Admin
 * without a membership cannot touch a private one.
 */
export async function requireVenueManage(venueId: string): Promise<VenueAccess> {
    if (!venueId || typeof venueId !== "string") {
        throw AppError.notFound("Venue tidak ditemukan.");
    }

    const venue = await prisma.venue.findUnique({
        where: { id: venueId },
        select: { id: true, organizerId: true },
    });

    if (!venue) {
        throw AppError.notFound("Venue tidak ditemukan.");
    }

    if (venue.organizerId === null) {
        const scope = await requirePlatformPermission(
            PERMISSIONS.VENUE_MANAGE_GLOBAL
        );

        return { scope, venue, isGlobal: true };
    }

    const scope = await requireOrganizerAccess(
        venue.organizerId,
        PERMISSIONS.VENUE_MANAGE
    );

    return { scope, venue, isGlobal: false };
}

/**
 * Require the capability to CREATE a new venue in a given ownership class.
 *
 * Creating a global venue has no existing row to resolve, so the permission is
 * checked directly against the platform authority; creating a private one is scoped
 * to the target organizer.
 */
export async function requireVenueCreate(
    organizerId: string | null
): Promise<AuthzScope> {
    if (organizerId === null) {
        return requirePlatformPermission(PERMISSIONS.VENUE_MANAGE_GLOBAL);
    }

    return requireOrganizerAccess(organizerId, PERMISSIONS.VENUE_MANAGE);
}

/**
 * Guard for event creation: the actor must hold event-write in the target organizer.
 *
 * Note this takes the organizer from the caller, but the caller is responsible for
 * having obtained it from a trusted source (a route segment naming the organizer, or
 * the actor's own resolved scope). The permission decision itself is always made
 * against the actor's database-resolved memberships, so a forged value gains nothing.
 */
export async function requireEventCreate(
    organizerId: string
): Promise<AuthzScope> {
    return requireOrganizerAccess(organizerId, PERMISSIONS.EVENT_WRITE);
}

/**
 * The organizer ids in which the actor currently holds an ACTIVE membership.
 *
 * Derived from the resolved scope, never from the request. Used by list endpoints so
 * that "list my events" cannot be widened into "list all events" by a query
 * parameter.
 */
export function activeOrganizerIds(scope: AuthzScope): string[] {
    return scope.organizerScopes
        .filter((m) => m.status === "ACTIVE")
        .map((m) => m.organizerId);
}

/** Re-exported for the tenant-isolation tests. */
export const __errorCodes = ERROR_CODES;
