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
 * Three authority classes, deliberately separated and never merged:
 *
 *   1. APPLICATION CONTROL (`application.settings`, `branding.manage`, `maintenance.manage`)
 *      — PHASE 32. The application's own configuration. ADMIN only; a MANAGER holds none of
 *      the three, so this section does not render for them and every destination below
 *      refuses them independently.
 *   2. Platform master data (`sport.manage`, `venue.manage.global`) — canonical data shared
 *      by every organizer.
 *   3. Organizer venue management (`venue.manage`) — private to one tenant. This one is
 *      OPERATIONAL, not system control, which is why a MANAGER legitimately keeps it: a
 *      fully operational role manages its own tenant's venues.
 *
 * The page lists only the sections the caller can actually open, and each destination
 * re-checks its own permission — so nobody reaches platform or application configuration even
 * by URL, and a MANAGER who opens this hub sees operational settings only.
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

    const hasSystemControl =
        capabilities.canManageApplicationSettings ||
        capabilities.canManageBranding ||
        capabilities.canManageMaintenance;

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Pengaturan"
                description="Pengaturan aplikasi (khusus ADMIN), data kanonik platform, dan konfigurasi organizer dipisahkan dan diatur oleh izin yang berbeda."
            />

            {/* ── SISTEM (PHASE 32 — ADMIN ONLY) ─────────────────────────────── */}
            {hasSystemControl ? (
                <SectionCard
                    title="Pengaturan aplikasi"
                    description="Kontrol pemilik sistem: ketersediaan dan identitas aplikasi"
                >
                    <div className="flex flex-col">
                        {capabilities.canManageUsers ? (
                            <DataRow
                                divider={false}
                                title={
                                    <TextLink href="/dashboard/users">Pengguna</TextLink>
                                }
                                meta="Kelola akun MANAGER dan PIC platform"
                                trailing="Kelola"
                            />
                        ) : null}

                        {capabilities.canManageApplicationSettings ? (
                            <DataRow
                                divider={capabilities.canManageUsers}
                                title={
                                    <TextLink href="/dashboard/settings/application">
                                        Aplikasi
                                    </TextLink>
                                }
                                meta="Status aplikasi: ketersediaan dan logo yang sedang aktif"
                                trailing="Lihat"
                            />
                        ) : null}

                        {capabilities.canManageBranding ? (
                            <DataRow
                                divider={capabilities.canManageApplicationSettings}
                                title={
                                    <TextLink href="/dashboard/settings/branding">
                                        Branding
                                    </TextLink>
                                }
                                meta="Logo aplikasi untuk landing page dan dashboard"
                                trailing="Kelola"
                            />
                        ) : null}

                        {capabilities.canManageMaintenance ? (
                            <DataRow
                                divider={
                                    capabilities.canManageApplicationSettings ||
                                    capabilities.canManageBranding
                                }
                                title={
                                    <TextLink href="/dashboard/settings/maintenance">
                                        Maintenance
                                    </TextLink>
                                }
                                meta="Tutup halaman publik dan alur pembelian"
                                trailing="Kelola"
                            />
                        ) : null}
                    </div>
                </SectionCard>
            ) : null}

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

            {!hasPlatformSettings &&
            !hasSystemControl &&
            !capabilities.canManageVenues ? (
                <EmptyBlock
                    title="Tidak ada pengaturan yang tersedia"
                    description="Peran kamu belum memiliki izin konfigurasi aplikasi, platform, maupun organizer."
                />
            ) : null}
        </div>
    );
}
