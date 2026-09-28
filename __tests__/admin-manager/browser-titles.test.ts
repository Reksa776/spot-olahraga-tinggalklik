/**
 * ==========================================
 * EVERY ROUTE HAS A FEATURE-SPECIFIC BROWSER TITLE
 * ==========================================
 *
 * The tab must say WHICH page is open, and it must name the platform exactly once. The architecture
 * that makes both true at once is pinned here:
 *
 *   one brand source   the root layout composes `%s — <PlatformSetting.platformName>` from the SAME
 *                      `getApplicationBranding()` read that already drives the favicon and the
 *                      lockup, so renaming the platform in the dashboard renames the tab;
 *   one place to look  every page exports a SHORT feature title ("Events", "Detail Pesanan") and no
 *                      page spells the wordmark into a title — that is what prevents the suffix from
 *                      being duplicated and what makes the format uniform;
 *   no page left out   EVERY `app/**\/page.tsx` in the repository defines a title, so no route falls
 *                      back to a path-derived or empty title;
 *   the root page      `app/page.tsx` IS the segment the template is defined in, so it composes its
 *                      own full title through the same helper instead of relying on inheritance;
 *   dynamic pages      an order detail page names its own order in the title, read from the ROUTE —
 *                      so it asks the database nothing and cannot leak another tenant's row.
 *
 * Source inspection is the right tool: this repository has no DOM testing library, and the properties
 * above are structural (which file exports what). The one RUNTIME property — that Next actually
 * renders the composed title into `<title>` — cannot be asserted without a browser session, and the
 * verification for it is the built output, not this suite.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";

import { brandingTitle, platformTitle, TITLE_SEPARATOR, titleTemplate } from "@/lib/metadata";

function read(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf-8");
}

/** Source with comments removed, so a doc comment cannot satisfy (or defeat) an assertion. */
function code(path: string): string {
    return read(path)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every page in the application, discovered from the filesystem rather than listed by hand — a
 * hand-written list is exactly how a new route ends up without a title.
 */
const APP_PAGES = readdirSync(resolve(process.cwd(), "app"), { recursive: true })
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.split(sep).join("/"))
    .filter((entry) => entry === "page.tsx" || entry.endsWith("/page.tsx"))
    .map((entry) => `app/${entry}`)
    .sort();

const LAYOUT = "app/layout.tsx";
const METADATA_HELPER = "lib/metadata.ts";
const HOME_PAGE = "app/page.tsx";

/* ==================================================================================
 * 1. THE HELPERS — PURE, AND THE ONLY PLACE THE FORMAT LIVES
 * ================================================================================== */

describe("the title format lives in one helper", () => {
    it("composes `<feature> — <brand>` with the shared separator", () => {
        expect(TITLE_SEPARATOR).toBe(" — ");
        expect(platformTitle("Events", "TinggalKlik.Co")).toBe("Events — TinggalKlik.Co");
        expect(platformTitle("Detail Pesanan", "TinggalKlik.Co")).toBe(
            "Detail Pesanan — TinggalKlik.Co"
        );
    });

    it("builds the Next.js template from the SAME separator", () => {
        const template = titleTemplate("TinggalKlik.Co");

        expect(template).toBe("%s — TinggalKlik.Co");
        expect(template).toContain("%s");
        // The composed form and the templated form must agree, or the home page and the rest of the
        // application would render two different shapes of title.
        const brand = "TinggalKlik.Co";

        expect(template.replace("%s", "Events")).toBe(platformTitle("Events", brand));
    });

    it("follows a renamed platform — nothing here hardcodes the brand", () => {
        const branding = { logoUrl: null, platformName: "Tiket Kita" };

        expect(brandingTitle(branding)).toEqual({
            default: "Tiket Kita",
            template: "%s — Tiket Kita",
        });
        expect(platformTitle("Events", "Tiket Kita")).toBe("Events — Tiket Kita");
    });

    it("a template always ships a default, which Next.js requires", () => {
        const title = brandingTitle({ logoUrl: null, platformName: "TinggalKlik.Co" });

        expect(title).toEqual({
            default: "TinggalKlik.Co",
            template: "%s — TinggalKlik.Co",
        });
    });

    it("does not read the database or the request itself — it takes the branding it is given", () => {
        const source = code(METADATA_HELPER);

        expect(source).not.toContain("prisma");
        expect(source).not.toContain("getApplicationSettings");
        expect(source).not.toContain("server-only");
        // The helper is pure: the ONE type import is the branding shape it maps.
        expect(source).toContain("ApplicationBranding");
    });
});

