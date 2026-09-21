import { readFileSync } from "node:fs";
import path from "node:path";

import { THEME_BOOTSTRAP_SCRIPT } from "@/components/dashboard/theme/theme-config";

/**
 * ==========================================
 * THEME HYDRATION CONTRACT
 * ==========================================
 *
 * The theme bootstrap runs BEFORE React hydrates, and it can only know what the browser stores —
 * `localStorage` never reaches the server. So there is exactly one way for the document element to
 * hydrate cleanly: the set of attributes the script can write must be small, deliberate, and
 * limited to values the server genuinely cannot know.
 *
 * This suite exists because it was not. The script ended with `d.style.colorScheme = r`, and since
 * "no stored appearance" resolves to `light` rather than to nothing, the write was UNCONDITIONAL: an
 * inline `style="color-scheme: light"` appeared on `<html>` before hydration on every page for every
 * visitor, including anonymous buyers who have never opened the dashboard, and React reported
 *
 *     A tree hydrated but some attributes of the server rendered HTML didn't match the client
 *     properties.  <html lang="id"  - style={{color-scheme:"light"}} >
 *
 * The fix was NOT to suppress the warning: `color-scheme` is a CSS concern and is now declared in
 * `app/globals.css`, keyed off the same `dark` class the script already sets, so that attribute is
 * not written at all any more. That is the first half of the contract below.
 *
 * The second half is the honesty check on what remains. `class`, `data-accent` and `data-chart` are
 * still applied pre-paint by the script, because that is the entire point of it (no flash of the
 * default palette), and no server render can know them. `<html>` therefore carries React's
 * documented escape hatch for an element whose ATTRIBUTES are legitimately client-only — scoped to
 * that one element, and only defensible while `<html>` declares nothing React itself owns.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Source with comments removed: the modules below name the old attribute when explaining the bug. */
function readCode(relativePath: string): string {
    return read(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("theme hydration: the bootstrap writes only client-only attributes", () => {
    it("never touches <html>'s style property or `color-scheme`", () => {
        // The exact shape of the reported mismatch. If either of these reappears, the console
        // warning comes back on every page load for every visitor.
        //
        // `\bstyle\b` rather than a substring: this script DOES contain `color-scheme` inside the
        // `(prefers-color-scheme: dark)` media query it matches against, which is a read of the OS
        // preference and not a write to the document. What must never come back is a reference to
        // the DOM `style` property.
        expect(THEME_BOOTSTRAP_SCRIPT).not.toMatch(/\bstyle\b/);
        expect(THEME_BOOTSTRAP_SCRIPT).not.toMatch(/colorScheme/i);
    });

    it("sets exactly the two attribute palettes and the `dark` class — nothing else", () => {
        const attributes = [
            ...THEME_BOOTSTRAP_SCRIPT.matchAll(/setAttribute\("([^"]*)"/g),
        ].map((match) => match[1]);

        expect(attributes.sort()).toEqual(["data-accent", "data-chart"]);

        const classes = THEME_BOOTSTRAP_SCRIPT.match(
            /classList\.(?:add|remove)\("([^"]*)"\)/g
        );

        expect(classes?.sort()).toEqual([
            'classList.add("dark")',
            'classList.remove("dark")',
        ]);
    });

    it("keeps the pre-paint behaviour it exists for", () => {
        // The three reads that make it a bootstrap rather than a nice-to-have: storage first, the OS
        // preference for `system`, and `light` as the fallback the provider also defaults to.
        expect(THEME_BOOTSTRAP_SCRIPT).toContain("localStorage.getItem");
        expect(THEME_BOOTSTRAP_SCRIPT).toContain("prefers-color-scheme: dark");
        expect(THEME_BOOTSTRAP_SCRIPT).toContain('"light"');
    });
});

describe("theme hydration: color-scheme is CSS, derived from the same class", () => {
    it("declares both modes in the stylesheet, keyed off `html` / `html.dark`", () => {
        const css = read("app/globals.css");

        expect(css).toMatch(/html\s*\{[^}]*color-scheme:\s*light;/);
        expect(css).toMatch(/html\.dark\s*\{[^}]*color-scheme:\s*dark;/);
    });

    it("is not set from JavaScript anywhere else either", () => {
        // The provider re-applies the class while the user is in the dashboard; it must not
        // re-introduce the inline style through the other door.
        const provider = readCode("components/dashboard/theme/theme-provider.tsx");

        expect(provider).not.toContain("style.colorScheme");
        expect(provider).toContain("root.classList.add");
        expect(provider).toContain("root.classList.remove");
    });
});

describe("theme hydration: what suppressHydrationWarning is allowed to cover", () => {
    const layout = readCode("app/layout.tsx");

    it("marks <html> and nothing else", () => {
        // One level deep, on the element that carries the bootstrap's attributes. On <body> (or on a
        // provider) it would start hiding genuine markup mismatches.
        expect((layout.match(/suppressHydrationWarning/g) ?? []).length).toBe(1);
    });

    it("<html> declares no attribute React itself owns, so nothing else can diverge", () => {
        const htmlTag = /<html[^>]*>/.exec(layout)?.[0] ?? "";

        expect(htmlTag).toContain('lang="id"');
        expect(htmlTag).toContain("suppressHydrationWarning");

        // `style` and `className` are the two props React compares against the DOM on hydration.
        // Both must stay absent: the only attributes that can differ are the bootstrap's.
        expect(htmlTag).not.toContain("style");
        expect(htmlTag).not.toContain("className");
    });

    it("still emits the bootstrap from the root, before the app", () => {
        expect(layout).toContain("THEME_BOOTSTRAP_SCRIPT");
        expect(layout).toMatch(/<body>\s*\{[\s\S]*?THEME_BOOTSTRAP_SCRIPT[\s\S]*?<AuthProvider>/);
    });
});
