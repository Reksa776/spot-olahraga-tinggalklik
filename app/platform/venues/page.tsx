import { Stack, Text } from "@mantine/core";

import GlobalVenueManager from "@/components/platform/GlobalVenueManager";
import { AccessDeniedPanel, PageHeader } from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";
import { listGlobalVenues } from "@/lib/venues/service";

/**
 * Platform-global venue management (D-64).
 *
 * `listGlobalVenues` requires the platform-scope `venue.manage.global` permission and
 * filters to `organizerId: null`, so this page shows exactly the canonical/shared venues
 * and never another organizer's private ones. It is the platform half of D-64; the
 * organizer half lives at /organizer/venues.
 *
 * The permission failure is caught for the same reason as on the sports page: a signed-in actor
 * holding a different platform permission still reaches this page, and an authorization outcome
 * must not be presented as a 500. Only `AuthzError` is handled; everything else propagates.
 */

export const dynamic = "force-dynamic";

export default async function PlatformVenuesPage() {
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
                    <Text size="sm">
                        Peran platform kamu belum memiliki izin mengelola venue global.
                    </Text>
                }
                actionHref="/"
                actionLabel="Lihat situs"
            />
        );
    }

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Platform"
                title="Venue global"
                description="Venue kanonik yang bisa dipakai semua organizer. Venue milik satu organizer dikelola dari dashboard organizer masing-masing."
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
        </Stack>
    );
}
