import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
    ROUTE_INVENTORY,
    UNUSED_FILE_CANDIDATES,
    routesByStatus,
    type RouteStatus,
} from "@/lib/ui/route-inventory";

/**
 * ==========================================
 * ROUTE INVENTORY INTEGRITY
 * ==========================================
 *
 * A page inventory with per-route evidence is only worth having if it can be checked. A markdown
 * table cannot; this table is a data structure, so it can be.
 *
 * What is pinned here is the *inventory mechanism*, not the statuses themselves:
 *
 *   • every page in the tree is in the table (a new page cannot be added unclassified);
 *   • no entry points at a file that does not exist (a moved page cannot leave a ghost row);
 *   • nothing is marked reachable without naming where it is reachable FROM;
 *   • the retail application stays gone — this fails if a retail page is reintroduced without the
 *     inventory being reconsidered, which is exactly the drift that made an earlier revision's
 *     64-row table unrepresentative of the product;
 *   • the back office stays ONE dashboard — this fails if `/organizer/**` or `/platform/**`
 *     reappears as a second dashboard instead of living under `/dashboard/**`.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
    const absolute = path.join(ROOT, dir);

    for (const name of readdirSync(absolute)) {
        const rel = path.posix.join(dir, name);
        const abs = path.join(ROOT, rel);

        if (statSync(abs).isDirectory()) {
            if (["node_modules", ".git", ".next"].includes(name)) continue;
            walk(rel, out);
        } else {
            out.push(rel);
        }
    }

    return out;
}

/** `app/a/b/page.tsx` → `/a/b`; `app/page.tsx` → `/`. Mirrors the probe's derivation. */
function routeOf(file: string): string {
    const stripped = file
        .replace(/^app/, "")
        .replace(/\/page\.tsx$/, "")
        .replace(/^page\.tsx$/, "");

    return stripped === "" ? "/" : stripped;
}

const PAGES_ON_DISK = walk("app")
    .filter((f) => f.endsWith("/page.tsx") || f === "app/page.tsx")
    .map(routeOf)
    .sort();

const INVENTORY_ROUTES = ROUTE_INVENTORY.map((entry) => entry.route).sort();

describe("P10-1. the inventory covers the whole application", () => {
    it("accounts for every page that exists", () => {
        expect(INVENTORY_ROUTES).toEqual(PAGES_ON_DISK);
    });

    it("is 29 pages, and says so", () => {
        expect(ROUTE_INVENTORY.length).toBe(29);
    });

    it("lists each route exactly once", () => {
        expect(new Set(INVENTORY_ROUTES).size).toBe(ROUTE_INVENTORY.length);
    });

    it("points every entry at a file that exists", () => {
        for (const entry of ROUTE_INVENTORY) {
            expect(existsSync(path.join(ROOT, entry.file))).toBe(true);
        }
    });

    it("maps each entry's file back to its own route", () => {
        for (const entry of ROUTE_INVENTORY) {
            expect(routeOf(entry.file)).toBe(entry.route);
        }
    });
});

describe("P10-2. reachability claims carry evidence", () => {
    const reachable = ROUTE_INVENTORY.filter(
        (entry) => entry.status === "KEEP" || entry.status === "REFACTOR"
    );

    it("never marks a route reachable without naming a referrer", () => {
        for (const entry of reachable) {
            expect(entry.referencedBy.length).toBeGreaterThan(0);
            // The sentinel the probe writes when it finds nothing. A reachable row must not
            // carry it: that combination is exactly the bug the v1 probe had.
            expect(entry.referencedBy).not.toContain("NO inbound reference");
        }
    });

    it("has no unreferenced routes left", () => {
        // `BLOCKED` used to hold three retail pages that were unlinked but not provably dead.
        // They were retail, and the retail application was removed, so the bucket is empty.
        expect(routesByStatus("BLOCKED")).toEqual([]);
    });
});

