/**
 * ==========================================
 * PURCHASE PROOF SWEEP — OPERATOR ENTRYPOINT (PHASE 2)
 * ==========================================
 *
 *   npm run sweep:purchase-proof
 *   npm run sweep:purchase-proof -- --limit 50
 *
 * WHY A MANUAL COMMAND, NOT A CRON JOB
 * ------------------------------------
 * Phase 2 is forbidden from installing a production scheduler, and none is proven to exist.
 * The recovery mechanism is a bounded, idempotent function (`sweepMissingPurchaseProofs`) and
 * this entrypoint is how an operator runs it today. Wiring it to a scheduler later is a
 * deployment decision: it can run from the existing machine-authenticated tick route, a PM2
 * cron restart, or a system timer — the function does not care, and running it twice is safe.
 *
 * It only ENQUEUES. It never claims a delivery, contacts a provider, or sends a message.
 */

import "dotenv/config";

import { prisma } from "@/lib/prisma";
import { structuredLog } from "@/lib/notifications/logger";
import { sweepMissingPurchaseProofs } from "@/lib/notifications/purchase-proof";

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

    const result = await sweepMissingPurchaseProofs({ limit });

    structuredLog("info", "notification.purchase_proof.sweep_cli_complete", {
        ...result,
        limit,
        sentMessages: 0,
    });
}

main()
    .catch((error: unknown) => {
        structuredLog("error", "notification.purchase_proof.sweep_cli_failed", {
            error: error instanceof Error ? error.message : String(error),
        });

        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect().catch(() => undefined);
    });
