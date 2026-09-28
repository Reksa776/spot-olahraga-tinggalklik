import GlobalVenueManager from "@/components/platform/GlobalVenueManager";
import { FilterBar } from "@/components/dashboard/filters/FilterBar";
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
 *
 * ── THE SEARCH THE READ MODEL ALREADY HAD ──────────────────────────────────────
 * `listGlobalVenues` accepts `q` (a `name` match) and returned the full canonical list to a page
 * with no control for it. The search box exposes that parameter unchanged; the permission check
 * above the query is untouched, so nothing about who may read is affected.
 */

export const dynamic = "force-dynamic";

/** Browser tab title. The brand suffix is composed by the root layout's `title.template`. */
export const metadata = { title: "Venues" };

export default async function DashboardGlobalVenuesSettingsPage({
    searchParams,
}: {
    searchParams: Promise<{ q?: string }>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    let result;

    try {
        result = await listGlobalVenues(scope, { q: params.q ?? null });
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

            <FilterBar
                basePath="/dashboard/settings/venues"
                current={{ q: params.q }}
                fields={[]}
                search={{
                    label: "Cari venue",
                    placeholder: "Nama venue",
                    value: params.q,
                }}
            />

            <GlobalVenueManager
                filtered={Boolean(params.q)}
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
