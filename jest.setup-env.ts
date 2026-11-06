import { applyTestDatabaseUrl } from "./__tests__/support/test-database";

// This is setupFiles (before each worker imports test modules and lib/prisma.ts).
// Fail before any test can construct a database client if an explicit isolated URL is absent.
applyTestDatabaseUrl();
