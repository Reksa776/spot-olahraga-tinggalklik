import TicketScanner from "@/components/organizer/TicketScanner";
import {
    InfoNote,
    SectionCard,
    StatusBadge,
    TextLink,
} from "@/components/dashboard/primitives";
import { requireOrganizerAccess } from "@/lib/authz";
import { CHECK_IN_GRACE_MS } from "@/lib/events/lifecycle";
import { isEventCheckInOpen } from "@/lib/events/sales-state";
import { eventStatusTone } from "@/lib/events/status";
import { getOrganizerPageContext } from "@/lib/organizer/context";
import { prisma } from "@/lib/prisma";
import {
    listEventCheckIns,
    requireEventCheckInAccess,
} from "@/lib/ticketing/checkin/service";

/**
 * Event-scoped gate scanner — one event, the check-in API's own scope.
 *
 * The page authorizes with `requireEventCheckInAccess`, the SAME database-decided gate
 * the `POST /api/organizer/events/:id/check-in` route uses: the actor must hold
 * `checkin.scan` inside the event's own organizer (a foreign tenant's id yields the
 * never-confirming 404) and, for a `CHECKIN_STAFF` member without `checkin.override`,
 * have an active `StaffEventAssignment` for this event. Nothing about the tenant or the
 * authority is read from the URL beyond the resource id.
 *
 * The window (`gateState`) comes from the same canonical `isEventCheckInOpen` predicate
 * on the server clock, exactly as the manage-event page derives it — a staff member
 * never reaches a scanner the API would refuse.
 */

export const dynamic = "force-dynamic";

export default async function DashboardEventCheckInScannerPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;

    await getOrganizerPageContext();

    const { event } = await requireEventCheckInAccess(id);

    // Display + gate fields only — authorization already happened above.
    const eventRow = await prisma.event.findUniqueOrThrow({
        where: { id: event.id },
        select: {
            id: true,
            title: true,
            eventCode: true,
            slug: true,
            status: true,
            startAt: true,
            endAt: true,
            archivedAt: true,
            cancelledAt: true,
            requiresCheckIn: true,
        },
    });

    const now = new Date();
    const checkInOpen = isEventCheckInOpen(eventRow, now);
    const checkInEndsAt = eventRow.endAt
        ? new Date(eventRow.endAt.getTime() + CHECK_IN_GRACE_MS)
        : null;

    const inGraceWindow =
        checkInOpen &&
        eventRow.endAt !== null &&
        now.getTime() > eventRow.endAt.getTime();

    const gateState: "OPEN" | "GRACE" | "CLOSED" = !checkInOpen
        ? "CLOSED"
        : inGraceWindow
          ? "GRACE"
          : "OPEN";

    const canReadLog = await requireOrganizerAccess(
        event.organizerId,
        "checkin.log.read"
    )
        .then(() => true)
        .catch(() => false);

    const checkIns = canReadLog ? await listEventCheckIns(event.id, 20) : null;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                <TextLink href="/dashboard/check-in">← Semua event yang menerima check-in</TextLink>

                <h1 className="mt-1 text-2xl font-bold leading-tight tracking-tight">
                    {eventRow.title}
                </h1>

                <p className="text-sm text-muted-foreground">
                    {eventRow.eventCode} ·{" "}
                    <span className="font-mono">/e/{eventRow.slug}</span>
                </p>

                <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>Status:</span>
                    <StatusBadge tone={eventStatusTone(eventRow.status)}>
                        {eventRow.status}
                    </StatusBadge>
                </p>
            </div>

            <SectionCard title="Pindai tiket">
                {checkInOpen ? (
                    <TicketScanner
                        eventId={eventRow.id}
                        canReadLog={canReadLog}
                        initialItems={checkIns?.items ?? []}
                        initialTotal={checkIns?.total ?? 0}
                        gateState={gateState}
                        requiresCheckIn={eventRow.requiresCheckIn}
                    />
                ) : (
                    <InfoNote tone="warn">
                        Event ini tidak menerima check-in pada statusnya saat ini
                        {eventRow.status === "CANCELLED"
                            ? " karena sudah dibatalkan"
                            : eventRow.archivedAt !== null
                              ? " karena sudah diarsipkan"
                              : eventRow.status === "COMPLETED"
                                ? " karena sudah selesai dan masa tenggang check-in telah berakhir"
                                : " karena belum dipublikasikan"}
                        . Pintu masuk dibuka sejak event dipublikasikan
                        {checkInEndsAt
                            ? ` (hingga 30 menit setelah waktu selesai: ${checkInEndsAt.toLocaleString(
                                  "id-ID"
                              )})`
                            : ""}
                        .
                    </InfoNote>
                )}
            </SectionCard>
        </div>
    );
}