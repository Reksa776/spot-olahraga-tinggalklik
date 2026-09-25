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
        // Global error handling: the error taxonomy/classification (pure) and the static
        // guards over the boundaries and the error components. This namespace exists because
        // the classification is what stops a database outage from being rendered as a 404,
        // and that guarantee is checked from both the pure side and the wiring side.
        "**/__tests__/errors/*.test.ts",
        // Phase 26 — the liveness/readiness probes. Separated from `errors/` because a
        // health check is an OPERATIONAL surface rather than an error-handling one, and the
        // property that matters (liveness must not touch the database) is a deployment
        // contract rather than a classification rule.
        "**/__tests__/health/*.test.ts",
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
        // PIC vertical slice — referral token + fee engine (pure), the wiring guards, and
        // the checkout→settlement→EARNED integration against the real database.
        "**/__tests__/ticketing-pic/*.test.ts",
        // PIC self-service dashboard — entry gate, ownership isolation, metric
        // reporting and the menu rendering of the PIC-only surface.
        "**/__tests__/pic-self-service/*.test.ts",
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
        // PHASE 32 — ADMIN vs MANAGER separation, application maintenance mode and
        // application branding. A namespace of its own because it is the only suite whose
        // subject is the APPLICATION rather than a business feature: the role split, the
        // availability switch, and the logo.
        "**/__tests__/admin-manager/*.test.ts",
        // The back-office reporting surface: the windowed report read model, its filters and
        // its trend buckets, and the CSV/Excel export that must agree with it exactly. A
        // namespace of its own because its subject is the READ MODEL and the export contract
        // rather than any one vertical's business rules (it reads orders, tickets, payments
        // and refunds together, and changes none of them).
        "**/__tests__/dashboard/*.test.ts",
    ],
    // WHY forceExit IS SET
    // -------------------
    // `lib/rate-limit.ts` starts a module-scope `setInterval` to prune its in-memory
    // bucket Map, and that timer is never `unref()`-ed. Any suite that transitively
    // imports it leaves the interval running, so Jest finishes the tests and then hangs
    // instead of exiting. `forceExit` contains it here (a one-line `.unref()` on that
    // interval is the proper fix). It only affects worker shutdown, never test results.
    // ── ONE WRITER PER DATABASE (Phase 22 Part 12) ────────────────────────────────
    //
    // The integration suites share ONE MySQL schema, and several of them assert on
    // GLOBAL facts — the public catalogue's contents, the seeded sport taxonomy, a
    // tenant's order list. Two workers doing that at once means one suite's fixture is the
    // other suite's unexpected row: with the default worker pool this run reported 87
    // failing tests (11 suites), of which only 34 (3 suites) reproduce when the suites run
    // one at a time. The other 53 were pure interference — and, worse, they were
    // indistinguishable from real breakage, so a genuine regression had nowhere to show up.
    //
    // Serialising costs about 20 seconds and buys a run whose failures mean something.
    // (The alternative — one database per worker — is the right answer at a larger scale,
    // but it multiplies the schema, migration and seed provisioning by the worker count, so
    // it is deliberately not attempted here.)
    maxWorkers: 1,
    forceExit: true,
    // ── ISOLATION FROM DEVELOPMENT DATA (Phase 22 Part 12) ────────────────────────
    //
    // The integration suites run against a REAL MySQL. They used to run against the
    // DEVELOPMENT one, which is how an aborted test could leave a `PUBLISHED + PUBLIC`
    // fixture event on the public catalogue: the suites and the application were writing
    // to the same schema.
    //
    // `setupFiles` runs in every worker BEFORE the test module graph is imported — the only
    // point at which `DATABASE_URL` can be redirected before `lib/prisma.ts` builds its
    // `PrismaClient`. It points the worker at `<DATABASE_URL database>_test`.
    //
    // `globalSetup` runs once before the workers and refuses to start a run whose test
    // database does not exist or is behind, with the exact command that fixes it.
    setupFiles: ["<rootDir>/jest.setup-env.ts"],
    // Runs inside every test file's own sandbox and therefore shares that file's
    // `@/lib/prisma` instance, disconnecting its connection pool when the file ends. Without
    // it each of the ~100 database-backed suites keeps a `cpus * 2 + 1` pool open for the
    // whole run (`forceExit` skips `$disconnect`), and the later suites fail with MySQL's
    // "Too many connections" — a flake that looks like a regression. See
    // `jest.teardown-env.ts`.
    setupFilesAfterEnv: ["<rootDir>/jest.teardown-env.ts"],
    globalSetup: "<rootDir>/__tests__/support/global-setup.ts",
    // Safety net for the integration suites: after the whole run, archive any stranded fixture
    // event and deactivate any stranded fixture sport, so a test that aborts before its own
    // cleanup can never leave a `PUBLISHED + PUBLIC` event (or an active test sport) on a public
    // surface. Identification is by reserved fixture prefix + reserved email domain; it never
    // deletes. It neutralises BOTH databases: the test one (where fixtures are created now) and
    // the development one (which still holds residue from before the isolation existed).
    // See `__tests__/support/fixture-teardown.ts`.
    globalTeardown: "<rootDir>/__tests__/support/fixture-teardown.ts",
    transform: {
        "^.+\\.tsx?$": [
            "ts-jest",
            {
                tsconfig: "tsconfig.json",
            },
        ],
    },
};
