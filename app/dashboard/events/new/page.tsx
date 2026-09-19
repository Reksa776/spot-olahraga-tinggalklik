import EventForm from "@/components/organizer/EventForm";
import { PageHeader, SectionCard } from "@/components/dashboard/primitives";
import { requireOrganizerAccess } from "@/lib/authz";
import { getOrganizerPageContext } from "@/lib/organizer/context";
import { listPublicSports } from "@/lib/sports/service";
import { listVenues } from "@/lib/venues/service";

/**
 * Create-event page.
 *
 * The target organizer is `context.currentOrganizerId`, resolved from the actor's database
 * memberships — never from a URL or a form field. It is still passed through
 * `requireOrganizerAccess` here so the form renders only when the actor truly holds
 * `event.write`, and the API repeats the check on submit.
 */

export const dynamic = "force-dynamic";

export default async function DashboardNewEventPage() {
    const context = await getOrganizerPageContext();

    if (!context.currentOrganizerId) {
        return null;
    }

    // Fail closed before rendering: no form is shown to an actor without the capability.
    await requireOrganizerAccess(context.currentOrganizerId, "event.write");

    const [sports, venues] = await Promise.all([
        listPublicSports(),
        listVenues(context.scope, { organizerId: context.currentOrganizerId }),
    ]);

    return (
        <div className="mx-auto w-full max-w-[820px]">
            <PageHeader
                eyebrow="Dashboard"
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
        </div>
    );
}
