import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import DashboardAppShell from "@/components/dashboard/DashboardAppShell";
import DashboardProviders from "@/components/dashboard/DashboardProviders";
import { AccessDeniedPanel } from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { canEnterDashboard, computeDashboardCapabilities } from "@/lib/dashboard/scope";
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

    const capabilities = computeDashboardCapabilities(scope);

    // One gate, one definition: `canEnterDashboard` is the same function the access tests
    // assert against, so the layout cannot drift from what is verified.
    if (!canEnterDashboard(capabilities)) {
        return (
            <DashboardProviders>
                <AccessDeniedPanel
                    title="Akses dashboard ditolak"
                    body={
                        <p className="text-sm leading-relaxed">
                            Akun kamu belum memiliki akses ke dashboard. Hubungi admin
                            platform untuk diberikan peran penyelenggara atau izin
                            platform.
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

    const session = await auth();

    const hasPlatformSurface =
        capabilities.canManageSports ||
        capabilities.canManageGlobalVenues ||
        capabilities.canManagePlatformPic;

    const contextLabel = hasPlatformSurface
        ? `Platform · ${scope.platformRole}`
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
            >
                {children}
            </DashboardAppShell>
        </DashboardProviders>
    );
}
