/**
 * ==========================================
 * PHASE 15 — LIFECYCLE PREDICATES (pure)
 * ==========================================
 *
 * No database, no Next.js, no clock of the module's own: every predicate receives `now`.
 * These are the rules the scheduler, the manual completion action and the gate all derive
 * from, so they are pinned here rather than only through the integration suite.
 *
 * The contract under test is `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` §5–§7:
 *
 *   PUBLISHED ──startAt──▶ ONGOING ──endAt + 30m──▶ COMPLETED
 */

import {
    advanceEventLifecycleBatch,
    CHECK_IN_GRACE_MINUTES,
    CHECK_IN_GRACE_MS,
    completionDueAt,
    isCompletionDue,
    isOngoingDue,
    mayCompleteManually,
    type LifecycleEvent,
} from "@/lib/events/lifecycle";
import { isEventCheckInOpen } from "@/lib/events/sales-state";

const NOW = new Date("2026-09-19T12:00:00.000Z");

/** `minutes` relative to NOW; negative = in the past. */
function at(minutes: number): Date {
    return new Date(NOW.getTime() + minutes * 60_000);
}

function event(overrides: Partial<LifecycleEvent> = {}): LifecycleEvent {
    return {
        status: "PUBLISHED",
        startAt: at(-60),
        endAt: at(60),
        archivedAt: null,
        cancelledAt: null,
        ...overrides,
    };
}

describe("P15-1. the grace window is defined once", () => {
    it("is exactly 30 minutes, in one place", () => {
        expect(CHECK_IN_GRACE_MINUTES).toBe(30);
        expect(CHECK_IN_GRACE_MS).toBe(30 * 60_000);
    });

    it("the gate and the completion job read the SAME constant", () => {
        // If completion used a different number than the gate, an event would either shut its
        // door while still admitting people, or keep admitting after it was marked finished.
        // Both sides are exercised at the boundary below with the imported constant, so a
        // second literal anywhere would make one of these flip.
        const justInside = event({ status: "ONGOING", endAt: at(-29) });
        const justOutside = event({ status: "ONGOING", endAt: at(-31) });

        expect(isCompletionDue(justInside, NOW)).toBe(false);
        expect(isCompletionDue(justOutside, NOW)).toBe(true);

        expect(
            isEventCheckInOpen(
                { ...justInside, status: "COMPLETED" } as never,
                NOW
            )
        ).toBe(true);
        expect(
            isEventCheckInOpen(
                { ...justOutside, status: "COMPLETED" } as never,
                NOW
            )
        ).toBe(false);
    });
});

describe("P15-2. completionDueAt", () => {
    it("is null for an event with no fixed end", () => {
        // P14-D22: no end means no completion instant, automatically or manually.
        expect(completionDueAt(null)).toBeNull();
    });

    it("is exactly endAt + 30 minutes", () => {
        const endAt = at(0);

        expect(completionDueAt(endAt)?.toISOString()).toBe(
            new Date(endAt.getTime() + CHECK_IN_GRACE_MS).toISOString()
        );
    });
});

describe("P15-3. isOngoingDue — automatic, monotonic, catch-up aware", () => {
    it("is due once startAt has arrived and completion is not yet due", () => {
        expect(isOngoingDue(event({ startAt: at(0) }), NOW)).toBe(true);
        expect(isOngoingDue(event({ startAt: at(-5) }), NOW)).toBe(true);
    });

    it("is not due before startAt", () => {
        expect(isOngoingDue(event({ startAt: at(1) }), NOW)).toBe(false);
    });

    it("is NOT due when completion is already due — the final state wins in one pass", () => {
        // Catch-up rule: a tick that runs after the whole event has passed must produce
        // COMPLETED, never a fabricated ONGOING step.
        expect(
            isOngoingDue(event({ startAt: at(-180), endAt: at(-60) }), NOW)
        ).toBe(false);
    });

    it("never re-applies to an ONGOING or COMPLETED event", () => {
        expect(isOngoingDue(event({ status: "ONGOING" }), NOW)).toBe(false);
        expect(isOngoingDue(event({ status: "COMPLETED" }), NOW)).toBe(false);
    });

    it("is not due for a cancelled or archived event, whatever its dates say", () => {
        expect(isOngoingDue(event({ cancelledAt: NOW }), NOW)).toBe(false);
        expect(isOngoingDue(event({ archivedAt: NOW }), NOW)).toBe(false);
    });

    it("is due for an endAt-less event that has started", () => {
        // A running/road event with no fixed end is live once it starts.
        expect(isOngoingDue(event({ endAt: null }), NOW)).toBe(true);
    });
});

describe("P15-4. isCompletionDue", () => {
    it("is due at exactly endAt + 30m and not one millisecond before", () => {
        const endAt = at(-30);

        expect(isCompletionDue(event({ status: "ONGOING", endAt }), NOW)).toBe(
            true
        );
        expect(
            isCompletionDue(
                event({ status: "ONGOING", endAt: new Date(endAt.getTime() + 1) }),
                NOW
            )
        ).toBe(false);
    });

    it("is due from PUBLISHED too (a late tick completes without an ONGOING step)", () => {
        expect(isCompletionDue(event({ status: "PUBLISHED", endAt: at(-60) }), NOW)).toBe(
            true
        );
    });

    it("is never due without an endAt", () => {
        expect(isCompletionDue(event({ status: "ONGOING", endAt: null }), NOW)).toBe(
            false
        );
    });

    it("is never due for COMPLETED, CANCELLED or ARCHIVED", () => {
        expect(isCompletionDue(event({ status: "COMPLETED", endAt: at(-60) }), NOW)).toBe(
            false
        );
        expect(isCompletionDue(event({ cancelledAt: NOW, endAt: at(-60) }), NOW)).toBe(
            false
        );
        expect(isCompletionDue(event({ archivedAt: NOW, endAt: at(-60) }), NOW)).toBe(
            false
        );
    });
});

describe("P15-5. mayCompleteManually", () => {
    it("allows a human to complete once endAt has passed", () => {
        expect(mayCompleteManually(event({ status: "PUBLISHED", endAt: at(0) }), NOW)).toBe(
            true
        );
        expect(mayCompleteManually(event({ status: "ONGOING", endAt: at(-1) }), NOW)).toBe(
            true
        );
    });

    it("refuses before endAt — finishing early is what CANCELLATION expresses", () => {
        expect(mayCompleteManually(event({ endAt: at(1) }), NOW)).toBe(false);
    });

    it("refuses when there is no endAt (P14-D22)", () => {
        expect(mayCompleteManually(event({ endAt: null }), NOW)).toBe(false);
    });

    it("refuses for a state a human may not move out of", () => {
        expect(mayCompleteManually(event({ status: "COMPLETED" }), NOW)).toBe(false);
        expect(mayCompleteManually(event({ status: "DRAFT" }), NOW)).toBe(false);
        expect(mayCompleteManually(event({ cancelledAt: NOW }), NOW)).toBe(false);
        expect(mayCompleteManually(event({ archivedAt: NOW }), NOW)).toBe(false);
    });
});

describe("P15-6. the batch is exported and needs a database", () => {
    it("is a function — the pure suite never calls it", () => {
        // The batch lives in the same module so there is exactly ONE lifecycle
        // implementation; it is exercised against the real database in the integration suite.
        expect(typeof advanceEventLifecycleBatch).toBe("function");
    });
});
