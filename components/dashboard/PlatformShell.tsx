"use client";

import type { ReactNode } from "react";
import { FiGlobe, FiTarget } from "react-icons/fi";

import DashboardShell, { type ShellNavEntry } from "./DashboardShell";

/**
 * The `/platform` back-office navigation.
 *
 * The two booleans are the whole authority model of this shell, and they are computed by the
 * server layout from `decidePlatformPermission(...)`. The menu is therefore a *rendering* of a
 * decision that was already made elsewhere — never a decision of its own. A caller without
 * `SPORT_MANAGE` cannot receive the sports item, because the item is not constructed until the
 * boolean arrives as `true`.
 *
 * The platform role is shown in the sidebar context line so an operator can see which privilege
 * level they are acting under, which the previous header displayed too.
 */
export default function PlatformShell({
    canManageSports,
    canManageGlobalVenues,
    platformRole,
    userName,
    userEmail,
    children,
}: {
    canManageSports: boolean;
    canManageGlobalVenues: boolean;
    platformRole?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    children: ReactNode;
}) {
    const nav: ShellNavEntry[] = [];

    if (canManageSports) {
        nav.push({ label: "Cabang olahraga", href: "/platform/sports", icon: <FiTarget size={18} /> });
    }

    if (canManageGlobalVenues) {
        nav.push({ label: "Venue global", href: "/platform/venues", icon: <FiGlobe size={18} /> });
    }

    return (
        <DashboardShell
            nav={nav}
            sectionLabel="Platform"
            sectionDescription={platformRole ? `Peran: ${platformRole}` : undefined}
            userName={userName}
            userEmail={userEmail}
        >
            {children}
        </DashboardShell>
    );
}
