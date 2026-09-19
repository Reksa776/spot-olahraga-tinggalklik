"use client";

import type { ReactNode } from "react";

import { DashboardThemeProvider, DashboardThemeScript } from "./theme/theme-provider";

/**
 * ==========================================
 * DASHBOARD PROVIDERS
 * ==========================================
 *
 * The single provider stack every back-office surface is wrapped in, mounted by the three layouts
 * (`/admin`, `/organizer`, `/platform`).
 *
 *   `DashboardThemeScript`    the pre-paint bootstrap. It applies the stored appearance (with the
 *                             system preference resolved), accent and chart palette to `<html>`
 *                             before the first frame, so a personalised dashboard never flashes the
 *                             default colours on load.
 *
 *   `DashboardThemeProvider`  `next-themes` for light/dark/system, plus the accent and chart-palette
 *                             context, plus the `data-dashboard-shell` marker the footer suppression
 *                             keys off.
 *
 * WHY THERE IS NO LONGER A MANTINE PROVIDER HERE
 * ----------------------------------------------
 * Mantine components throw at render time when no provider is in the tree, so during the migration
 * this file deliberately kept a `MantineProvider` mounted for the pages that had not been ported yet,
 * and the migration order was provider-LAST: port every consumer off the component library, and only
 * then remove the provider, the theme module and the component-library stylesheet the layouts
 * imported.
 *
 * That condition is now met — a repository-wide scan finds no dashboard file importing the library,
 * and `__tests__/ui-consolidation/shadcn-dashboard.test.ts` pins that count at zero. The dashboard's
 * entire visual system now arrives as CSS custom properties from `app/globals.css` and shadcn
 * components from `components/dashboard/ui/**`, so the provider stack is only the theme system.
 *
 * SERVER/CLIENT BOUNDARY
 * ----------------------
 * This is a client component because `next-themes` is, but it is designed to be rendered BY a server
 * component: the three layouts are server components and pass server-rendered children through it,
 * which React supports — a client provider may accept server-rendered children. Nothing here takes a
 * callback or a component reference, so it stays legal at that boundary.
 */

export default function DashboardProviders({ children }: { children: ReactNode }) {
    return (
        <>
            <DashboardThemeScript />

            <DashboardThemeProvider>{children}</DashboardThemeProvider>
        </>
    );
}
