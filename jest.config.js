/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    moduleNameMapper: {
        "^@/(.*)$": "<rootDir>/$1",
    },
    testMatch: [
        "**/__tests__/ipaymu/*.test.ts",
        "**/__tests__/marketing/*.test.ts",
        "!**/__tests__/marketing/pricing-engine.test.ts",
        "**/__tests__/p0/*.test.ts",
        "**/__tests__/order-refund/*.test.ts",
        "**/__tests__/security/*.test.ts",
        // Phase 3 — authentication, authorization and tenant isolation.
        "**/__tests__/authz/*.test.ts",
        // Phase 4 — event/venue/sport domain, EXIF stripping, public catalog.
        "**/__tests__/events/*.test.ts",
        "**/__tests__/locations/*.test.ts",
        "**/__tests__/images/*.test.ts",
        "**/__tests__/venues/*.test.ts",
        // Phase 5 — ticket type CRUD, inventory CAS and the publish precondition.
        "**/__tests__/ticket-types/*.test.ts",
        // Phase 6 — reservation lifecycle, checkout, ownership and concurrency.
        //
        // NOTE: deliberately NOT `**/__tests__/checkout/*.test.ts`. That directory
        // already contains a TRACKED legacy script, `lifecycle.test.ts`, which is a
        // standalone `tsx` entry point (hand-rolled `assert`, ends in `process.exit(1)`)
        // and was never part of any Jest testMatch. Enrolling it would inject its
        // unrelated retail/iPaymu verdicts into the Jest counts and terminate the
        // worker on the first failure, silently changing the regression baseline.
        "**/__tests__/ticketing-checkout/*.test.ts",
        // Phase 7 — payment creation, gateway verification, settlement, and the
        // duplicate/race behaviour of the webhook ledger.
        //
        // NOTE: like the Phase 6 entry above, this is a dedicated namespace rather than a
        // broad glob. `__tests__/` contains standalone legacy scripts that were never part
        // of any testMatch (they hand-roll `assert` and end in `process.exit`), so a glob
        // wide enough to catch one of them would terminate the worker and silently change
        // the regression baseline.
        "**/__tests__/ticketing-payment/*.test.ts",
        // Phase 8 — ticket issuance, identity/QR, the wallet read side, and the real-InnoDB
        // idempotency races.
        //
        // Same reasoning as the two entries above: a dedicated namespace rather than a
        // broad glob, because `__tests__/` contains standalone legacy scripts (hand-rolled
        // `assert`, ending in `process.exit`) that were never part of any testMatch. A glob
        // wide enough to catch one would terminate the worker and silently change the
        // regression baseline.
        "**/__tests__/ticketing-issuance/*.test.ts",
        // Phase 9 — the public discovery UI, the ticket wallet/e-ticket presentation, and the
        // static guards over the UI's architectural boundaries.
        //
        // Same reasoning as the entries above: a dedicated namespace rather than a broad glob,
        // because `__tests__/` contains standalone legacy scripts (hand-rolled `assert`, ending in
        // `process.exit`) that were never part of any testMatch. A glob wide enough to catch one
        // would terminate the worker and silently change the regression baseline.
        //
        // Note the extension: these suites render components with `react-dom/server`, so the
        // transform must accept `.tsx` imports — which the `transform` block below already does
        // (the test files themselves stay `.ts` and build elements with `createElement`, so no
        // JSX is needed in a `.ts` file).
        "**/__tests__/ticketing-ui/*.test.ts",
        // Phase 10 — the route inventory, the single-identity accent contract, and the proof that
        // the check-in gate stayed closed.
        //
        // Same reasoning as the entries above: a dedicated namespace rather than a broad glob,
        // because `__tests__/` contains standalone legacy scripts (hand-rolled `assert`, ending in
        // `process.exit`) that were never part of any testMatch. A glob wide enough to catch one
        // would terminate the worker and silently change the regression baseline.
        "**/__tests__/ui-consolidation/*.test.ts",
    ],
    // WHY forceExit IS SET
    // -------------------
    // `lib/rate-limit.ts` starts a module-scope `setInterval` to prune its in-memory
    // bucket Map, and that timer is never `unref()`-ed. Any suite that transitively
    // imports it (the Phase 4 event services do, through the audit-log helper that
    // reads the client IP) leaves the interval running, so Jest finishes the tests
    // and then hangs instead of exiting.
    //
    // This is a PRE-EXISTING defect in shared retail infrastructure, not a Phase 4
    // change, and it is out of Phase 4's scope to modify that file. `forceExit`
    // contains it here and the underlying issue is recorded in the Phase 4 report as
    // a finding (a one-line `.unref()` on that interval is the proper fix). It only
    // affects worker shutdown, never test results.
    forceExit: true,
    transform: {
        "^.+\\.tsx?$": [
            "ts-jest",
            {
                tsconfig: "tsconfig.json",
            },
        ],
    },
};
