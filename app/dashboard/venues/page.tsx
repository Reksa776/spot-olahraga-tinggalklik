import VenueManager from "@/components/organizer/VenueManager";
import { FilterBar } from "@/components/dashboard/filters/FilterBar";
import { PageHeader } from "@/components/dashboard/primitives";
import { getOrganizerPageContext } from "@/lib/organizer/context";
import { listVenues } from "@/lib/venues/service";

/**
 * Organizer venue management.
 *
 * Lists global venues (read-only for an organizer, because they are shared) alongside the
 * organizer's own private venues, which is exactly what `listVenues` scopes: global plus
 * the organizers the actor can read. Another tenant's private venue is never returned.
 *
 * ── THE SEARCH THE READ MODEL ALREADY HAD, NOW REACHABLE ────────────────────────
 * `listVenues` has always accepted `q` (a `name` match) and no control ever exposed it, so an
 * organizer with a long venue list could only scan it. The search box is that control: it adds a
 * parameter, not a predicate, and the service still applies its own scoping, so the searchable set is
 * exactly the venues the actor may already read.
 */

export const dynamic = "force-dynamic";

/** Browser tab title. The brand suffix is composed by the root layout's `title.template`. */
export const metadata = { title: "Venues" };

export default async function DashboardVenuesPage({
    searchParams,
}: {
    searchParams: Promise<{ q?: string }>;
}) {
    const params = await searchParams;
    const context = await getOrganizerPageContext();

    if (!context.currentOrganizerId) {
        return null;
    }

    const result = await listVenues(context.scope, {
        organizerId: context.currentOrganizerId,
        q: params.q ?? null,
    });

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Venue"
                description="Venue global dikelola oleh platform dan dapat dipakai semua organizer. Venue milik organizer hanya dapat diakses oleh anggota organizer ini."
            />

            <FilterBar
                basePath="/dashboard/venues"
                current={{ q: params.q }}
                fields={[]}
                search={{
                    label: "Cari venue",
                    placeholder: "Nama venue",
                    value: params.q,
                }}
            />

            <VenueManager
                organizerId={context.currentOrganizerId}
                filtered={Boolean(params.q)}
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
        </div>
    );
}
