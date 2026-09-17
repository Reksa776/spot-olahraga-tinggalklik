import { Stack, Text } from "@mantine/core";

import SportManager from "@/components/platform/SportManager";
import { AccessDeniedPanel, PageHeader } from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";
import { listSportsForAdmin } from "@/lib/sports/service";

/**
 * Platform sport master data.
 *
 * `listSportsForAdmin` re-checks the platform `sport.manage` permission itself, so this
 * page cannot render data the caller is not entitled to even if the layout guard above
 * is somehow bypassed. The 14 seeded sports are listed, never re-created — management
 * here is edit/deactivate/delete only (plus deliberate additions).
 *
 * WHY THE PERMISSION FAILURE IS CAUGHT
 * ------------------------------------
 * A signed-in actor who holds ONE platform permission still renders the shell (the layout only
 * denies when they hold none), so this page runs and the service-level check rejects it. The throw
 * was propagating out of a page render, which the App Router surfaces as a 500 — an authorization
 * outcome presented as a server crash. The catch below turns exactly that outcome into the same
 * panel the layout would have shown, and NOTHING else is caught or swallowed: the permission
 * decision still lives in `listSportsForAdmin`, and any non-authorization error still propagates
 * untouched.
 */

export const dynamic = "force-dynamic";

export default async function PlatformSportsPage() {
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    let result;

    try {
        result = await listSportsForAdmin(scope);
    } catch (error) {
        if (!isAuthzError(error)) {
            throw error;
        }

        return (
            <AccessDeniedPanel
                title="Akses ditolak"
                body={
                    <Text size="sm">
                        Peran platform kamu belum memiliki izin mengelola cabang olahraga.
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
                title="Cabang olahraga"
                description="Taksonomi global yang dipakai semua event. Data awal berasal dari seed, jadi tidak perlu dibuat ulang. Nonaktifkan cabang olahraga yang sudah tidak dipakai agar tidak muncul di filter katalog."
            />

            <SportManager
                sports={result.items.map((sport) => ({
                    id: sport.id,
                    name: sport.name,
                    slug: sport.slug,
                    isActive: sport.isActive,
                    sortOrder: sport.sortOrder,
                    eventCount: sport.eventCount,
                }))}
            />
        </Stack>
    );
}