/* ==================================================================================
 * 2. THE LAYOUT — ONE TEMPLATE, FROM THE BRANDING SOURCE
 * ================================================================================== */

describe("the root layout owns the brand suffix", () => {
    const layout = code(LAYOUT);

    it("resolves the title from the same branding read as the favicon", () => {
        expect(layout).toContain("brandingTitle(branding)");
        expect(layout).toContain("getApplicationBranding");
        // One read for both: the title and the icon cannot disagree about the platform.
        expect(layout.match(/getApplicationBranding\(\)/g)?.length).toBe(1);
    });

    it("never hardcodes a page title, a brand string or a description", () => {
        const start = layout.indexOf("export async function generateMetadata");
        const end = layout.indexOf("export default async function RootLayout");
        const block = layout.slice(start, end);

        expect(block).not.toContain("TinggalKlik.Co");
        expect(block).not.toMatch(/\bdescription\s*:/);
        expect(block).not.toMatch(/\brobots\s*:/);
    });
});

/* ==================================================================================
 * 3. NO PAGE IS LEFT WITHOUT A TITLE
 * ================================================================================== */

describe("every route defines its own title", () => {
    it("discovers the whole application, not a sample", () => {
        expect(APP_PAGES.length).toBeGreaterThanOrEqual(39);
        // The four page groups the audit named must all be present in the discovery.
        expect(APP_PAGES).toContain("app/dashboard/page.tsx");
        expect(APP_PAGES).toContain("app/login/page.tsx");
        expect(APP_PAGES).toContain("app/e/[slug]/page.tsx");
        expect(APP_PAGES).toContain("app/ticketing/tickets/page.tsx");
    });

    it.each(APP_PAGES)("%s exports a title", (page) => {
        const source = code(page);

        const exportsMetadata =
            source.includes("export const metadata") ||
            source.includes("export function generateMetadata") ||
            source.includes("export async function generateMetadata");

        expect({ page, exportsMetadata }).toEqual({ page, exportsMetadata: true });

        // A `title` inside the metadata region — either a string or an object with
        // `template`/`default`/`absolute`.
        expect({ page, hasTitle: /\btitle\s*:/.test(source) }).toEqual({
            page,
            hasTitle: true,
        });
    });

    it.each(APP_PAGES)("%s never spells the brand into a title", (page) => {
        // The suffix is the layout's job. A page that writes it out renders it twice.
        const titles = [...code(page).matchAll(/\btitle\s*:\s*"([^"]*)"/g)].map(
            (match) => match[1]
        );

        for (const title of titles) {
            expect({ page, title }).toEqual({
                page,
                title: expect.not.stringContaining("TinggalKlik"),
            });
        }
    });
});

/* ==================================================================================
 * 4. THE FEATURE TITLE EACH GROUP CARRIES
 * ================================================================================== */

