import { Stack } from "@mantine/core";

import VenueManager from "@/components/organizer/VenueManager";
import { PageHeader } from "@/components/dashboard/primitives";
import { getOrganizerPageContext } from "@/lib/organizer/context";
import { listVenues } from "@/lib/venues/service";

/**
 * Organizer venue management.
 *
 * Lists global venues (read-only for an organizer, because they are shared) alongside
 * the organizer's own private venues, which is exactly what `listVenues` scopes: global
 * plus the organizers the actor can read. Another tenant's private venue is never
 * returned.
 */

export const dynamic = "force-dynamic";

export default async function OrganizerVenuesPage() {
    const context = await getOrganizerPageContext();

    if (!context.currentOrganizerId) {
        return null;
    }

    const result = await listVenues(context.scope, {
        organizerId: context.currentOrganizerId,
    });

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Penyelenggara"
                title="Venue"
                description="Venue global dikelola oleh platform dan dapat dipakai semua organizer. Venue milik organizer hanya dapat diakses oleh anggota organizer ini."
            />

            <VenueManager
                organizerId={context.currentOrganizerId}
                venues={result.items.map((venue) => ({
                    id: venue.id,
                    name: venue.name,
                    city: venue.city,
                    address: venue.address,
                    capacity: venue.capacity,
                    isGlobal: venue.isGlobal,
                    eventCount: venue.eventCount,
                }))}
            />
        </Stack>
    );
}
