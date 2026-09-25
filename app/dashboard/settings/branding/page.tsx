import { BrandingLogoManager } from "@/components/dashboard/BrandingLogoManager";
import { AccessDeniedPanel, PageHeader } from "@/components/dashboard/primitives";
import { getApplicationBranding } from "@/lib/app-settings";
import { PERMISSIONS, requirePlatformPermission } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";

/**
 * ==========================================
 * PHASE 32 — SETTINGS → BRANDING
 * ==========================================
 *
 * ADMIN ONLY, guarded by `branding.manage`. The page reads the SAME accessor the public
 * chrome reads (`getApplicationBranding`), so the preview here is the asset the landing page,
 * the dashboard lockup and the maintenance page are already rendering — one source of truth
 * rather than a dashboard-local copy.
 *
 * There is no second logo setting anywhere: the dashboard and the landing page both receive
 * `PlatformSetting.logoUrl` through `components/Brand.tsx`.
 */

export const dynamic = "force-dynamic";

export default async function DashboardBrandingSettingsPage() {
    let branding;

    try {
        await requirePlatformPermission(PERMISSIONS.BRANDING_MANAGE);
        branding = await getApplicationBranding();
    } catch (error) {
        if (!isAuthzError(error)) {
            throw error;
        }

        return (
            <AccessDeniedPanel
                title="Akses ditolak"
                body={
                    <p className="text-sm leading-relaxed">
                        Hanya ADMIN platform yang dapat mengubah branding aplikasi.
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
                title="Branding"
                description="Logo aplikasi yang dipakai landing page publik dan header dashboard. Simpan sebagai aset persisten, bukan tautan sementara."
            />

            <BrandingLogoManager initialLogoUrl={branding.logoUrl} />
        </div>
    );
}
