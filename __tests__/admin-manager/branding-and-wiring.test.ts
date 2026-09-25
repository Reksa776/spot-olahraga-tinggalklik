/**
 * ==========================================
 * PHASE 32 — BRANDING + ENFORCEMENT WIRING
 * ==========================================
 *
 * Two halves, both about the same property: the configured logo and the availability switch
 * must be enforced and rendered in ONE place each, and the enforcement must exist where the
 * request actually arrives.
 *
 *   PART A — the lockup. `components/Brand.tsx` renders the configured logo when there is
 *            one, the built-in mark when there is not, and links to `/` either way. That
 *            fallback is what makes "no broken image, no 404, no empty gap" a property
 *            rather than a defensive handler.
 *
 *   PART B — the wiring. Static assertions that the server-side enforcement points exist and
 *            that the client/server split keeps the logo a single source of truth. These are
 *            deliberately source-level checks: the alternative is a browser test of a closed
 *            site, and a redirect that only works in a browser is not the control the brief
 *            asked for.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import Brand from "@/components/Brand";
import { brandingLogoDir } from "@/lib/branding/logo";
import { buildDashboardNav } from "@/components/dashboard/DashboardAppShell";
import type { DashboardCapabilities } from "@/lib/dashboard/scope";

const ROOT = path.resolve(__dirname, "..", "..");

function read(relative: string): string {
    return readFileSync(path.join(ROOT, relative), "utf8");
}

/* ==================================================================================
 * PART A — THE LOCKUP
 * ================================================================================== */

describe("the brand lockup renders the configured logo, with a real fallback", () => {
    test("with a configured logo it renders the image AND the wordmark", () => {
        const html = renderToStaticMarkup(
            createElement(Brand, { logoSrc: "/api/uploads/branding/1-a.png" })
        );

        expect(html).toContain('src="/api/uploads/branding/1-a.png"');
        expect(html).toContain("<img");
        // The `[LOGO] Application Name` shape the brief asks for.
        expect(html).toContain("TinggalKlik");

        // Decorative: the wordmark already names the destination, so the image must not be
        // announced twice.
        expect(html).toContain('aria-hidden="true"');
    });

    test("without a logo it renders the built-in mark and NO img element", () => {
        const html = renderToStaticMarkup(createElement(Brand, {}));

        expect(html).not.toContain("<img");
        expect(html).toContain("TK");
        expect(html).toContain("TinggalKlik");
    });

    test("an explicit null (a REMOVED logo) falls back exactly like no logo", () => {
        const nulled = renderToStaticMarkup(
            createElement(Brand, { logoSrc: null })
        );
        const omitted = renderToStaticMarkup(createElement(Brand, {}));

        expect(nulled).toBe(omitted);
        expect(nulled).not.toContain("<img");
    });

    test("the logo is clickable and navigates to the public landing page", () => {
        for (const props of [
            { logoSrc: "/api/uploads/branding/1-a.png" },
            { logoSrc: null },
        ]) {
            const html = renderToStaticMarkup(createElement(Brand, props));

            // A normal internal anchor to `/` — the brief's requirement, and not a
            // `window.location` assignment.
            expect(html).toContain('href="/"');
        }
    });
});

/* ==================================================================================
 * PART B — ONE SOURCE OF TRUTH, TWO SURFACES
 * ================================================================================== */

describe("landing page and dashboard read the SAME branding source", () => {
    test("both public chrome surfaces pass the configured logo into the shared lockup", () => {
        for (const file of [
            "components/ticketing/SiteHeader.tsx",
            "components/ticketing/SiteFooter.tsx",
        ]) {
            const source = read(file);

            expect(source).toContain("getApplicationBranding");
            expect(source).toContain("<Brand");
            expect(source).toContain("logoSrc");
        }
    });

    test("the dashboard threads the same value from the layout down to the sidebar", () => {
        // The layout is the only place that may read it (a client component cannot), and the
        // value travels shell → nav so the desktop rail and the mobile top bar agree.
        expect(read("app/dashboard/layout.tsx")).toContain("getApplicationBranding");
        expect(read("app/dashboard/layout.tsx")).toContain("logoSrc");

        for (const file of [
            "components/dashboard/DashboardAppShell.tsx",
            "components/dashboard/DashboardShell.tsx",
            "components/dashboard/DashboardNav.tsx",
        ]) {
            const source = read(file);

            expect({ file, hasLogoSrc: source.includes("logoSrc") }).toEqual({
                file,
                hasLogoSrc: true,
            });
        }
    });

    test("there is no second logo configuration anywhere", () => {
        // The ONLY place a logo reference may be persisted is `PlatformSetting.logoUrl`,
        // written by the application service. A second field (a dashboard logo, a footer
        // logo) would be exactly the duplicate configuration the brief forbids.
        const service = read("lib/application/service.ts");

        expect(service).toContain("logoUrl");
        expect(read("lib/app-settings.ts")).toContain("logoUrl");

        // There is no store-setting write path for a logo at all.
        expect(read("lib/store-settings.ts")).not.toContain("logo");
    });
});

