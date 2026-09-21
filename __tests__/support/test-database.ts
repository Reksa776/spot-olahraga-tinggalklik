/**
 * ==========================================
 * DEDICATED TEST DATABASE — URL RESOLUTION
 * ==========================================
 *
 * Phase 22 Part 12. The ticketing integration suites run against a REAL MySQL, and they
 * used to run against the DEVELOPMENT database. That is why residue from an aborted test
 * (`P6 …` events, test sports, stranded orders and payments) appeared in the running
 * application: the suites and the app were writing to the same schema, and once a fixture
 * had been published through the real services it was indistinguishable from live data on
 * every public surface.
 *
 * The fix is to stop sharing the schema. Jest runs against `<appdb>_test` on the same
 * server, derived deterministically from `DATABASE_URL` so there is no second secret to
 * configure and no way for the two to drift apart. The development database is never
 * written to by a test again.
 *
 * ── WHY THE NAME IS DERIVED AND NOT CONFIGURED ──────────────────────────────────
 * A `TEST_DATABASE_URL` variable would be a second source of truth for the same server,
 * credentials, charset and migration history — and, in practice, one that gets set on the
 * developer's machine and forgotten in CI, which silently reintroduces the shared schema.
 * Appending a fixed suffix to the path can only ever point at a sibling database on the
 * same server.
 *
 * ── WHY IT IS IDEMPOTENT ────────────────────────────────────────────────────────
 * `testDatabaseUrl` returns its input unchanged when the name already ends in `_test`, so
 * a worker that resolves the URL twice, or an operator who exports the test URL directly,
 * cannot end up at `<appdb>_test_test`.
 */

/*
 * Imported for its side effect, and it has to stay at the top of the file: Prisma Client is
 * what reads `.env` into `process.env`.
 *
 * `applyTestDatabaseUrl` runs as a Jest `setupFiles` entry, i.e. in a worker BEFORE the test
 * module graph is imported. Without this import `DATABASE_URL` would still be undefined at
 * that moment and the redirect to the test database would quietly not happen — which is the
 * exact failure this whole module exists to prevent.
 */
import "@prisma/client";

/** The reserved suffix that marks the test database. */
export const TEST_DATABASE_SUFFIX = "_test";

/**
 * The test-database URL for an application URL.
 *
 * @throws when `appUrl` is not a parseable absolute URL — a malformed `DATABASE_URL` should
 *         fail loudly here rather than turn into a confusing connection error later.
 */
export function testDatabaseUrl(appUrl: string): string {
    const parsed = new URL(appUrl);
    const name = parsed.pathname.replace(/^\//, "");

    if (!name) {
        throw new Error(
            `DATABASE_URL has no database name in its path: '${parsed.pathname}'`
        );
    }

    if (name.endsWith(TEST_DATABASE_SUFFIX)) {
        return appUrl;
    }

    parsed.pathname = `/${name}${TEST_DATABASE_SUFFIX}`;

    return parsed.toString();
}

/**
 * Point this process at the test database.
 *
 * The absence of `DATABASE_URL` is an error rather than a no-op: silently keeping the
 * application database is the outcome this function exists to prevent.
 *
 * @returns the URL the process was pointed at.
 */
export function applyTestDatabaseUrl(): string {
    const appUrl = process.env.DATABASE_URL;

    if (!appUrl) {
        throw new Error(
            "DATABASE_URL is not set. Jest needs it to resolve the test database " +
                "(<DATABASE_URL database>_test). Add it to .env."
        );
    }

    const resolved = testDatabaseUrl(appUrl);

    process.env.DATABASE_URL = resolved;

    return resolved;
}
