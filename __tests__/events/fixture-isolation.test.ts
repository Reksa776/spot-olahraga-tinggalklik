import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * ==========================================
 * FIXTURE ISOLATION — NO GHOST EVENTS ON THE PUBLIC SURFACE
 * ==========================================
 *
 * The public landing showed events that no operator could find in their dashboard: `P6 …` / `P7 …`
 * fixtures created by the ticketing integration suites. The chain was:
 *
 *   `createEvent` defaults `visibility` to `PUBLIC` (the schema default) →
 *   the harnesses pass no `visibility` → they call the REAL `publishEvent` (that is the point of
 *   the suites) → `PUBLISHED + PUBLIC` is exactly what `publicVisibilityWhere` serves to anonymous
 *   visitors → and an assertion that fails mid-test (or aborts the run) skips the suite's inline
 *   cleanup, so the fixture stays in the database forever.
 *
 * The dashboard was never wrong: it scopes by `readableOrganizerIds`, and no real user belongs to a
 * `P6`/`P7` test tenant, so those events were correctly invisible there. That is precisely what
 * made them ghosts — visible publicly, explainable nowhere.
 *
 * This suite is the ratchet. It does not re-test the catalog ( `catalog.integration.test.ts` owns
 * that); it asserts the thing that was missing: a fixture that a test creates and publishes can
 * never enter the public listing, even when the test's own cleanup never runs.
 *
 * Deliberately NOT asserted here: which suites exist or how they clean up. A suite may add or drop
 * cleanup freely; it may not publish a PUBLIC fixture.
 */

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * The suites that create events and publish them for real.
 *
 * Kept as an explicit list rather than a directory walk: a new suite is a deliberate addition, and
 * adding one here should be a conscious act, not something this guard silently absorbs.
 */
const FIXTURE_SOURCES = [
    "__tests__/ticketing-checkout/checkout.integration.test.ts",
    "__tests__/ticketing-checkout/checkout-concurrency.integration.test.ts",
    "__tests__/ticketing-payment/payment-harness.ts",
];

/** Source with comments removed, so prose that names `createEvent` is not counted as a call. */
function readCode(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

function countMatches(haystack: string, pattern: RegExp): number {
    return haystack.match(pattern)?.length ?? 0;
}

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("P21-F1. a published fixture can never reach the public listing", () => {
    it.each(FIXTURE_SOURCES)("%s creates every event UNLISTED", (file) => {
        const code = readCode(file);

        const created = countMatches(code, /createEvent\(/g);
        const unlisted = countMatches(code, /visibility:\s*FIXTURE_VISIBILITY/g);

        // Sanity: the file really does create events (a rename would otherwise pass vacuously).
        expect(created).toBeGreaterThan(0);

        // One `UNLISTED` per creation — every fixture, including the ones a failing test can
        // strand, is unlisted.
        expect(unlisted).toBe(created);
    });

    it("no fixture source hardcodes a PUBLIC event", () => {
        for (const file of FIXTURE_SOURCES) {
            expect(readCode(file)).not.toMatch(/visibility:\s*[\"']PUBLIC[\"']/);
        }
    });

    it("the isolation depends on the catalog requiring PUBLIC, which is still enforced", () => {
        /*
         * The guard above is only meaningful because the catalog refuses anything that is not
         * PUBLIC. If that rule were ever relaxed, `UNLISTED` fixtures would become visible again
         * and this file would be asserting a false safety. So the rule is pinned here too.
         */
        const catalog = readCode("lib/events/catalog.ts");

        expect(catalog).toContain('visibility: "PUBLIC"');
        // ARCHIVED is hidden from every public surface; the listing also excludes a past event.
        expect(catalog).toContain("archivedAt: null");
    });

    it("the public listing still resolves through the shared catalog, not a second query", () => {
        // The landing, the /events page and the API must all read one source of truth.
        for (const surface of ["app/page.tsx", "app/events/page.tsx", "app/api/events/route.ts"]) {
            expect(readCode(surface)).toMatch(/listPublicEvents|publicVisibilityWhere/);
        }
    });
});

describe("P21-F2. a run that aborts still cannot leave a public fixture", () => {
    /*
     * The `UNLISTED` guard above protects against a fixture that a test creates and abandons. The
     * sports grid has no "unlisted" flag, so a fixture SPORT cannot be protected the same way — and
     * the suites' inline cleanup is skipped when a test aborts (which the ticketing suites do in a
     * plain environment). The net for that case is the global teardown, and this pins it: if it were
     * ever removed, an aborted run would silently start leaking again.
     */

    it("registers a global teardown in the Jest config", () => {
        expect(read("jest.config.js")).toContain(
            'globalTeardown: "<rootDir>/__tests__/support/fixture-teardown.ts"'
        );
    });

    it("the teardown archives fixture events instead of deleting them", () => {
        const teardown = readCode("__tests__/support/fixture-teardown.ts");

        // The domain operation, not a delete — a stranded event may still hold financial rows.
        expect(teardown).toContain('status: "ARCHIVED"');
        expect(teardown).toContain("archivedAt");
        expect(teardown).not.toMatch(/event\.delete/);
        expect(teardown).not.toMatch(/deleteMany/);
    });

    it("the teardown only ever touches reserved fixture identifiers", () => {
        const teardown = readCode("__tests__/support/fixture-teardown.ts");

        // Both signals are required to identify a fixture tenant, and the reserved sport prefixes
        // are the only sports it will retire.
        expect(teardown).toContain('"@example.test"');
        expect(teardown).toMatch(/FIXTURE_ORGANIZER_PREFIXES/);
        expect(teardown).toMatch(/FIXTURE_SPORT_PREFIXES/);
        expect(teardown).toContain('isActive: false');
    });
});
