import {
    DataRow,
    EmptyBlock,
    PageHeader,
    SectionCard,
    TextLink,
} from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { computeDashboardCapabilities } from "@/lib/dashboard/scope";

/**
 * Settings hub.
 *
 * Two authority classes, deliberately separated and never merged: platform master data
 * (`sport.manage`, `venue.manage.global`) is canonical data shared by every organizer, and
 * organizer venue management (`venue.manage`) is private to one tenant. The page lists only
 * the sections the caller can actually open, and each destination re-checks its own
 * permission — so an organizer never reaches platform configuration even by URL.
 */

export const dynamic = "force-dynamic";

export default async function DashboardSettingsPage() {
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    const capabilities = computeDashboardCapabilities(scope);

    const hasPlatformSettings =
        capabilities.canManageSports || capabilities.canManageGlobalVenues;

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Pengaturan"
                description="Konfigurasi platform (data kanonik) dan konfigurasi organizer (data milik satu penyelenggara) dipisahkan dan diatur oleh izin yang berbeda."
            />

            {hasPlatformSettings ? (
                <SectionCard
                    title="Pengaturan platform"
                    description="Data kanonik yang dipakai seluruh penyelenggara"
                >
                    <div className="flex flex-col">
                        {capabilities.canManageSports ? (
                            <DataRow
                                divider={false}
                                title={
                                    <TextLink href="/dashboard/settings/sports">
                                        Cabang olahraga
                                    </TextLink>
                                }
                                meta="Taksonomi global yang dipakai semua event"
                                trailing="Kelola"
                            />
                        ) : null}

                        {capabilities.canManageGlobalVenues ? (
                            <DataRow
                                divider={capabilities.canManageSports}
                                title={
                                    <TextLink href="/dashboard/settings/venues">
                                        Venue global
                                    </TextLink>
                                }
                                meta="Venue kanonik yang bisa dipakai semua organizer"
                                trailing="Kelola"
                            />
                        ) : null}
                    </div>
                </SectionCard>
            ) : null}

            {capabilities.canManageVenues ? (
                <SectionCard
                    title="Pengaturan organizer"
                    description="Data milik penyelenggara ini saja"
                >
                    <DataRow
                        divider={false}
                        title={
                            <TextLink href="/dashboard/venues">
                                Venue organizer
                            </TextLink>
                        }
                        meta="Venue privat milik organizer ini, tidak terlihat tenant lain"
                        trailing="Kelola"
                    />
                </SectionCard>
            ) : null}

            {!hasPlatformSettings && !capabilities.canManageVenues ? (
                <EmptyBlock
                    title="Tidak ada pengaturan yang tersedia"
                    description="Peran kamu belum memiliki izin konfigurasi platform maupun organizer."
                />
            ) : null}
        </div>
    );
}