/* ==================================================================================
 * PART C — THE ENFORCEMENT POINTS EXIST, SERVER-SIDE
 * ================================================================================== */

describe("maintenance enforcement is server-side and centralised", () => {
    test("the ROOT LAYOUT is the page enforcement point", () => {
        const layout = read("app/layout.tsx");

        // Server-side, before any page renders — and reading the role from the session.
        expect(layout).toContain("maintenanceBlocksPage");
        expect(layout).toContain("MAINTENANCE_PATH");
        expect(layout).toContain("redirect(");
        expect(layout).toContain("auth()");
        // The path comes from the proxy, and the decision function is the shared one.
        expect(layout).toContain("x-pathname");
    });

    test("the proxy forwards the request path — and does not decide availability itself", () => {
        const proxy = read("proxy.ts");

        expect(proxy).toContain('requestHeaders.set("x-pathname", pathname)');
        // It must NOT read the maintenance flag: the Edge runtime has no Prisma, so a decision
        // here would be a decision without the database.
        expect(proxy).not.toContain("maintenanceMode");
        expect(proxy).not.toContain("maintenanceBlocksPage");
    });

    test("both money-moving endpoints refuse while maintenance is ON", () => {
        for (const file of [
            "app/api/ticketing/checkout/route.ts",
            "app/api/ticketing/orders/[orderNumber]/pay/route.ts",
        ]) {
            const source = read(file);

            expect({ file, guarded: source.includes("assertPurchasingAvailable") }).toEqual(
                { file, guarded: true }
            );
        }
    });

    test("the public catalogue endpoints close with the page that renders them", () => {
        // "Operational public APIs must respect maintenance state": these four ARE the public
        // application in JSON form, so serving a live catalogue while the HTML says the site is
        // closed would make the state advisory rather than real.
        for (const file of [
            "app/api/events/route.ts",
            "app/api/events/[slug]/route.ts",
            "app/api/events/[slug]/share/route.ts",
            "app/api/sports/route.ts",
        ]) {
            const source = read(file);

            expect({ file, guarded: source.includes("assertNotInMaintenance") }).toEqual({
                file,
                guarded: true,
            });
        }
    });

    test("and the endpoints that must keep answering are NOT guarded", () => {
        // The exemptions are the point: a probe, the sign-in machinery and the cron tick must
        // survive maintenance, and an asset route that stopped answering would break the logo
        // on the maintenance page itself.
        for (const file of [
            "app/api/health/route.ts",
            "app/api/health/ready/route.ts",
            "app/api/internal/jobs/tick/route.ts",
            "app/api/uploads/branding/[filename]/route.ts",
            "app/api/uploads/events/[filename]/route.ts",
        ]) {
            const source = read(file);

            expect({ file, guarded: source.includes("assertNotInMaintenance") }).toEqual({
                file,
                guarded: false,
            });
        }
    });

    test("health, auth and asset routes stay reachable while maintenance is ON", () => {
        const proxy = read("proxy.ts");

        // `/api/health` and `/api/auth/` are public prefixes, and the branding asset route is
        // public because the maintenance page itself renders the logo.
        expect(proxy).toContain('"/api/health"');
        expect(proxy).toContain('"/api/auth/"');
        expect(proxy).toContain('"/api/uploads/branding/"');
    });

    test("the ADMIN-only endpoints are protected and permission-guarded", () => {
        // The proxy classifies them as session-protected…
        expect(read("proxy.ts")).toContain('"/api/admin/"');

        // …and the services re-guard every operation, so a MANAGER session is refused even
        // with a valid cookie, a correct CSRF token and a well-formed body.
        const service = read("lib/application/service.ts");

        expect(service).toContain("PERMISSIONS.MAINTENANCE_MANAGE");
        expect(service).toContain("PERMISSIONS.BRANDING_MANAGE");
        expect(service).toContain("PERMISSIONS.APPLICATION_SETTINGS");
    });
});

/* ==================================================================================
 * PART D — THE MENU IS A RENDERING OF THE DECISION
 * ================================================================================== */

function caps(over: Partial<DashboardCapabilities> = {}): DashboardCapabilities {
    return {
        canManageSports: false,
        canManageGlobalVenues: false,
        canManagePlatformPic: false,
        canReadEvents: false,
        canManageEvents: false,
        canReadOrders: false,
        canReadPayments: false,
        canAssignPic: false,
        canManageVenues: false,
        canManageSettlements: false,
        canReadReports: false,
        canCheckIn: false,
        hasTenantAccess: false,
        hasActivePicProfile: false,
        hasPlatformRoleEntry: false,
        canManageApplicationSettings: false,
        canManageMaintenance: false,
        canManageBranding: false,
        canManageUsers: false,
        ...over,
    };
}

