/*
 * `@/auth` is mocked because `lib/dashboard/scope.ts` imports the `@/lib/authz` barrel, whose
 * guards import the real Auth.js entrypoint — an ESM module Jest cannot parse without this.
 * It is the same one-line mock the rest of the `auth-flow` dashboard suites use, and nothing
 * this file tests touches a session: every helper below is pure.
 */
jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PlatformRole } from "@prisma/client";

import Brand from "@/components/Brand";
import {
    DesktopNavLinks,
    signedInNavItems,
} from "@/components/ticketing/SiteHeader";

import {
    DEFAULT_POST_LOGIN_PATH,
    postLoginDestination,
    resolveSafeCallbackUrl,
} from "@/lib/auth/redirect";
import {
    defaultDestinationForIntent,
    intentForPlatformRole,
} from "@/lib/auth/roles";
import { decideSessionGate } from "@/lib/auth/session-gate";
import type { AuthzScope } from "@/lib/authz";
import {
    canEnterDashboard,
    computeDashboardCapabilities,
    getDashboardPath,
    shouldShowDashboardNav,
} from "@/lib/dashboard/scope";

/**
 * ==========================================
 * DASHBOARD NAVBAR + CUSTOMER LOGIN REDIRECT
 * ==========================================
 *
 * Two behaviours, and they are tested as two different KINDS of claim:
 *
 *   1. The decisions are PURE — `shouldShowDashboardNav(role)` and `postLoginDestination(...)` —
 *      so every role, every hostile `callbackUrl` and the guest case are exercised directly,
 *      with no session, no database and no rendered HTML.
 *   2. The WIRING is asserted against the real sources, because a correct decision nobody calls
 *      is not a feature: `SiteHeader` must ask the helper, render ONE Dashboard destination in
 *      two renderings (desktop link, mobile drawer row), and `MobileMenuLinks` must close the
 *      drawer it navigated from.
 *
 * The security half is deliberately separated at the bottom: hiding a link is UX, and the tests
 * there pin that `/dashboard` still refuses an account without entry rights and that the layout
 * does not consult the navbar's flag.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Strip comments, so prose that NAMES `/dashboard` is not mistaken for a rendered link. */
