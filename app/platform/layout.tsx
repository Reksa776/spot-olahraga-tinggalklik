import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { Text } from "@mantine/core";

import DashboardProviders from "@/components/dashboard/DashboardProviders";
import PlatformShell from "@/components/dashboard/PlatformShell";
import { AccessDeniedPanel } from "@/components/dashboard/primitives";
import { PERMISSIONS, getAuthzScope } from "@/lib/authz";
import { decidePlatformPermission } from "@/lib/authz/permissions";

import "@mantine/core/styles.css";

/**
 * ==========================================
 * PLATFORM ADMIN LAYOUT
 * ==========================================
 *
 * WHY THIS IS `/platform` AND NOT `/admin`
 * ----------------------------------------
 * The existing `/admin` layout (`app/admin/layout.tsx`) gates on the **legacy retail** role:
 * `session.user.role !== "ADMIN"`. That column and the new `platformRole` are deliberately separate
 * dimensions (Phase 3), and no implicit bridge was written from the legacy role to a platform
 * privilege — deriving one from the other would be a hidden grant.
 *
 * Rendering the ticketing platform surfaces under `/admin` would therefore have made them
 * reachable only by users who ALSO hold the legacy retail role, which is both wrong and confusing.
 * They live here instead, and this layout authorizes on the platform-scope permissions the pages
 * actually need.
 *
 * The guard is a convenience for rendering only. Every write goes through `/api/admin/sports` or
 * `/api/admin/venues`, which repeat the platform permission check — so this layout grants nothing
 * on its own.
 *
 * PHASE MANTINE: the gates are untouched. The `canManageSports` / `canManageGlobalVenues` booleans
 * below now also drive the shell's navigation, which means the menu is a rendering of this decision
 * rather than a second, independent opinion about who may see what.
 *
 * NOTE for future edits: this is a SERVER component. Mantine's `Button`/`Card`/`Anchor` accept a
 * `component` prop, but a component *reference* cannot cross the server/client boundary — hence
 * `AccessDeniedPanel`, a client component that builds its own `<Link>` internally.
 */

export const dynamic = "force-dynamic";

export default async function PlatformLayout({
    children,
}: {
    children: ReactNode;
}) {
    const scope = await getAuthzScope();

    if (!scope) {
        redirect("/login");
    }

    const canManageSports =
        decidePlatformPermission(scope, PERMISSIONS.SPORT_MANAGE).allowed;
    const canManageGlobalVenues = decidePlatformPermission(
        scope,
        PERMISSIONS.VENUE_MANAGE_GLOBAL
    ).allowed;

    if (!canManageSports && !canManageGlobalVenues) {
        return (
            <DashboardProviders>
                <AccessDeniedPanel
                    title="Akses platform ditolak"
                    body={
                        <Text size="sm">
                            Area ini hanya untuk admin platform. Peran platform kamu saat ini:{" "}
                            <Text span fw={600}>
                                {scope.platformRole}
                            </Text>
                            .
                        </Text>
                    }
                    actionHref="/"
                    actionLabel="Lihat situs"
                />
            </DashboardProviders>
        );
    }

    return (
        <DashboardProviders>
            <PlatformShell
                canManageSports={canManageSports}
                canManageGlobalVenues={canManageGlobalVenues}
                platformRole={scope.platformRole}
            >
                {children}
            </PlatformShell>
        </DashboardProviders>
    );
}
