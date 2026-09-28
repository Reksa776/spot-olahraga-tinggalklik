/**
 * ==========================================
 * THE CLIENT POLICY CORE
 * ==========================================
 *
 * Everything the brief asks the client to guarantee is asserted here, with INJECTED time — no
 * waiting, no flakiness:
 *
 *   F    duplicate event           → one refresh
 *   D    ten events in a burst     → one refresh
 *   —    an unrelated domain       → NO refresh
 *   J/K  hidden tab, then visible  → held, then exactly one immediate refresh
 *   I    stream down               → interval-driven refresh; reconnect stops it
 *   —    healthy stream            → never polls
 *   M    dirty form                → held, until the user decides
 *   N    read-only page            → refreshes with no interaction at all
 *
 * The fake clock below is a real scheduler: timers are queued with their due time and `advance`
 * runs them in order, so a `setInterval` genuinely repeats and a debounce genuinely resets.
 */

import {
    createRealtimeCore,
    nextBackoffMs,
    parseChannelMessage,
    parseRealtimeEnvelope,
    toChangeMessage,
    toPresenceMessage,
    type RealtimeCore,
    type RealtimeCoreDeps,
    type TimerHandle,
} from "@/lib/realtime/client-core";
import {
    REALTIME_CHANNEL_NAME,
    type RealtimeDomain,
    type RealtimeEnvelope,
} from "@/lib/realtime/taxonomy";

const DEBOUNCE_MS = 300;
const FALLBACK_MS = 15_000;

/* ---------------------------------------------------------------------------------
 * A deterministic clock
 * --------------------------------------------------------------------------------- */

class FakeClock {
    now = 1_000_000;

    private nextId = 1;
    private timers = new Map<number, { at: number; every: number | null; fn: () => void }>();

    setTimer = (fn: () => void, ms: number): TimerHandle => {
        const id = this.nextId++;
        this.timers.set(id, { at: this.now + ms, every: null, fn });
        return id as unknown as TimerHandle;
    };

    clearTimer = (handle: TimerHandle): void => {
        this.timers.delete(handle as unknown as number);
    };

    setRepeatingTimer = (fn: () => void, ms: number): TimerHandle => {
        const id = this.nextId++;
        this.timers.set(id, { at: this.now + ms, every: ms, fn });
        return id as unknown as TimerHandle;
    };

    clearRepeatingTimer = (handle: TimerHandle): void => {
        this.timers.delete(handle as unknown as number);
    };

    /** Move time forward, running every timer that becomes due, in due order. */
    advance(ms: number): void {
        const target = this.now + ms;

        for (;;) {
            let nextId: number | null = null;
            let nextAt = 0;

            for (const [id, timer] of this.timers) {
                if (timer.at <= target && (nextId === null || timer.at < nextAt)) {
                    nextId = id;
                    nextAt = timer.at;
                }
            }

            if (nextId === null) {
                break;
            }

            const timer = this.timers.get(nextId);
            this.now = timer!.at;

            if (timer!.every === null) {
                this.timers.delete(nextId);
            } else {
                timer!.at = this.now + timer!.every;
            }

            timer!.fn();
        }

        this.now = target;
    }

    pending(): number {
        return this.timers.size;
    }
}

function envelope(
    overrides: { id: string } & Partial<Omit<RealtimeEnvelope, "id">>
): RealtimeEnvelope {
    return {
        id: overrides.id,
        type: overrides.type ?? "PAYMENT_PAID",
        domains: overrides.domains ?? ["orders"],
        entityType: overrides.entityType ?? "EventOrder",
        entityId: overrides.entityId ?? "ord_1",
        at: overrides.at ?? new Date(1_000_000).toISOString(),
    };
}

type Harness = {
    clock: FakeClock;
    core: RealtimeCore;
    refreshes: string[];
    statuses: string[];
    pendings: boolean[];
};

