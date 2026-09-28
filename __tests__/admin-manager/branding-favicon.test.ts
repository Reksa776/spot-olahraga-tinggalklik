/**
 * ==========================================
 * FAVICON FOLLOWS THE DB BRANDING LOGO
 * ==========================================
 *
 * The browser tab icon must be the SAME asset the platform is branded with
 * (`PlatformSetting.logoUrl`, resolved by `getApplicationBranding()`), and it must fall back to a
 * static icon — never a broken URL — when no logo is configured.
 *
 * Two properties are pinned here:
 *
 *   1. the pure mapping (`brandingIcons`) — a configured logo is used verbatim for icon, shortcut
 *      and Apple touch icon; a `null` logo resolves to the static fallback;
 *   2. the wiring — the root layout exposes it through `generateMetadata()` and only that field, and
 *      no FILE-BASED icon is left in `app/` (file-based metadata outranks `generateMetadata`, so a
 *      leftover `app/favicon.ico` would make the configured logo impossible to win).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    DEFAULT_FAVICON_PATH,
    brandingIcons,
} from "@/lib/branding/metadata";

function read(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf-8");
}

/** Source with comments removed, so a doc comment cannot satisfy (or defeat) an assertion. */
function code(path: string): string {
    return read(path)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

const STORED_LOGO = "/api/uploads/branding/1700000000000-abcdef0123456789.webp";

describe("brandingIcons — the tab icon IS the configured logo", () => {
    it("uses the configured logo URL verbatim for icon, shortcut and apple", () => {
        const icons = brandingIcons({
            logoUrl: STORED_LOGO,
            platformName: "TinggalKlik.Co",
        });

        expect(icons).toEqual({
            icon: STORED_LOGO,
            shortcut: STORED_LOGO,
            apple: STORED_LOGO,
        });
    });

    it("falls back to the static icon when no logo is configured", () => {
        const icons = brandingIcons({
            logoUrl: null,
            platformName: "TinggalKlik.Co",
        });

        expect(icons.icon).toBe(DEFAULT_FAVICON_PATH);
        expect(icons.shortcut).toBe(DEFAULT_FAVICON_PATH);
        expect(icons.apple).toBe(DEFAULT_FAVICON_PATH);
        // The fallback must be a real, browser-accessible asset, not an empty string.
        expect(DEFAULT_FAVICON_PATH).toBe("/favicon.ico");
    });

    it("derives nothing from the platform name — the LOGO is the only source", () => {
        const icons = brandingIcons({
            logoUrl: STORED_LOGO,
            platformName: "Some Other Name",
        });

        expect(Object.keys(icons).sort()).toEqual(["apple", "icon", "shortcut"]);
        expect(icons.icon).toBe(STORED_LOGO);
    });
});

describe("the root layout exposes the branding icon through generateMetadata", () => {
    const layout = code("app/layout.tsx");

    it("reads the platform branding (not a hardcoded asset)", () => {
        expect(layout).toContain("generateMetadata");
        expect(layout).toContain("getApplicationBranding");
        expect(layout).toContain("brandingIcons");
        // No hardcoded brand asset as the primary production icon.
        expect(layout).not.toMatch(/icons\s*:\s*\{[^}]*"\/?favicon\.ico"/);
    });

    it("sets ONLY the icons and the title TEMPLATE — never a page's description or robots", () => {
        const start = layout.indexOf("export async function generateMetadata");
        const end = layout.indexOf("export default async function RootLayout");
        const block = layout.slice(start, end);

        expect(block).toContain("icons: brandingIcons(branding)");
        expect(block).toContain("title: brandingTitle(branding)");

        // `brandingTitle` resolves to a `{ default, template }` pair: a page's own title is
        // COMPOSED with it rather than overridden, and a route with no title of its own names the
        // platform instead of falling back to its path.
        expect(block).toContain("brandingTitle");

        // description/robots belong to each page; Next merges parent metadata with the page's.
        expect(block).not.toMatch(/\bdescription\s*:/);
        expect(block).not.toMatch(/\brobots\s*:/);
    });

    it("keeps the page metadata intact, with the brand composed rather than spelled out", () => {
        // No page hardcodes the wordmark: `app/login` exports the short feature title, and the one
        // route the layout's template cannot reach (the landing page, which IS that segment)
        // composes it through the same helper.
        expect(read("app/login/page.tsx")).toContain('title: "Login"');
        expect(read("app/page.tsx")).toContain('platformTitle("Home", branding.platformName)');
        // No page spells the brand into a TITLE any more. (`description` copy is a different
        // concern and is deliberately untouched by this change.)
        expect(read("app/login/page.tsx")).not.toMatch(/title:\s*"[^"]*TinggalKlik/);
        expect(read("app/maintenance/page.tsx")).not.toMatch(/title:\s*"[^"]*TinggalKlik/);
        expect(read("app/events/page.tsx")).not.toMatch(/title:\s*"[^"]*TinggalKlik/);
    });
});

describe("the branding source stays the platform setting", () => {
    it("maps only the resolved platform logo, never an organizer/event/avatar asset", () => {
        const helper = code("lib/branding/metadata.ts");

        expect(helper).toContain("branding.logoUrl");
        expect(helper).toContain("DEFAULT_FAVICON_PATH");
        expect(helper).not.toMatch(/organizer/i);
        expect(helper).not.toMatch(/\bevent\b/i);
        expect(helper).not.toMatch(/avatar/i);
    });

    it("still reads `logoUrl` from the `PlatformSetting` singleton", () => {
        const settings = read("lib/app-settings.ts");

        expect(settings).toContain("platformSetting");
        expect(settings).toContain("logoUrl");
        expect(settings).toContain("getApplicationBranding");
    });

    it("removed the file-based icon that would outrank generateMetadata", () => {
        // `app/favicon.ico` is file-based metadata and would override `generateMetadata().icons`.
        expect(existsSync(resolve(process.cwd(), "app/favicon.ico"))).toBe(false);
        // The static fallback is preserved, now served from `public/`.
        expect(existsSync(resolve(process.cwd(), "public/favicon.ico"))).toBe(true);
    });
});
