import GlobalVenueManager from "@/components/platform/GlobalVenueManager";
import { AccessDeniedPanel, PageHeader } from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";
import { listGlobalVenues } from "@/lib/venues/service";

/**
 * Platform-global venue management (D-64).
 *
 * `listGlobalVenues` requires the platform-scope `venue.manage.global` permission and filters
 * to `organizerId: null`, so this page shows exactly the canonical/shared venues and never
 * another organizer's private ones. It is the platform half of D-64; the organizer half is
 * `/dashboard/venues`.
 */

export const dynamic = "force-dynamic";

export default async function DashboardGlobalVenuesSettingsPage() {
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    let result;

    try {
        result = await listGlobalVenues(scope);
    } catch (error) {
        if (!isAuthzError(error)) {
            throw error;
        }

        return (
            <AccessDeniedPanel
                title="Akses ditolak"
                body={
                    <p className="text-sm leading-relaxed">
                        Peran platform kamu belum memiliki izin mengelola venue global.
                    </p>
                }
                actionHref="/dashboard/settings"
                actionLabel="Kembali ke pengaturan"
            />
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard · Pengaturan platform"
                title="Venue global"
                description="Venue kanonik yang bisa dipakai semua organizer. Venue milik satu organizer dikelola dari pengaturan organizer masing-masing."
            />

            <GlobalVenueManager
                venues={result.items.map((venue) => ({
                    id: venue.id,
                    name: venue.name,
                    city: venue.city,
                    address: venue.address,
                    capacity: venue.capacity,
                    eventCount: venue.eventCount,
                }))}
            />
        </div>
    );
}
