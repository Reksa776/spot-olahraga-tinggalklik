import {
    AccessDeniedPanel,
    PageHeader,
} from "@/components/dashboard/primitives";
import UserManager, {
    type ManagedUserRow,
} from "@/components/admin/UserManager";
import { listManagedUsers } from "@/lib/admin/users";
import { getAuthzScope } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";

/**
 * ==========================================
 * PHASE 33 — DASHBOARD → PENGGUNA (ADMIN ONLY)
 * ==========================================
 *
 * The ADMIN-only user management surface for the two fixed V1 roles: MANAGER and PIC.
 * The list comes from `listManagedUsers`, which re-enforces `user.manage` — the same
 * platform permission the API enforces — so this page adds no authority of its own and
 * every other role that navigates here is refused with the standard denial panel.
 *
 * Deliberately out of scope, per the phase brief:
 *   • no ADMIN creation or editing (ADMIN is provisioned out-of-band);
 *   • no permission editing (authority lives in the role maps, not per-user rows);
 *   • no PIC event assignment here (that is the PIC assignment flow's job — an account is
 *     not an assignment);
 *   • no delete (deactivation via `disabledAt` is reversible; users are never destroyed).
 */
export const dynamic = "force-dynamic";

export default async function DashboardUsersPage() {
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    let result;

    try {
        result = await listManagedUsers(scope);
    } catch (error) {
        if (!isAuthzError(error)) {
            throw error;
        }

        return (
            <AccessDeniedPanel
                title="Akses ditolak"
                body={
                    <p className="text-sm leading-relaxed">
                        Hanya ADMIN platform yang dapat mengelola pengguna. Akun MANAGER,
                        PIC, dan pelanggan tidak memiliki izin manajemen pengguna.
                    </p>
                }
                actionHref="/dashboard"
                actionLabel="Kembali ke dashboard"
            />
        );
    }

    const users: ManagedUserRow[] = result.items.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        // The service only ever lists these two roles; the narrowing is the contract.
        platformRole: user.platformRole === "MANAGER" ? "MANAGER" : "PIC",
        disabled: user.disabled,
        disabledAt: user.disabledAt,
        createdAt: user.createdAt,
        picProfile: user.picProfile,
    }));

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard · Sistem"
                title="Pengguna"
                description="Kelola akun operasional MANAGER dan PIC. Pembuatan akun PIC sekaligus membuat profil PIC-nya (status awal Menunggu); penugasan ke event tetap dilakukan dari alur penugasan PIC."
            />

            <UserManager users={users} />
        </div>
    );
}