describe("the SYSTEM section of the dashboard menu", () => {
    const SYSTEM_HREFS = [
        "/dashboard/settings/application",
        "/dashboard/settings/branding",
        "/dashboard/settings/maintenance",
    ];

    function hrefs(capabilities: DashboardCapabilities): string[] {
        return buildDashboardNav(capabilities)
            .flatMap((group) => group.items)
            .map((item) => item.href);
    }

    function sections(capabilities: DashboardCapabilities): string[] {
        return buildDashboardNav(capabilities).map((group) => group.label);
    }

    test("an ADMIN sees a Sistem section with all three destinations", () => {
        const hrefsForAdmin = hrefs(
            caps({
                canManageApplicationSettings: true,
                canManageMaintenance: true,
                canManageBranding: true,
                hasTenantAccess: true,
                canReadEvents: true,
            })
        );

        expect(sections(caps({ canManageMaintenance: true }))).toContain("Sistem");

        for (const href of SYSTEM_HREFS) {
            expect(hrefsForAdmin).toContain(href);
        }
    });

    test("a MANAGER sees NO system destination and NO Sistem section", () => {
        // A fully operational operator: every operational row, zero application control.
        const manager = caps({
            hasTenantAccess: true,
            canReadEvents: true,
            canManageEvents: true,
            canReadOrders: true,
            canReadPayments: true,
            canAssignPic: true,
            canManageVenues: true,
            canManageSettlements: true,
            canReadReports: true,
            canCheckIn: true,
        });

        expect(sections(manager)).not.toContain("Sistem");

        for (const href of SYSTEM_HREFS) {
            expect(hrefs(manager)).not.toContain(href);
        }

        // …and the operational rows are all still present: the section is absent, not the menu.
        for (const href of [
            "/dashboard/events",
            "/dashboard/orders",
            "/dashboard/customers",
            "/dashboard/payments",
            "/dashboard/refunds",
            "/dashboard/settlements",
            "/dashboard/check-in",
            "/dashboard/reports",
            "/dashboard/venues",
        ]) {
            expect(hrefs(manager)).toContain(href);
        }
    });

    test("each row is gated by its OWN capability, not by one shared flag", () => {
        const onlyBranding = hrefs(caps({ canManageBranding: true }));

        expect(onlyBranding).toContain("/dashboard/settings/branding");
        expect(onlyBranding).not.toContain("/dashboard/settings/application");
        expect(onlyBranding).not.toContain("/dashboard/settings/maintenance");
    });
});

/* ==================================================================================
 * PART E — UPLOAD SAFETY (what the branding path must NOT do)
 * ================================================================================== */

describe("the logo upload contract", () => {
    const logo = read("lib/branding/logo.ts");

    test("it validates by magic bytes and strips metadata, reusing the existing pipeline", () => {
        expect(logo).toContain("stripImageMetadata");
        expect(logo).toContain("detectImageFormat");
        // The declared MIME type is never the decision.
        expect(logo).toContain("file.type");
    });

    test("SVG is not accepted (no sanitizer exists in this codebase)", () => {
        expect(logo).not.toContain("svg");
        expect(read("lib/images/format.ts")).not.toContain('"svg"');
    });

    test("the stored filename is generated server-side from random bytes", () => {
        expect(logo).toContain("crypto.randomBytes");
        // The original client filename is never used for the filesystem.
        expect(logo).not.toContain("file.name");
    });

    test("the asset dir lives under the persistent upload tree, never build output", () => {
        // Asserted FUNCTIONALLY rather than by grepping the source: the source legitimately
        // NAMES `.next` and `node_modules` in its own documentation of what it avoids, and a
        // substring assertion would fail on the explanation instead of the behaviour.
        const previous = process.env.UPLOAD_DIR;

        try {
            process.env.UPLOAD_DIR = path.join(os.tmpdir(), "phase32-branding-probe");

            expect(brandingLogoDir()).toBe(
                path.join(process.env.UPLOAD_DIR, "branding")
            );

            delete process.env.UPLOAD_DIR;

            const fallback = brandingLogoDir();

            // The default is the persistent `storage/uploads` tree — the same one event
            // imagery and settlement proofs survive rebuilds and restarts in.
            expect(fallback).toContain(path.join("storage", "uploads"));
            expect(fallback).not.toContain(`${path.sep}.next${path.sep}`);
            expect(fallback).not.toContain(`${path.sep}node_modules${path.sep}`);
        } finally {
            if (previous === undefined) {
                delete process.env.UPLOAD_DIR;
            } else {
                process.env.UPLOAD_DIR = previous;
            }
        }
    });

    test("binary data is never stored in the database — only a URL", () => {
        // `logoUrl` is a String column; nothing writes a Buffer to it.
        expect(read("prisma/schema.prisma")).toContain("logoUrl");
        expect(read("prisma/schema.prisma")).not.toMatch(
            /logoUrl\s+Bytes/
        );
    });
});
