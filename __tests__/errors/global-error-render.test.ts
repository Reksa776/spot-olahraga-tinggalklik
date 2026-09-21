jest.mock("../../app/globals.css", () => ({}));

import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import DashboardError from "@/app/dashboard/error";
import RootError from "@/app/error";
import GlobalError from "@/app/global-error";
import TicketingError from "@/app/ticketing/error";

/**
 * ==========================================
 * THE LAST-RESORT SCREEN, ACTUALLY RENDERED
 * ==========================================
 *
 * `app/global-error.tsx` is the one screen that only ever appears when something else has
 * already failed: Next.js replaces the entire document when the ROOT LAYOUT throws, which is a
 * code path `app/error.tsx` cannot cover because that boundary lives inside the layout it would
 * need.
 *
 * ── WHY A RENDER TEST AND NOT ANOTHER STATIC GUARD ──────────────────────────────
 * The static guards in `__tests__/errors/error-boundaries.test.ts` prove the file EXISTS, is a
 * client component, and ships `<html>`, `<body>` and the stylesheet. None of that proves the
 * component can RENDER — a boundary that throws while rendering the error is a blank page, and
 * it would never be exercised by the happy path. So this suite renders it, with the CSS import
 * stubbed, in a plain React tree:
 *
 *   • with NO App Router context, which is the situation it actually runs in (the layout that
 *     would have provided that context is what failed): if anything here reached for
 *     `useRouter`/`usePathname`/a provider, the render would throw and this suite would fail;
 *   • with an error whose message is deliberately full of things a page must never show
 *     (SQL, a credential-shaped value, a filesystem path, a stack) so "it renders" cannot be
 *     satisfied by leaking the very thing the boundary exists to contain.
 *
 * `reset` is a spy: the retry control must be wired to the boundary's own reset, and the same
 * button must exist on every boundary (one error surface for the whole application).
 */

/** Something that looks exactly like what must never reach a buyer's screen. */
function leakyError(): Error & { digest?: string } {
    return Object.assign(
        new Error(
            "PrismaClientKnownRequestError: SELECT * FROM Payment WHERE api_key='sk_live_LEAKED' at /srv/app/.next/server/chunks/9.js"
        ),
        { digest: "req_9f2c41" }
    );
}

/** Everything a user could ever see rendered by an error screen. */
function render(
    Component: ComponentType<{ error: Error & { digest?: string }; reset: () => void }>,
    error: Error & { digest?: string },
    reset: () => void = () => undefined
): string {
    return renderToStaticMarkup(createElement(Component, { error, reset }));
}

/** The strings that must never appear in ANY error surface. */
const FORBIDDEN = [
    "SELECT * FROM",
    "api_key",
    "sk_live_LEAKED",
    "PrismaClientKnownRequestError",
    ".next/server",
    "/srv/app",
    "stack",
    "process.env",
    "AUTH_SECRET",
];

const SURFACES = [
    ["app/global-error.tsx", GlobalError],
    ["app/error.tsx", RootError],
    ["app/dashboard/error.tsx", DashboardError],
    ["app/ticketing/error.tsx", TicketingError],
] as const;

/* ==================================================================================
 * 1. IT RENDERS, WITH NO LAYOUT AND NO ROUTER
 * ================================================================================== */

describe("the global boundary renders a complete document on its own", () => {
    const html = render(GlobalError, leakyError());

    it("ships its own <html> and <body>, in Indonesian", () => {
        // North star: if this boundary renders, there is no root layout output to inherit —
        // no document, no `lang`, no stylesheet — so the component has to supply all of it.
        expect(html.startsWith("<html")).toBe(true);
        expect(html).toContain('lang="id"');
        expect(html).toContain("<body");
        expect(html).toContain("</html>");
    });

    it("needs no App Router context to render", () => {
        // The render above already proves it: there is no provider, no router and no layout in
        // this tree, which is exactly the state the application is in when this file is used.
        expect(html.length).toBeGreaterThan(0);
    });

    it("shows the safe Indonesian message and a way forward", () => {
        expect(html).toContain("Terjadi masalah");
        expect(html).toContain("Data Anda tetap aman");
        expect(html).toContain("Coba lagi");
        expect(html).toContain("Kembali ke beranda");
    });

    it("keys the failure to its digest, which is the only safe identifier", () => {
        expect(html).toContain("Kode referensi: req_9f2c41");
    });
});

/* ==================================================================================
 * 2. NOTHING LEAKS
 * ================================================================================== */

describe("no boundary renders the error's internals", () => {
    it.each(SURFACES)("%s renders without leaking", (_file, Component) => {
        const html = render(Component, leakyError());

        for (const forbidden of FORBIDDEN) {
            expect(html).not.toContain(forbidden);
        }

        // The message may be LOGGED (from the browser, where an operator can retrieve it) but
        // it is never rendered.
        expect(html).not.toContain("PrismaClientKnownRequestError");
    });

    it("renders nothing extra when React withholds the digest", () => {
        // In production React passes a digest; if it does not, the reference line must vanish
        // rather than render the word "undefined" at a buyer.
        const html = render(GlobalError, new Error("plain failure"));

        expect(html).not.toContain("Kode referensi");
        expect(html).not.toContain("undefined");
    });

    it("offers only same-origin destinations", () => {
        const html = render(GlobalError, leakyError());
        const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

        expect(hrefs.length).toBeGreaterThan(0);

        for (const href of hrefs) {
            expect(href.startsWith("/")).toBe(true);
            expect(href.startsWith("//")).toBe(false);
            expect(href).not.toContain("http");
        }
    });
});

/* ==================================================================================
 * 3. EVERY BOUNDARY IS THE SAME SURFACE
 * ================================================================================== */

describe("each route boundary renders one shared fallback", () => {
    it.each(SURFACES)("%s renders the retry control and a route-appropriate title", (file, Component) => {
        const html = render(Component, leakyError());

        expect(html).toContain("Coba lagi");

        // The route boundaries name their own surface; the two global ones share the generic
        // wording, so a bug in one file cannot quietly change another's copy.
        if (file === "app/dashboard/error.tsx") {
            expect(html).toContain("Dashboard tidak dapat dimuat");
        }

        if (file === "app/ticketing/error.tsx") {
            expect(html).toContain("Halaman tiket tidak dapat dimuat");
            // A buyer's worst fear on a failure screen is that their money or their ticket
            // changed. The copy has to answer that explicitly.
            expect(html).toContain("Status pesanan dan pembayaran Anda tidak berubah");
        }

        if (file === "app/global-error.tsx" || file === "app/error.tsx") {
            expect(html).toContain("Terjadi masalah");
        }
    });

    it.each(SURFACES)("%s wires its retry to the boundary's own reset()", (_file, Component) => {
        const reset = jest.fn();
        const html = render(Component, leakyError(), reset);

        // The handler is attached in React, not in the markup: assert the button exists and that
        // rendering did not invoke `reset` on its own (a boundary that resets while rendering
        // would loop).
        expect(html).toContain("<button");
        expect(reset).not.toHaveBeenCalled();
    });

    it("the dashboard boundary keeps the back-office marker, so the marketing footer stays off", () => {
        expect(render(DashboardError, leakyError())).toContain("data-dashboard-shell");
    });
});