describe("each route names its own feature", () => {
    it.each([
        ["app/dashboard/page.tsx", "Dashboard"],
        ["app/dashboard/events/page.tsx", "Events"],
        ["app/dashboard/orders/page.tsx", "Orders"],
        ["app/dashboard/payments/page.tsx", "Payments"],
        ["app/dashboard/customers/page.tsx", "Customers"],
        ["app/dashboard/refunds/page.tsx", "Refunds"],
        ["app/dashboard/settlements/page.tsx", "Settlements"],
        ["app/dashboard/venues/page.tsx", "Venues"],
        ["app/dashboard/pic/page.tsx", "PIC"],
        ["app/dashboard/users/page.tsx", "Users"],
        ["app/dashboard/reports/page.tsx", "Reports"],
        ["app/dashboard/check-in/page.tsx", "Check-in"],
        ["app/dashboard/settings/page.tsx", "Settings"],
        ["app/dashboard/settings/application/page.tsx", "Application Settings"],
        ["app/dashboard/settings/branding/page.tsx", "Branding"],
        ["app/dashboard/settings/maintenance/page.tsx", "Maintenance"],
        ["app/dashboard/settings/sports/page.tsx", "Sports"],
        ["app/dashboard/settings/venues/page.tsx", "Venues"],
    ])("%s is titled %s", (page, title) => {
        expect(code(page)).toContain(`title: "${title}"`);
    });

    it.each([
        ["app/dashboard/events/new/page.tsx", "Buat Event"],
        ["app/dashboard/events/[id]/page.tsx", "Detail Event"],
        ["app/dashboard/events/[id]/check-in/page.tsx", "Check-in Event"],
        ["app/dashboard/settlements/[id]/page.tsx", "Detail Pencairan"],
        ["app/dashboard/pic/[id]/page.tsx", "Detail PIC"],
    ])("%s (a nested/detail route) is titled %s", (page, title) => {
        expect(code(page)).toContain(`title: "${title}"`);
    });

    it.each([
        ["app/events/page.tsx", "Events"],
        ["app/faq/page.tsx", "FAQ"],
        ["app/kontak/page.tsx", "Kontak"],
        ["app/refund-policy/page.tsx", "Kebijakan Refund"],
        ["app/syarat-ketentuan/page.tsx", "Syarat & Ketentuan"],
        ["app/maintenance/page.tsx", "Maintenance"],
        ["app/login/page.tsx", "Login"],
        ["app/register/page.tsx", "Register"],
    ])("%s (public/auth) is titled %s", (page, title) => {
        expect(code(page)).toContain(`title: "${title}"`);
    });

    it.each([
        ["app/ticketing/orders/page.tsx", "Pesanan saya"],
        ["app/ticketing/tickets/page.tsx", "Tiket saya"],
        ["app/ticketing/tickets/[ticketCode]/page.tsx", "Tiket elektronik"],
        ["app/ticketing/refunds/page.tsx", "Refund saya"],
    ])("%s (customer) is titled %s", (page, title) => {
        expect(code(page)).toContain(`title: "${title}"`);
    });
});

/* ==================================================================================
 * 5. THE ROOT PAGE COMPOSES ITS OWN (THE TEMPLATE CANNOT REACH IT)
 * ================================================================================== */

describe("the landing page composes its full title", () => {
    it("uses the shared helper with `absolute`, so a template cannot double the suffix", () => {
        const source = code(HOME_PAGE);

        expect(source).toContain("generateMetadata");
        expect(source).toContain('platformTitle("Home", branding.platformName)');
        expect(source).toContain("title: { absolute:");
        expect(source).toContain("getApplicationBranding");
    });

    it("still carries a description, so the landing page keeps a rich preview", () => {
        const source = code(HOME_PAGE);

        expect(source).toContain("description:");
        expect(source).toContain("event olahraga");
    });
});

/* ==================================================================================
 * 6. DYNAMIC ROUTES NAME THEIR ENTITY FROM THE URL
 * ================================================================================== */

describe("a detail route names its entity without asking the database", () => {
    it.each([
        "app/dashboard/orders/[orderNumber]/page.tsx",
        "app/ticketing/orders/[orderNumber]/page.tsx",
    ])("%s titles itself from the ROUTE parameter", (page) => {
        const source = code(page);

        expect(source).toContain("export async function generateMetadata");
        expect(source).toContain("params: Promise<{ orderNumber: string }>");
        expect(source).toContain("title: `Pesanan ${orderNumber}`");
    });

    it("the dashboard order title reads the param, not a fetched order", () => {
        const start = code("app/dashboard/orders/[orderNumber]/page.tsx").indexOf(
            "export async function generateMetadata"
        );
        const block = code("app/dashboard/orders/[orderNumber]/page.tsx").slice(
            start,
            start + 700
        );

        expect(block).toContain("const { orderNumber } = await params;");
        expect(block).not.toContain("prisma");
        expect(block).not.toContain("getDashboardOrder");
    });

    it("the event detail page keeps its DB-backed entity title", () => {
        const source = code("app/e/[slug]/page.tsx");

        expect(source).toContain("export async function generateMetadata");
        // A configured event name IS the feature title; the layout adds the brand suffix.
        expect(source).toContain("title: event.title");
        // It still degrades to a real title rather than an error page when the slug is unavailable.
        expect(source).toContain('title: "Event tidak ditemukan"');
        // And it never exposes anything but the public title/description.
        expect(source).not.toContain("buyerEmail");
        expect(source).not.toContain("paymentReference");
    });
});

