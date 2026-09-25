import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { getApplicationBranding } from "@/lib/app-settings";
import DashboardAppShell from "@/components/dashboard/DashboardAppShell";
import DashboardProviders from "@/components/dashboard/DashboardProviders";
import { AccessDeniedPanel } from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { canEnterDashboard, computeDashboardCapabilities } from "@/lib/dashboard/scope";
import { findActivePicProfile } from "@/lib/pic/self-service";
import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * THE DASHBOARD LAYOUT
 * ==========================================
 *
 * ONE layout for every back-office surface. It replaces the previous `/platform` and
 * `/organizer` layouts, which were two copies of the same chrome with two different gates.
 *
 * ── WHAT IS DECIDED HERE, AND WHAT IS NOT ─────────────────────────────────────────
 * Decided HERE: whether the actor may enter the back office at all, and which menu rows
 * they are shown. Nothing else.
 *
 * NOT decided here: any data scope. Every page and every service re-resolves authority
 * from the database through `lib/authz`. This layout is chrome and a fail-closed entry
 * gate; removing it would grant nobody a single extra row, because each page's service
 * runs its own `decide*`/`require*` check. The menu is a rendering of those decisions, not
 * a substitute for them.
 *
 * ── WHY THE GATE IS "NO TENANT ACCESS AND NO PLATFORM CAPABILITY" ─────────────────
 * A platform ADMIN with `sport.manage` must be able to open the dashboard even with no
 * organizer membership; an organizer OWNER must be able to open it with no platform role.
 * A plain CUSTOMER holds neither, and is the only actor refused. Refusing exactly that set
 * — rather than "must be ADMIN" — is what keeps one gate correct for both populations.
 *
 * PHASE 34 — the gate additionally admits on the PLATFORM ROLE alone. Phase 33 provisions
 * MANAGER and PIC accounts separately from organizer membership, so a MANAGER can exist
 * before any membership and a PIC account exists while its profile is PENDING; both were
 * wrongly refused. Entry is not data access: a MANAGER without a membership still reads no
 * tenant, and a PENDING PIC still has no self-service. The pages and services below remain
 * the data boundary — see `canEnterDashboard`.
 *
 * The `auth()` call is DISPLAY ONLY (top-bar account menu), exactly as before.
 */

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
    children,
}: {
    children: ReactNode;
}) {
    const scope = await getAuthzScope();

    if (!scope) {
        redirect("/login");
    }

    let capabilities = computeDashboardCapabilities(scope);

    // One gate, one definition: `canEnterDashboard` is the same function the access tests
    // assert against, so the layout cannot drift from what is verified.
    //
    // The pure capability set cannot see a PIC's own-scope surface (a pure PIC holds no
    // membership and no platform permission). Probe the database for:
    //   * a PIC-role account — PHASE 34: it enters on its platform role, so the probe is
    //     what decides whether the PIC SELF-SERVICE rows are offered (the ACTIVE profile),
    //     and
    //   * any first-pass-DENIED account — an ACTIVE profile can admit a non-PIC account
    //     exactly as before.
    // The probe resolves the caller's OWN profile from their session-derived id — never
    // from the request — and can never widen what they may read: it only sets a menu flag.
    if (scope.platformRole === "PIC" || !canEnterDashboard(capabilities)) {
        const hasActivePicProfile =
            (await findActivePicProfile(scope.userId)) !== null;

        capabilities = computeDashboardCapabilities(scope, {
            hasActivePicProfile,
        });
    }

    if (!canEnterDashboard(capabilities)) {
        return (
            <DashboardProviders>
                <AccessDeniedPanel
                    title="Akses dashboard ditolak"
                    body={
                        <p className="text-sm leading-relaxed">
                            Akun kamu belum memiliki akses ke dashboard. Hubungi admin
                            platform untuk diberikan peran penyelenggara, izin
                            platform, atau profil PIC yang aktif.
                        </p>
                    }
                    actionHref="/events"
                    actionLabel="Lihat katalog event"
                    standalone
                />
            </DashboardProviders>
        );
    }

    const activeOrganizerIds = scope.organizerScopes
        .filter((membership) => membership.status === "ACTIVE")
        .map((membership) => membership.organizerId);

    const organizers = activeOrganizerIds.length
        ? await prisma.organizer.findMany({
              where: { id: { in: activeOrganizerIds } },
              select: { name: true },
              orderBy: { name: "asc" },
          })
        : [];

    // PHASE 32 — the dashboard lockup renders the SAME configured logo the public landing
    // page does. Resolved here (server side, once) and threaded down to the client shell, so
    // the sidebar and the mobile top bar cannot render two different marks, and so the source
    // of truth stays `PlatformSetting.logoUrl` rather than a second dashboard-only setting.
    const [session, branding] = await Promise.all([
        auth(),
        getApplicationBranding(),
    ]);

    const hasPlatformSurface =
        capabilities.canManageSports ||
        capabilities.canManageGlobalVenues ||
        capabilities.canManagePlatformPic;

    // PHASE 34 — a platform-role account with no platform capability yet (a MANAGER
    // without `sport.manage`, a PENDING PIC) used to fall through to "Penyelenggara",
    // which mislabelled who they are. The label now follows the authoritative platform
    // role first.
    const isPlatformAdminOrManager =
        scope.platformRole === "ADMIN" || scope.platformRole === "MANAGER";

    const contextLabel =
        hasPlatformSurface || isPlatformAdminOrManager
            ? `Platform · ${scope.platformRole}`
            : capabilities.hasActivePicProfile || scope.platformRole === "PIC"
              ? "PIC"
              : "Penyelenggara";

    return (
        <DashboardProviders>
            <DashboardAppShell
                capabilities={capabilities}
                contextLabel={contextLabel}
                organizerLabel={
                    organizers.length
                        ? organizers.map((organizer) => organizer.name).join(", ")
                        : undefined
                }
                userName={session?.user?.name}
                userEmail={session?.user?.email}
                logoSrc={branding.logoUrl}
            >
                {children}
            </DashboardAppShell>
        </DashboardProviders>
    );
}
