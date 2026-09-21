import CheckInPanel from "@/components/organizer/CheckInPanel";
import EventActions from "@/components/organizer/EventActions";
import EventForm from "@/components/organizer/EventForm";
import EventImageManager from "@/components/organizer/EventImageManager";
import TicketTypeManager from "@/components/organizer/TicketTypeManager";
import {
    InfoNote,
    PrimaryAction,
    SectionCard,
    StatusBadge,
    TextLink,
} from "@/components/dashboard/primitives";
import { requireOrganizerAccess } from "@/lib/authz";
import { listEventImages, MAX_IMAGES_PER_EVENT } from "@/lib/events/images";
import { CHECK_IN_GRACE_MS } from "@/lib/events/lifecycle";
import { isEventCheckInOpen } from "@/lib/events/sales-state";
import { getOrganizerEvent } from "@/lib/events/service";
import { eventStatusTone } from "@/lib/events/status";
import { getOrganizerPageContext } from "@/lib/organizer/context";
import { listPublicSports } from "@/lib/sports/service";
import { listEventCheckIns } from "@/lib/ticketing/checkin/service";
import { listEventTicketTypes } from "@/lib/ticket-types/service";
import { listVenues } from "@/lib/venues/service";

/**
 * Manage one event: details, ticket types, quota, images and publication state.
 *
 * `getOrganizerEvent` resolves the event's tenant and authorizes `event.read`, so an id
 * belonging to another organizer raises `ORGANIZER_ACCESS_DENIED` (404) and this page
 * renders Next's not-found boundary instead of leaking anything. The URL's `:id` is a
 * resource identifier only; nothing about the tenant is taken from it.
 */

export const dynamic = "force-dynamic";