function harness(domains: RealtimeDomain[], deps: Partial<RealtimeCoreDeps> = {}): Harness {
    const clock = new FakeClock();
    const refreshes: string[] = [];
    const statuses: string[] = [];
    const pendings: boolean[] = [];

    const core = createRealtimeCore({
        domains,
        onRefresh: (reason) => refreshes.push(reason),
        onStatus: (status) => statuses.push(status),
        onPending: (pending) => pendings.push(pending),
        now: () => clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        setRepeatingTimer: clock.setRepeatingTimer,
        clearRepeatingTimer: clock.clearRepeatingTimer,
        debounceMs: DEBOUNCE_MS,
        fallbackIntervalMs: FALLBACK_MS,
        staleMs: 50_000,
        ...deps,
    });

    return { clock, core, refreshes, statuses, pendings };
}

/* ==================================================================================
 * VALIDATION — the stream and the channel are untrusted input
 * ================================================================================== */

describe("envelope validation", () => {
    test("accepts a well-formed envelope", () => {
        const parsed = parseRealtimeEnvelope({
            id: "rt_1",
            type: "PAYMENT_PAID",
            domains: ["orders", "payments"],
            entityType: "EventOrder",
            entityId: "ord_1",
            at: "2026-09-28T00:00:00.000Z",
        });

        expect(parsed).toEqual({
            id: "rt_1",
            type: "PAYMENT_PAID",
            domains: ["orders", "payments"],
            entityType: "EventOrder",
            entityId: "ord_1",
            at: "2026-09-28T00:00:00.000Z",
        });
    });

    test("drops anything malformed, unknown or unparseable", () => {
        const good = {
            id: "rt_1",
            type: "PAYMENT_PAID",
            domains: ["orders"],
            entityType: "EventOrder",
            entityId: null,
            at: "2026-09-28T00:00:00.000Z",
        };

        expect(parseRealtimeEnvelope(good)).not.toBeNull();
        expect(parseRealtimeEnvelope({ ...good, domains: [] })).not.toBeNull();

        expect(parseRealtimeEnvelope(null)).toBeNull();
        expect(parseRealtimeEnvelope("string")).toBeNull();
        expect(parseRealtimeEnvelope({})).toBeNull();
        expect(parseRealtimeEnvelope({ ...good, id: "" })).toBeNull();
        expect(parseRealtimeEnvelope({ ...good, type: "ORDER_DELETED" })).toBeNull();
        // ONE unknown domain invalidates the frame rather than silently under-invalidating.
        expect(parseRealtimeEnvelope({ ...good, domains: ["orders", "nope"] })).toBeNull();
        expect(parseRealtimeEnvelope({ ...good, entityId: 5 })).toBeNull();
        expect(parseRealtimeEnvelope({ ...good, at: "not-a-date" })).toBeNull();
    });

    test("the channel message parser refuses foreign traffic", () => {
        expect(parseChannelMessage({ channel: "other", kind: "presence", tabId: "a" })).toBeNull();
        expect(parseChannelMessage({ kind: "presence", tabId: "a" })).toBeNull();
        expect(parseChannelMessage({ channel: REALTIME_CHANNEL_NAME, kind: "nope" })).toBeNull();
        expect(
            parseChannelMessage({ channel: REALTIME_CHANNEL_NAME, kind: "presence", tabId: "" })
        ).toBeNull();

        const presence = parseChannelMessage(
            toPresenceMessage("presence", "tab-1", "2026-09-28T00:00:00.000Z")
        );
        expect(presence).toEqual({
            channel: REALTIME_CHANNEL_NAME,
            kind: "presence",
            tabId: "tab-1",
            at: "2026-09-28T00:00:00.000Z",
        });

        // A change message is tagged `source: "server"` — the tag that stops a re-broadcast loop.
        const change = parseChannelMessage(toChangeMessage(envelope({ id: "rt_9" })));
        expect(change).toEqual({
            channel: REALTIME_CHANNEL_NAME,
            kind: "change",
            source: "server",
            envelope: envelope({ id: "rt_9" }),
        });
    });
});

