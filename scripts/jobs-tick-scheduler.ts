/**
 * Runs the existing scheduled jobs once at startup and then every minute.
 * PM2 supervises the process; job logic and leases stay in `lib/jobs/tick.ts`.
 */

import "dotenv/config";

import { prisma } from "@/lib/prisma";
import { runJobsTick } from "@/lib/jobs/tick";

const INTERVAL_MS = 60_000;

async function main(): Promise<void> {
    let stopping = false;
    let wakeSleep: (() => void) | null = null;

    const shutdown = () => {
        stopping = true;
        wakeSleep?.();
    };

    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    console.log(JSON.stringify({
        event: "jobs.tick.scheduler_started",
        intervalMs: INTERVAL_MS,
    }));

    try {
        while (!stopping) {
            try {
                const result = await runJobsTick();
                const reminder = result.jobs.h36Reminder;

                console.log(JSON.stringify({
                    event: "jobs.tick.scheduler_result",
                    success: result.ok,
                    h36Ran: reminder.ran,
                    h36Ok: reminder.ok,
                    h36ScannedEvents: reminder.scannedEvents,
                    h36ScannedTickets: reminder.scannedTickets,
                    h36Enqueued: reminder.enqueued,
                    h36Existing: reminder.existing,
                    h36SkippedNoContact: reminder.skippedNoContact,
                    h36SkippedInvalidContact: reminder.skippedInvalidContact,
                    h36Failed: reminder.failed,
                    at: result.now,
                }));
            } catch (error) {
                console.error(JSON.stringify({
                    event: "jobs.tick.scheduler_error",
                    error: error instanceof Error ? error.message : "TICK_FAILED",
                    at: new Date().toISOString(),
                }));
            }

            if (!stopping) {
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(() => {
                        wakeSleep = null;
                        resolve();
                    }, INTERVAL_MS);

                    wakeSleep = () => {
                        clearTimeout(timer);
                        wakeSleep = null;
                        resolve();
                    };
                });
            }
        }
    } finally {
        await prisma.$disconnect().catch(() => undefined);
    }
}

main().catch((error: unknown) => {
    console.error(JSON.stringify({
        event: "jobs.tick.scheduler_fatal",
        error: error instanceof Error ? error.message : "STARTUP_FAILED",
    }));
    process.exitCode = 1;
});
