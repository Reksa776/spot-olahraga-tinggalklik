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
    /*
     * PHASE 2 — KEEP THE SHARED TEST QUEUE ISOLATED PER FILE.
     *
     * Settlement now enqueues a purchase proof after it commits (the production behaviour under
     * test). A payment suite therefore leaves real QUEUED rows behind after it deletes its orders.
     * Phase 1's queue suite asserts GLOBAL claim/recovery facts (`claimDueDeliveries` has no
     * template filter), so those rows would make its counts depend on which suite ran first.
     *
     * Removing only this template's rows from the isolated TEST database restores the isolation
     * the suite assumes. It asserts nothing, weakens nothing, and cannot touch the application
     * database: `prisma` is pinned to the validated TEST_DATABASE_URL by `jest.setup-env.ts`.
     */
    await prisma.notification
        .deleteMany({ where: { templateKey: "purchase-proof.v1" } })
        .catch(() => undefined);

    // The post-issuance ticket notification is the same kind of residue: an issuance suite
    // leaves QUEUED rows behind after its own teardown sets the order/event references to null.
    // It is removed for the same isolation reason as the purchase proof above.
    await prisma.notification
        .deleteMany({ where: { templateKey: "ticket-issued.v1" } })
        .catch(() => undefined);

    await prisma.$disconnect();
});
