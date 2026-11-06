import type {
    NotificationCategory,
    NotificationDeliveryChannel,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { PHASE_1_DELIVERY_CHANNELS } from "./types";

/**
 * ==========================================
 * DELIVERY QUEUE — STATE MACHINE (PHASE 1)
 * ==========================================
 *
 * The schema already carries everything the queue needs, and NO COLUMN WAS ADDED:
 *
 *   status          QUEUED → SENDING → SENT | FAILED | SKIPPED
 *   attemptCount    incremented by the claim, not by the caller
 *   maxAttempts     terminal threshold
 *   nextRetryAt     ⚠ DOUBLES AS THE LEASE DEADLINE WHILE `status = SENDING`
 *   UNIQUE(notificationId, channel)
 *   INDEX(status, nextRetryAt)
 *
 * ── WHY `nextRetryAt` IS ALSO THE LEASE ──────────────────────────────────────────────
 * The pre-implementation audit proposed adding `lockedUntil`/`lockedBy`/`lastAttemptAt` via a
 * migration. That migration is NOT created, for a concrete reason measured in this repository:
 * the Jest global setup refuses to run when the test database has fewer applied migrations than
 * the files on disk, and Phase 1 is forbidden from running migrations. A schema change would
 * therefore either break every integration suite or require an illegal `migrate deploy`.
 *
 * `nextRetryAt` already means "this row must not be touched before this instant". While a row is
 * `SENDING`, that instant is the lease deadline, so the same column gives claim visibility and
 * crash recovery with no DDL:
 *
 *     QUEUED,  nextRetryAt = retry time      → claimed when now >= nextRetryAt
 *     SENDING, nextRetryAt = lease deadline  → recovered when now >= nextRetryAt
 *
 * The alternative — treating `SENDING` as forever — would leave a crashed delivery stuck with no
 * way to distinguish it from one in flight. The cost of reusing the column is that a row's
 * `nextRetryAt` is not meaningful as a retry hint while it is `SENDING`; that is documented here
 * and in the Phase 1 report.
 *
 * ── NEVER RETRY AN AMBIGUOUS DELIVERY AUTOMATICALLY ──────────────────────────────────
 * If the worker dies after a provider accepted the message but before `SENT` was written, the
 * true outcome is unknown. Automatically reclaiming an expired `SENDING` row would resend a
 * message that may already have been delivered. So recovery is deliberately one-way:
 *
 *     expired SENDING  →  FAILED / AMBIGUOUS_DELIVERY  (terminal, operator review)
 *
 * `FAILED` rows are never claimed again. A human decides whether a duplicate send is acceptable;
 * the queue never guesses. Under dry-run no provider can have accepted anything, so in Phase 1
 * this path can only be reached by a crash or a test.
 *
 * ── LEGACY ISOLATION ─────────────────────────────────────────────────────────────────
 * Every claim query joins the notification and requires `category IS NOT NULL` AND
 * `templateKey IS NOT NULL`. The 44 legacy rows have neither, so they are invisible to the
 * worker even if someone enqueues a delivery for one by hand.
 */

/** Default lease for one claimed delivery. Covers a slow SMTP handshake in a later phase. */
export const NOTIFICATION_DELIVERY_LEASE_MS = 120_000;

/** 1 → 2 = 60 s, 2 → 3 = 5 min, then terminal. Jitter is ±20 %. */
export const NOTIFICATION_RETRY_BACKOFF_MS = [60_000, 300_000] as const;

/** Recorded on a delivery whose provider outcome cannot be known. Never auto-retried. */
export const AMBIGUOUS_DELIVERY_CODE = "AMBIGUOUS_DELIVERY";
export const AMBIGUOUS_DELIVERY_MESSAGE =
    "Delivery lease expired while SENDING; the provider outcome is unknown, so automatic resend is refused. Operator review required.";

export type ClaimedDelivery = {
    id: string;
    notificationId: number;
    channel: NotificationDeliveryChannel;
    attemptCount: number;
    maxAttempts: number;
    recipient: string;
    templateKey: string | null;
    category: NotificationCategory | null;
    payload: string | null;
};

export type ClaimOptions = {
    now?: Date;
    limit?: number;
    channels?: readonly NotificationDeliveryChannel[];
    leaseMs?: number;
};

/**
 * Claim up to `limit` due deliveries, each with its own conditional UPDATE.
 *
 * The SELECT is only a candidate list; the CAS is the guard. `updateMany` filters on
 * `status = QUEUED` AND the visibility deadline, and only `count === 1` admits the row to this
 * worker. Two workers that selected the same row therefore produce exactly one claim.
 */
export async function claimDueDeliveries(
    options: ClaimOptions = {}
): Promise<ClaimedDelivery[]> {
    const now = options.now ?? new Date();
    const limit = Math.max(1, options.limit ?? 20);
    const leaseMs = options.leaseMs ?? NOTIFICATION_DELIVERY_LEASE_MS;
    const channels = options.channels ?? PHASE_1_DELIVERY_CHANNELS;

    const candidates = await prisma.notificationDelivery.findMany({
        where: {
            status: "QUEUED",
            channel: { in: [...channels] },
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
            // The legacy filter, in the query rather than in a caller's good intentions.
            notification: {
                category: { not: null },
                templateKey: { not: null },
            },
        },
        orderBy: [{ queuedAt: "asc" }],
        take: limit,
        select: {
            id: true,
            notificationId: true,
            channel: true,
            attemptCount: true,
            maxAttempts: true,
            notification: {
                select: {
                    recipient: true,
                    templateKey: true,
                    category: true,
                    payload: true,
                },
            },
        },
    });

    const leaseDeadline = new Date(now.getTime() + leaseMs);
    const claimed: ClaimedDelivery[] = [];

    for (const candidate of candidates) {
        const update = await prisma.notificationDelivery.updateMany({
            where: {
                id: candidate.id,
                status: "QUEUED",
                OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
            },
            data: {
                status: "SENDING",
                attemptCount: { increment: 1 },
                nextRetryAt: leaseDeadline,
            },
        });

        if (update.count !== 1) {
            continue;
        }

        claimed.push({
            id: candidate.id,
            notificationId: candidate.notificationId,
            channel: candidate.channel,
            attemptCount: candidate.attemptCount + 1,
            maxAttempts: candidate.maxAttempts,
            recipient: candidate.notification.recipient,
            templateKey: candidate.notification.templateKey,
            category: candidate.notification.category,
            payload: candidate.notification.payload,
        });
    }

    return claimed;
}

/** Compute the next retry instant, or `null` when the attempt budget is exhausted. */
export function computeRetryDelayMs(
    attempt: number,
    random: () => number = Math.random
): number | null {
    const base = NOTIFICATION_RETRY_BACKOFF_MS[attempt - 1];

    if (base === undefined) {
        return null;
    }

    // ±20 % jitter, so a batch that failed together does not retry in lockstep.
    const jitter = 0.8 + Math.min(Math.max(random(), 0), 1) * 0.4;

    return Math.round(base * jitter);
}

/** Record a simulated delivery. It is NOT a send, so it is SKIPPED — never SENT. */
export async function markDeliverySimulated(
    id: string,
    options: { provider: string; code: string; message: string; now?: Date }
): Promise<void> {
    await prisma.notificationDelivery.updateMany({
        where: { id, status: "SENDING" },
        data: {
            status: "SKIPPED",
            provider: options.provider,
            errorCode: options.code,
            errorMessage: options.message,
            nextRetryAt: null,
        },
    });
}

/** Record a real provider acceptance. Unreachable in Phase 1 (no live transport exists). */
export async function markDeliverySent(
    id: string,
    options: { provider: string; providerMessageId?: string; now?: Date }
): Promise<void> {
    const now = options.now ?? new Date();

    await prisma.notificationDelivery.updateMany({
        where: { id, status: "SENDING" },
        data: {
            status: "SENT",
            provider: options.provider,
            providerMessageId: options.providerMessageId ?? null,
            sentAt: now,
            nextRetryAt: null,
            errorCode: null,
            errorMessage: null,
        },
    });
}

/**
 * Record a failure.
 *
 * Transient failures go back to QUEUED with a backoff deadline. The last attempt and permanent
 * failures become terminal `FAILED`. The CAS is on `status = SENDING`, so a duplicate completion
 * is a no-op rather than a second state change.
 */
export async function recordDeliveryFailure(
    id: string,
    options: {
        attemptCount: number;
        maxAttempts: number;
        errorCode: string;
        errorMessage: string;
        now?: Date;
        random?: () => number;
    }
): Promise<"retry-scheduled" | "failed"> {
    const now = options.now ?? new Date();
    const delay = computeRetryDelayMs(options.attemptCount, options.random);

    if (delay === null || options.attemptCount >= options.maxAttempts) {
        await prisma.notificationDelivery.updateMany({
            where: { id, status: "SENDING" },
            data: {
                status: "FAILED",
                failedAt: now,
                nextRetryAt: null,
                errorCode: options.errorCode,
                errorMessage: options.errorMessage,
            },
        });

        return "failed";
    }

    await prisma.notificationDelivery.updateMany({
        where: { id, status: "SENDING" },
        data: {
            status: "QUEUED",
            nextRetryAt: new Date(now.getTime() + delay),
            errorCode: options.errorCode,
            errorMessage: options.errorMessage,
        },
    });

    return "retry-scheduled";
}

/**
 * Terminal skip for a condition retrying cannot fix (unknown template, disabled transport,
 * uncategorised notification). `SKIPPED` is not a failure and is never retried.
 */
export async function markDeliverySkipped(
    id: string,
    options: { code: string; message: string; provider?: string | null; now?: Date }
): Promise<void> {
    await prisma.notificationDelivery.updateMany({
        where: { id, status: "SENDING" },
        data: {
            status: "SKIPPED",
            provider: options.provider ?? null,
            errorCode: options.code,
            errorMessage: options.message,
            nextRetryAt: null,
        },
    });
}

/**
 * Start of the current Asia/Jakarta day (WIB, UTC+7, no DST) as a UTC instant.
 *
 * The daily WhatsApp cap is a business-day limit, not a UTC one. Indonesia has no daylight
 * saving, so the offset is a constant and this needs no timezone database.
 */
export function startOfJakartaDay(now: Date): Date {
    const OFFSET_MS = 7 * 60 * 60_000;
    const local = new Date(now.getTime() + OFFSET_MS);

    return new Date(
        Date.UTC(
            local.getUTCFullYear(),
            local.getUTCMonth(),
            local.getUTCDate()
        ) - OFFSET_MS
    );
}

/**
 * How many WhatsApp deliveries have actually been attempted (or simulated) today.
 *
 * `SENT` counts a real acceptance. `SKIPPED / DRY_RUN_SIMULATED` counts a simulated send, so
 * the conservative policy is exercised in dry-run exactly as it will be in production. A
 * `SKIPPED` for an invalid recipient or a disabled transport is NOT a send and is excluded.
 */
export async function countWhatsAppSendsToday(
    options: { now?: Date } = {}
): Promise<number> {
    const now = options.now ?? new Date();
    const start = startOfJakartaDay(now);

    return prisma.notificationDelivery.count({
        where: {
            channel: "WHATSAPP",
            OR: [
                { status: "SENT", sentAt: { gte: start } },
                {
                    status: "SKIPPED",
                    errorCode: "DRY_RUN_SIMULATED",
                    updatedAt: { gte: start },
                },
            ],
        },
    });
}

/**
 * Recover deliveries whose lease expired while `SENDING`.
 *
 * Returns the number recovered. Each is marked FAILED/AMBIGUOUS_DELIVERY — deliberately NOT
 * returned to QUEUED — because the provider may already have accepted the message.
 */
export async function recoverExpiredDeliveryLeases(options: {
    now?: Date;
    limit?: number;
} = {}): Promise<number> {
    const now = options.now ?? new Date();
    const limit = Math.max(1, options.limit ?? 50);

    const stale = await prisma.notificationDelivery.findMany({
        where: {
            status: "SENDING",
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        },
        orderBy: [{ updatedAt: "asc" }],
        take: limit,
        select: { id: true },
    });

    if (stale.length === 0) {
        return 0;
    }

    const update = await prisma.notificationDelivery.updateMany({
        where: {
            id: { in: stale.map((row) => row.id) },
            status: "SENDING",
        },
        data: {
            status: "FAILED",
            failedAt: now,
            nextRetryAt: null,
            errorCode: AMBIGUOUS_DELIVERY_CODE,
            errorMessage: AMBIGUOUS_DELIVERY_MESSAGE,
        },
    });

    return update.count;
}
