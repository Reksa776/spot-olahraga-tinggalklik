import {
    AccessDeniedPanel,
    DataRow,
    PageHeader,
    SectionCard,
    TextLink,
} from "@/components/dashboard/primitives";
import { getApplicationSettingsForAdmin } from "@/lib/application/service";
import { getAuthzScope } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";

/**
 * ==========================================
 * PHASE 32 — SETTINGS → APPLICATION
 * ==========================================
 *
 * ADMIN ONLY. The overview of the application's own configuration — what it is called, whether
 * it is currently available, and whether it carries a custom logo — with the two editable
 * surfaces one click away.
 *
 * ── WHY THIS PAGE IS READ-ONLY ─────────────────────────────────────────────────
 * Every value shown here has exactly ONE editing surface (Branding owns the logo, Maintenance
 * owns availability), and duplicated controls are how two screens start disagreeing about the
 * same setting. So this page reports state and links to the owner of each value rather than
 * offering a second way to change it.
 *
 * The values are read through the SAME accessor the public chrome uses, so what an ADMIN sees
 * here is what a visitor is being served — not a dashboard-only rendering of the settings.
 */

export const dynamic = "force-dynamic";

export default async function DashboardApplicationSettingsPage() {
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    let settings;

    try {
        settings = await getApplicationSettingsForAdmin();
    } catch (error) {
        if (!isAuthzError(error)) {
            throw error;
        }

        return (
            <AccessDeniedPanel
                title="Akses ditolak"
                body={
                    <p className="text-sm leading-relaxed">
                        Hanya ADMIN platform yang dapat melihat pengaturan aplikasi.
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
                eyebrow="Dashboard · Sistem"
                title="Aplikasi"
                description="Identitas dan ketersediaan aplikasi. Nilai di bawah read-only; perubahan dilakukan dari halaman pemiliknya masing-masing agar tidak ada dua sumber kebenaran."
            />

            <SectionCard
                title="Status aplikasi"
                description="Kondisi yang sedang dilayani ke publik"
            >
                <div className="flex flex-col">
                    <DataRow
                        divider={false}
                        title="Nama aplikasi"
                        meta="Dipakai sebagai nama platform"
                        trailing={settings.platformName}
                    />

                    <DataRow
                        title="Maintenance"
                        meta="Menutup halaman publik dan alur pembelian"
                        trailing={
                            <TextLink href="/dashboard/settings/maintenance">
                                {settings.maintenance.enabled ? "ON" : "OFF"}
                            </TextLink>
                        }
                    />

                    <DataRow
                        title="Pesan maintenance"
                        meta={
                            settings.maintenance.enabled
                                ? "Ditampilkan di halaman maintenance"
                                : "Dipakai saat maintenance diaktifkan"
                        }
                        trailing={
                            <span className="max-w-[22rem] truncate">
                                {settings.maintenance.message}
                            </span>
                        }
                    />

                    <DataRow
                        title="Logo aplikasi"
                        meta="Dipakai landing page publik dan header dashboard"
                        trailing={
                            <TextLink href="/dashboard/settings/branding">
                                {settings.logoUrl ? "Terpasang" : "Brand bawaan"}
                            </TextLink>
                        }
                    />
                </div>
            </SectionCard>
        </div>
    );
}
