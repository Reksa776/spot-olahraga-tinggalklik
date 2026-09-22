import { readFileSync } from "node:fs";
import { Dirent as NodeDirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { sanitizeScannedPayload } from "@/components/organizer/TicketScanner";
import {
    canEnterDashboard,
    computeDashboardCapabilities,
} from "@/lib/dashboard/scope";
import { listCheckInGateEvents } from "@/lib/dashboard/gates";
import type { AuthzScope } from "@/lib/authz";
import {
    listEventCheckIns,
    normalizeCode,
    requireEventCheckInAccess,
} from "@/lib/ticketing/checkin/service";
import { checkInRequestSchema } from "@/lib/ticketing/checkin/validation";

/**
 * ==========================================
 * FEATURE — GATE SCANNER WIRING GUARDS (pure + static)
 * ==========================================
 *
 * The scanner is a second INPUT DEVICE for the existing check-in engine, never a
 * parallel system. These guards pin the properties that keep it that way:
 *
 *   • `sanitizeScannedPayload` is the ONLY client-side transform — it strips control
 *     noise and caps length, and nothing else touches the decoded value;
 *   • the scanner posts to the SAME `…/events/:id/check-in` route the manual panel and
 *     the API suite already cover — there is still exactly ONE check-in route;
 *   • the scan page authorizes with `requireEventCheckInAccess`, the API's own
 *     database-decided gate (pinned in the check-in suite), never a URL-trusted tenant;
 *   • the window and the hub both use the canonical `isEventCheckInOpen` predicate, so a
 *     list row, a scan page and the API can never disagree about the gate;
 *   • `canCheckIn` delegates to `checkin.scan`, so menu visibility and the request
 *     authority come from the same permission — and a `CHECKIN_STAFF` with no other
 *     rights can still enter the dashboard (the hub needs it, and every page re-decides).
 */

const ROOT = path.resolve(__dirname, "..", "..");
const API_ROOT = path.resolve(__dirname, "..", "..", "app", "api");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Strip comments, so a comment DESCRIBING a pattern is never mistaken for the pattern. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** A CHECKIN_STAFF member of one tenant — the persona the whole feature exists for. */
function staffScope(): AuthzScope {
    return {
        userId: "u-staff-scan",
        platformRole: "CUSTOMER",
        organizerScopes: [
            { organizerId: "org-scan", role: "CHECKIN_STAFF", status: "ACTIVE" },
        ],
        grants: [],
    };
}

function customerScope(): AuthzScope {
    return {
        userId: "u-customer-scan",
        platformRole: "CUSTOMER",
        organizerScopes: [],
        grants: [],
    };
}

describe("scan — sanitizeScannedPayload (the only client transform)", () => {
    it("trims and deletes control characters a camera may hand back", () => {
        expect(sanitizeScannedPayload("  EVT-7K3M-AK9P\n ")).toBe("EVT-7K3M-AK9P");
        expect(sanitizeScannedPayload("TICKET:\u0000EVT-7K3M-AK9P\u0007")).toBe(
            "TICKET:EVT-7K3M-AK9P"
        );
        expect(sanitizeScannedPayload("EVT-\u001fAK9P")).toBe("EVT-AK9P");
    });

    it("caps length and treats non-strings as empty", () => {
        const long = `EVT-${"1".repeat(500)}`;
        expect(sanitizeScannedPayload(long).length).toBe(128);
        expect(sanitizeScannedPayload(null)).toBe("");
        expect(sanitizeScannedPayload(undefined)).toBe("");
        expect(sanitizeScannedPayload(37)).toBe("");
        expect(sanitizeScannedPayload({})).toBe("");
    });

    it("stays defense-in-depth — the server still decides via isTicketCode", () => {
        const payload = sanitizeScannedPayload("  TICKET:EVT-7K3M-AK9P weird-suffix  ");

        expect(payload.length).toBeLessThanOrEqual(128);
        // The request schema only takes a non-empty string; the FORMAT decision is
        // `normalizeCode` → `isTicketCode`, the same path the shared route runs.
        expect(normalizeCode(payload)).toBeNull();
    });
});

describe("scan — the API surface is still shared, not duplicated", () => {
    it("lists exactly one check-in route in the whole API tree", async () => {
        async function walk(dir: string): Promise<string[]> {
            let entries: NodeDirent[];
            try {
                entries = await readdir(dir, { withFileTypes: true });
            } catch {
                return [];
            }

            const files: string[] = [];
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    files.push(...(await walk(full)));
                } else if (/check-in\/route\.(ts|tsx)$/.test(full)) {
                    files.push(path.relative(API_ROOT, full));
                }
            }
            return files;
        }

        expect(await walk(API_ROOT)).toEqual([
            path.join("organizer", "events", "[id]", "check-in", "route.ts"),
        ]);
    });
});

