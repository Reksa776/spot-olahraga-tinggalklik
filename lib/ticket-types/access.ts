import { AppError } from "@/lib/api/errors";
import { requireOrganizerAccess, type AuthzScope, type Permission } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * TICKET TYPE RESOURCE ACCESS GUARD
 * ==========================================
 *
 * Mirrors `lib/events/access.ts`, and for the same reason: design §29.5 bans
 * "checking permission **after** fetching the row". A ticket type is reached by its own
 * id, so the guard must resolve *ownership* in one narrow query — the owning event and
 * that event's organizer — and authorize before any business column is read.
 *
 * The lookup selects the ticketing id, the event id and the organizer id, and nothing
 * else. That keeps two Phase 4 properties intact:
 *
 *   1. A denial cannot disclose a single business field of another tenant's record,
 *      because none was loaded.
 *   2. `ORGANIZER_ACCESS_DENIED` maps to **404** (Phase 3 / design §7.4), so a caller
 *      cannot use the response to probe whether another organizer's ticket type exists.
 *
 * `organizerId` here comes from the ticket type's event, never from the request. The
 * Phase 5 brief states the same rule as "the request may contain an `eventId`, but
 * `eventId` is DATA, never AUTHORITY" — this is where that is enforced for the ticket
 * type path, and `requireEventAccess` enforces it for the collection path.
 */

export type TicketTypeAccess = {
    scope: AuthzScope;
    ticketType: { id: string; eventId: string };
    /** The tenant the ticket type belongs to, resolved from the database. */
    organizerId: string;
};

export async function requireTicketTypeAccess(
    ticketTypeId: string,
    permission: Permission
): Promise<TicketTypeAccess> {
    if (!ticketTypeId || typeof ticketTypeId !== "string") {
        throw AppError.notFound("Jenis tiket tidak ditemukan.");
    }

    // Narrow ownership lookup ONLY — no name, price, quota or counters.
    const ticketType = await prisma.ticketType.findUnique({
        where: { id: ticketTypeId },
        select: {
            id: true,
            eventId: true,
            event: { select: { organizerId: true } },
        },
    });

    if (!ticketType) {
        throw AppError.notFound("Jenis tiket tidak ditemukan.");
    }

    const organizerId = ticketType.event.organizerId;

    const scope = await requireOrganizerAccess(organizerId, permission);

    return {
        scope,
        ticketType: { id: ticketType.id, eventId: ticketType.eventId },
        organizerId,
    };
}

/**
 * Re-exported so the ticket-type module does not need a second import path for the
 * event-scoped guard it delegates to.
 */
export { requireEventAccess } from "@/lib/events/access";
