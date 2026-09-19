import { prisma } from "@/lib/prisma";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";

/**
 * ==========================================
 * EVENT LIFECYCLE (Phase 15 — P14-D01..P14-D06)
 * ==========================================
 *
 * The ONE canonical statement of the event lifecycle, split into a pure half (predicates,
 * no database, no clock of their own) and a batch half (conditional writes + audit).
 *
 * The contract implemented here was decided in `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md`:
 *
 *   PUBLISHED ──startAt──▶ ONGOING ──endAt + 30m──▶ COMPLETED
 *
 *   * `ONGOING` is AUTOMATIC and derived — there is no manual entry and no manual exit
 *     (P14-D02/P14-D03). It is the interval `[startAt, endAt + grace)`.
 *   * `COMPLETED` is automatic at `endAt + CHECK_IN_GRACE` (P14-D04) and manual once `endAt`
 *     has passed (P14-D05). Both need a non-null `endAt` (P14-D22).
 *   * The grace window is exactly 30 minutes and is defined ONCE, here (P14-D06). Nothing
 *     else in the tree may hard-code a grace duration — the gate predicate in
 *     `sales-state.ts` imports this constant, so the gate and the scheduler cannot drift.
 *
 * ── WHY THERE IS NO `ongoingAt` COLUMN ───────────────────────────────────────────────
 * `ONGOING` is a function of `startAt`, so a second timestamp would be a second source of
 * truth for the same fact. `completedAt` DOES exist, because the platform's observation of
 * the completion is not derivable when a tick ran late: the scheduled instant is
 * `endAt + grace`, the observed instant is what the audit row and the column record.
 *
 * ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────────────
 * No orders, tickets, payments, refunds, quota or ledger rows are touched. Completion is a
 * time statement, not a commercial one (P14-D16): an event may complete while a refund is
 * in flight, while an unpaid order exists, or while a payment is non-terminal, and this
 * module does nothing about any of them. No money moves.
 */

/**
 * The check-in grace window, in minutes (P14-D06).
 *
 * Fixed by product decision: not per-event, not per-ticket-type, and deliberately NOT a
 * `PlatformSetting` column — a configuration surface nobody asked for is an operational
 * risk with no test coverage. Both the completion job and the gate predicate read this one
 * value.
 */
export const CHECK_IN_GRACE_MINUTES = 30;

/** The same window in milliseconds, so no caller re-derives it. */
export const CHECK_IN_GRACE_MS = CHECK_IN_GRACE_MINUTES * 60_000;

/** The subset of an `Event` row the lifecycle predicates need. */
export type LifecycleEvent = {
    status: string;
    startAt: Date;
    endAt: Date | null;
    archivedAt: Date | null;
    cancelledAt: Date | null;
};

/** Statuses the lifecycle may move OUT of automatically. `COMPLETED` is terminal here. */
const AUTO_SOURCE_STATUSES = ["PUBLISHED", "ONGOING"] as const;

/**
 * The instant at which an event becomes due for completion.
 *
 * `null` in, `null` out: an event with no fixed end has no completion instant at all
 * (P14-D22) — it stays live until it is cancelled or archived.
 */
export function completionDueAt(endAt: Date | null): Date | null {
    return endAt ? new Date(endAt.getTime() + CHECK_IN_GRACE_MS) : null;
}

/**
 * An event is still a live, publicly-facing event.
 *
 * Cancellation and archival are separate columns from `status` (the schema carries both),
 * so both are checked: relying on `status` alone would trust one of two columns that can
 * disagree.
 */
function isLive(event: LifecycleEvent): boolean {
    return event.archivedAt === null && event.cancelledAt === null;
}

/**
 * Is this event due to become `COMPLETED` right now? (P14-D04)
 *
 * Requires a non-null `endAt` and `now >= endAt + grace`. The boundary is inclusive, which
 * is the complement of the gate's strict window (`now <= endAt + grace`), so an event
 * completes at the exact instant its gate closes.
 */
export function isCompletionDue(
    event: LifecycleEvent,
    now: Date
): boolean {
    if (!isLive(event)) {
        return false;
    }

    if (!(AUTO_SOURCE_STATUSES as readonly string[]).includes(event.status)) {
        return false;
    }

    const dueAt = completionDueAt(event.endAt);

    return dueAt !== null && dueAt.getTime() <= now.getTime();
}

/**
 * Is this event due to become `ONGOING` right now? (P14-D01/P14-D02)
 *
 * Only from `PUBLISHED`: the transition is monotonic and is never re-applied. An event
 * whose completion is already due is deliberately NOT moved to `ONGOING` first — the tick
 * resolves the final state in one pass, so a scheduler that was down for a day produces
 * `COMPLETED`, not a fabricated intermediate history (P14-D02's catch-up rule).
 */
export function isOngoingDue(event: LifecycleEvent, now: Date): boolean {
    if (!isLive(event)) {
        return false;
    }

    if (event.status !== "PUBLISHED") {
        return false;
    }

    if (event.startAt.getTime() > now.getTime()) {
        return false;
    }

    return !isCompletionDue({ ...event, status: "ONGOING" }, now);
}

/**
 * May a human complete this event right now? (P14-D05)
 *
 * There is no "complete an event early" path: finishing before the scheduled end is what
 * CANCELLATION expresses, and a completion that contradicts the dates would make the
 * public record wrong. `endAt IS NULL` can never be completed, automatically or manually
 * (P14-D22) — the design's precondition ("past `endAt`") cannot be satisfied, so the
 * conservative reading is that it is unreachable and the event is cancelled or archived.
 */
