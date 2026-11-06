/**
 * ==========================================
 * TICKET ISSUED SWEEP — OPERATOR ENTRYPOINT
 * ==========================================
 *
 *   npm run sweep:ticket-issued
 *   npm run sweep:ticket-issued -- --limit 50
 *
 * Recovery is MANUAL and bounded. Phase 2 has no approved production scheduler, so this is a
 * command an operator runs deliberately; wiring it to an existing tick later is a deployment
 * decision, and running it more than once is safe because it uses the same idempotency keys as
 * the issuance hook.
 *
 * It only ENQUEUES. It never claims a delivery, runs the worker, or sends a message.
 */

import "dotenv/config";

import { prisma } from "@/lib/prisma";
import { structuredLog } from "@/lib/notifications/logger";
import { sweepMissingTicketNotifications } from "@/lib/notifications/ticket-issued";

function readLimit(argv: readonly string[]): number {
    const inline = argv.find((arg) => arg.startsWith("--limit="));
    const separator = argv.indexOf("--limit");
    const raw = inline
        ? inline.slice("--limit=".length)
        : separator >= 0
          ? argv[separator + 1]
          : undefined;
    const parsed = raw ? Number(raw) : NaN;

    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
        return 20;
    }

    return parsed;
}

async function main(): Promise<void> {
    const limit = readLimit(process.argv.slice(2));

    const result = await sweepMissingTicketNotifications({ limit });

    structuredLog("info", "notification.ticket_issued.sweep_cli_complete", {
        ...result,
        limit,
        sentMessages: 0,
    });
}

main()
    .catch((error: unknown) => {
        structuredLog("error", "notification.ticket_issued.sweep_cli_failed", {
            error: error instanceof Error ? error.message : String(error),
        });

        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect().catch(() => undefined);
    });
