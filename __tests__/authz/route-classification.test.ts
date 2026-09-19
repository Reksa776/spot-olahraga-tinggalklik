/**
 * ==========================================
 * PHASE 3 — API ROUTE CLASSIFICATION
 * ==========================================
 *
 * Closes phase 0 finding S-3 / approved decision D-49 and phase 3 brief §15:
 * "ensure authentication-sensitive routes cannot silently become accessible
 * because a route was omitted from an allow-list."
 *
 * The proxy is an allow-list, and any `/api/*` path absent from BOTH
 * `PUBLIC_API_PREFIXES` and `PROTECTED_API_PREFIXES` falls through
 * unauthenticated. Before this test, three of 115 routes were in that state.
 *
 * The retail application and its API tree were removed, so the population this guard
 * enumerates is now the ticketing surface only — roughly a quarter of its former size,
 * hence the lower sanity floor below.
 *
 * The fix is not to guess which of them should be protected — it is to make
 * omission impossible to do silently. This test enumerates every route file on
 * disk and fails if any one of them is unclassified, so adding a new route
 * without classifying it fails CI rather than quietly shipping.
 *
 * `proxy.ts` is read as source rather than imported: importing it executes
 * `auth(...)` and initialises Auth.js, which is unnecessary here and would make
 * the test depend on the runtime.
 */

import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

function readFile(relativePath: string): string {
    return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

/** Pull a string array literal out of proxy.ts by variable name. */
function readPrefixes(source: string, variableName: string): string[] {
    const match = source.match(
        new RegExp(`${variableName}[^=]*=\\s*\\[([\\s\\S]*?)\\]`)
    );

    if (!match) {
        throw new Error(
            `Could not find ${variableName} in proxy.ts — did it get renamed?`
        );
    }

    return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Every `route.ts` / `route.tsx` under app/api, as paths relative to the repo root. */
function collectRouteFiles(dir: string): string[] {
    const out: string[] = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
            out.push(...collectRouteFiles(full));
        } else if (entry.name === "route.ts" || entry.name === "route.tsx") {
            out.push(full.replace(/\\/g, "/"));
        }
    }

    return out;
}

/**
 * Map a route file to the URL path it serves, with dynamic segments as `*`.
 *
 * Deliberately tolerant of both relative (`app/api/...`) and absolute
 * (`/repo/app/api/...`) inputs: an earlier version stripped a leading `app` with
 * an anchored regex, which silently failed on absolute paths and made EVERY route
 * look unclassified.
 */
function routeFileToUrlPath(file: string): string {
    const normalized = file.replace(/\\/g, "/");
    const marker = normalized.lastIndexOf("/app/");

    const appRelative =
        marker >= 0 ? normalized.slice(marker) : `/${normalized}`;

    return (
        appRelative
            .replace(/^\/app/, "")
            .replace(/\/route\.tsx?$/, "")
            .replace(/\[\.\.\.[^\]]+\]/g, "*")
            .replace(/\[[^\]]+\]/g, "*") || "/api"
    );
}

const proxySource = readFile("proxy.ts");
const PUBLIC_API_PREFIXES = readPrefixes(proxySource, "PUBLIC_API_PREFIXES");
const PROTECTED_API_PREFIXES = readPrefixes(
    proxySource,
    "PROTECTED_API_PREFIXES"
);
const PROTECTED_PAGE_ROUTES = readPrefixes(
    proxySource,
    "PROTECTED_PAGE_ROUTES"
);

const routeFiles = collectRouteFiles(join(process.cwd(), "app", "api"));

function classify(urlPath: string): "PUBLIC" | "PROTECTED" | "UNCLASSIFIED" {
    if (PUBLIC_API_PREFIXES.some((p) => urlPath.startsWith(p))) {
        return "PUBLIC";
    }
    if (PROTECTED_API_PREFIXES.some((p) => urlPath.startsWith(p))) {
        return "PROTECTED";
    }
    return "UNCLASSIFIED";
}

describe("proxy route classification (phase 0 S-3 / §15)", () => {
    test("the route files were actually found", () => {
        // Guards against a silently-empty enumeration making every test below
        // vacuously pass. The ticketing surface has ~30 route files; 20 is a floor,
        // not an expectation.
        expect(routeFiles.length).toBeGreaterThan(20);
    });

    test("EVERY API route is explicitly classified as public or protected", () => {
        const unclassified = routeFiles
            .map(routeFileToUrlPath)
            .filter((urlPath) => classify(urlPath) === "UNCLASSIFIED")
            .sort();

        expect(unclassified).toEqual([]);
    });

    test("no prefix appears in both lists", () => {
        const overlap = PUBLIC_API_PREFIXES.filter((p) =>
            PROTECTED_API_PREFIXES.includes(p)
        );

        // The proxy checks PUBLIC first, so an overlap would silently make a
        // "protected" route public.
        expect(overlap).toEqual([]);
    });

    test("the admin namespace is protected, not public", () => {
        expect(PROTECTED_API_PREFIXES).toContain("/api/admin/");
        expect(PUBLIC_API_PREFIXES).not.toContain("/api/admin/");
    });

    test("the ticketing payment webhook stays public (the provider cannot authenticate)", () => {
        // The retail provider callbacks (`/api/payment/ipaymu/notification`,
        // `/api/payment/midtrans/notification`) were deleted with the retail application. The
        // ticketing webhook is the remaining one, and it must stay reachable unauthenticated —
        // its trust boundary is the HMAC signature, not a session.
        expect(PUBLIC_API_PREFIXES).toContain("/api/ticketing/payment/webhook");

        // It is a STRICT sub-path of the protected ticketing prefix, and public prefixes are
        // matched first, so the webhook is opened while the rest of the purchase surface is not.
        expect(PROTECTED_API_PREFIXES).toContain("/api/ticketing/");
        expect(PROTECTED_API_PREFIXES).not.toContain("/api/ticketing/payment/webhook");
    });

    test("the page-route list covers the single dashboard and the buyer's own pages", () => {
        // The back office was consolidated into ONE dashboard. `/dashboard` is now a live,
        // session-gated section, so it belongs in this list (it was absent when the name meant
        // the deleted retail dashboard).
        for (const route of ["/dashboard", "/ticketing"]) {
            expect(PROTECTED_PAGE_ROUTES).toContain(route);
        }

        // The retired dashboard prefixes have no pages any more: next.config.ts redirects them,
        // so gating them here would redirect an anonymous visitor to /login instead of letting
        // the redirect carry them to the login-gated dashboard.
        for (const retired of ["/organizer", "/platform"]) {
            expect(PROTECTED_PAGE_ROUTES).not.toContain(retired);
        }

        // The retail page routes (`/admin`, `/profile`, `/orders`, `/cart`, `/checkout`,
        // `/addresses`, ...) were deleted with the retail application.
        for (const retailRoute of ["/admin", "/profile", "/orders", "/cart"]) {
            expect(PROTECTED_PAGE_ROUTES).not.toContain(retailRoute);
        }
    });
});