/* ==================================================================================
 * COALESCING AND DEDUPLICATION
 * ================================================================================== */

describe("one refresh per coalescing window", () => {
    test("ten events inside the window produce exactly ONE refresh", () => {
        const { core, clock, refreshes } = harness(["orders", "payments", "tickets"]);
        core.start();

        for (let index = 0; index < 10; index += 1) {
            expect(core.ingest(envelope({ id: `rt_${index}` }), "server")).toBe("accepted");

            clock.advance(10);
        }

        // Still inside the window relative to the LAST event: nothing has fired yet.
        expect(refreshes).toEqual([]);

        clock.advance(DEBOUNCE_MS);
        expect(refreshes).toEqual(["stream"]);
    });

    test("a duplicate id produces no second refresh", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();

        expect(core.ingest(envelope({ id: "rt_dup" }), "server")).toBe("accepted");
        clock.advance(400);
        expect(refreshes).toEqual(["stream"]);

        expect(core.ingest(envelope({ id: "rt_dup" }), "server")).toBe("duplicate");
        clock.advance(400);
        expect(refreshes).toEqual(["stream"]);
    });

    test("the same change arriving over both the stream and the channel is one refresh", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();

        expect(core.ingest(envelope({ id: "rt_both" }), "server")).toBe("accepted");
        // A peer tab forwarded the identical envelope.
        expect(core.ingest(envelope({ id: "rt_both" }), "broadcast")).toBe("duplicate");

        clock.advance(DEBOUNCE_MS);
        expect(refreshes).toEqual(["stream"]);
    });

    test("two windows produce two refreshes, not more", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();

        core.ingest(envelope({ id: "rt_a" }), "server");
        clock.advance(DEBOUNCE_MS);
        core.ingest(envelope({ id: "rt_b" }), "server");
        clock.advance(DEBOUNCE_MS);

        expect(refreshes).toEqual(["stream", "stream"]);
    });

    test("an event forwarded by another tab still refreshes once, tagged as a broadcast", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();

        core.ingest(envelope({ id: "rt_peer" }), "broadcast");
        clock.advance(DEBOUNCE_MS);

        expect(refreshes).toEqual(["broadcast"]);
    });

    test("the out-of-order case is harmless: a stale envelope still only invalidates", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();

        // An OLDER envelope delivered after a newer one. There is no version column to compare
        // (deliberately: the database has none), so the worst case is a second refresh.
        core.ingest(envelope({ id: "rt_new", at: "2026-09-28T10:00:00.000Z" }), "server");
        clock.advance(DEBOUNCE_MS);
        core.ingest(envelope({ id: "rt_old", at: "2026-09-28T09:00:00.000Z" }), "server");
        clock.advance(DEBOUNCE_MS);

        expect(refreshes).toEqual(["stream", "stream"]);
    });
});

/* ==================================================================================
 * RELEVANCE — unrelated pages must not refresh
 * ================================================================================== */

describe("a page only reacts to the domains it reads", () => {
    test("an unrelated domain is ignored outright", () => {
        const { core, clock, refreshes } = harness(["payments"]);

        // A payments-only page must ignore a venue change entirely.
        expect(core.ingest(envelope({ id: "rt_v", domains: ["venues"] }), "server")).toBe(
            "ignored"
        );
        clock.advance(1_000);

        expect(refreshes).toEqual([]);
    });

    test("a single overlapping domain is enough", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();

        expect(
            core.ingest(
                envelope({ id: "rt_multi", domains: ["venues", "orders", "events"] }),
                "server"
            )
        ).toBe("accepted");

        clock.advance(DEBOUNCE_MS);
        expect(refreshes).toEqual(["stream"]);
    });

    test("a page with NO domains never refreshes — the public/marketing case", () => {
        const { core, clock, refreshes } = harness([]);

        for (const domain of ["orders", "payments", "tickets"] as const) {
            expect(core.ingest(envelope({ id: `rt_${domain}`, domains: [domain] }), "server")).toBe(
                "ignored"
            );
        }

        clock.advance(5_000);
        expect(refreshes).toEqual([]);
    });

    test("setDomains re-points the same client after a navigation", () => {
        const { core, clock, refreshes } = harness(["payments"]);
        core.start();

        expect(core.ingest(envelope({ id: "rt_1", domains: ["orders"] }), "server")).toBe(
            "ignored"
        );

        core.setDomains(["orders"]);
        expect(core.getDomains()).toEqual(["orders"]);

        expect(core.ingest(envelope({ id: "rt_2", domains: ["orders"] }), "server")).toBe(
            "accepted"
        );

        clock.advance(DEBOUNCE_MS);
        expect(refreshes).toEqual(["stream"]);
    });
});

