"use client";

import type { ReactNode } from "react";

import { MantineProvider } from "@mantine/core";

import { dashboardTheme } from "./mantine-theme";

/**
 * ==========================================
 * MANTINE PROVIDER — DASHBOARD SCOPE ONLY
 * ==========================================
 *
 * WHY IT IS HERE AND NOT IN `app/layout.tsx`
 * ------------------------------------------
 * `MantineProvider` is client-side infrastructure: it establishes a React context every Mantine
 * component reads, and it ships a baseline stylesheet that sets `body { margin: 0; font-family: … }`.
 * Mounting it at the application root would put both over the customer-facing ticketing and retail
 * surfaces, which this phase must not touch. Mounting it in the three dashboard layouts means:
 *
 *   • the Mantine context exists only under `/admin`, `/organizer` and `/platform`;
 *   • the Mantine baseline CSS is bundled only for those routes (Next gives each layout segment
 *     its own CSS), so `/`, `/events`, `/e/[slug]` and `/ticketing/**` keep Tailwind's reset;
 *   • the root layout stays byte-identical, which is the safest possible outcome for Auth.js and
 *     server rendering.
 *
 * Server components can still render inside this provider — a client component may accept
 * server-rendered `children`, and those children render within the provider's React tree, so
 * Mantine context is available even though the children themselves stayed on the server.
 *
 * WHY THE COLOR SCHEME IS FORCED
 * ------------------------------
 * `forceColorScheme="light"` makes Mantine ignore storage and the OS preference. That removes the
 * need for `ColorSchemeScript` in `<head>` (which would mean editing the root layout) and removes
 * any chance of a hydration mismatch from a colour scheme the rest of the app cannot express — no
 * other surface in this repository has dark mode.
 */
export default function DashboardProviders({ children }: { children: ReactNode }) {
    return (
        <MantineProvider theme={dashboardTheme} forceColorScheme="light">
            {children}
        </MantineProvider>
    );
}