describe("scan — the scanner page rides the API's own gate", () => {
    it("authorizes with requireEventCheckInAccess, not a URL-trusted tenant", () => {
        const page = code(read("app/dashboard/events/[id]/check-in/page.tsx"));

        expect(page).toMatch(/requireEventCheckInAccess/);
    });

    it("derives window state server-side via the canonical predicate", () => {
        const page = read("app/dashboard/events/[id]/check-in/page.tsx");

        expect(code(page)).toMatch(/isEventCheckInOpen\(eventRow/);
        expect(code(page)).toMatch(/CHECK_IN_GRACE_MS/);
        expect(page).not.toMatch(/BarcodeDetector|getUserMedia/);
    });

    it("reads the admission list with the same helper the API suite pins", () => {
        const page = code(read("app/dashboard/events/[id]/check-in/page.tsx"));

        expect(page).toMatch(/listEventCheckIns\(event\.id, 20\)/);
    });

    it("is force-dynamic, like every dashboard page that reads a session", () => {
        const page = read("app/dashboard/events/[id]/check-in/page.tsx");
        const hub = read("app/dashboard/check-in/page.tsx");

        expect(page).toMatch(/export const dynamic = "force-dynamic"/);
        expect(hub).toMatch(/export const dynamic = "force-dynamic"/);
    });
});

describe("scan — the scanner component stays an input device", () => {
    it("decodes with the browser-native BarcodeDetector, never a package", () => {
        const source = code(read("components/organizer/TicketScanner.tsx"));

        expect(source).toMatch(/\bBarcodeDetector\b/);
        expect(source).not.toMatch(/import .*(zxing|jsqr|barcode)/i);
    });

    it("does not persist or log the raw payload anywhere client-side", () => {
        const source = code(read("components/organizer/TicketScanner.tsx"));

        expect(source).not.toMatch(/localStorage|sessionStorage|console\./);
        // The single endpoint constant — the SAME route the manual panel calls.
        expect(source).toMatch(
            /const endpoint = `\/api\/organizer\/events\/\$\{eventId\}\/check-in`/
        );
        expect(source).toMatch(/method: "POST"/);
        // The ONE `/api/` literal is the shared route; nothing else is addressed.
        expect(source.match(/\/api\/[^`"]*/g) ?? []).toEqual([
            "/api/organizer/events/${eventId}/check-in",
        ]);
    });

    it("receives the gate window from the server, never from the browser clock", () => {
        const source = code(read("components/organizer/TicketScanner.tsx"));

        expect(source).not.toMatch(/new Date\(\)/);
        expect(source).toMatch(/gateState/);
        expect(source).toMatch(/requiresCheckIn/);
    });
});

describe("scan — the lane is driven by one permission", () => {
    it("capability computation binds canCheckIn to checkin.scan", () => {
        const capabilities = computeDashboardCapabilities(staffScope());

        expect(capabilities.canCheckIn).toBe(true);
        // The persona that motivated the feature: scan rights, no event-read rights.
        expect(capabilities.canReadEvents).toBe(false);
        expect(capabilities.hasTenantAccess).toBe(true);
    });

    it("a plain customer holds no scan lane anywhere", () => {
        const capabilities = computeDashboardCapabilities(customerScope());

        expect(capabilities.canCheckIn).toBe(false);
        expect(capabilities.hasTenantAccess).toBe(false);
        expect(canEnterDashboard(capabilities)).toBe(false);
    });

    it("a scanner staff member may enter the dashboard (their ONLY surface is the hub)", () => {
        expect(canEnterDashboard(computeDashboardCapabilities(staffScope()))).toBe(true);
    });

    it("the hub lists only events the caller may scan, with an empty scope yielding empty", async () => {
        const result = await listCheckInGateEvents(customerScope(), new Date());

        expect(result.total).toBe(result.items.length);
        expect(result.items).toEqual([]);
    });

    it("the hub is scoped by checkin.scan, not event read", () => {
        const gates = code(read("lib/dashboard/gates.ts"));

        expect(gates).toMatch(/organizerIdsWith\(scope, PERMISSIONS\.CHECKIN_SCAN\)/);
        expect(gates).toMatch(/isEventCheckInOpen\(event, now\)/);
    });
});

describe("scan — recorded shared helpers still resolve at import time", () => {
    it("requireEventCheckInAccess and listEventCheckIns stay the shape the API suite exercises", () => {
        expect(typeof requireEventCheckInAccess).toBe("function");
        expect(typeof listEventCheckIns).toBe("function");
        expect(typeof checkInRequestSchema.safeParse).toBe("function");
    });
});