describe("P10-3. the inventory describes reality, not intent", () => {
    it("carries no REMOVE or REDIRECT rows", () => {
        // Nothing left in the tree is marked for removal, and nothing was retired behind an alias:
        // the retail routes were deleted outright rather than redirected, because the product no
        // longer has a retail surface for an old URL to land on.
        expect(routesByStatus("REMOVE")).toHaveLength(0);
        expect(routesByStatus("REDIRECT")).toHaveLength(0);
    });

    it("has exactly one back office, at /dashboard", () => {
        // The consolidation's invariant: no `/organizer` or `/platform` page exists. Those paths
        // are 307-redirected in next.config.ts, so they are not in the inventory at all.
        for (const entry of ROUTE_INVENTORY) {
            expect(entry.route.startsWith("/organizer")).toBe(false);
            expect(entry.route.startsWith("/platform")).toBe(false);
        }

        const dashboardRoutes = ROUTE_INVENTORY.filter((entry) =>
            entry.route === "/dashboard" || entry.route.startsWith("/dashboard/")
        );

        // Overview + events (list/new/detail) + venues + orders (list/detail) + customers +
        // payments + refunds + PIC (list/detail) + reports + settings (hub/sports/venues) = 16.
        expect(dashboardRoutes.length).toBe(16);
    });

    it("contains no retail route", () => {
        const retailPrefixes = [
            "/products",
            "/cart",
            "/checkout",
            "/buy-now",
            "/orders",
            "/addresses",
            "/affiliate",
            "/promos",
            "/campaigns",
            "/flash-sales",
            "/promotions",
            "/home",
            "/admin",
            "/profile",
        ];

        for (const entry of ROUTE_INVENTORY) {
            for (const prefix of retailPrefixes) {
                expect(entry.route.startsWith(prefix)).toBe(false);
            }
        }
    });

    it("has no refactor backlog left", () => {
        // The `REFACTOR` bucket was the accent-sweep backlog, and every row in it was a retail page
        // body. Those pages are gone, so nothing is waiting on a repaint.
        expect(routesByStatus("REFACTOR")).toEqual([]);
    });

    it("uses only statuses the type allows", () => {
        const allowed: RouteStatus[] = ["KEEP", "REFACTOR", "REDIRECT", "REMOVE", "BLOCKED"];

        for (const entry of ROUTE_INVENTORY) {
            expect(allowed).toContain(entry.status);
        }
    });
});

describe("P10-4. the unused-file candidates are reported, not deleted", () => {
    it("reports no unused-file candidate", () => {
        // The two zero-byte retail profile components the previous revision listed here were
        // deleted with the retail application. An empty list is the honest answer, and a new
        // candidate has to be added deliberately rather than appearing by accident.
        expect(UNUSED_FILE_CANDIDATES).toHaveLength(0);
    });

    // Conditional on purpose: `it.each([])` registers a single placeholder test that fails, which
    // would make an empty candidate list indistinguishable from a real defect.
    if (UNUSED_FILE_CANDIDATES.length > 0) {
        it.each(UNUSED_FILE_CANDIDATES.map((c) => c.file))(
            "%s is still present and still empty",
            (file) => {
                const absolute = path.join(ROOT, file);

                expect(existsSync(absolute)).toBe(true);
                expect(readFileSync(absolute, "utf8").length).toBe(0);
            }
        );
    }

    it("no file imports any candidate", () => {
        const sources = [...walk("app"), ...walk("components"), ...walk("lib"), ...walk("__tests__")];

        /*
         * Asserted as an IMPORT, not as a substring: the candidate has to be named in the
         * inventory table and in this file, so a `toContain` on the bare module name would fail
         * on the very documentation that reports it.
         */
        for (const candidate of UNUSED_FILE_CANDIDATES) {
            const moduleName = path.basename(candidate.file, ".tsx");
            const importRe = new RegExp(
                `from\\s+["'][^"']*\\/${moduleName}["']|require\\(\\s*["'][^"']*\\/${moduleName}["']`
            );

            for (const source of sources) {
                if (source === candidate.file) continue;

                expect(readFileSync(path.join(ROOT, source), "utf8")).not.toMatch(importRe);
            }
        }
    });
});
