import { Box } from "@mantine/core";

import EventForm from "@/components/organizer/EventForm";
import { PageHeader, SectionCard } from "@/components/dashboard/primitives";
import { requireOrganizerAccess } from "@/lib/authz";
import { getOrganizerPageContext } from "@/lib/organizer/context";
import { listPublicSports } from "@/lib/sports/service";
import { listVenues } from "@/lib/venues/service";

/**
 * Create-event page.
 *
 * The target organizer is `context.currentOrganizerId`, which comes from the actor's
 * database-resolved memberships — not from a URL or a form field. It is still passed
 * through `requireOrganizerAccess` here so the page renders only when the actor truly
 * holds `event.write`, and the API repeats the check on submit.
 *
 * Presentation is Mantine, and the form itself is unchanged: same props, same fields, same
 * validation, same submit contract.
 */

export const dynamic = "force-dynamic";

export default async function NewEventPage() {
    const context = await getOrganizerPageContext();

    if (!context.currentOrganizerId) {
        return null;
    }

    // Fail closed before rendering: no form is shown to an actor without the capability.
    await requireOrganizerAccess(
        context.currentOrganizerId,
        "event.write"
    );

    const [sports, venues] = await Promise.all([
        listPublicSports(),
        listVenues(context.scope, { organizerId: context.currentOrganizerId }),
    ]);

    return (
        <Box maw={820} mx="auto">
            <PageHeader
                eyebrow="Penyelenggara"
                title="Event baru"
                description="Event disimpan sebagai draft. Publikasi dilakukan dari halaman kelola event setelah jenis tiket tersedia."
            />

            <SectionCard>
                <EventForm
                    mode="create"
                    organizerId={context.currentOrganizerId}
                    sports={sports.items.map((sport) => ({
                        id: sport.id,
                        name: sport.name,
                    }))}
                    venues={venues.items.map((venue) => ({
                        id: venue.id,
                        name: venue.name,
                        isGlobal: venue.isGlobal,
                    }))}
                />
            </SectionCard>
        </Box>
    );
}
