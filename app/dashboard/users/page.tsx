import { FilterBar } from "@/components/dashboard/filters/FilterBar";
import { buildFilterField } from "@/components/dashboard/filters/filter-types";
import {
    AccessDeniedPanel,
    LinkPagination,
    PageHeader,
} from "@/components/dashboard/primitives";
import UserManager, {
    type ManagedUserRow,
} from "@/components/admin/UserManager";
import { MANAGED_ROLE_LABELS } from "@/lib/dashboard/filter-options";
import { MANAGED_ROLES, listManagedUsers, type ManagedRole } from "@/lib/admin/users";
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
 * ── THE FILTERS THE READ MODEL ALREADY HAD, NOW REACHABLE ───────────────────────
 * `listManagedUsers` has always accepted `{ role, search, page }` and returned a `pagination`
 * envelope, and NOTHING in the product could reach any of the three: the row count was silently
 * capped at the first page, and the only way to find a PIC was to scan the table. The page now
 * renders exactly those three, with no new parameter and no change to the service:
 *
 *   role     `?role=MANAGER|PIC` — the two-role union the service validates against. An unknown
 *            value is DROPPED here, so it can never reach a Prisma `platformRole` comparison;
 *   search   `?search=` — the free-text match on name and email the read model implements;
 *   page     `?page=` — the cap is 50 rows per page, so a paginated list is the only honest one.
 *
 * `role` and `search` are the SERVICE's own parameter names, so the URL is the read model's
 * contract rather than a translation layer. Both ride along in `LinkPagination` and are preserved
 * by every filter change (the shared merge drops only `page`).
 *
 * Deliberately out of scope, per the phase brief:
 *   • no ADMIN creation or editing (ADMIN is provisioned out-of-band);
 *   • no permission editing (authority lives in the role maps, not per-user rows);
 *   • no PIC event assignment here (that is the PIC assignment flow's job — an account is
 *     not an assignment);
 *   • no delete (deactivation via `disabledAt` is reversible; users are never destroyed).
 */
export const dynamic = "force-dynamic";

/** Browser tab title. The brand suffix is composed by the root layout's `title.template`. */
export const metadata = { title: "Users" };

/** `?role=` is validated against the two managed roles before it reaches the service. */
function parseRole(value: string | string[] | undefined): ManagedRole | null {
    const raw = Array.isArray(value) ? value[0] : value;

    return raw && (MANAGED_ROLES as readonly string[]).includes(raw)
        ? (raw as ManagedRole)
        : null;
}

export default async function DashboardUsersPage({
    searchParams,
}: {
    searchParams: Promise<{ role?: string | string[]; search?: string; page?: string }>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    const role = parseRole(params.role);
    const search = params.search?.trim() || null;
    const page = params.page ? Number(params.page) : 1;

    let result;

    try {
        result = await listManagedUsers(scope, {
            role: role ?? undefined,
            search: search ?? undefined,
            page,
        });
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

    const roleField = buildFilterField({
        name: "role",
        label: "Peran",
        allLabel: "Semua peran",
        values: role ? [role] : [],
        members: MANAGED_ROLES,
        labels: MANAGED_ROLE_LABELS,
    });

    const isFiltered = Boolean(role || search);

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard · Sistem"
                title="Pengguna"
                description="Kelola akun operasional MANAGER dan PIC. Pembuatan akun PIC sekaligus membuat profil PIC-nya (status awal Menunggu); penugasan ke event tetap dilakukan dari alur penugasan PIC."
            />

            <FilterBar
                basePath="/dashboard/users"
                current={{
                    role: role ?? undefined,
                    search: search ?? undefined,
                }}
                fields={[roleField]}
                search={{
                    name: "search",
                    label: "Cari pengguna",
                    placeholder: "Nama atau email",
                    value: search ?? undefined,
                }}
            />

            <UserManager
                users={users}
                filtered={isFiltered}
                footer={
                    <LinkPagination
                        page={result.pagination.page}
                        totalPages={result.pagination.totalPages}
                        basePath="/dashboard/users"
                        query={{
                            role: role ?? undefined,
                            search: search ?? undefined,
                        }}
                        label="Halaman"
                    />
                }
            />
        </div>
    );
}
