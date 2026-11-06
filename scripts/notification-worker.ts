/**
 * ==========================================
 * NOTIFICATION WORKER — PROCESS ENTRYPOINT (PHASE 1)
 * ==========================================
 *
 *   npm run worker:notifications            # poll until SIGTERM/SIGINT
 *   npm run worker:notifications -- --once  # one batch, then exit
 *
 * This is a SEPARATE OS process from Next.js, by design. It does not listen on a port, does not
 * import the Next runtime, and never depends on a request to run. Phase P1 declares it as the
 * `tinggalklik-worker` app in `ecosystem.config.cjs`; starting that app remains an explicit
 * operator action, and the kill switch still defaults to disabled.
 *
 * DEFAULT BEHAVIOUR WITH NO CONFIGURATION: `NOTIFICATIONS_ENABLED` unset → disabled. The worker
 * starts, logs its resolved configuration, performs no database write, and keeps polling. That
 * is the safe default the owner asked for.
 *
 * `--once` is useful for verifying an installation without leaving a process behind. It obeys
 * exactly the same kill switch and transport clamp.
 */

import "dotenv/config";

import { prisma } from "@/lib/prisma";
import { resolveNotificationConfig } from "@/lib/notifications/config";
import { structuredLog } from "@/lib/notifications/logger";
import { createNotificationWorker } from "@/lib/notifications/worker";

async function main(): Promise<void> {
    const once = process.argv.includes("--once");

    const worker = createNotificationWorker({
        config: resolveNotificationConfig(),
    });

    let shuttingDown = false;

    const shutdown = (signal: string) => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;

        structuredLog("info", "notification.worker.signal", { signal });

        // Graceful: stop() awaits the in-flight batch, so a claimed delivery is completed and
        // its status written before the process exits.
        void worker.stop().finally(async () => {
            await prisma.$disconnect().catch(() => undefined);

            process.exit(0);
        });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    try {
        if (once) {
            const summary = await worker.runOnce();

            structuredLog("info", "notification.worker.once_complete", { ...summary });

            return;
        }

        await worker.start();
    } finally {
        await prisma.$disconnect().catch(() => undefined);
    }
}

main().catch(async (error: unknown) => {
    structuredLog("error", "notification.worker.fatal", {
        error: error instanceof Error ? error.message : String(error),
    });

    await prisma.$disconnect().catch(() => undefined);

    process.exitCode = 1;
});
