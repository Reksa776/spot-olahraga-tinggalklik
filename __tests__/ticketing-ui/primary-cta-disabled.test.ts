/*
 * `@/auth` is mocked for the same reason every other header suite mocks it: importing
 * `SiteHeader` reaches the Auth.js entrypoint through `@/lib/dashboard/scope`, which is an ESM
 * module Jest cannot parse. Nothing here reads a session — `BuatEventAction` is a pure function
 * of no props, and `MobileMenuLinks` is a pure function of a plain row list.
 */
jest.mock("@/auth", () => ({ auth: jest.fn() }));

import fs from "fs";
import path from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MobileMenuLinks, {
    type MobileMenuItem,
} from "@/components/ticketing/MobileMenuLinks";
import { BuatEventAction } from "@/components/ticketing/SiteHeader";

/**
 * ==========================================
 * "BUAT EVENT" IS VISIBLE AND DISABLED
 * ==========================================
 *
 * The requirement is a NEGATIVE one, and negatives are the ones a test has to be careful about:
 * "no navigation happens" is satisfied by any of a dozen implementations that merely LOOK inert —
 * an `<a href="/login">` the session happens to reject, a link whose click handler calls
 * `preventDefault`, a link to the create-event page that this phase forgot was still there. None
 * of those is the same as a control that CANNOT navigate, and a source-level assertion on one
 * line of JSX cannot tell them apart either.
 *
 * So this suite proves the property at the level it actually lives:
 *
 *   render    The two surfaces are RENDERED and the markup is inspected. The desktop control is
 *             an exported pure component (like `DesktopNavLinks`) precisely so it can be; the
 *             drawer's rows are rendered through the real `MobileMenuLinks`. "No navigation" is
 *             then a fact about the output — there is no `href`, no anchor, nothing for a
 *             browser to act on — rather than a promise about the source.
 *   source    Where the output cannot express it (which module owns the label, whether a route
 *             is still in scope for a future edit to wire up), the file is read with comments
 *             STRIPPED, so the docblock that NAMES `/dashboard/events` cannot pass for a link.
 *
 * ── WHAT IS DELIBERATELY NOT ASSERTED ─────────────────────────────────────────────
 * That the create-event page is gone. It is not: this phase disables an entry point, and the
 * last test here pins that the route still exists and is still reached from the surfaces that
 * own it.
 */

const ROOT = path.resolve(__dirname, "..", "..");

const SITE_HEADER = "components/ticketing/SiteHeader.tsx";
const MOBILE_MENU_LINKS = "components/ticketing/MobileMenuLinks.tsx";
const HEADER_NAV = "components/ticketing/header-nav.ts";
const CREATE_EVENT_PAGE = "app/dashboard/events/page.tsx";
const PUBLIC_EVENTS_PAGE = "app/events/page.tsx";

