import { applyTestDatabaseUrl } from "./__tests__/support/test-database";

/**
 * ==========================================
 * JEST — RUN AGAINST THE TEST DATABASE, NEVER DEVELOPMENT
 * ==========================================
 *
 * Registered in `jest.config.js` as a `setupFiles` entry, which Jest runs in EVERY worker
 * before the test module graph is imported. That ordering is the whole point: `lib/prisma.ts`
 * builds its `PrismaClient` at import time, so the URL has to be redirected before any test
 * file can import it.
 *
 * This is what stops an integration run from writing fixtures into the development schema.
 * See `__tests__/support/test-database.ts` for why the name is derived rather than
 * configured, and `__tests__/support/global-setup.ts` for the guard that fails the run with
 * an actionable message when the test database has not been created.
 */

applyTestDatabaseUrl();
