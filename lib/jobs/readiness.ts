import { prisma } from "@/lib/prisma";

import { NOTIFICATION_WORKER_LOCK } from "@/lib/notifications/worker-lock";

import { JOB_NAMES, type JobName } from "./lock";

/**
 * ==========================================
 * JOB / WORKER READINESS
 * ==========================================
 *
 * `JobLock.lastRunAt` and `lastStatus` are the honest heartbeat of the two schedulers this
 * deployment has:
 *
 *   • the external cron calling `POST /api/internal/jobs/tick` (three leased jobs), and
 *   • the separate notification worker (`scripts/notification-worker.ts`).
 *
 * They are written on lease release. A row whose `lastRunAt` is older than twice its expected
 * interval therefore means the process that should be writing it is not running — exactly the
 * failure mode behind a missing H-36 reminder ("the reminder was never enqueued" or "the
 * queue was never drained").
 *
 * This module only READS. It never takes a lease, never triggers a job, and never writes, so it
 * is safe to render from a dashboard page.
 *
 * Threshold: stale when `now - lastRunAt > 2 × interval`. A row that has never run is reported
 * as `never-run`, which is a warning, not a success.
 */

export type MonitoredJobName = JobName | typeof NOTIFICATION_WORKER_LOCK;

export type JobLockRow = {
    name: string;
    lastRunAt: Date | null;
    lastStatus: string | null;
    lockedUntil: Date | null;
    lockedBy: string | null;
};

export type JobReadiness = {
    name: MonitoredJobName;
    label: string;
    lastRunAt: string | null;
    lastStatus: string | null;
    lastRunAgeMs: number | null;
    intervalMs: number;
    staleAfterMs: number;
    stale: boolean;
    severity: "ok" | "warning" | "never-run";
    warning: string | null;
};

export type ReadinessReport = {
    now: string;
    stale: boolean;
    jobs: JobReadiness[];
    warnings: string[];
};

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_WORKER_POLL_MS = 5_000;

export const JOB_LABELS: Record<MonitoredJobName, string> = {
    [JOB_NAMES.EVENT_LIFECYCLE]: "Event lifecycle (cron tick)",
    [JOB_NAMES.RESERVATION_REAPER]: "Reservation reaper (cron tick)",
    [JOB_NAMES.H36_REMINDER]: "H-36 reminder enqueue (cron tick)",
    [NOTIFICATION_WORKER_LOCK]: "Notification worker (delivery queue)",
};

export const JOB_INTERVALS_MS: Record<MonitoredJobName, number> = {
    [JOB_NAMES.EVENT_LIFECYCLE]: DEFAULT_TICK_INTERVAL_MS,
    [JOB_NAMES.RESERVATION_REAPER]: DEFAULT_TICK_INTERVAL_MS,
    [JOB_NAMES.H36_REMINDER]: DEFAULT_TICK_INTERVAL_MS,
    [NOTIFICATION_WORKER_LOCK]: DEFAULT_WORKER_POLL_MS,
};

/** The monitored jobs in display order. A missing row is reported, not omitted. */
export const MONITORED_JOBS: readonly MonitoredJobName[] = [
    JOB_NAMES.EVENT_LIFECYCLE,
    JOB_NAMES.RESERVATION_REAPER,
    JOB_NAMES.H36_REMINDER,
    NOTIFICATION_WORKER_LOCK,
];

/**
 * Expected cadence for one job. The worker's poll interval is configurable, so read it from
 * the same environment variable the worker itself uses; an invalid value falls back exactly
 * as `resolveNotificationConfig` does.
 */
export function expectedIntervalMs(
    name: MonitoredJobName,
    env: Record<string, string | undefined> = process.env
): number {
    if (name !== NOTIFICATION_WORKER_LOCK) {
        return DEFAULT_TICK_INTERVAL_MS;
    }

    const raw = env.NOTIFICATION_WORKER_POLL_MS?.trim();

    if (!raw) {
        return DEFAULT_WORKER_POLL_MS;
    }

    const parsed = Number(raw);

    return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 300_000
        ? parsed
        : DEFAULT_WORKER_POLL_MS;
}

function warningFor(job: {
    label: string;
    stale: boolean;
    severity: "ok" | "warning" | "never-run";
    intervalMs: number;
}): string | null {
    if (job.severity === "never-run") {
        return `${job.label}: belum pernah berjalan. Pastikan cron memanggil POST /api/internal/jobs/tick dan proses tinggalklik-worker aktif.`;
    }

    if (job.stale) {
        return `${job.label}: heartbeat lebih lama dari ${2 * job.intervalMs / 1000} detik. Prosesnya kemungkinan berhenti.`;
    }

    return null;
}

/**
 * Pure projection used by the dashboard and by tests.
 */
export function buildJobReadiness(
    rows: readonly JobLockRow[],
    now: Date = new Date(),
    env: Record<string, string | undefined> = process.env
): ReadinessReport {
    const byName = new Map(rows.map((row) => [row.name, row]));
    const warnings: string[] = [];

    const jobs = MONITORED_JOBS.map((name): JobReadiness => {
        const row = byName.get(name) ?? null;
        const intervalMs = expectedIntervalMs(name, env);
        const staleAfterMs = intervalMs * 2;
        const label = JOB_LABELS[name];
        const age = row?.lastRunAt ? now.getTime() - row.lastRunAt.getTime() : null;

        const severity: JobReadiness["severity"] =
            row?.lastRunAt == null ? "never-run" : age !== null && age > staleAfterMs ? "warning" : "ok";
        const stale = severity !== "ok";

        const warning = warningFor({ label, stale, severity, intervalMs });

        if (warning) {
            warnings.push(warning);
        }

        return {
            name,
            label,
            lastRunAt: row?.lastRunAt?.toISOString() ?? null,
            lastStatus: row?.lastStatus ?? null,
            lastRunAgeMs: age,
            intervalMs,
            staleAfterMs,
            stale,
            severity,
            warning,
        };
    });

    return {
        now: now.toISOString(),
        stale: warnings.length > 0,
        jobs,
        warnings,
    };
}

/** Read the heartbeat rows. Never writes and never acquires a lease. */
export async function readJobReadiness(
    now: Date = new Date(),
    env: Record<string, string | undefined> = process.env
): Promise<ReadinessReport> {
    const rows = await prisma.jobLock.findMany({
        where: { name: { in: [...MONITORED_JOBS] } },
        select: {
            name: true,
            lastRunAt: true,
            lastStatus: true,
            lockedUntil: true,
            lockedBy: true,
        },
    });

    return buildJobReadiness(rows, now, env);
}
