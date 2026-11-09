import { advanceEventLifecycleBatch } from "@/lib/events/lifecycle";
import { runH36ReminderSweep } from "@/lib/notifications/h36-reminder";
import { structuredLog } from "@/lib/notifications/logger";
import { expireDueReservations } from "@/lib/ticketing/reservations";

import {
    acquireJobLock,
    JOB_NAMES,
    releaseJobLock,
    type JobName,
} from "./lock";

/**
 * ==========================================
 * THE JOB TICK (Phase 15 — P14-D09 / P14-D10)
 * ==========================================
 *
 * The ONE entry point an external scheduler calls. `POST /api/internal/jobs/tick` is the
 * transport; this module is the contract, and it is deliberately transport-free so tests
 * can invoke it without a request object.
 *
 * ── THE ARRANGEMENT THE LOCK FIXES ───────────────────────────────────────────────────
 *
 *   VPS crontab (every minute)  →  POST /api/internal/jobs/tick  →  runJobsTick()
 *                                                                    ├── JOB 1 event lifecycle
 *                                                                    ├── JOB 2 reservation expiry
 *                                                                    └── JOB 3 H-36 reminder (enqueue only)
 *
 *   • Business logic NEVER lives in cron. The scheduler only triggers; every predicate,
 *     CAS, transaction and audit row belongs to the service it calls.
 *   • THREE jobs. Phase 15 pinned two (P14-D10); Phase 4 adds the H-36 reminder as an
 *     enqueue-only producer for the existing notification outbox. It does not send, claim
 *     or retry — the worker owns that — and it is still a named job, not a hidden rule.
 *   • ONE `now` for the whole tick. Both jobs receive the same instant, so no boundary
 *     (`startAt`, `endAt + 30m`, a reservation TTL) can be straddled mid-run.
 *   • Each job is isolated: its own lease, its own try/catch, its own outcome. A failure in
 *     one is reported and does NOT prevent the other — a broken lifecycle query must not
 *     silently stop seats from being released.
 *   • JOB 2 is the EXISTING `expireDueReservations`, unmodified: this tick is the production
 *     caller it has been missing since Phase 6, which is why wiring it here finally closes
 *     the "phantom sold-out event" gap that `design P-2` recorded.
 */

export type EventLifecycleJobOutcome = {
    job: JobName;
    /** False when the lease was held by another invocation; the job did nothing. */
    ran: boolean;
    ok: boolean;
    toOngoing: number;
    toCompleted: number;
    scanned: number;
    error?: string;
};

export type ReservationReaperJobOutcome = {
    job: JobName;
    ran: boolean;
    ok: boolean;
    ordersExpired: number;
    reservationsExpired: number;
    seatsReleased: number;
    scanned: number;
    /** Non-fatal inconsistencies the reaper observed (e.g. a hold that survived expiry). */
    anomalies: string[];
    error?: string;
};

export type H36ReminderJobOutcome = {
    job: JobName;
    ran: boolean;
    ok: boolean;
    scannedEvents: number;
    scannedTickets: number;
    enqueued: number;
    existing: number;
    skippedNoContact: number;
    skippedInvalidContact: number;
    skippedDuplicateRecipient: number;
    skippedIneligible: number;
    superseded: number;
    failed: number;
    error?: string;
};

export type TickResult = {
    /** True only when every job that ran succeeded. A skipped job is not a failure. */
    ok: boolean;
    now: string;
    jobs: {
        eventLifecycle: EventLifecycleJobOutcome;
        reservationExpiry: ReservationReaperJobOutcome;
        h36Reminder: H36ReminderJobOutcome;
    };
    durationMs: number;
};

/**
 * Run one job under its lease.
 *
 * The shape is fixed for both jobs: claim the lease → run → release with the outcome. A job
 * whose lease is held returns `ran: false` (no error, no audit, no work), which is the
 * normal result of a slow run overlapping the next minute's cron.
 */
type LeasedJobRun<T> =
    | { ran: false; ok: true; data?: undefined; error?: undefined }
    | { ran: true; ok: true; data: T; error?: undefined }
    | { ran: true; ok: false; data?: undefined; error: string };

