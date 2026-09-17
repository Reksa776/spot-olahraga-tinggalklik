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
 * PHASE 10 — ROUTE INVENTORY INTEGRITY
 * ==========================================
 *
 * The brief asks for a page inventory with per-route evidence and forbids deletions without
 * proof. A markdown table cannot be verified; this table is a data structure, so it can be.
 *
 * What is pinned here is the *inventory mechanism*, not the statuses themselves:
 *
 *   • every page in the tree is in the table (a new page cannot be added unclassified);
 *   • no entry points at a file that does not exist (a moved page cannot leave a ghost row);
 *   • nothing is marked reachable without naming where it is reachable FROM;
 *   • nothing is marked REMOVE — the phase deleted no route, and this fails if someone marks a
 *     route removable without also deleting it, or deletes one without updating the table.
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

    it("is 64 pages, and says so", () => {
        expect(ROUTE_INVENTORY.length).toBe(64);
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

    it("keeps every unreferenced route in the BLOCKED bucket, with a reason", () => {
        const blocked = routesByStatus("BLOCKED");

        expect(blocked.map((entry) => entry.route).sort()).toEqual([
            "/campaigns",
            "/flash-sales",
            "/promotions",
        ]);

        for (const entry of blocked) {
            expect(entry.referencedBy).toContain("NO inbound reference");
            // A one-liner would not be a reason. These rows explain why removal is unsafe.
            expect(entry.referencedBy.length).toBeGreaterThan(80);
        }
    });
});

describe("P10-3. the inventory describes reality, not intent", () => {
    it("proposes no deletion this phase actually performed", () => {
        // No REMOVE rows, and no REDIRECT rows: nothing was retired, so nothing needs an alias.
        expect(routesByStatus("REMOVE")).toHaveLength(0);
        expect(routesByStatus("REDIRECT")).toHaveLength(0);
    });

    it("keeps the ticketing and discovery surfaces out of the refactor backlog", () => {
        const backlog = routesByStatus("REFACTOR").map((entry) => entry.route);

        for (const route of [
            "/",
            "/events",
            "/e/[slug]",
            "/ticketing/tickets",
            "/ticketing/tickets/[ticketCode]",
            "/ticketing/orders/[orderNumber]",
            "/login",
            "/register",
        ]) {
            expect(backlog).not.toContain(route);
        }
    });

    it("uses only statuses the type allows", () => {
        const allowed: RouteStatus[] = ["KEEP", "REFACTOR", "REDIRECT", "REMOVE", "BLOCKED"];

        for (const entry of ROUTE_INVENTORY) {
            expect(allowed).toContain(entry.status);
        }
    });
});

describe("P10-4. the unused-file candidates are reported, not deleted", () => {
    it.each(UNUSED_FILE_CANDIDATES.map((c) => c.file))(
        "%s is still present and still empty",
        (file) => {
            const absolute = path.join(ROOT, file);

            expect(existsSync(absolute)).toBe(true);
            expect(readFileSync(absolute, "utf8").length).toBe(0);
        }
    );

    it("no file imports them", () => {
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
