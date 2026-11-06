/**
 * ==========================================
 * NOTIFICATION WORKER — HEALTH PROBE (PHASE P1)
 * ==========================================
 *
 *   npm run health:worker
 *
 * Exit 0:
 *   - NOTIFICATIONS_ENABLED is off: the worker is intentionally idle and no heartbeat is
 *     expected. PM2 still supervises the process itself.
 *   - enabled, and the `notification-dispatch` lease shows recent activity (or a live lease).
 *
 * Exit 1:
 *   - enabled, but the heartbeat row is missing, stale, or the database cannot be read.
 *
 * This is a READ-ONLY probe. It does not claim the lease, enqueue, send, or modify any row.
 * It prints JSON with no database URL, credential, recipient, or phone number.
 */

import "dotenv/config";

import { prisma } from "@/lib/prisma";
import { resolveNotificationConfig } from "@/lib/notifications/config";
import { sanitizeErrorMessage } from "@/lib/notifications/logger";
import { readNotificationWorkerLease } from "@/lib/notifications/worker-lock";

type HealthReport = {
    status: "ok" | "disabled" | "unhealthy";
    enabled: boolean;
    lastRunAt: string | null;
    lastRunAgeMs: number | null;
    lastStatus: string | null;
    leaseActive: boolean;
    maxAgeMs: number;
};

function write(report: HealthReport): void {
    const line = JSON.stringify(report);

    if (report.status === "unhealthy") {
        console.error(line);
        process.exitCode = 1;
    } else {
        console.log(line);
    }
}

async function main(): Promise<void> {
    const config = resolveNotificationConfig();

    if (!config.enabled) {
        write({
            status: "disabled",
            enabled: false,
            lastRunAt: null,
            lastRunAgeMs: null,
            lastStatus: null,
            leaseActive: false,
            maxAgeMs: 0,
        });
        return;
    }

    // A worker polls every `pollIntervalMs`; the lease can be held for `leaseMs` while a
    // batch runs. Activity older than both windows (with headroom) means the process is not
    // making progress. This is deliberately not the public web health endpoint: an email or
    // WhatsApp outage must not take the site out of rotation.
    const maxAgeMs = Math.max(config.pollIntervalMs * 3, config.leaseMs * 2);
    const now = Date.now();
    const lease = await readNotificationWorkerLease();
    const lastRunAt = lease?.lastRunAt ?? null;
    const lastRunAgeMs = lastRunAt ? now - lastRunAt.getTime() : null;
    const leaseActive = Boolean(
        lease?.lockedUntil && lease.lockedUntil.getTime() > now
    );
    const healthy =
        leaseActive || (lastRunAgeMs !== null && lastRunAgeMs <= maxAgeMs);

    write({
        status: healthy ? "ok" : "unhealthy",
        enabled: true,
        lastRunAt: lastRunAt?.toISOString() ?? null,
        lastRunAgeMs,
        lastStatus: lease?.lastStatus ?? null,
        leaseActive,
        maxAgeMs,
    });
}

main()
    .catch((error: unknown) => {
        // Keep the failure diagnostic useful without echoing a connection string or recipient.
        console.error(
            JSON.stringify({
                status: "unhealthy",
                enabled: true,
                error: sanitizeErrorMessage(error),
            })
        );
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect().catch(() => undefined);
    });
