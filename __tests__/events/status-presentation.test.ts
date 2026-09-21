import { readFileSync } from "node:fs";
import path from "node:path";

import {
    EVENT_STATUS_FILTERS,
    eventStatusTone,
    parseEventStatusFilter,
} from "@/lib/events/status";

/**
 * ==========================================
 * EVENT STATUS — PRESENTATION AND FILTER VOCABULARY
 * ==========================================
 *
 * The event dashboard rendered the same status three different ways before this suite existed: the
 * list had a tone map, the detail header had an inline ternary, and the overview had a third
 * expression — and `ONGOING` was missing from all of them, so a live event (the state the tick
 * produces at `startAt`) rendered as a neutral grey badge indistinguishable from a draft.
 *
 * These tests pin the two halves of the fix:
 *
 *   1. the vocabulary itself — every REACHABLE status is present, the intentionally unreachable one
 *      is not, and an unknown value degrades to `neutral` instead of throwing;
 *   2. the architectural ratchet — the surfaces read the one table, the filter parameter is
 *      validated before it reaches Prisma, and pagination comes from the service instead of a
 *      second copy of the page size.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("P21-S1. the event status vocabulary", () => {
    it("lists every status the application can produce, in lifecycle order", () => {
        expect(EVENT_STATUS_FILTERS).toEqual([
            "DRAFT",
            "PUBLISHED",
            "ONGOING",
            "COMPLETED",
            "CANCELLED",
            "ARCHIVED",
        ]);
    });

    it("does not advertise the state the design made unreachable", () => {
        /*
         * `PENDING_REVIEW` exists in the Prisma enum but D-13 locked self-publish: no approval queue,
         * so no code path can set it. Listing it as a filter would offer a query that can only ever
         * return an empty page.
         */
        expect(EVENT_STATUS_FILTERS).not.toContain("PENDING_REVIEW");
    });

    it("tones each reachable status, and distinguishes a live event from a mere draft", () => {
        expect(eventStatusTone("PUBLISHED")).toBe("success");
        expect(eventStatusTone("ONGOING")).toBe("brand");
        expect(eventStatusTone("COMPLETED")).toBe("info");
        expect(eventStatusTone("CANCELLED")).toBe("error");
        expect(eventStatusTone("DRAFT")).toBe("neutral");
        expect(eventStatusTone("ARCHIVED")).toBe("neutral");

        // The regression this phase fixed: a live event must not look like a draft.
        expect(eventStatusTone("ONGOING")).not.toBe(eventStatusTone("DRAFT"));
        expect(eventStatusTone("ONGOING")).not.toBe(eventStatusTone("PUBLISHED"));
    });

    it("degrades to neutral for anything it does not know", () => {
        // A status label is presentation: an unrecognised value must never take a page down.
        expect(eventStatusTone("PENDING_REVIEW")).toBe("neutral");
        expect(eventStatusTone("SOMETHING_NEW")).toBe("neutral");
    });
});

describe("P21-S2. the status filter is validated before it reaches the query", () => {
    it("accepts exactly the reachable statuses", () => {
        for (const status of EVENT_STATUS_FILTERS) {
            expect(parseEventStatusFilter(status)).toBe(status);
        }
    });

    it("maps everything else, including absence, to 'no filter'", () => {
        // Prisma rejects an unknown enum value by throwing, so forwarding the raw query-string
        // value would turn `?status=NOPE` into a 500 instead of a page.
        expect(parseEventStatusFilter(undefined)).toBeNull();
        expect(parseEventStatusFilter("")).toBeNull();
        expect(parseEventStatusFilter("PENDING_REVIEW")).toBeNull();
        expect(parseEventStatusFilter("draft")).toBeNull();
        expect(parseEventStatusFilter("' OR 1=1")).toBeNull();
    });
});

describe("P21-S3. the dashboard surfaces agree about a status", () => {
    it("the event list reads the shared table and validates its filter", () => {
        const list = read("app/dashboard/events/page.tsx");

        expect(list).toContain("eventStatusTone");
        expect(list).toContain("parseEventStatusFilter");
        expect(list).toContain("EVENT_STATUS_FILTERS");

        // No second tone table, and no `as never` escape hatch around the enum.
        expect(list).not.toContain("STATUS_TONE");
        expect(list).not.toContain("as never");
    });

    it("the event detail header and the overview read the same table", () => {
        const detail = read("app/dashboard/events/[id]/page.tsx");
        const overview = read("app/dashboard/page.tsx");

        expect(detail).toContain("eventStatusTone");
        expect(overview).toContain("eventStatusTone");

        // The old inline conditionals are gone: they were how the three surfaces drifted.
        expect(detail).not.toMatch(/event\.status === "PUBLISHED"\s*\?\s*"success"/);
        expect(overview).not.toMatch(/event\.status === "PUBLISHED" \? "success" : "info"/);
    });

    it("pagination is the service's answer, not a second copy of the page size", () => {
        const list = read("app/dashboard/events/page.tsx");

        expect(list).toContain("result.pagination.totalPages");
        // Re-deriving it from a hardcoded limit is how a footer ends up disagreeing with its rows.
        expect(list).not.toMatch(/Math\.ceil\(result\.pagination\.total \/ 20\)/);
    });

    it("a live event keeps its link to the public page", () => {
        // `ONGOING` is listed and on sale exactly like `PUBLISHED`, so the detail header must offer
        // the public link in both states.
        const detail = read("app/dashboard/events/[id]/page.tsx");

        expect(detail).toMatch(/status === "PUBLISHED" \|\| event\.status === "ONGOING"/);
    });

    it("publishing an event without an end time is still refused on the server", () => {
        /*
         * The dashboard copy now says `endAt` is required before publication, but copy is not a
         * control. This asserts the Phase 20B contract is still enforced where it matters — the
         * service — so the UI wording and the rule cannot be changed independently.
         */
        const service = read("lib/events/service.ts");

        expect(service).toContain("if (current.endAt === null)");
        expect(service).toContain("Waktu selesai event wajib diisi sebelum event dipublikasikan");
    });
});