export default async function DashboardManageEventPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    const context = await getOrganizerPageContext();

    const event = await getOrganizerEvent(context.scope, id);

    // Fail closed before rendering the edit form: read access to the event does not
    // imply write access (a FINANCE member can read events but not edit them).
    const canWrite = await requireOrganizerAccess(event.organizerId, "event.write")
        .then(() => true)
        .catch(() => false);

    // The gate is a separate capability from editing: a gate staff member holds
    // `checkin.scan` without `event.write`, and a FINANCE member holds neither. Both
    // decisions are made from the database-resolved membership, so the panel below cannot
    // be reached by a role that the API would refuse.
    const canCheckIn = await requireOrganizerAccess(
        event.organizerId,
        "checkin.scan"
    )
        .then(() => true)
        .catch(() => false);

    const canReadCheckInLog = await requireOrganizerAccess(
        event.organizerId,
        "checkin.log.read"
    )
        .then(() => true)
        .catch(() => false);

    // ── PHASE 15 — the check-in WINDOW is decided here, once, from the same predicate the
    // API uses (P14-D06). `now` is taken ONCE so the three derived facts below cannot
    // disagree with each other, and it is the SERVER clock — the browser's is never part of
    // a security or lifecycle decision.
    const now = new Date();
    const checkInOpen = isEventCheckInOpen(event, now);
    const checkInEndsAt = event.endAt
        ? new Date(event.endAt.getTime() + CHECK_IN_GRACE_MS)
        : null;

    // Inside the grace window means: the gate is open, a fixed end exists, and the end has
    // already passed. Derived from the canonical predicate + the canonical constant — this
    // is a DISPLAY state, not a second gate predicate.
    const inGraceWindow =
        checkInOpen &&
        event.endAt !== null &&
        now.getTime() > event.endAt.getTime();

    const gateState: "OPEN" | "GRACE" | "CLOSED" = !checkInOpen
        ? "CLOSED"
        : inGraceWindow
          ? "GRACE"
          : "OPEN";

    // ── PHASE 20B (D-P19-03 = A) — THE COPY BELOW DESCRIBES THE PREDICATE, NOT A
    // START-TIME GATE. `isEventCheckInOpen` has no `startAt` term, so admission is possible
    // from the moment an event is PUBLISHED until `endAt + 30m` (or indefinitely when there
    // is no `endAt`). The previous copy claimed the gate opened only for an event in
    // progress, which the code never implemented; the owner's Option A keeps the BEHAVIOUR
    // and corrects the WORDS, so the page does not promise a rule the server does not
    // enforce. No display logic changes here: `gateState` still comes from the one canonical
    // predicate and the one canonical grace constant.

    const [sports, venues, images, ticketTypes, checkIns] = await Promise.all([
        listPublicSports(),
        listVenues(context.scope, { organizerId: event.organizerId }),
        listEventImages(context.scope, event.id),
        listEventTicketTypes(context.scope, event.id),
        canCheckIn && canReadCheckInLog
            ? listEventCheckIns(event.id, 20)
            : Promise.resolve(null),
    ]);

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                <TextLink href="/dashboard/events">← Semua event</TextLink>

                <h1 className="mt-1 text-2xl font-bold leading-tight tracking-tight">
                    {event.title}
                </h1>

                <p className="text-sm text-muted-foreground">
                    {event.eventCode} ·{" "}
                    <span className="font-mono">/e/{event.slug}</span>
                </p>

                {/*
                    Both live states link to the public page: an ONGOING event is listed and on
                    sale exactly like a PUBLISHED one (the tick moves it to ONGOING at `startAt`),
                    so omitting it here left a running event with no way to view what buyers see.
                    A CANCELLED, ARCHIVED or DRAFT event is not listed, and a COMPLETED one has
                    dropped out of the catalog, so none of them offer the link.
                */}
                {event.status === "PUBLISHED" || event.status === "ONGOING" ? (
                    <div>
                        <PrimaryAction href={`/e/${event.slug}`}>
                            Lihat halaman publik
                        </PrimaryAction>
                    </div>
                ) : null}
            </div>

            <SectionCard title="Status & publikasi">
                <div className="flex flex-col gap-3">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span>Status saat ini:</span>
                        <StatusBadge tone={eventStatusTone(event.status)}>
                            {event.status}
                        </StatusBadge>
                        {event.publishedAt
                            ? ` · pertama dipublikasikan ${new Date(
                                  event.publishedAt
                              ).toLocaleString("id-ID")}`
                            : ""}
                    </p>

                    <EventActions
                        eventId={event.id}
                        status={event.status}
                        endAt={event.endAt ? event.endAt.toISOString() : null}
                    />
                </div>
            </SectionCard>

            <SectionCard title="Ringkasan penjualan">
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <div className="flex flex-col gap-0.5">
                        <span className="text-sm text-muted-foreground">
                            Status penjualan
                        </span>
                        <span className="font-semibold">{event.sales.salesState}</span>
                    </div>

                    <div className="flex flex-col gap-0.5">
                        <span className="text-sm text-muted-foreground">
                            Jenis tiket aktif
                        </span>
                        <span className="font-semibold">
                            {event.sales.activeTicketTypeCount}
                        </span>
                    </div>

                    <div className="flex flex-col gap-0.5">
                        <span className="text-sm text-muted-foreground">
                            Harga terendah
                        </span>
                        <span className="font-semibold tabular-nums">
                            {event.sales.priceFrom === null
                                ? "—"
                                : event.sales.priceFrom.toLocaleString("id-ID")}
                        </span>
                    </div>

                    <div className="flex flex-col gap-0.5">
                        <span className="text-sm text-muted-foreground">Tiket habis</span>
                        <span className="font-semibold">
                            {event.sales.isSoldOut ? "Ya" : "Tidak"}
                        </span>
                    </div>
                </div>
            </SectionCard>

            {canCheckIn ? (
                <SectionCard title="Check-in & kehadiran">
                    {checkInOpen ? (
                        <CheckInPanel
                            eventId={event.id}
                            canReadLog={canReadCheckInLog}
                            initialItems={checkIns?.items ?? []}
                            initialTotal={checkIns?.total ?? 0}
                            gateState={gateState}
                            requiresCheckIn={event.requiresCheckIn}
                        />
                    ) : (
                        <InfoNote tone="warn">
                            Event ini tidak menerima check-in pada statusnya saat ini
                            {event.status === "CANCELLED"
                                ? " karena sudah dibatalkan"
                                : event.archivedAt !== null
                                  ? " karena sudah diarsipkan"
                                  : event.status === "COMPLETED"
                                    ? " karena sudah selesai dan masa tenggang check-in telah berakhir"
                                    : ""}
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
            ) : null}

            <SectionCard title="Jenis tiket & kuota">
                {canWrite ? (                        <TicketTypeManager
                            eventId={event.id}
                            eventStartAt={event.startAt.toISOString()}
                            // PHASE 20B (D-P19-05 = A): the readiness preview needs the
                            // end time, because publishing without one is refused.
                            eventEndAt={event.endAt ? event.endAt.toISOString() : null}
                            serverNow={new Date().toISOString()}
                        ticketTypes={ticketTypes.items.map((type) => ({
                            id: type.id,
                            name: type.name,
                            description: type.description,
                            price: type.price,
                            currency: type.currency,
                            minPerOrder: type.minPerOrder,
                            maxPerOrder: type.maxPerOrder,
                            salesStartAt: type.salesStartAt,
                            salesEndAt: type.salesEndAt,
                            isActive: type.isActive,
                            sortOrder: type.sortOrder,
                            salesState: type.salesState,
                            isSoldOut: type.isSoldOut,
                            inventory: type.inventory,
                        }))}
                    />
                ) : (
                    <p className="text-sm text-muted-foreground">
                        Kamu tidak memiliki akses untuk mengubah jenis tiket.
                    </p>
                )}
            </SectionCard>

            <SectionCard title="Gambar event">
                <EventImageManager
                    eventId={event.id}
                    images={images.items.map((image) => ({
                        id: image.id,
                        url: image.url,
                        altText: image.altText,
                        sortOrder: image.sortOrder,
                    }))}
                    maxImages={MAX_IMAGES_PER_EVENT}
                />
            </SectionCard>

            <SectionCard title="Detail event">
                {canWrite ? (
                    <EventForm
                        mode="edit"
                        eventId={event.id}
                        organizerId={event.organizerId}
                        sports={sports.items.map((sport) => ({
                            id: sport.id,
                            name: sport.name,
                        }))}
                        venues={venues.items.map((venue) => ({
                            id: venue.id,
                            name: venue.name,
                            isGlobal: venue.isGlobal,
                        }))}
                        initial={{
                            title: event.title,
                            sportId: event.sportId,
                            venueId: event.venueId ?? "",
                            description: event.description ?? "",
                            rules: event.rules ?? "",
                            bannerUrl: event.bannerUrl ?? "",
                            startAt: event.startAt.toISOString(),
                            endAt: event.endAt?.toISOString(),
                            salesStartAt: event.salesStartAt?.toISOString(),
                            salesEndAt: event.salesEndAt?.toISOString(),
                            maxTicketsPerOrder:
                                event.maxTicketsPerOrder === null
                                    ? undefined
                                    : String(event.maxTicketsPerOrder),
                            contactName: event.contactName ?? "",
                            contactPhone: event.contactPhone ?? "",
                            visibility: event.visibility as "PUBLIC" | "UNLISTED",
                            requiresCheckIn: event.requiresCheckIn,
                        }}
                    />
                ) : (
                    <p className="text-sm text-muted-foreground">
                        Kamu hanya memiliki akses baca untuk event ini.
                    </p>
                )}
            </SectionCard>
        </div>
    );
}