/* ==================================================================================
 * 7. THE 404 IS A PAGE TOO
 * ==================================================================================
 *
 * `not-found.tsx` is not a `page.tsx`, so the discovery above does not reach it — but Next.js
 * renders it INSIDE the root layout and reads its `metadata` export, so it is a route in every way
 * that matters here. It used to be the one surface that fell back to a path-derived title.
 */

describe("the not-found boundary names itself", () => {
    const NOT_FOUND = "app/not-found.tsx";

    it("exports a feature title (the layout still composes the brand)", () => {
        const source = code(NOT_FOUND);

        expect(source).toContain("export const metadata");
        expect(source).toContain('title: "Halaman tidak ditemukan"');
    });

    it("is a server component — a client one could not export metadata", () => {
        expect(code(NOT_FOUND)).not.toContain('"use client"');
    });

    it("the error boundaries are client components and therefore keep the default title", () => {
        // Documented rather than wished for: `error.tsx`/`global-error.tsx` MUST be client components
        // (`reset()` is a client function), and a client module cannot export server metadata. Their
        // title is the layout's `title.default` — the platform name — which is the honest answer for
        // a boundary that has no feature yet.
        for (const file of ["app/error.tsx", "app/global-error.tsx"]) {
            const source = code(file);

            expect({ file, client: source.includes('"use client"') }).toEqual({
                file,
                client: true,
            });
        }
    });
});

/* ==================================================================================
 * 8. PRIVATE SURFACES STAY UNINDEXABLE
 * ================================================================================== */

describe("the existing robots policy is untouched", () => {
    it.each([
        "app/login/page.tsx",
        "app/register/page.tsx",
        "app/maintenance/page.tsx",
        "app/ticketing/orders/page.tsx",
        "app/ticketing/tickets/page.tsx",
        "app/ticketing/refunds/page.tsx",
        "app/ticketing/tickets/[ticketCode]/page.tsx",
    ])("%s is still noindex/nofollow", (page) => {
        expect(code(page)).toContain("robots: { index: false, follow: false }");
    });

    it("a buyer's order page stays noindex after becoming entity-titled", () => {
        expect(code("app/ticketing/orders/[orderNumber]/page.tsx")).toContain(
            "robots: { index: false, follow: false }"
        );
    });
});

/* ==================================================================================
 * 9. NO DUPLICATED OPENGRAPH TITLE
 * ================================================================================== */

describe("OpenGraph inherits the title instead of restating it", () => {
    it.each([
        "app/faq/page.tsx",
        "app/kontak/page.tsx",
        "app/refund-policy/page.tsx",
        "app/syarat-ketentuan/page.tsx",
    ])("%s has no second, drifting openGraph title", (page) => {
        const source = code(page);

        // Next.js inherits the resolved title and the `description` into `openGraph` when a page does
        // not set them, so a copy here could only ever disagree with the tab.
        expect(source).not.toContain("openGraph");
    });

    it("the one page that DOES set openGraph sets it for a reason (a real preview)", () => {
        const source = code("app/e/[slug]/page.tsx");

        // An event share card needs its own image and canonical URL — that is not a title duplicate.
        expect(source).toContain("openGraph");
        expect(source).toContain("images: event.bannerUrl ? [event.bannerUrl] : undefined");
        expect(source).toContain("alternates: { canonical: `/e/${event.slug}` }");
    });
});