function read(relativePath: string): string {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Strip comments, so prose that NAMES a route is not mistaken for a link to it. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const HEADER_SOURCE = code(read(SITE_HEADER));
const LINKS_SOURCE = code(read(MOBILE_MENU_LINKS));
const NAV_SOURCE = code(read(HEADER_NAV));

/** The desktop control exactly as it ships: the real component, rendered. */
const DESKTOP_CTA = renderToStaticMarkup(createElement(BuatEventAction));

/** A signed-out drawer: the public row, the CTA in its real position, then "Masuk". */
const DRAWER_ITEMS: MobileMenuItem[] = [
    { href: "/events", label: "Event" },
    { label: "Buat event", disabled: true },
    { href: "/login", label: "Masuk" },
];

const DRAWER = renderToStaticMarkup(
    createElement(MobileMenuLinks, { items: DRAWER_ITEMS })
);

/** The rendered `<li>` chunks, so a claim about the CTA row cannot be satisfied by another row. */
const DRAWER_ROWS = DRAWER.split("</li>");

function drawerRowContaining(text: string): string {
    const row = DRAWER_ROWS.find((chunk) => chunk.includes(text));

    expect(row).toBeDefined();

    return row!;
}

describe("the disabled 'Buat event' CTA", () => {
    test("is still IN the navbar — the label renders on both surfaces", () => {
        expect(DESKTOP_CTA).toContain("Buat event");
        expect(DRAWER).toContain("Buat event");
    });

    test("keeps its place in the drawer row order", () => {
        // The row set the drawer had is unchanged; only this row's interactivity is.
        expect(DRAWER.indexOf(">Event<")).toBeLessThan(
            DRAWER.indexOf("Buat event")
        );
        expect(DRAWER.indexOf("Buat event")).toBeLessThan(
            DRAWER.indexOf(">Masuk<")
        );
    });

    test("the desktop control is a native DISABLED button, not an anchor", () => {
        expect(DESKTOP_CTA).toContain("<button");
        expect(DESKTOP_CTA).toContain('type="button"');
        expect(DESKTOP_CTA).toContain("disabled");

        // The whole point: there is no destination and no anchor, so there is nothing the
        // browser can navigate to — by click, by keyboard, or by "open in new tab".
        expect(DESKTOP_CTA).not.toContain("<a");
        expect(DESKTOP_CTA).not.toContain("href");
    });

    test("the drawer row is a disabled button and adds NO anchor to the list", () => {
        const ctaRow = drawerRowContaining("Buat event");

        expect(ctaRow).toContain("<button");
        expect(ctaRow).toContain("disabled");
        expect(ctaRow).not.toContain("<a");
        expect(ctaRow).not.toContain("href");

        // Three rows in, two anchors out: the disabled row contributes none, so the count is
        // also proof that no SECOND element was invented to carry the CTA.
        expect(DRAWER.match(/<a /g) ?? []).toHaveLength(2);
        expect(DRAWER.match(/<button/g) ?? []).toHaveLength(1);
    });

    test("every OTHER drawer row still navigates", () => {
        expect(drawerRowContaining(">Event<")).toContain('href="/events"');
        expect(drawerRowContaining(">Masuk<")).toContain('href="/login"');
    });

    test("the disabled state is VISIBLE, and hover cannot fire on it", () => {
        // Dimmed and unmistakably non-interactive, without giving up the primary CTA's colours.
        expect(DESKTOP_CTA).toContain("cursor-not-allowed");
        expect(DESKTOP_CTA).toContain("opacity-40");

        // `cn` is `tailwind-merge`, so the override DROPS the variant's own hover fill. If it did
        // not, the CTA would still brighten under the pointer — the one cue that says clickable.
        expect(DESKTOP_CTA).not.toContain("hover:bg-ink-800");
        expect(DESKTOP_CTA).toContain("hover:bg-ink-900");

        const ctaRow = drawerRowContaining("Buat event");

        expect(ctaRow).toContain("cursor-not-allowed");
        expect(ctaRow).toContain("opacity-50");
    });
});

describe("no route in the header leads to the CTA", () => {
    test("the item definition carries NO href at all", () => {
        const definition = HEADER_SOURCE.split("\n").find((line) =>
            line.includes("const BUAT_EVENT_ITEM")
        );

        expect(definition).toBeDefined();
        expect(definition).toContain('"Buat event"');
        expect(definition).toContain("disabled: true");
        expect(definition).not.toContain("href");
    });

    test("the create-event route is not reachable from the header code", () => {
        // Not a single route literal survives in the header: the old `href` is gone, and no
        // replacement was pointed at /login, /create-event or the dashboard either.
        expect(HEADER_SOURCE).not.toContain("/dashboard/events");
        expect(HEADER_SOURCE).not.toContain("/create-event");
    });

    test("the label has ONE definition, consumed by both surfaces", () => {
        // One literal, so the desktop control and the drawer row cannot disagree about the CTA,
        // and a second hardcoded link could not hide somewhere else in the header.
        expect(HEADER_SOURCE.match(/"Buat event"/g) ?? []).toHaveLength(1);

        expect(HEADER_SOURCE).toContain("{BUAT_EVENT_ITEM.label}");
        expect(HEADER_SOURCE).toContain("BUAT_EVENT_ITEM,");
    });

    test("there is no redirect, no router call and no preventDefault workaround", () => {
        for (const source of [HEADER_SOURCE, LINKS_SOURCE]) {
            expect(source).not.toContain("preventDefault");
            expect(source).not.toContain("useRouter");
            expect(source).not.toMatch(/router\.(push|replace)/);
            expect(source).not.toMatch(/\bredirect\(/);
            expect(source).not.toContain("window.location");
        }
    });

    test("the disabled row is rendered from the item's own flag, with no handler", () => {
        expect(LINKS_SOURCE).toMatch(/item\.disabled/);
        expect(LINKS_SOURCE).toContain("type=\"button\"");
        expect(LINKS_SOURCE).toContain("disabled");

        // The disabled branch is the button, with no `onClick` — nothing to intercept, because
        // nothing fires. The interactive branch keeps its own handler.
        const disabledBranch = LINKS_SOURCE.slice(
            LINKS_SOURCE.indexOf("item.disabled"),
            LINKS_SOURCE.indexOf(") : (", LINKS_SOURCE.indexOf("item.disabled"))
        );

        expect(disabledBranch).toContain("<button");
        expect(disabledBranch).not.toContain("onClick");
        expect(LINKS_SOURCE).toContain("onClick={closeDrawer}");
    });

    test("the disabled treatment is a shared, documented class on the nav geometry", () => {
        // One definition of "dimmed and inert", next to the variant it layers onto.
        expect(NAV_SOURCE).toContain("export const HEADER_NAV_DISABLED");
        expect(NAV_SOURCE).toContain("cursor-not-allowed");
        expect(NAV_SOURCE).toContain("hover:bg-ink-900");

        // And the header actually consumes it, on top of the variant the CTA always used.
        expect(HEADER_SOURCE).toContain("HEADER_NAV_DISABLED");
        expect(HEADER_SOURCE).toContain("HEADER_NAV_VARIANT.primary");
    });
});

describe("the create-event route was NOT removed", () => {
    test("the page and its other entry points are untouched", () => {
        expect(fs.existsSync(path.join(ROOT, CREATE_EVENT_PAGE))).toBe(true);
        expect(read(CREATE_EVENT_PAGE)).toContain("export default async function");

        // Still reached from the surfaces that own it: the public empty state, the dashboard
        // shell's nav and the storefront's own call to action.
        expect(code(read(PUBLIC_EVENTS_PAGE))).toContain(
            'href: "/dashboard/events"'
        );
        expect(code(read("components/dashboard/DashboardAppShell.tsx"))).toContain(
            'href: "/dashboard/events"'
        );
    });
});
