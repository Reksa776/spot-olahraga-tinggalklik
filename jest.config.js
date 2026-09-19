/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    moduleNameMapper: {
        "^@/(.*)$": "<rootDir>/$1",
    },
    // NOTE: the retail namespaces (`marketing`, `p0`, `order-refund`, `admin`, `affiliate`,
    // `broadcast`, `checkout`, `shipping`, `spin-wheel`, `transaction`, `voucher-picker`) were
    // removed from `testMatch` together with the retail application they tested. The remaining
    // namespaces are the ticketing surface plus the shared auth/security/shared-infrastructure
    // guards that still apply to it.
    testMatch: [
        "**/__tests__/ipaymu/*.test.ts",
        "**/__tests__/security/*.test.ts",
        // Phase 3 — authentication, authorization and tenant isolation.
        "**/__tests__/authz/*.test.ts",
        // Login → dashboard: the post-login redirect and open-redirect guard (pure), and
        // who actually gets dashboard access (integration).
        //
        // NOTE: `__tests__/auth/` is deliberately NOT matched. That directory holds a
        // standalone `tsx` script (`register-rate-limit.test.ts`) meant to be run by hand —
        // it has no `describe`/`it`, so enrolling it here would fail the run.
        "**/__tests__/auth-flow/*.test.ts",
        // Phase 4 — event/venue/sport domain, EXIF stripping, public catalog.
        "**/__tests__/events/*.test.ts",
        "**/__tests__/locations/*.test.ts",
        "**/__tests__/images/*.test.ts",
        "**/__tests__/venues/*.test.ts",
        // Phase 5 — ticket type CRUD, inventory CAS and the publish precondition.
        "**/__tests__/ticket-types/*.test.ts",
        // Phase 6 — reservation lifecycle, checkout, ownership and concurrency.
        "**/__tests__/ticketing-checkout/*.test.ts",
        // Phase 7 — payment creation, gateway verification, settlement, and the
        // duplicate/race behaviour of the webhook ledger.
        "**/__tests__/ticketing-payment/*.test.ts",
        // Phase 8 — ticket issuance, identity/QR, the wallet read side, and the real-InnoDB
        // idempotency races.
        "**/__tests__/ticketing-issuance/*.test.ts",
        // Phase 10B — the refund lifecycle: eligibility policy (pure), the static
        // architectural guards, and the end-to-end request→approve→settle path.
        "**/__tests__/ticketing-refunds/*.test.ts",
        // Phase 13 — the gate: the code parser and gate predicate (pure), the static
        // guards over the manual-code contract, and the end-to-end admit/duplicate/
        // cross-tenant/concurrency behaviour against the real database.
        "**/__tests__/ticketing-checkin/*.test.ts",
        // Phase 15 — the job runner: the DB lease, the two-job tick (including the real
        // reservation reaper), job isolation, and the machine-authenticated tick route.
        "**/__tests__/jobs/*.test.ts",
        // Phase 9 — the public discovery UI, the ticket wallet/e-ticket presentation, and the
        // static guards over the UI's architectural boundaries.
        //
        // Note the extension: these suites render components with `react-dom/server`, so the
        // transform must accept `.tsx` imports — which the `transform` block below already does
        // (the test files themselves stay `.ts` and build elements with `createElement`, so no
        // JSX is needed in a `.ts` file).
        "**/__tests__/ticketing-ui/*.test.ts",
        // The route inventory, the single-identity accent contract, and the proof that
        // the check-in gate stayed closed.
        "**/__tests__/ui-consolidation/*.test.ts",
    ],
    // WHY forceExit IS SET
    // -------------------
    // `lib/rate-limit.ts` starts a module-scope `setInterval` to prune its in-memory
    // bucket Map, and that timer is never `unref()`-ed. Any suite that transitively
    // imports it leaves the interval running, so Jest finishes the tests and then hangs
    // instead of exiting. `forceExit` contains it here (a one-line `.unref()` on that
    // interval is the proper fix). It only affects worker shutdown, never test results.
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
