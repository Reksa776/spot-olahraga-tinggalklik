import "./globals.css";

import { Toaster } from "react-hot-toast";

import AuthProvider from "@/components/providers/AuthProvider";
import { THEME_BOOTSTRAP_SCRIPT } from "@/components/dashboard/theme/theme-config";

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

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
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
