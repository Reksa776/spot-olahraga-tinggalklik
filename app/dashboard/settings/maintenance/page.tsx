import { MaintenanceSettingsForm } from "@/components/dashboard/MaintenanceSettingsForm";
import { AccessDeniedPanel, PageHeader } from "@/components/dashboard/primitives";
import { getApplicationSettingsForAdmin } from "@/lib/application/service";
import { getAuthzScope } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";

/**
 * ==========================================
 * PHASE 32 — SETTINGS → APPLICATION → MAINTENANCE MODE
 * ==========================================
 *
 * ADMIN ONLY. The page renders the switch and the current state; the state and the write are
 * both guarded server-side:
 *
 *   * `getApplicationSettingsForAdmin()` requires `application.settings`, so a MANAGER who
 *     types the URL is answered with a denial panel rather than the form — the brief's
 *     "direct URL must fail", enforced by re-deciding here rather than by trusting that no
 *     link was rendered;
 *   * the form's `PATCH` requires `maintenance.manage`, so even a forged request from a
 *     session that somehow rendered this page is refused.
 *
 * Only `AuthzError` is handled; anything else propagates, because a genuine fault must not be
 * presented as an authorization outcome.
 */

export const dynamic = "force-dynamic";

export default async function DashboardMaintenanceSettingsPage() {
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
                        Hanya ADMIN platform yang dapat mengelola maintenance aplikasi.
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
                title="Maintenance"
                description="Menutup seluruh halaman publik dan alur pembelian. Dashboard tetap terbuka untuk ADMIN agar mode ini selalu bisa dimatikan kembali."
            />

            <MaintenanceSettingsForm
                initial={{
                    maintenanceMode: settings.maintenance.enabled,
                    maintenanceMessage: settings.maintenance.message,
                    maintenanceEtaMessage: settings.maintenance.etaMessage ?? "",
                }}
            />
        </div>
    );
}
