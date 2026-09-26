/**
 * ==========================================
 * AUTH BRANDING — DATABASE-DRIVEN, WITH A REAL FALLBACK
 * ==========================================
 *
 * The sign-in and sign-up screens render the platform's configured branding, which lives in
 * ONE place: `PlatformSetting.logoUrl` / `PlatformSetting.platformName`, read through
 * `getApplicationBranding()`. This suite pins the properties that make that true:
 *
 *   1. THE LOCKUP renders a configured logo AND a configured name, and falls back to the
 *      built-in mark/wordmark when either is missing — never a broken image.
 *   2. A LOGO REFERENCE IS ONLY SERVED WHEN THE ASSET EXISTS. `brandingLogoExists` is the
 *      read-side guard, and a non-branding or dangling URL resolves to "no logo".
 *   3. A LONG NAME does not break the layout: it is truncatable, not unconstrained.
 *   4. BOTH AUTH PAGES resolve branding SERVER-SIDE and pass it down — no client fetch, so
 *      the logo is in the first painted frame.
 *   5. BOTH AUTH FORMS consume the SAME prop shape and render the SAME lockup component, so
 *      login and register cannot drift into two branding systems.
 *
 * These are deliberately source-level plus a pure render: the alternative would be a browser
 * test against a database row, and the property under test is the WIRING, not the query.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import Brand from "@/components/Brand";
import { brandingLogoExists } from "@/lib/branding/logo";

const ROOT = path.resolve(__dirname, "..", "..");

function read(relative: string): string {
    return readFileSync(path.join(ROOT, relative), "utf8");
}

/** Comments removed: prose about branding is not the wiring. */
function readCode(relative: string): string {
    return read(relative)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

/* ==================================================================================
 * 1. THE LOCKUP — CONFIGURED VALUE, OR THE BUILT-IN FALLBACK
 * ================================================================================== */

describe("the brand lockup renders configured branding, with a safe fallback", () => {
    it("renders the configured logo and the configured name together", () => {
        const html = renderToStaticMarkup(
            createElement(Brand, {
                logoSrc: "/api/uploads/branding/1-qa.png",
                name: "EventKita.ID",
            })
        );

        expect(html).toContain('src="/api/uploads/branding/1-qa.png"');
        expect(html).toContain("<img");

        // The configured name, not the literal default.
        expect(html).toContain("EventKita");
        expect(html).toContain(".ID");
    });

    it("falls back to the built-in mark and wordmark when nothing is configured", () => {
        const html = renderToStaticMarkup(createElement(Brand, {}));

        expect(html).not.toContain("<img");
        expect(html).toContain("TK");
        expect(html).toContain("TinggalKlik");
    });

    it("treats a blank configured name as unset rather than rendering empty chrome", () => {
        const html = renderToStaticMarkup(createElement(Brand, { name: "   " }));

        expect(html).toContain("TinggalKlik");
    });

    it("keeps a long configured name usable — the wordmark is truncatable, not unconstrained", () => {
        const long = "TinggalKlik Indonesia Nusantara Ticketing Platform.Co";
        const html = renderToStaticMarkup(createElement(Brand, { name: long }));

        // The name is present…
        expect(html).toContain("TinggalKlik Indonesia Nusantara Ticketing Platform");
        // …and the span that carries it can ellipsize instead of pushing the layout.
        expect(html).toContain("truncate");
    });
});

/* ==================================================================================
 * 2. A LOGO REFERENCE IS ONLY SERVED WHEN THE ASSET EXISTS
 * ================================================================================== */

describe("a dangling or non-branding logo reference resolves to no logo", () => {
    it("refuses a null/empty reference", async () => {
        await expect(brandingLogoExists(null)).resolves.toBe(false);
        await expect(brandingLogoExists(undefined)).resolves.toBe(false);
        await expect(brandingLogoExists("")).resolves.toBe(false);
    });

    it("refuses a reference that is not a stored branding asset", async () => {
        for (const hostile of [
            "/logo.png",
            "https://cdn.example.com/logo.png",
            "/api/uploads/branding/../../.env",
            "/api/uploads/branding/",
        ]) {
            await expect(brandingLogoExists(hostile)).resolves.toBe(false);
        }
    });

    it("refuses a well-formed reference whose file is gone", async () => {
        await expect(
            brandingLogoExists(
                "/api/uploads/branding/does-not-exist-qa-1234.png"
            )
        ).resolves.toBe(false);
    });
});

/* ==================================================================================
 * 3. THE RESOLVER EXPOSES BOTH HALVES THE LOCKUP NEEDS
 * ================================================================================== */

describe("getApplicationBranding is the single branding read model", () => {
    const settings = readCode("lib/app-settings.ts");

    it("returns the configured name as well as the logo", () => {
        expect(settings).toContain("export type ApplicationBranding");
        expect(settings).toContain("platformName: string;");
        expect(settings).toContain("platformName: settings.platformName");
    });

    it("keeps a defined answer when the settings row is absent", () => {
        // The fallback name is a constant, so a fresh deployment is branded, not blank.
        expect(settings).toContain("FALLBACK_PLATFORM_NAME");
    });
});

/* ==================================================================================
 * 4. BOTH AUTH PAGES RESOLVE BRANDING SERVER-SIDE
 * ================================================================================== */

describe("login and register resolve branding on the server, not on the client", () => {
    const pages: Array<[string, string]> = [
        ["app/login/page.tsx", "LoginForm"],
        ["app/register/page.tsx", "RegisterForm"],
    ];

    it.each(pages)("%s reads the configured branding", (file) => {
        const code = readCode(file);

        expect(code).toContain("getApplicationBranding");
        // Overlapped with the scope read rather than sequenced after it.
        expect(code).toContain("getApplicationBranding(),");
    });

    it.each(pages)("%s passes the branding into the form", (file) => {
        const code = readCode(file);

        expect(code).toContain("branding={branding}");
    });

    it.each(pages)("%s stays a server component (no client-side fetch)", (file) => {
        const code = readCode(file);

        expect(code).not.toContain('"use client"');
        expect(code).not.toContain("fetch(");
    });

    it("both pages read the SAME resolver from the SAME module", () => {
        for (const [file] of pages) {
            expect(readCode(file)).toContain('from "@/lib/app-settings"');
        }
    });
});

/* ==================================================================================
 * 5. BOTH FORMS RENDER THE SAME LOCKUP WITH THE SAME PROPS
 * ================================================================================== */

describe("login and register share one branding prop shape and one lockup", () => {
    const forms = [
        "components/auth/LoginForm.tsx",
        "components/auth/RegisterForm.tsx",
    ];

    it.each(forms)("%s accepts the DB branding prop", (file) => {
        const code = readCode(file);

        expect(code).toContain("branding: ApplicationBranding");
        expect(code).toContain('from "@/lib/app-settings"');
    });

    it.each(forms)("%s forwards the branding to its shell", (file) => {
        expect(readCode(file)).toContain("branding={branding}");
    });

    it.each(forms)("%s renders the configured logo and name in its own lockup", (file) => {
        const code = readCode(file);

        expect(code).toContain("<Brand");
        expect(code).toContain("logoSrc={branding.logoUrl}");
        expect(code).toContain("name={branding.platformName}");
    });

    it("the shared shell takes the branding as a required prop", () => {
        const shell = readCode("components/auth/LoginShell.tsx");

        expect(shell).toContain("branding: ApplicationBranding");
        expect(shell).toContain("logoSrc={branding.logoUrl}");
        expect(shell).toContain("name={branding.platformName}");
    });
});
