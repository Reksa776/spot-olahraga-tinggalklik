"use client";

import type { ReactNode } from "react";

import { DashboardThemeProvider } from "./theme/theme-provider";

/**
 * ==========================================
 * DASHBOARD PROVIDERS
 * ==========================================
 *
 * The single provider stack every back-office surface is wrapped in, mounted by the dashboard
 * layout.
 *
 *   `DashboardThemeProvider`  appearance (light/dark/system) plus the accent and chart-palette
 *                             context. It owns the picker state and re-applies the three
 *                             attributes to `<html>` while the user is in the dashboard.
 *
 * WHERE THE BOOTSTRAP SCRIPT WENT
 * -------------------------------
 * It used to be rendered here, as `<DashboardThemeScript />` — a `<script>` element returned by a
 * client component. That is not a legal thing to do in the App Router, and this phase removed it:
 * a `<script>` inside a route is a host element React renders, so on CLIENT-SIDE navigation into
 * the dashboard React created it on the client, logged
 *   "Encountered a script tag while rendering React component …"
 * and — as that message says — never executed it. The two symptoms have one cause: the script
 * belonged to a route segment instead of the document.
 *
 * It now lives in `app/layout.tsx` as a plain inline `<script>` emitted by the ROOT Server
 * Component into the first child of `<body>`, so the browser runs it while parsing — before the
 * app below it is painted — and, because the root layout is never re-rendered on client-side
 * navigation, no navigation can re-create it. (`next/script strategy="beforeInteractive"` was
 * tried first and rejected: for an INLINE script Next defers it past `DOMContentLoaded`, which
 * reintroduces the flash the script exists to prevent.)
 *
 * WHY THE DASHBOARD-SCOPED PROVIDER IS STILL CORRECT HERE
 * -------------------------------------------------------
 * Only the SCRIPT had to move. The provider is dashboard chrome: the three preferences are for
 * the back office, which is why no other surface mounts it and why `app/layout.tsx` mounts only
 * the script.
 *
 * SERVER/CLIENT BOUNDARY
 * ----------------------
 * This is a client component because the theme context is, but it is designed to be rendered BY a
 * server component: the dashboard layout is a server component and passes server-rendered children
 * through it, which React supports — a client provider may accept server-rendered children. Nothing
 * here takes a callback or a component reference, so it stays legal at that boundary.
 */

export default function DashboardProviders({ children }: { children: ReactNode }) {
    return <DashboardThemeProvider>{children}</DashboardThemeProvider>;
}