export function mayCompleteManually(
    event: LifecycleEvent,
    now: Date
): boolean {
    if (!isLive(event)) {
        return false;
    }

    if (!(AUTO_SOURCE_STATUSES as readonly string[]).includes(event.status)) {
        return false;
    }

    if (!event.endAt) {
        return false;
    }

    return now.getTime() >= event.endAt.getTime();
}

/** What one lifecycle batch did. `scanned` counts the candidates examined. */
export type LifecycleBatchResult = {
    toOngoing: number;
    toCompleted: number;
    scanned: number;
};

/** The default batch ceiling per run (P14-D10). Bounded so one tick cannot run long. */
export const LIFECYCLE_BATCH_SIZE = 200;

/**
 * Advance every event whose time has come. JOB 1 of the tick (P14-D10).
 *
 * TWO STEPS, both time-driven and both idempotent:
 *
 *   STEP 1  `PUBLISHED → ONGOING`   where `startAt <= now` and completion is not yet due.
 *   STEP 2  `{PUBLISHED,ONGOING} → COMPLETED` where `endAt + grace <= now`.
 *
 * Step 2 runs only on rows step 1 did not take, so a single run resolves the final state
 * without double work. Each step first SELECTS a bounded candidate set (ordered, so two
 * concurrent runs agree on the order they contend in) and then performs, per row, a
 * CONDITIONAL UPDATE carrying the full predicate — never a read-then-write. `count === 1`
 * means this caller won the transition; `0` means somebody else moved the row, and the
 * caller moves on silently.
 *
 * One audit row per successful transition, written after the write commits. A run that
 * transitions nothing writes nothing.
 *
 * `now` is supplied by the caller so a single tick passes ONE instant to every job and no
 * boundary can be straddled mid-run.
 */
export async function advanceEventLifecycleBatch(
    options: { now?: Date; batchSize?: number } = {}
): Promise<LifecycleBatchResult> {
    const now = options?.now ?? new Date();
    const batchSize = Math.max(1, options?.batchSize ?? LIFECYCLE_BATCH_SIZE);

    // `endAt + grace > now`  ⇔  `endAt > now - grace`. Expressed as a value comparison so
    // the whole step stays one indexed condition (no computed column, no raw SQL).
    const graceBoundary = new Date(now.getTime() - CHECK_IN_GRACE_MS);

    let toOngoing = 0;
    let toCompleted = 0;
    let scanned = 0;

    /* ── STEP 1: PUBLISHED → ONGOING ────────────────────────────────────────────── */
    const ongoingCandidates = await prisma.event.findMany({
        where: {
            status: "PUBLISHED",
            archivedAt: null,
            cancelledAt: null,
            startAt: { lte: now },
            // Completion not yet due: either no fixed end, or the end is still in the future.
            OR: [{ endAt: null }, { endAt: { gt: graceBoundary } }],
        },
        select: { id: true, organizerId: true, startAt: true },
        orderBy: [{ startAt: "asc" }, { id: "asc" }],
        take: batchSize,
    });

    scanned += ongoingCandidates.length;

    for (const candidate of ongoingCandidates) {
        const claimed = await prisma.event.updateMany({
            where: {
                id: candidate.id,
                status: "PUBLISHED",
                archivedAt: null,
                cancelledAt: null,
                startAt: { lte: now },
                OR: [{ endAt: null }, { endAt: { gt: graceBoundary } }],
            },
            data: { status: "ONGOING" },
        });

        if (claimed.count !== 1) {
            continue;
        }

        toOngoing += 1;

        await writeTicketingAudit({
            action: "event.ongoing",
            actorType: "SYSTEM",
            actorOrganizerId: null,
            organizerId: candidate.organizerId,
            entityType: "Event",
            entityRef: candidate.id,
            description:
                "Event otomatis berstatus ONGOING karena waktu mulai telah tiba.",
            beforeState: { status: "PUBLISHED" },
            afterState: { status: "ONGOING" },
            reason: "EVENT_STARTED",
        });
    }

    /* ── STEP 2: {PUBLISHED,ONGOING} → COMPLETED ────────────────────────────────── */
    const completionCandidates = await prisma.event.findMany({
        where: {
            status: { in: [...AUTO_SOURCE_STATUSES] },
            archivedAt: null,
            cancelledAt: null,
            endAt: { not: null, lte: graceBoundary },
        },
        select: { id: true, organizerId: true, status: true, endAt: true },
        orderBy: [{ endAt: "asc" }, { id: "asc" }],
        take: batchSize,
    });

    scanned += completionCandidates.length;

    for (const candidate of completionCandidates) {
        const claimed = await prisma.event.updateMany({
            where: {
                id: candidate.id,
                status: { in: [...AUTO_SOURCE_STATUSES] },
                archivedAt: null,
                cancelledAt: null,
                endAt: { not: null, lte: graceBoundary },
            },
            data: { status: "COMPLETED", completedAt: now },
        });

        if (claimed.count !== 1) {
            continue;
        }

        toCompleted += 1;

        await writeTicketingAudit({
            action: "event.complete",
            actorType: "SYSTEM",
            actorOrganizerId: null,
            organizerId: candidate.organizerId,
            entityType: "Event",
            entityRef: candidate.id,
            description:
                "Event otomatis berstatus COMPLETED setelah masa tenggang check-in berakhir.",
            beforeState: { status: candidate.status },
            afterState: {
                status: "COMPLETED",
                completedAt: now.toISOString(),
            },
            reason: "EVENT_ENDED",
        });
    }

    return { toOngoing, toCompleted, scanned };
}