/* ==================================================================================
 * VISIBILITY
 * ================================================================================== */

describe("a hidden tab spends nothing and a returning tab refreshes once", () => {
    test("a hidden tab holds the refresh instead of performing it", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();
        core.setVisible(false);

        core.ingest(envelope({ id: "rt_hidden" }), "server");
        clock.advance(5_000);

        expect(refreshes).toEqual([]);
        expect(core.isPending()).toBe(true);
    });

    test("becoming visible applies exactly ONE immediate refresh", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();
        core.setVisible(false);

        core.ingest(envelope({ id: "rt_1" }), "server");
        core.ingest(envelope({ id: "rt_2" }), "server");

        core.setVisible(true);

        // Immediate: not deferred by the debounce window.
        expect(refreshes).toEqual(["visibility"]);
        expect(core.isPending()).toBe(false);

        clock.advance(5_000);
        expect(refreshes).toEqual(["visibility"]);
    });

    test("status reports paused while hidden and live again afterwards", () => {
        const { core, clock, statuses } = harness(["orders"]);
        core.start();

        core.setConnected(true);
        core.setVisible(false);
        core.setVisible(true);
        clock.advance(10);

        expect(statuses).toContain("paused");
        expect(core.status()).toBe("live");
    });
});

/* ==================================================================================
 * FALLBACK AND RECONNECT
 * ================================================================================== */

describe("the fallback is bounded, interval-driven and only runs while the stream is down", () => {
    test("a healthy connected stream NEVER polls", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();
        core.setConnected(true);

        // Keep the connection fresh with heartbeats for two minutes.
        for (let index = 0; index < 8; index += 1) {
            core.noteFrame();
            clock.advance(FALLBACK_MS);
        }

        expect(refreshes).toEqual([]);
        expect(core.status()).toBe("live");
    });

    test("a stream that goes silent is treated as dead and the fallback takes over", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();
        core.setConnected(true);
        core.noteFrame();

        // 60s of silence > the 50s staleness window, plus the debounce window.
        clock.advance(60_400);

        expect(refreshes.length).toBeGreaterThan(0);
        expect(new Set(refreshes)).toEqual(new Set(["fallback"]));
    });

    test("with no stream at all, the fallback refreshes on its interval", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();

        expect(core.status()).toBe("connecting");

        clock.advance(FALLBACK_MS + 400);
        clock.advance(FALLBACK_MS + 400);

        expect(refreshes.length).toBeGreaterThanOrEqual(2);
        expect(core.status()).toBe("fallback");
    });

    test("a hidden tab does not poll either", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();
        core.setVisible(false);

        clock.advance(120_000);

        expect(refreshes).toEqual([]);
    });

    test("reconnecting stops the fallback immediately", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();

        clock.advance(FALLBACK_MS + 1_000);
        const afterFirstFallback = refreshes.length;
        expect(afterFirstFallback).toBeGreaterThan(0);

        core.setConnected(true);
        core.noteFrame();

        clock.advance(50_000);
        expect(refreshes.length).toBe(afterFirstFallback);
    });
});

