import { SimpleGrid, Stack, Text, Title } from "@mantine/core";

import EventActions from "@/components/organizer/EventActions";
import EventForm from "@/components/organizer/EventForm";
import EventImageManager from "@/components/organizer/EventImageManager";
import TicketTypeManager from "@/components/organizer/TicketTypeManager";
import {
    PrimaryAction,
    SectionCard,
    StatusBadge,
    TextLink,
} from "@/components/dashboard/primitives";
import { requireOrganizerAccess } from "@/lib/authz";
import { listEventImages, MAX_IMAGES_PER_EVENT } from "@/lib/events/images";
import { getOrganizerEvent } from "@/lib/events/service";
import { getOrganizerPageContext } from "@/lib/organizer/context";
import { listPublicSports } from "@/lib/sports/service";
import { listEventTicketTypes } from "@/lib/ticket-types/service";
import { listVenues } from "@/lib/venues/service";

/**
 * Manage one event: details, images, publication state.
 *
 * `getOrganizerEvent` resolves the event's tenant and authorizes `event.read`, so an id
 * belonging to another organizer raises `ORGANIZER_ACCESS_DENIED` (404) and this page
 * renders Next's not-found boundary instead of leaking anything.
 *
 * The URL's `:id` is treated purely as a resource identifier. Nothing about the tenant
 * is taken from it.
 *
 * PHASE (Mantine body migration): presentation only. Every service call, the `canWrite` probe and
 * every prop passed to `EventActions` / `TicketTypeManager` / `EventImageManager` / `EventForm` are
 * unchanged — including the `Date` → ISO conversions and the `canWrite` fallbacks. Links to other
 * surfaces go through the client `TextLink`/`PrimaryAction` primitives rather than
 * `component={Link}`, because this is a Server Component (see the RSC rule in
 * `__tests__/ui-consolidation/mantine-dashboard.test.ts` P-M7).
 */

export const dynamic = "force-dynamic";

export default async function ManageEventPage({
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

    // Ticket types are loaded here rather than from the API so the page renders the
    // tier list, its inventory, and the publish-readiness preview in one pass. The
    // service authorizes through the event, so a foreign id fails closed.
    const [sports, venues, images, ticketTypes] = await Promise.all([
        listPublicSports(),
        listVenues(context.scope, { organizerId: event.organizerId }),
        listEventImages(context.scope, event.id),
        listEventTicketTypes(context.scope, event.id),
    ]);

    return (
        <Stack gap="lg">
            <Stack gap="xs">
                <TextLink href="/organizer/events">← Semua event</TextLink>

                <Title order={1} mt={4}>
                    {event.title}
                </Title>

                <Text size="sm" c="dimmed">
                    {event.eventCode} · <Text span ff="monospace">/e/{event.slug}</Text>
                </Text>

                {event.status === "PUBLISHED" ? (
                    <PrimaryAction href={`/e/${event.slug}`}>Lihat halaman publik</PrimaryAction>
                ) : null}
            </Stack>

            <SectionCard title="Status & publikasi">
                <Stack gap="sm">
                    <Text size="sm" c="dimmed">
                        Status saat ini:{" "}
                        <StatusBadge
                            tone={
                                event.status === "PUBLISHED"
                                    ? "success"
                                    : event.status === "CANCELLED"
                                      ? "error"
                                      : "neutral"
                            }
                        >
                            {event.status}
                        </StatusBadge>
                        {event.publishedAt
                            ? ` · pertama dipublikasikan ${new Date(
                                  event.publishedAt
                              ).toLocaleString("id-ID")}`
                            : ""}
                    </Text>

                    <EventActions eventId={event.id} status={event.status} />
                </Stack>
            </SectionCard>

            <SectionCard title="Ringkasan penjualan">
                <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
                    <Stack gap={2}>
                        <Text size="sm" c="dimmed">
                            Status penjualan
                        </Text>
                        <Text fw={600}>{event.sales.salesState}</Text>
                    </Stack>

                    <Stack gap={2}>
                        <Text size="sm" c="dimmed">
                            Jenis tiket aktif
                        </Text>
                        <Text fw={600}>{event.sales.activeTicketTypeCount}</Text>
                    </Stack>

                    <Stack gap={2}>
                        <Text size="sm" c="dimmed">
                            Harga terendah
                        </Text>
                        <Text fw={600}>
                            {event.sales.priceFrom === null
                                ? "—"
                                : event.sales.priceFrom.toLocaleString("id-ID")}
                        </Text>
                    </Stack>

                    <Stack gap={2}>
                        <Text size="sm" c="dimmed">
                            Tiket habis
                        </Text>
                        <Text fw={600}>{event.sales.isSoldOut ? "Ya" : "Tidak"}</Text>
                    </Stack>
                </SimpleGrid>
            </SectionCard>

            <SectionCard title="Jenis tiket & kuota">
                {canWrite ? (
                    <TicketTypeManager
                        eventId={event.id}
                        eventStartAt={event.startAt.toISOString()}
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
                    <Text size="sm" c="dimmed">
                        Kamu tidak memiliki akses untuk mengubah jenis tiket.
                    </Text>
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
                            startAt: event.startAt.toISOString(),
                            endAt: event.endAt?.toISOString() ?? "",
                            contactName: event.contactName ?? "",
                            contactPhone: event.contactPhone ?? "",
                            visibility: event.visibility as "PUBLIC" | "UNLISTED",
                            requiresCheckIn: event.requiresCheckIn,
                        }}
                    />
                ) : (
                    <Text size="sm" c="dimmed">
                        Kamu hanya memiliki akses baca untuk event ini.
                    </Text>
                )}
            </SectionCard>
        </Stack>
    );
}