function readCode(relativePath: string): string {
    return read(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

const SITE_HEADER = "components/ticketing/SiteHeader.tsx";
const MOBILE_MENU_LINKS = "components/ticketing/MobileMenuLinks.tsx";
const DASHBOARD_LAYOUT = "app/dashboard/layout.tsx";

/** Every platform role the schema can hold — the vocabulary the helper must answer for. */
const PLATFORM_ROLES: readonly PlatformRole[] = [
    "ADMIN",
    "MANAGER",
    "PIC",
    "CUSTOMER",
];

/** The roles the brief requires a Dashboard item for, and the one role it forbids. */
const DASHBOARD_ROLES: readonly PlatformRole[] = ["ADMIN", "MANAGER", "PIC"];

/** An actor with this platform role and NO tenant membership and NO grant. */
function roleOnlyScope(platformRole: PlatformRole): AuthzScope {
    return {
        userId: `user-${platformRole.toLowerCase()}`,
        platformRole,
        organizerScopes: [],
        grants: [],
    };
}

/* ==================================================================================
 * 1. WHO IS OFFERED THE ITEM (pure decision)
 * ================================================================================== */

describe("the navbar offers Dashboard to exactly the back-office roles", () => {
    it("offers it to ADMIN, MANAGER and PIC", () => {
        for (const role of DASHBOARD_ROLES) {
            expect(shouldShowDashboardNav(role)).toBe(true);
        }
    });

    it("withholds it from a CUSTOMER", () => {
        expect(shouldShowDashboardNav("CUSTOMER")).toBe(false);
    });

    it("withholds it from a guest, and treats a missing role as a refusal", () => {
        // `auth()` returns no session for a visitor, and `session.user.platformRole` is nullable
        // because `User.platformRole` is. Both must be hidden rather than advertised: an unknown
        // role is not a back-office role.
        expect(shouldShowDashboardNav(null)).toBe(false);
        expect(shouldShowDashboardNav(undefined)).toBe(false);
    });

    it("agrees with the entry gate it advertises, role by role", () => {
        /*
         * The coupling that keeps the navbar honest: for a role-only actor the helper and
         * `canEnterDashboard` must produce the SAME answer, because the item exists to lead
         * somewhere the account is admitted. If a future role is added, or the gate changes, this
         * fails rather than the two quietly drifting apart.
         */
        for (const role of PLATFORM_ROLES) {
            const capabilities = computeDashboardCapabilities(roleOnlyScope(role));

            expect(shouldShowDashboardNav(role)).toBe(canEnterDashboard(capabilities));
        }
    });
});

/* ==================================================================================
 * 1b. WHERE THE ITEM POINTS (pure decision) — the reported role-routing bug
 * ================================================================================== */

describe("the Dashboard destination follows the account's role", () => {
    it("sends ADMIN and MANAGER to the one operator dashboard", () => {
        expect(getDashboardPath("ADMIN")).toBe("/dashboard");
        expect(getDashboardPath("MANAGER")).toBe("/dashboard");
    });

    it("sends PIC to the PIC self-service surface — never the operator dashboard", () => {
        // The regression: `href="/dashboard"` was a single hardcoded constant, so a PIC
        // clicking the navbar row landed on the operator overview.
        expect(getDashboardPath("PIC")).toBe("/dashboard/pic");
        expect(getDashboardPath("PIC")).not.toBe("/dashboard");
    });

    it("never points a CUSTOMER (or a guest) at a back-office surface", () => {
        // The item is hidden for these accounts; even if a future edit rendered it, the
        // destination is the public storefront, never /dashboard or /dashboard/pic.
        expect(getDashboardPath("CUSTOMER")).toBe("/");
        expect(getDashboardPath(null)).toBe("/");
        expect(getDashboardPath(undefined)).toBe("/");
    });

    it("agrees with the login flow's own role table, role by role", () => {
        // One mapping, derived rather than duplicated: the navbar and the post-login redirect
        // must not be able to disagree about where a role belongs.
        for (const role of PLATFORM_ROLES) {
            expect(getDashboardPath(role)).toBe(
                defaultDestinationForIntent(intentForPlatformRole(role))
            );
        }
    });
});

/* ==================================================================================
 * 2. WHAT THE HEADER ACTUALLY RENDERS
 * ================================================================================== */

describe("SiteHeader renders one role-aware Dashboard destination", () => {
    const code = readCode(SITE_HEADER);

    it("asks the authoritative helpers, each exactly once", () => {
        expect(code).toContain('from "@/lib/dashboard/scope"');
        expect(code).toContain("shouldShowDashboardNav(platformRole)");
        expect(code).toContain("getDashboardPath(platformRole)");
        expect(code).toContain("const platformRole = session?.user.platformRole;");

        // One decision per render, shared by both renderings — not two independent guesses.
        expect(code.match(/shouldShowDashboardNav\(/g) ?? []).toHaveLength(1);
        expect(code.match(/getDashboardPath\(/g) ?? []).toHaveLength(1);
    });

    it("carries no hardcoded `/dashboard` link for any role", () => {
        // The exact line the reported bug lived on: one generic href every role shared.
        expect(code).not.toContain('href="/dashboard"');
        expect(code).not.toMatch(/href:\s*"\/dashboard"/);
    });

    it("builds ONE item list that both renderings consume", () => {
        // The desktop row and the mobile drawer read the same array, so they cannot disagree
        // about who is offered the back-office entrance or where it points.
        expect(code).toContain(
            "const navItems = signedIn ? signedInNavItems(platformRole) : [];"
        );
        expect(code).toContain("<DesktopNavLinks items={navItems} />");
        expect(code).toContain(
            "<MobileMenu signedIn={signedIn} navItems={navItems} />"
        );
        expect(code).toContain(
            '...(signedIn ? navItems : [{ href: "/login", label: "Masuk" }])'
        );
    });

    it("keeps Dashboard OUT of the public NAV list", () => {
        // Same reasoning as "Pesanan saya": the public list renders for every visitor, and a
        // back-office link there would send a guest to /login.
        const nav = code.slice(
            code.indexOf("const NAV = ["),
            code.indexOf("];", code.indexOf("const NAV = ["))
        );

        expect(nav).not.toContain("/dashboard");
    });

    it("has no duplicate Dashboard entry in one rendering", () => {
        // One label definition, read by the single item builder.
        expect(code.match(/DASHBOARD_NAV_LABEL\s*=\s*"Dashboard"/g) ?? []).toHaveLength(1);
        expect(code.match(/label:\s*DASHBOARD_NAV_LABEL/g) ?? []).toHaveLength(1);
    });

    it("still shows the signed-in buyer their own actions and the sign-out control", () => {
        expect(code).toContain('href: "/ticketing/orders"');
        expect(code).toContain('href: "/ticketing/tickets"');
        expect(code).toContain("<SiteSignOut />");
        expect(code).toContain('<SiteSignOut variant="menu" />');
    });
});

/* ==================================================================================
 * 2b. THE LANDING NAVBAR'S ACTUAL OUTPUT — rendered, not read
 * ==================================================================================
 *
 * `/` renders `SiteShell → SiteHeader`, and this is the desktop row that produces it. The
 * tests below RENDER that row for each role (it is a pure, synchronous component) and assert
 * the `href` the browser would receive — so a PIC's "Dashboard" item is proven to be
 * `/dashboard/pic`, not merely declared to be.
 */

describe("the landing navbar emits the role-correct href (rendered output)", () => {
    function renderDesktopRow(role: PlatformRole): string {
        return renderToStaticMarkup(
            createElement(DesktopNavLinks, { items: signedInNavItems(role) })
        );
    }

    it("PIC → /dashboard/pic, never /dashboard", () => {
        const html = renderDesktopRow("PIC");

        expect(html).toContain('href="/dashboard/pic"');
        expect(html).not.toContain('href="/dashboard"');
    });

    it("ADMIN → /dashboard", () => {
        const html = renderDesktopRow("ADMIN");

        expect(html).toContain('href="/dashboard"');
        expect(html).not.toContain('href="/dashboard/pic"');
    });

    it("MANAGER → /dashboard", () => {
        const html = renderDesktopRow("MANAGER");

        expect(html).toContain('href="/dashboard"');
        expect(html).not.toContain('href="/dashboard/pic"');
    });

    it("CUSTOMER → no operator or PIC dashboard link at all", () => {
        const html = renderDesktopRow("CUSTOMER");

        expect(html).not.toContain('href="/dashboard"');
        expect(html).not.toContain('href="/dashboard/pic"');
        expect(html).not.toContain("Dashboard");
    });

    it("keeps the buyer's own rows for every role", () => {
        for (const role of PLATFORM_ROLES) {
            const html = renderDesktopRow(role);

            expect(html).toContain('href="/ticketing/orders"');
            expect(html).toContain('href="/ticketing/tickets"');
        }
    });

    it("exposes the same items the drawer spreads, for every role", () => {
        for (const role of PLATFORM_ROLES) {
            const items = signedInNavItems(role);
            const expected = shouldShowDashboardNav(role) ? 3 : 2;

            expect(items).toHaveLength(expected);
            expect(items.some((item) => item.href === "/dashboard/pic")).toBe(
                role === "PIC"
            );
        }
    });
});

/* ==================================================================================
 * 2c. THE HEADER IS ONE UI SYSTEM — one geometry for every item
 * ==================================================================================
 *
 * The reported visual defect: each item hand-wrote its own box (`rounded-lg px-3 py-2` vs
 * `rounded-xl px-4 py-2`), none had a fixed height and none forbade wrapping, so "Pesanan
 * saya" wrapped onto two lines and the row read as differently sized buttons. The contract
 * now lives in ONE module and every item consumes it.
 */

const HEADER_NAV_STYLES = "components/ticketing/header-nav.ts";
const SITE_SIGN_OUT = "components/ticketing/SiteSignOut.tsx";

describe("every header item shares one geometry", () => {
    const styles = readCode(HEADER_NAV_STYLES);
    const header = readCode(SITE_HEADER);
    const signOut = readCode(SITE_SIGN_OUT);

    it("defines one box with a fixed height and no wrapping", () => {
        for (const token of [
            "h-10",
            "items-center",
            "justify-center",
            "whitespace-nowrap",
            "rounded-xl",
            "px-4",
            "text-sm",
        ]) {
            expect(styles).toContain(token);
        }
    });

    it("keeps `display` OUT of the shared box, so `hidden` is never overridden", () => {
        // Tailwind emits `.hidden{display:none}` BEFORE `.inline-flex{display:inline-flex}`, so
        // an element carrying both is visible at EVERY width. The shared box therefore declares
        // no display, and each call site passes exactly one (bare `inline-flex` when always
        // visible, `hidden xl:inline-flex` when it collapses into the drawer).
        expect(styles).not.toContain("inline-flex");
        expect(styles).not.toMatch(/\.?\bhidden\b/);

        // Every gated item pairs `hidden` with a breakpoint display utility in ONE string.
        for (const source of [header, signOut]) {
            const gated = source.match(/"hidden xl:inline-flex"/g) ?? [];
            expect(gated.length).toBeGreaterThan(0);
        }
    });

    it("renders every control from that one box", () => {
        // Public links, the signed-in rows, "Masuk", "Buat event" and the sign-out control.
        expect(header).toContain("HEADER_NAV_VARIANT.quiet");
        expect(header).toContain("HEADER_NAV_VARIANT[item.variant]");
        expect(header).toContain("HEADER_NAV_VARIANT.outline");
        expect(header).toContain("HEADER_NAV_VARIANT.primary");
        expect(signOut).toContain("HEADER_NAV_VARIANT.outline");
    });

    it("leaves no item with its own hand-written box", () => {
        // The old per-item geometry is gone: no `rounded-lg px-3 py-2` (links) and no
        // `rounded-xl px-4 py-2` (chips) survives in the header or its sign-out control.
        for (const source of [header, signOut]) {
            expect(source).not.toMatch(/rounded-lg px-3 py-2/);
            expect(source).not.toMatch(/rounded-xl[^\n]*px-4[^\n]*py-2(?!\.5)/);
        }
    });
});

/* ==================================================================================
 * 2d. THE BRAND REGION IS SHRINK-SAFE
 * ==================================================================================
 *
 * The reported visual defect: `[logo] Ti...  Event  Cabang olahraga  [Search]` — the lockup was
 * ellipsized and the primary navigation rode over it. The search region uses `flex-1`
 * (`flex-basis: 0%`), so it cannot absorb negative free space; the shared `Brand` lockup was the
 * ONLY shrinkable item, so flexbox crushed it. The fix is the row's flex contract, not offsets.
 */

const BRAND_COMPONENT = "components/Brand.tsx";

describe("the landing navbar's brand never truncates or overlaps", () => {
    const header = readCode(SITE_HEADER);

    it("renders the configured logo and the name as ONE lockup", () => {
        const html = renderToStaticMarkup(
            createElement(Brand, {
                logoSrc: "/uploads/logo.png",
                name: "TinggalKlik.Co",
            })
        );

        expect(html).toContain('src="/uploads/logo.png"');
        expect(html).toContain("TinggalKlik");
        expect(html).toContain(".Co");
    });

    it("falls back to the built-in wordmark when no logo is configured", () => {
        const html = renderToStaticMarkup(
            createElement(Brand, { logoSrc: null })
        );

        expect(html).toContain("TinggalKlik");
    });

    it("takes the name from the branding source, never a literal", () => {
        expect(readCode(BRAND_COMPONENT)).toContain("logoSrc");
        expect(header).toContain("getApplicationBranding");
        expect(header).toContain("logoSrc={branding.logoUrl}");
        expect(header).not.toContain("TinggalKlik");
    });

    it("wraps the lockup in a non-shrinking region (`flex: 0 0 auto`)", () => {
        // The brand is ONE unit that must never give way; inside this region the lockup's
        // `truncate` can never fire, so the name renders whole and cannot be overlapped.
        expect(header).toContain('<div className="flex shrink-0 items-center">');
    });

    it("declares the shrink behaviour of every other region", () => {
        // Primary nav pinned, search is the ONE flexible region, user nav pinned.
        expect(header).toContain("hidden shrink-0 items-center gap-1 lg:flex");
        expect(header).toContain(
            "hidden min-w-0 flex-1 justify-end md:flex lg:max-w-xl"
        );
        expect(header).toContain(
            "ml-auto flex shrink-0 items-center gap-1.5 md:ml-0"
        );
    });

    it("does not solve the overlap with ad-hoc offsets or stacking", () => {
        for (const hack of ["ml-10", "mr-10", "absolute left-", "z-50 ml-"]) {
            expect(header).not.toContain(hack);
        }
    });

    it("keeps the signed-in controls inline only where the row can hold them", () => {
        // Below `xl` the same items live in the existing mobile drawer, whose toggle is the
        // only thing the row carries. That is what keeps the brand pinned AND the row from
        // overflowing horizontally at tablet / small-laptop widths.
        expect(header).toContain('<details className="relative xl:hidden">');
        expect(readCode(SITE_SIGN_OUT)).toContain('"hidden xl:inline-flex"');
    });
});

/* ==================================================================================
 * 3. THE MOBILE DRAWER CLOSES ON NAVIGATION
 * ================================================================================== */

describe("the mobile drawer closes when a row navigates", () => {
    const code = readCode(MOBILE_MENU_LINKS);

    it("is a client component — a DOM write is the only way to close a `<details>`", () => {
        expect(read(MOBILE_MENU_LINKS)).toContain('"use client"');
        expect(code).toContain("closest(\"details\")");
        expect(code).toContain('removeAttribute("open")');
    });

    it("closes on the row's own click, so the keyboard path closes it too", () => {
        // Activating a link with Enter or Space fires `click`; no key handler is needed, and none
        // is added, so the native semantics stay untouched.
        expect(code).toContain("onClick={closeDrawer}");
        expect(code).not.toContain("onKeyDown");
    });

    it("keeps the drawer's own layout and the server-owned rows", () => {
        const header = readCode(SITE_HEADER);

        // `<details>` is still the toggle, the list is still a `<ul>`, and the row data still comes
        // from SiteHeader (including the capability-gated Dashboard row).
        expect(header).toContain("<details");
        expect(header).toContain("<summary");
        expect(header).toContain("<MobileMenuLinks items={items}");
        expect(code).toContain("<ul className=\"space-y-1\">");
    });
});

/* ==================================================================================
 * 4. A CUSTOMER LANDS ON THE STOREFRONT
 * ================================================================================== */

describe("a customer's post-login destination is the storefront", () => {
    it("is `/` from the intent table", () => {
        expect(defaultDestinationForIntent("CUSTOMER")).toBe("/");
    });

    it("is `/` when the destination helper is asked with the customer intent", () => {
        expect(postLoginDestination(null, { intentDefault: "CUSTOMER" })).toBe("/");
    });

    it("is `/` for a null platformRole, since the scope resolves that to CUSTOMER", () => {
        expect(intentForPlatformRole(null)).toBe("CUSTOMER");
        expect(
            postLoginDestination(null, {
                intentDefault: intentForPlatformRole(null),
            })
        ).toBe("/");
    });

    it("leaves the helper's own default alone — `/dashboard` was not weakened", () => {
        // The bare default is the back office and stays there: only the CUSTOMER ENTRANCE moved,
        // so the retirement checks in `post-login-redirect.test.ts` still hold.
        expect(DEFAULT_POST_LOGIN_PATH).toBe("/dashboard");
        expect(postLoginDestination(null)).toBe("/dashboard");
        expect(postLoginDestination(undefined)).toBe("/dashboard");
    });
});

/* ==================================================================================
 * 5. THE DASHBOARD-CAPABLE ROLES ARE UNCHANGED
 * ================================================================================== */

describe("ADMIN, MANAGER and PIC keep their existing destinations", () => {
    it("sends ADMIN and MANAGER to the one dashboard", () => {
        expect(defaultDestinationForIntent("ADMIN")).toBe("/dashboard");
        expect(defaultDestinationForIntent("MANAGER")).toBe("/dashboard");
        expect(postLoginDestination(null, { intentDefault: "ADMIN" })).toBe("/dashboard");
        expect(postLoginDestination(null, { intentDefault: "MANAGER" })).toBe("/dashboard");
    });

    it("sends PIC to the PIC surface", () => {
        expect(defaultDestinationForIntent("PIC")).toBe("/dashboard/pic");
        expect(postLoginDestination(null, { intentDefault: "PIC" })).toBe("/dashboard/pic");
    });

    it("routes an already-authenticated back-office visitor to their own surface", () => {
        for (const platformRole of DASHBOARD_ROLES) {
            const expected = defaultDestinationForIntent(
                intentForPlatformRole(platformRole)
            );

            expect(decideSessionGate({ platformRole }, null)).toEqual({
                action: "redirect",
                to: expected,
            });
        }
    });
});

/* ==================================================================================
 * 6. A SAFE CALLBACK STILL WINS, A HOSTILE ONE STILL LOSES
 * ================================================================================== */

describe("the safe-callback contract is preserved for every role", () => {
    it("honours an interrupted path, for the customer too", () => {
        expect(postLoginDestination("/events", { intentDefault: "CUSTOMER" })).toBe(
            "/events"
        );
        expect(
            postLoginDestination("/ticketing/orders/EVT-1", { intentDefault: "CUSTOMER" })
        ).toBe("/ticketing/orders/EVT-1");
        expect(
            postLoginDestination("/events?page=2#sports", { intentDefault: "CUSTOMER" })
        ).toBe("/events?page=2#sports");

        // And the same for the back-office entrances: the callback outranks the role default.
        expect(
            postLoginDestination("/dashboard/orders/ORD-1", { intentDefault: "ADMIN" })
        ).toBe("/dashboard/orders/ORD-1");
    });

    it("still refuses to leave the origin, and falls back to the role's own surface", () => {
        for (const hostile of [
            "https://evil.example",
            "http://evil.example/dashboard",
            "//evil.example",
            "///evil.example",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "/\\evil.example",
            "/dashboard\nLocation: https://evil.example",
            "dashboard",
        ]) {
            expect(resolveSafeCallbackUrl(hostile)).toBeNull();

            // The hostile value never reaches navigation: the role's own default is used instead.
            expect(postLoginDestination(hostile, { intentDefault: "CUSTOMER" })).toBe("/");
            expect(postLoginDestination(hostile, { intentDefault: "ADMIN" })).toBe(
                "/dashboard"
            );
        }
    });

    it("still refuses a callback that would loop back to the auth pages", () => {
        for (const loop of ["/login", "/register", "/login?callbackUrl=/events"]) {
            expect(postLoginDestination(loop, { intentDefault: "CUSTOMER" })).toBe("/");
        }
    });

    it("applies the same rules on the server-side session gate", () => {
        // A signed-in customer bounced from /events goes back to /events…
        expect(decideSessionGate({ platformRole: "CUSTOMER" }, "/events")).toEqual({
            action: "redirect",
            to: "/events",
        });

        // …an unusable one goes to their own surface (the storefront), never off-origin.
        expect(decideSessionGate({ platformRole: "CUSTOMER" }, "//evil.example")).toEqual({
            action: "redirect",
            to: "/",
        });
    });
});

/* ==================================================================================
 * 7. HIDING A LINK IS NOT A CONTROL
 * ================================================================================== */

describe("hiding the Dashboard item changes no authorization", () => {
    it("a CUSTOMER still cannot enter the dashboard", () => {
        const capabilities = computeDashboardCapabilities(roleOnlyScope("CUSTOMER"));

        expect(canEnterDashboard(capabilities)).toBe(false);
        expect(capabilities.hasPlatformRoleEntry).toBe(false);

        // The navbar agreeing with the gate is a consequence of the gate, not a substitute for it.
        expect(shouldShowDashboardNav("CUSTOMER")).toBe(false);
    });

    it("a PIC who now has the link still holds no operator read", () => {
        // The role-aware link is a UI destination. A role-only PIC resolves with NO tenant
        // capability, so even if the row pointed at `/dashboard` the operator data would be
        // refused by the same deciders the API uses — the href change grants nothing.
        const capabilities = computeDashboardCapabilities(roleOnlyScope("PIC"));

        expect(getDashboardPath("PIC")).toBe("/dashboard/pic");
        expect(capabilities.hasTenantAccess).toBe(false);
        expect(capabilities.canReadOrders).toBe(false);
        expect(capabilities.canReadPayments).toBe(false);
    });

    it("a guest has no session-derived capability at all", () => {
        // The header only ever asks about a session it has; a guest has none, and the layout
        // redirects an anonymous visitor to /login regardless of what the navbar drew.
        expect(shouldShowDashboardNav(null)).toBe(false);
    });

    it("the dashboard layout decides for itself, and never consults the navbar flag", () => {
        const layout = readCode(DASHBOARD_LAYOUT);

        expect(layout).toContain("canEnterDashboard");
        expect(layout).toContain("computeDashboardCapabilities");
        expect(layout).toContain("AccessDeniedPanel");

        // The UX helper must not become an access decision anywhere on the server: the layout and
        // the request proxy decide from the scope, never from what the navbar drew.
        expect(layout).not.toContain("shouldShowDashboardNav");
        expect(readCode("proxy.ts")).not.toContain("shouldShowDashboardNav");
    });
});
