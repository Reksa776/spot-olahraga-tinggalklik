"use client";

import type { ReactNode } from "react";

import { ADMIN_NAV } from "@/components/admin/AdminNavbar";
import DashboardShell from "./DashboardShell";

/**
 * The `/admin` back office shell.
 *
 * The menu itself is `ADMIN_NAV` in `components/admin/AdminNavbar.tsx` — that is where the
 * destinations, groups and labels live, and where four pre-existing suites look for them. This
 * component only binds that definition to the shared shell and the section's own labelling, so the
 * admin, organiser and platform back offices render through one `AppShell`.
 *
 * See `ADMIN_NAV` for why the item set contains no ticketing surface: the retail `role` gate on
 * this section and the `platformRole` gate on `/platform` are separate authority dimensions, and
 * bridging them in a menu would be a hidden grant.
 */
export default function AdminShell({
    userName,
    userEmail,
    children,
}: {
    userName?: string | null;
    userEmail?: string | null;
    children: ReactNode;
}) {
    return (
        <DashboardShell
            nav={ADMIN_NAV}
            sectionLabel="Admin"
            sectionDescription="Back office toko"
            userName={userName}
            userEmail={userEmail}
        >
            {children}
        </DashboardShell>
    );
}