async function runLeasedJob<T>(
    name: JobName,
    now: Date,
    body: () => Promise<T>
): Promise<LeasedJobRun<T>> {
    const acquired = await acquireJobLock(name, {
        now,
        lockedBy: `${process.pid}-${now.getTime()}`,
    });

    if (!acquired) {
        return { ran: false, ok: true };
    }

    try {
        const data = await body();

        await releaseJobLock(name, { now, status: "OK" });

        return { ran: true, ok: true, data };
    } catch (error) {
        // The failure is reported to the caller AND recorded on the lease row, so a run that
        // only ever fails is visible without reading the cron's mail.
        await releaseJobLock(name, { now, status: "FAILED" });

        return {
            ran: true,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Execute both jobs, once.
 *
 * Idempotent by construction: every job is a bounded batch of conditional writes over the
 * CURRENT time, not a queue of missed events. Running it twice in a row is a no-op, and a
 * tick that was missed entirely is recovered by the next one (catch-up).
 */
export async function runJobsTick(
    options: { now?: Date } = {}
): Promise<TickResult> {
    const now = options.now ?? new Date();
    const startedAt = Date.now();

    const lifecycle = await runLeasedJob(
        JOB_NAMES.EVENT_LIFECYCLE,
        now,
        () => advanceEventLifecycleBatch({ now, batchSize: 200 })
    );

    const reaper = await runLeasedJob(
        JOB_NAMES.RESERVATION_REAPER,
        now,
        () => expireDueReservations({ now, batchSize: 100 })
    );

    // Phase 4 — enqueue only. The worker owns rendering, claiming, retrying and sending;
    // this job's whole effect is idempotent outbox rows.
    const reminder = await runLeasedJob(
        JOB_NAMES.H36_REMINDER,
        now,
        () => runH36ReminderSweep({ now, maxEvents: 25 })
    );

    /*
     * REMINDER ENQUEUE — THE LINE AN OPERATOR ACTUALLY NEEDS.
     *
     * The sweep's return value used to exist only in the HTTP response, which nothing reads.
     * These logs make the three failure shapes distinguishable without a database query:
     *
     *   ran=false                 → the previous tick still held the lease (or cron stopped)
     *   ok=false                  → the sweep threw; the error is on the lease row + here
     *   enqueued=0, scanned>0     → every occurrence already exists / was skipped (not a bug)
     *   failed>0                  → per-ticket enqueue errors, with no recipient in the log
     */
    structuredLog("info", "jobs.tick.h36_reminder", {
        ran: reminder.ran,
        ok: reminder.ok,
        reason: !reminder.ran
            ? "LEASE_HELD"
            : reminder.ok
              ? "RAN"
              : "JOB_FAILED",
        scannedEvents: reminder.data?.scannedEvents ?? 0,
        scannedTickets: reminder.data?.scannedTickets ?? 0,
        enqueued: reminder.data?.enqueued ?? 0,
        existing: reminder.data?.existing ?? 0,
        failed: reminder.data?.failed ?? 0,
        skippedNoContact: reminder.data?.skippedNoContact ?? 0,
        skippedInvalidContact: reminder.data?.skippedInvalidContact ?? 0,
        skippedDuplicateRecipient:
            reminder.data?.skippedDuplicateRecipient ?? 0,
        skippedIneligible: reminder.data?.skippedIneligible ?? 0,
        superseded: reminder.data?.superseded ?? 0,
        ...(reminder.error ? { error: reminder.error } : {}),
    });

    if (reminder.ran && reminder.ok && (reminder.data?.failed ?? 0) > 0) {
        structuredLog("error", "jobs.tick.h36_reminder_failed", {
            failed: reminder.data?.failed ?? 0,
            enqueued: reminder.data?.enqueued ?? 0,
            reason: "ENQUEUE_ERROR",
        });
    }

    if (
        reminder.ran &&
        reminder.ok &&
        (reminder.data?.enqueued ?? 0) === 0 &&
        (reminder.data?.scannedTickets ?? 0) > 0
    ) {
        structuredLog("info", "jobs.tick.h36_reminder_no_new_rows", {
            reason: "ALL_OCCURRENCES_EXIST_OR_INELIGIBLE",
            existing: reminder.data?.existing ?? 0,
            skippedNoContact: reminder.data?.skippedNoContact ?? 0,
            skippedInvalidContact: reminder.data?.skippedInvalidContact ?? 0,
            skippedIneligible: reminder.data?.skippedIneligible ?? 0,
        });
    }

    const eventLifecycle: EventLifecycleJobOutcome = {
        job: JOB_NAMES.EVENT_LIFECYCLE,
        ran: lifecycle.ran,
        ok: lifecycle.ok,
        toOngoing: lifecycle.data?.toOngoing ?? 0,
        toCompleted: lifecycle.data?.toCompleted ?? 0,
        scanned: lifecycle.data?.scanned ?? 0,
        ...(lifecycle.error ? { error: lifecycle.error } : {}),
    };

    const reservationExpiry: ReservationReaperJobOutcome = {
        job: JOB_NAMES.RESERVATION_REAPER,
        ran: reaper.ran,
        ok: reaper.ok,
        ordersExpired: reaper.data?.ordersExpired ?? 0,
        reservationsExpired: reaper.data?.reservationsExpired ?? 0,
        seatsReleased: reaper.data?.seatsReleased ?? 0,
        scanned: reaper.data?.scanned ?? 0,
        anomalies: reaper.data?.anomalies ?? [],
        ...(reaper.error ? { error: reaper.error } : {}),
    };

    const h36Reminder: H36ReminderJobOutcome = {
        job: JOB_NAMES.H36_REMINDER,
        ran: reminder.ran,
        ok: reminder.ok,
        scannedEvents: reminder.data?.scannedEvents ?? 0,
        scannedTickets: reminder.data?.scannedTickets ?? 0,
        enqueued: reminder.data?.enqueued ?? 0,
        existing: reminder.data?.existing ?? 0,
        skippedNoContact: reminder.data?.skippedNoContact ?? 0,
        skippedInvalidContact: reminder.data?.skippedInvalidContact ?? 0,
        skippedDuplicateRecipient:
            reminder.data?.skippedDuplicateRecipient ?? 0,
        skippedIneligible: reminder.data?.skippedIneligible ?? 0,
        superseded: reminder.data?.superseded ?? 0,
        failed: reminder.data?.failed ?? 0,
        ...(reminder.error ? { error: reminder.error } : {}),
    };

    const durationMs = Date.now() - startedAt;

    structuredLog("info", "jobs.tick.complete", {
        ok: eventLifecycle.ok && reservationExpiry.ok && h36Reminder.ok,
        ran: {
            eventLifecycle: eventLifecycle.ran,
            reservationExpiry: reservationExpiry.ran,
            h36Reminder: h36Reminder.ran,
        },
        failed: {
            eventLifecycle: eventLifecycle.ok ? 0 : 1,
            reservationExpiry: reservationExpiry.ok ? 0 : 1,
            h36Reminder: h36Reminder.ok ? 0 : 1,
        },
        durationMs,
    });

    return {
        ok: eventLifecycle.ok && reservationExpiry.ok && h36Reminder.ok,
        now: now.toISOString(),
        jobs: { eventLifecycle, reservationExpiry, h36Reminder },
        durationMs,
    };
}
