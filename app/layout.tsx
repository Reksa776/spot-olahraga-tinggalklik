import "./globals.css";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Toaster } from "react-hot-toast";

import { auth } from "@/auth";
import AuthProvider from "@/components/providers/AuthProvider";
import { THEME_BOOTSTRAP_SCRIPT } from "@/components/dashboard/theme/theme-config";
import { getMaintenanceState } from "@/lib/app-settings";
import { MAINTENANCE_PATH, maintenanceBlocksPage } from "@/lib/maintenance";

/**
 * The application root.
 *
 * It carries the session context, the toast host, and ONE document-level inline script — the theme
 * bootstrap. The retail chrome that used to live here (the storefront `Footer`, the TikTok pixel
 * loader and the legacy `useDialog()` provider) was removed with the retail application. Each
 * surface owns its own chrome instead: ticketing pages render `<SiteShell />`, and the back office
 * renders its dashboard shell.
 *
 * WHY THE THEME BOOTSTRAP IS HERE, AND WHY IT IS A PLAIN <script>
 * ---------------------------------------------------------------
 * It must run BEFORE first paint (or a personalised dashboard flashes the default palette), and it
 * must not be a `<script>` element rendered by a ROUTE SEGMENT. A route-rendered script is
 * re-created on every CLIENT-SIDE navigation into that route — React logs "Encountered a script tag
 * while rendering React component …" and, as that message states, does not execute it there, so the
 * bootstrap was both noisy and ineffective for anyone arriving via the post-login redirect or an
 * in-app link.
 *
 * It is emitted here, by a Server Component, directly into the document. React renders it to HTML on
 * the server, so the browser executes it while parsing the body — before anything below it is
 * painted — and because the ROOT layout is never re-rendered on client-side navigation, no
 * navigation can re-create it. Both properties were measured against this app, not assumed.
 *
 * WHY NOT `next/script strategy="beforeInteractive"`
 * -------------------------------------------------
 * That is the documented API for this job, and it was tried first. For an INLINE script it does not
 * work in either dev or a production build: Next emits a `self.__next_s.push(...)` stub in the body
 * and injects the real script only once its runtime boots, which is AFTER `DOMContentLoaded`
 * (measured: the palette attributes were still unset at DCL and appeared only later). That
 * re-introduces exactly the flash this script exists to prevent. `beforeInteractive` only hoists
 * pre-paint for `src`-based scripts; a server-rendered inline tag is the mechanism that actually
 * runs at the right stage. It is also the technique the theme provider itself uses — the difference
 * is that this one is NOT inside a client component or a route segment.
 *
 * The script reads the SAME three localStorage keys the dashboard provider writes (appearance,
 * accent, chart) and is a no-op for a visitor who has never personalised the back office: with no
 * stored appearance it resolves to `light`, matching the provider's default.
 *
 * WHY `<html>` CARRIES `suppressHydrationWarning`
 * ----------------------------------------------
 * A pre-paint bootstrap can only know what the BROWSER stores, and what it stores is by design
 * never sent to the server (`theme-config.ts`: appearance/accent/chart are client-side persistence
 * only). So for a returning operator whose dashboard is dark, `<html>` legitimately holds a `dark`
 * class, `data-accent` and `data-chart` that the server-rendered tag does not — the difference is
 * the whole point of running the script before paint, and no server render can avoid it.
 * `suppressHydrationWarning` is React's documented mechanism for precisely this: it silences the
 * comparison for THIS element's own attributes (one level deep) and nothing below it.
 *
 * It is a scoped acknowledgement, not a blanket cover-up, and the scope is checked rather than
 * assumed: `<html>` declares no `style` and no `className` of its own, so nothing React OWNS can
 * disagree — the only attributes that can differ are the three the bootstrap deliberately writes.
 * `color-scheme` used to be a fourth and was NOT unavoidable: it was written as an inline `style`
 * for every visitor including the anonymous ones, and it is now a class-derived rule in
 * `app/globals.css`, which removed the mismatch the console was reporting. Both halves of that
 * contract are pinned by `__tests__/ui-consolidation/theme-hydration.test.ts`.
 */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE 32 — APPLICATION MAINTENANCE: THE SERVER-SIDE ENFORCEMENT POINT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Availability is decided HERE, in the root Server Component, before any page renders a
 * single byte. The brief requires a SERVER-SIDE mechanism and explicitly forbids a
 * client-side React check, and this is the only place that (a) runs for every page, (b) can
 * read the database, and (c) cannot be skipped by a client, a hard refresh, a cached RSC
 * payload or a disabled `<script>`.
 *
 * WHY THE PATH COMES FROM A HEADER
 * A Server Component cannot read its own route path. `proxy.ts` therefore stamps the
 * request path onto `x-pathname` (it is the only layer that runs before the render and knows
 * the path). That header is a routing HINT, never an authority: it is fed to a PURE decision
 * function, and the actor's role comes from the server-side session, so a forged value can
 * at worst redirect the forger's own request.
 *
 * WHY `auth()` IS CALLED HERE AT ALL
 * ADMIN must keep the dashboard while maintenance is ON — that is the only way to switch it
 * back off, and the brief calls a locked-out ADMIN a failure of the feature. The role is read
 * from the session, which is resolved server-side from the database; `platformRole` is NEVER
 * read from a request header, body or query.
 *
 * WHY A MISSING HEADER DOES NOT BLOCK
 * `x-pathname` is absent only for a request the proxy matcher does not cover — a static
 * asset, or (in principle) a path containing a file extension, which this application serves
 * no page for. Failing OPEN there is deliberate: the one state this must never produce is a
 * redirect loop, and a missing path is exactly the input for which "block" and "redirect to
 * the maintenance page" are indistinguishable. Every real page route is covered by the
 * matcher, so the public surface is closed in practice, and the loop hazard is eliminated
 * structurally rather than by care.
 */
export default async function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const [requestHeaders, session, maintenance] = await Promise.all([
        headers(),
        auth(),
        getMaintenanceState(),
    ]);

    if (maintenance.enabled) {
        const pathname = requestHeaders.get("x-pathname");

        if (
            pathname &&
            maintenanceBlocksPage(
                pathname,
                session?.user?.platformRole ?? null
            )
        ) {
            // `/maintenance` is exempt by definition, so this cannot re-enter itself: the
            // decision is a function of the PATH, and that path answers `false`.
            redirect(MAINTENANCE_PATH);
        }
    }

    return (
        <html lang="id" suppressHydrationWarning>
            <body>
                {/*
                 * First child of <body>: it executes during parsing, before the app below it is
                 * painted, so no themed surface can flash. Nothing here is interactive — it only
                 * sets three attributes on <html> — so it needs no id, no defer and no loading
                 * strategy.
                 */}
                <script
                    dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
                />

                <AuthProvider>
                    {children}

                    <Toaster
                        position="top-right"
                        toastOptions={{
                            duration: 3000,
                        }}
                    />
                </AuthProvider>
            </body>
        </html>
    );
}
