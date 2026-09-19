import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * JOB RUNNER LEASE (Phase 15 — P14-D09 / P14-D10)
 * ==========================================
 *
 * The DB-backed single-flight primitive the tick route uses. It exists because the Phase 14
 * decision lock chose the ONLY scheduler shape the deployment can honestly support on a
 * single VPS with no Redis:
 *
 *   ✗ setInterval in a request process   — forbidden (no lifecycle, dies with the process,
 *                                          multi-instance unsafe)
 *   ✗ a process-local mutex / in-memory   — gives no protection across processes or restarts
 *   ✗ BullMQ + Redis                      — a stateful dependency the design itself flags
 *   ✗ MySQL GET_LOCK                      — connection-scoped, unreliable through Prisma's pool
 *   ✓ a lease ROW claimed by a conditional UPDATE
 *
 * ── THE LEASE IS NOT THE CORRECTNESS GUARD ───────────────────────────────────────────
 * Every job's own transitions are conditional writes, so even if two invocations ran
 * simultaneously the database would still produce exactly one transition. The lease exists
 * so a routine overlap is a cheap no-op rather than duplicated work, and so a crashed run is
 * visible (`lastRunAt` / `lastStatus`) and recoverable (the lease expires).
 *
 * `lockedUntil` is the lease deadline: acquisition is allowed when it is NULL or already in
 * the past, which is what lets a stale lease be taken over without operator action.
 */

/** The two jobs, and only two (P14-D10). The string is the `joblock.name` primary key. */
export const JOB_NAMES = {
    EVENT_LIFECYCLE: "event-lifecycle",
    RESERVATION_REAPER: "reservation-reaper",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/** How long a lease is held before it is considered abandoned. */
export const JOB_LEASE_MS = 5 * 60_000;

/** The statuses a run can record, so an operator can see the last thing that happened. */
export type JobRunStatus = "OK" | "FAILED" | "SKIPPED";

/**
 * Try to claim one job's lease.
 *
 * Two statements, in this order on purpose:
 *
 *   1. `upsert` with an EMPTY update — creates the row if this is the first run ever, and
 *      deliberately does NOT touch `lockedUntil`. (A `create`-only call would throw on the
 *      second run; an unconditional update would stomp an active lease.)
 *   2. a conditional `updateMany` whose WHERE clause is the whole acquisition rule:
 *      `lockedUntil IS NULL OR lockedUntil < now`. `count === 1` means this invocation owns
 *      the job; `0` means somebody else holds a live lease.
 *
 * Returns `true` when the lease was acquired.
 */
export async function acquireJobLock(
    name: JobName,
    options: { now?: Date; lockedBy: string; leaseMs?: number } = {
        lockedBy: "unknown",
    }
): Promise<boolean> {
    const now = options.now ?? new Date();
    const leaseMs = options.leaseMs ?? JOB_LEASE_MS;

    await prisma.jobLock.upsert({
        where: { name },
        create: { name },
        update: {},
    });

    const claimed = await prisma.jobLock.updateMany({
        where: {
            name,
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        },
        data: {
            lockedUntil: new Date(now.getTime() + leaseMs),
            lockedBy: options.lockedBy,
        },
    });

    return claimed.count === 1;
}

/**
 * Release one job's lease and record the outcome.
 *
 * Always called (success, failure or skip) so the next tick is never blocked by a lease that
 * was held for a run that already finished. `updateMany` rather than `update` so a missing
 * row is a no-op instead of a `P2025` that would mask the job's real result.
 */
export async function releaseJobLock(
    name: JobName,
    options: { now?: Date; status: JobRunStatus } = { status: "OK" }
): Promise<void> {
    const now = options.now ?? new Date();

    await prisma.jobLock.updateMany({
        where: { name },
        data: {
            lockedUntil: null,
            lockedBy: null,
            lastRunAt: now,
            lastStatus: options.status,
        },
    });
}

/** Read the two lease rows, for tests and for an operator looking at a stuck runner. */
export function readJobLocks() {
    return prisma.jobLock.findMany({ orderBy: { name: "asc" } });
}
