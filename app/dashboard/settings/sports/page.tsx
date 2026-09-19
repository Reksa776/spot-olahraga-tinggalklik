import SportManager from "@/components/platform/SportManager";
import { AccessDeniedPanel, PageHeader } from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";
import { listSportsForAdmin } from "@/lib/sports/service";

/**
 * Platform sport master data.
 *
 * `listSportsForAdmin` re-checks the platform `sport.manage` permission itself, so this page
 * cannot render data the caller is not entitled to even if the layout guard is bypassed. The
 * seeded sports are listed, never re-created — management here is edit/deactivate/delete
 * only (plus deliberate additions).
 *
 * The permission failure is caught because a signed-in actor holding ONE platform permission
 * still renders the shell; an authorization outcome must not be presented as a 500. Only
 * `AuthzError` is handled; everything else propagates.
 */

export const dynamic = "force-dynamic";

export default async function DashboardSportsSettingsPage() {
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
                    <p className="text-sm leading-relaxed">
                        Peran platform kamu belum memiliki izin mengelola cabang olahraga.
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
        </div>
    );
}
