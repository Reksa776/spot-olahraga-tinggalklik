import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * WORKER LEASE + HEARTBEAT (PHASE 1)
 * ==========================================
 *
 * The worker is its own OS process and polls the database. It must be safe when two instances
 * start (a deploy overlap, a forgotten `pm2 start`, an operator's second shell):
 *
 *   • the ROW-LEVEL CAS in `queue.ts` is the correctness guard — a delivery is claimed once
 *     no matter how many workers poll;
 *   • this LEASE is the single-flight guard for a batch, so overlap is a cheap no-op rather
 *     than duplicated scanning and duplicated recovery work.
 *
 * It reuses the EXISTING `joblock` table and the pattern already proven in `lib/jobs/lock.ts`
 * (conditional `updateMany` on `lockedUntil IS NULL OR lockedUntil < now`, plus an empty
 * `upsert` to create the row). It deliberately does NOT extend `JOB_NAMES`: Phase 15's comment
 * says "TWO jobs, no more", and notification dispatch is a separate process with its own row.
 *
 * `lastRunAt` / `lastStatus` are the heartbeat an operator or monitor reads. They are written on
 * release, so a row whose `lastRunAt` is old is the honest signal that the process is not alive —
 * which matters because Phase 1 does NOT install a scheduler.
 */

export const NOTIFICATION_WORKER_LOCK = "notification-dispatch";

/** Default lease for one polling batch. Long enough for a full batch, short enough to recover. */
export const NOTIFICATION_WORKER_LEASE_MS = 120_000;

export type NotificationWorkerStatus = "OK" | "FAILED" | "SKIPPED";

/** Claim the worker lease. `true` means this process may run a batch. */
export async function acquireNotificationWorkerLease(options: {
    lockedBy: string;
    now?: Date;
    leaseMs?: number;
}): Promise<boolean> {
    const now = options.now ?? new Date();
    const leaseMs = options.leaseMs ?? NOTIFICATION_WORKER_LEASE_MS;

    await prisma.jobLock.upsert({
        where: { name: NOTIFICATION_WORKER_LOCK },
        create: { name: NOTIFICATION_WORKER_LOCK },
        update: {},
    });

    const claimed = await prisma.jobLock.updateMany({
        where: {
            name: NOTIFICATION_WORKER_LOCK,
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        },
        data: {
            lockedUntil: new Date(now.getTime() + leaseMs),
            lockedBy: options.lockedBy.slice(0, 64),
        },
    });

    return claimed.count === 1;
}

/**
 * Extend the lease while a batch is still running (heartbeat).
 *
 * The guard `lockedBy = this worker` means an expired lease that another instance has since
 * taken over is never extended by the old owner.
 */
export async function renewNotificationWorkerLease(options: {
    lockedBy: string;
    now?: Date;
    leaseMs?: number;
}): Promise<boolean> {
    const now = options.now ?? new Date();
    const leaseMs = options.leaseMs ?? NOTIFICATION_WORKER_LEASE_MS;
    const workerId = options.lockedBy.slice(0, 64);

    const renewed = await prisma.jobLock.updateMany({
        where: { name: NOTIFICATION_WORKER_LOCK, lockedBy: workerId },
        data: { lockedUntil: new Date(now.getTime() + leaseMs) },
    });

    return renewed.count === 1;
}

/** Release the lease and record the outcome. Always called, including after a failure. */
export async function releaseNotificationWorkerLease(options: {
    status: NotificationWorkerStatus;
    now?: Date;
}): Promise<void> {
    const now = options.now ?? new Date();

    await prisma.jobLock.updateMany({
        where: { name: NOTIFICATION_WORKER_LOCK },
        data: {
            lockedUntil: null,
            lockedBy: null,
            lastRunAt: now,
            lastStatus: options.status,
        },
    });
}

/** Read the lease row for health checks and tests. */
export function readNotificationWorkerLease() {
    return prisma.jobLock.findUnique({ where: { name: NOTIFICATION_WORKER_LOCK } });
}
