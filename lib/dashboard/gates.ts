import type { Prisma } from "@prisma/client";

import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import { organizerIdsWith } from "@/lib/dashboard/scope";
import { isEventCheckInOpen } from "@/lib/events/sales-state";
import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * DASHBOARD GATES — "WHICH EVENT CAN THIS ACTOR SCAN?"
 * ==========================================
 *
 * The "Scan Tiket" surface lists the events the caller may admit people at. That is a
 * different scope from `listOrganizerEvents`: the events list is bound by `event.read`,
 * but a `CHECKIN_STAFF` member holds only `checkin.scan` + `checkin.log.read` — no
 * `event.read` at all — so reusing the events service would (correctly) refuse them.
 *
 * The single answer is the same decider the check-in API uses: `organizerIdsWith(scope,
 * checkin.scan)` resolves the tenants where the actor may scan, and each event is then
 * admitted only by the SAME canonical gate predicate (`isEventCheckInOpen`) the POST
 * `/api/organizer/events/:id/check-in` route uses. A list row and a scan request cannot
 * disagree about what "the gate is open" means, and an event the actor may not scan in
 * never appears.
 */

const GATE_EVENT_SELECT = {
    id: true,
    organizerId: true,
    title: true,
    slug: true,
    eventCode: true,
    status: true,
    startAt: true,
    endAt: true,
    archivedAt: true,
    cancelledAt: true,
    requiresCheckIn: true,
    organizer: { select: { name: true } },
} as const satisfies Prisma.EventSelect;

export type GateEvent = Prisma.EventGetPayload<{
    select: typeof GATE_EVENT_SELECT;
}>;

/**
 * Events the actor may check in at whose gate is currently open.
 *
 * `now` is a required parameter in practice (it defaults like the predicate does) and is
 * taken ONCE so list rows and the scan request share the same instant. The query is
 * scoped to the actor's `checkin.scan` tenants and never to a client-supplied organizer.
 */
export async function listCheckInGateEvents(
    scope: AuthzScope,
    now: Date = new Date()
): Promise<{ items: GateEvent[]; total: number }> {
    const organizerIds = organizerIdsWith(scope, PERMISSIONS.CHECKIN_SCAN);

    if (organizerIds.length === 0) {
        return { items: [], total: 0 };
    }

    const events = await prisma.event.findMany({
        where: { organizerId: { in: organizerIds } },
        select: GATE_EVENT_SELECT,
        // Mirror the events list ordering: most recent first.
        orderBy: [{ startAt: "desc" }, { createdAt: "desc" }],
    });

    const items = events.filter((event) => isEventCheckInOpen(event, now));

    return { items, total: items.length };
}