describe("reconnect backoff", () => {
    test("grows, is capped, and is jittered inside the bounds", () => {
        const fixed = { random: () => 0.5, minMs: 1_000, maxMs: 30_000 };

        const first = nextBackoffMs(1, fixed);
        const second = nextBackoffMs(2, fixed);
        const deep = nextBackoffMs(20, fixed);

        expect(first).toBeGreaterThanOrEqual(500);
        expect(first).toBeLessThanOrEqual(2_000);
        expect(second).toBeGreaterThan(first);
        expect(deep).toBeLessThanOrEqual(30_000);
        expect(nextBackoffMs(0, fixed)).toBeGreaterThanOrEqual(500);
    });

    test("jitter keeps two clients from retrying in lockstep", () => {
        const low = nextBackoffMs(5, { random: () => 0, minMs: 1_000, maxMs: 30_000 });
        const high = nextBackoffMs(5, { random: () => 1, minMs: 1_000, maxMs: 30_000 });

        expect(low).toBeLessThan(high);
    });
});

/* ==================================================================================
 * DIRTY FORMS
 * ================================================================================== */

describe("a blocked client never overwrites input, and waits for a decision", () => {
    test("while blocked, an event is accepted but the refresh is held", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();
        core.setBlocked(true);

        expect(core.ingest(envelope({ id: "rt_dirty" }), "server")).toBe("accepted");
        clock.advance(10_000);

        expect(refreshes).toEqual([]);
        expect(core.isPending()).toBe(true);
    });

    test("`flushPending` is the ONE path an automatic hold does not block", () => {
        const { core, refreshes } = harness(["orders"]);
        core.start();
        core.setBlocked(true);

        core.ingest(envelope({ id: "rt_1" }), "server");
        core.flushPending();

        expect(refreshes).toEqual(["stream"]);
        expect(core.isPending()).toBe(false);
    });

    test("`discardPending` drops the held refresh until something changes again", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();
        core.setBlocked(true);

        core.ingest(envelope({ id: "rt_1" }), "server");
        core.discardPending();
        clock.advance(1_000);

        expect(refreshes).toEqual([]);
        expect(core.isPending()).toBe(false);

        // A NEW change is a new decision.
        core.ingest(envelope({ id: "rt_2" }), "server");
        expect(core.isPending()).toBe(true);
    });

    test("unblocking applies the held refresh", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();
        core.setBlocked(true);

        core.ingest(envelope({ id: "rt_1" }), "server");
        clock.advance(1_000);
        expect(refreshes).toEqual([]);

        core.setBlocked(false);
        clock.advance(DEBOUNCE_MS);

        expect(refreshes).toEqual(["stream"]);
    });

    test("a read-only page is never blocked, so it refreshes immediately", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();
        core.setConnected(true);

        // No `setBlocked(true)` is ever called on a page with no editable field, which is what
        // makes "read-only pages refresh immediately" true by construction rather than by a rule.
        core.ingest(envelope({ id: "rt_ro" }), "server");
        clock.advance(DEBOUNCE_MS);

        expect(refreshes).toEqual(["stream"]);
    });
});

/* ==================================================================================
 * LIFECYCLE
 * ================================================================================== */

describe("dispose stops everything", () => {
    test("no timer survives disposal", () => {
        const { core, clock, refreshes } = harness(["orders"]);
        core.start();

        core.ingest(envelope({ id: "rt_1" }), "server");
        core.dispose();

        expect(clock.pending()).toBe(0);

        clock.advance(120_000);
        expect(refreshes).toEqual([]);
        expect(core.isPending()).toBe(false);
    });

    test("start is idempotent", () => {
        const { core, clock, refreshes } = harness(["orders"]);

        core.start();
        core.start();

        core.setConnected(true);
        clock.advance(30_000);

        expect(refreshes).toEqual([]);
        expect(clock.pending()).toBe(1);
    });
});
