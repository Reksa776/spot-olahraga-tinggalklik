import { prisma } from "./lib/prisma";

/**
 * ==========================================
 * JEST — RELEASE THE PRISMA POOL WHEN A TEST FILE ENDS
 * ==========================================
 *
 * Registered in `jest.config.js` as a `setupFilesAfterEnv` entry, i.e. it runs inside EVERY
 * test file's own module sandbox, and it therefore shares that file's `@/lib/prisma` instance.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────────
 * Jest gives every test file its own module registry and its own `globalThis`, so
 * `lib/prisma.ts`'s `globalForPrisma` cache — which exists to keep ONE client per process —
 * only keeps one client per FILE. Each of the ~100 database-backed suites therefore builds
 * its own `PrismaClient`, and a client opens a pool of up to `cpus * 2 + 1` connections on
 * first query (17 on an 8-core machine here).
 *
 * Nothing closes those pools. `forceExit: true` kills the worker at the end of the run
 * without waiting for `$disconnect`, so the pools accumulate for the whole run. On a run with
 * this many suites they eventually cross MySQL's `max_connections` (151 on this machine) and
 * the suites that happen to be executing at that moment fail with:
 *
 *     Too many database connections opened: ERROR HY000 (1040)
 *
 * That failure is an ENVIRONMENT symptom, not a regression — it lands in a different, always
 * unrelated suite on each run (auth/session, payment races, a PIC entry test), and every one
 * of those suites passes when run on its own. Adding a suite is enough to push a previously
 * green run over the edge, which makes a real regression indistinguishable from noise.
 *
 * ── WHY DISCONNECT AND NOT A SMALLER POOL ───────────────────────────────────────
 * Capping `connection_limit` in the URL would also cap the connections a SINGLE suite may
 * hold, and several suites are genuine concurrency tests that launch 5–8 simultaneous
 * operations (`Promise.all`) to exercise row locks. A pool of 2–3 would serialise those
 * operations and silently destroy the race the test exists to prove. Disconnecting per file
 * bounds the run to ONE file's pool at a time while leaving the pool itself at its default
 * size, so those races stay real.
 *
 * `$disconnect()` is safe here because Prisma reconnects lazily on the next query: a suite
 * whose own `afterAll` cleanup runs after this hook still works (it simply reopens a
 * connection), and a purely unit suite that never queried pays nothing.
 */

afterAll(async () => {
    await prisma.$disconnect();
});
