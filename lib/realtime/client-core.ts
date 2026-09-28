import {
    REALTIME_CHANNEL_NAME,
    REALTIME_DEBOUNCE_MS,
    REALTIME_STREAM_STALE_MS,
    isRealtimeDomain,
    isRealtimeEventType,
    realtimeFallbackIntervalMs,
    type RealtimeDomain,
    type RealtimeEnvelope,
} from "./taxonomy";

/**
 * ==========================================
 * REALTIME CLIENT CORE — ALL THE POLICY, NONE OF THE BROWSER
 * ==========================================
 *
 * This module is the whole client-side decision engine, written WITHOUT a DOM: it never touches
 * `EventSource`, `BroadcastChannel`, `document` or `window`. Those are injected by the React
 * provider, and time itself is injected too. That is not academic tidiness — the repository has no
 * jsdom and no testing library, so a policy that only exists inside a `useEffect` cannot be tested
 * at all, and "the fallback polls every 15s" or "ten events coalesce into one refresh" would be
 * claims in a comment rather than assertions in a suite.
 *
 * With the browser edge left outside, every rule the owner asked for is directly testable:
 *
 *   • coalescing        ten events inside the window produce ONE refresh
 *   • deduplication     the same envelope id twice produces ONE refresh
 *   • relevance         an event for another domain produces NO refresh
 *   • visibility        a hidden tab defers; becoming visible flushes once, immediately
 *   • fallback          a down stream refreshes on the interval, and reconnect stops it
 *   • fresh connections  a healthy stream never polls
 *   • dirty forms       a blocked client never auto-refreshes; it waits for a decision
 *
 * ── ONE REFRESH PER WINDOW, ALWAYS ───────────────────────────────────────────────
 * Every path that can lead to a refresh — a stream event, a cross-tab broadcast, the fallback
 * tick, or coming back from a hidden tab — funnels through `schedule()`. There is no second way to
 * ask for a refresh, so no path can produce a burst, and the "refresh storms" the brief warns about
 * are structurally impossible rather than merely unlikely.
 *
 * ── THE SERVER REMAINS THE ONLY SOURCE OF TRUTH ──────────────────────────────────
 * An envelope is never rendered and never applied to any state. It is matched against the current
 * page's domains and, if relevant, used to schedule a re-read of authoritative server data. The
 * core cannot express "set this field to that value", which is what keeps a transport from ever
 * becoming the authority for an order status, a fee, or a settlement.
 */

/* ==================================================================================
 * ENVELOPE VALIDATION — THE STREAM IS UNTRUSTED INPUT
 * ==================================================================================
 * A frame arrives from the network (or from another tab through a channel any page could post to).
 * An unknown type, an unknown domain or a malformed field is DROPPED, so a bad frame can produce
 * at most a wasted parse — never an unbounded refresh loop driven by garbage.
 */

export function parseRealtimeEnvelope(value: unknown): RealtimeEnvelope | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }

    const candidate = value as Record<string, unknown>;

    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
        return null;
    }

    if (!isRealtimeEventType(candidate.type)) {
        return null;
    }

    if (!Array.isArray(candidate.domains)) {
        return null;
    }

    const domains: RealtimeDomain[] = [];

    for (const domain of candidate.domains) {
        // A single unknown domain invalidates the frame: the taxonomy is closed, and silently
        // dropping half of a frame's domains would under-invalidate without anyone noticing.
        if (!isRealtimeDomain(domain)) {
            return null;
        }
        domains.push(domain);
    }

    if (typeof candidate.entityType !== "string") {
        return null;
    }

    if (candidate.entityId !== null && typeof candidate.entityId !== "string") {
        return null;
    }

    if (typeof candidate.at !== "string" || Number.isNaN(Date.parse(candidate.at))) {
        return null;
    }

    return {
        id: candidate.id,
        type: candidate.type,
        domains,
        entityType: candidate.entityType,
        entityId: (candidate.entityId as string | null) ?? null,
        at: candidate.at,
    };
}

/** Where an envelope came from. Only a `server` frame is ever re-broadcast to other tabs. */
export type RealtimeOrigin = "server" | "broadcast";

/**
 * What a cross-tab message looks like.
 *
 * `source` exists to stop a loop: tab A re-broadcasts a server frame, tab B applies it and must
 * NOT broadcast it again. B sees `source: "broadcast"` and stays quiet, so the channel carries
 * exactly one hop per change no matter how many tabs are open.
 */
export type RealtimeChangeMessage = {
    channel: typeof REALTIME_CHANNEL_NAME;
    kind: "change";
    source: RealtimeOrigin;
    envelope: RealtimeEnvelope;
};

/**
 * A tab's presence announcement (mount) and heartbeat, or its departure.
 *
 * EVERY tab announces, not just the one holding the stream: leadership is `lowest id among the
 * tabs that have announced recently`, so a newly opened tab with a lower id could not be discovered
 * — and could not take over — unless it says hello.
 */
/**
 * Split into two members with a SINGLE literal each rather than one member with a `"presence" |
 * "release"` discriminant: a union-typed discriminant does not narrow in a caller's `if` chain, so
 * the two-member shape is what lets a consumer reach the change message without a cast.
 */
export type RealtimePresenceMessage =
    | { channel: typeof REALTIME_CHANNEL_NAME; kind: "presence"; tabId: string; at: string }
    | { channel: typeof REALTIME_CHANNEL_NAME; kind: "release"; tabId: string; at: string };

export type RealtimeChannelMessage = RealtimeChangeMessage | RealtimePresenceMessage;

/** Build the message one tab posts so its peers learn about a change exactly once. */
export function toChangeMessage(envelope: RealtimeEnvelope): RealtimeChangeMessage {
    return {
        channel: REALTIME_CHANNEL_NAME,
        kind: "change",
        source: "server",
        envelope,
    };
}

/** Build a presence or departure message. */
export function toPresenceMessage(
    kind: "presence" | "release",
    tabId: string,
    at: string
): RealtimePresenceMessage {
    return { channel: REALTIME_CHANNEL_NAME, kind, tabId, at };
}

/** Read a channel message, or `null` for anything that is not one. */
export function parseChannelMessage(value: unknown): RealtimeChannelMessage | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }

    const candidate = value as Record<string, unknown>;

    // `channel` first: anything posted to this channel by an unrelated script must be inert.
    if (candidate.channel !== REALTIME_CHANNEL_NAME) {
        return null;
    }

    if (candidate.kind === "presence" || candidate.kind === "release") {
        if (typeof candidate.tabId !== "string" || candidate.tabId.length === 0) {
            return null;
        }

        return {
            channel: REALTIME_CHANNEL_NAME,
            kind: candidate.kind,
            tabId: candidate.tabId,
            at: typeof candidate.at === "string" ? candidate.at : "",
        };
    }

    if (candidate.kind !== "change") {
        return null;
    }

    if (candidate.source !== "server" && candidate.source !== "broadcast") {
        return null;
    }

    const envelope = parseRealtimeEnvelope(candidate.envelope);

    return envelope === null
        ? null
        : {
              channel: REALTIME_CHANNEL_NAME,
              kind: "change",
              source: candidate.source,
              envelope,
          };
}

/* ==================================================================================
 * BACKOFF
 * ==================================================================================
 * Exponential with full jitter, bounded. Jitter is injected so a test can assert the bounds rather
 * than a random value, and the cap matters more than the curve: the reverse proxy will drop idle
 * connections, and a client that retried every 30s forever would look connected while being useless.
 */
export function nextBackoffMs(
    attempt: number,
    options: {
        minMs?: number;
        maxMs?: number;
        random?: () => number;
    } = {}
): number {
    const minMs = options.minMs ?? 1_000;
    const maxMs = options.maxMs ?? 30_000;
    const random = options.random ?? Math.random;

    const capped = Math.min(maxMs, minMs * 2 ** Math.max(0, attempt));

    // Full jitter over [minMs/2, capped], so a fleet of tabs reconnecting after a deploy does not
    // arrive as one synchronized wave.
    return Math.round(minMs / 2 + random() * (capped - minMs / 2));
}

/* ==================================================================================
 * THE CORE
 * ================================================================================== */

/** What the indicator shows. `paused` is a hidden tab, not a broken connection. */
export type RealtimeConnectionStatus = "connecting" | "live" | "fallback" | "paused";

export type RealtimeRefreshReason = "stream" | "broadcast" | "fallback" | "visibility" | "manual";

export type RealtimeIngestOutcome =
    /** Malformed, or an event for a domain this page does not read. */
    | "ignored"
    /** Already seen on this client. */
    | "duplicate"
    /** Relevant, and a refresh is scheduled or will be once the client is unblocked. */
    | "accepted";

export type TimerHandle = ReturnType<typeof setTimeout>;

export type RealtimeCoreDeps = {
    domains: readonly RealtimeDomain[];
    /** Called at most once per coalescing window. This is the ONLY way a refresh happens. */
    onRefresh: (reason: RealtimeRefreshReason) => void;
    onStatus?: (status: RealtimeConnectionStatus) => void;
    onPending?: (pending: boolean) => void;
    debounceMs?: number;
    fallbackIntervalMs?: number;
    staleMs?: number;
    now?: () => number;
    /** Injected so a test drives time instead of waiting for it. */
    setTimer?: (callback: () => void, ms: number) => TimerHandle;
    clearTimer?: (handle: TimerHandle) => void;
    setRepeatingTimer?: (callback: () => void, ms: number) => TimerHandle;
    clearRepeatingTimer?: (handle: TimerHandle) => void;
};

export type RealtimeCore = {
    start: () => void;
    dispose: () => void;
    setDomains: (domains: readonly RealtimeDomain[]) => void;
    getDomains: () => readonly RealtimeDomain[];
    /** The transport's connection state (EventSource open/error). */
    setConnected: (connected: boolean) => void;
    setVisible: (visible: boolean) => void;
    /** Dirty-form protection: while blocked, the core never auto-refreshes. */
    setBlocked: (blocked: boolean) => void;
    /** Any frame (`change` or heartbeat), which is what "the stream is alive" means. */
    noteFrame: (at?: number) => void;
    ingest: (value: unknown, origin: RealtimeOrigin) => RealtimeIngestOutcome;
    isPending: () => boolean;
    /** Apply the pending refresh now (the banner's primary action). */
    flushPending: () => void;
    /** Drop the pending refresh until something changes again (the banner's secondary action). */
    discardPending: () => void;
    status: () => RealtimeConnectionStatus;
};

/** How many envelope ids are remembered for deduplication. */
const SEEN_LIMIT = 500;

export function createRealtimeCore(deps: RealtimeCoreDeps): RealtimeCore {
    const now = deps.now ?? (() => Date.now());
    const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
    const setRepeatingTimer =
        deps.setRepeatingTimer ?? ((callback, ms) => setInterval(callback, ms));
    const clearRepeatingTimer =
        deps.clearRepeatingTimer ?? ((handle) => clearInterval(handle));

    const debounceMs = deps.debounceMs ?? REALTIME_DEBOUNCE_MS;
    const fallbackIntervalMs = deps.fallbackIntervalMs ?? realtimeFallbackIntervalMs();
    const staleMs = deps.staleMs ?? REALTIME_STREAM_STALE_MS;

    let domains: readonly RealtimeDomain[] = deps.domains;
    let started = false;
    let visible = true;
    let blocked = false;
    let connected = false;
    /** Set once the fallback actually takes over, which is what distinguishes it from `connecting`. */
    let polling = false;
    let lastFrameAt = 0;
    let pending = false;
    let pendingReason: RealtimeRefreshReason = "stream";
    let refreshTimer: TimerHandle | null = null;
    let tickTimer: TimerHandle | null = null;
    let status: RealtimeConnectionStatus = "connecting";

    /** Bounded FIFO of seen ids; `Set` preserves insertion order, so the oldest is first out. */
    const seen = new Set<string>();

    function publishStatus(next: RealtimeConnectionStatus) {
        if (status === next) {
            return;
        }

        status = next;
        deps.onStatus?.(next);
    }

    function setPending(next: boolean) {
        if (pending === next) {
            return;
        }

        pending = next;
        deps.onPending?.(next);
    }

    /**
     * `connecting` and `fallback` are NOT the same thing to a user. A page that has just mounted is
     * waiting for its `EventSource` to open (milliseconds), and labelling that "Memperbarui..."
     * would make every load look degraded. `fallback` is only published once the fallback has
     * genuinely taken over — no stream, or a stream that has gone quiet.
     */
    function statusForState(): RealtimeConnectionStatus {
        if (!visible) {
            return "paused";
        }

        if (polling) {
            return "fallback";
        }

        return connected ? "live" : "connecting";
    }

    /**
     * The ONE scheduling entry point.
     *
     * A refresh is deferred while the tab is hidden (no point spending a request nobody sees) or
     * while a form is dirty (the owner must decide). Deferral is not cancellation: the pending flag
     * survives, and `flushPending` or a visibility change applies it exactly once.
     *
     * `force` is the user's own instruction and is the ONLY thing that bypasses a hold — which is
     * why it exists as a separate flag rather than as a variant of `immediate`: an automatic caller
     * asking for "now" must still respect a form the user is typing into.
     */
    function schedule(
        reason: RealtimeRefreshReason,
        options: { immediate?: boolean; force?: boolean } = {}
    ) {
        pendingReason = reason;
        setPending(true);

        if (!started) {
            return;
        }

        if ((blocked || !visible) && !options.force) {
            // Held, deliberately: the banner tells the user, and `flushPending` applies it.
            if (refreshTimer !== null) {
                clearTimer(refreshTimer);
                refreshTimer = null;
            }
            return;
        }

        if (refreshTimer !== null) {
            // Inside the window: the already-scheduled refresh WILL carry this reason too, because
            // a refresh re-reads every domain this page depends on. That is the coalescing.
            if (!options.immediate) {
                return;
            }

            clearTimer(refreshTimer);
            refreshTimer = null;
        }

        if (options.immediate) {
            runRefresh();
            return;
        }

        refreshTimer = setTimer(() => {
            refreshTimer = null;
            runRefresh();
        }, debounceMs);
    }

    function runRefresh() {
        if (refreshTimer !== null) {
            clearTimer(refreshTimer);
            refreshTimer = null;
        }

        if (!pending) {
            return;
        }

        setPending(false);
        deps.onRefresh(pendingReason);
    }

    /**
     * The single repeating tick.
     *
     * It exists for two jobs: notice that a stream has gone quiet (a half-open connection that
     * never fired `error`), and drive the fallback when there is no stream at all. Both are the same
     * action — "this client may be stale, re-read the page" — so one timer does both, and a healthy
     * stream does nothing at all.
     */
    function tick() {
        if (!visible) {
            return;
        }

        const quiet = connected && now() - lastFrameAt > staleMs;

        if (connected && !quiet) {
            return;
        }

        polling = true;
        publishStatus(statusForState());

        schedule("fallback");
    }

    return {
        start() {
            if (started) {
                return;
            }

            started = true;

            tickTimer = setRepeatingTimer(tick, fallbackIntervalMs);
            (tickTimer as unknown as { unref?: () => void }).unref?.();

            publishStatus(statusForState());
        },

        dispose() {
            started = false;

            if (refreshTimer !== null) {
                clearTimer(refreshTimer);
                refreshTimer = null;
            }

            if (tickTimer !== null) {
                clearRepeatingTimer(tickTimer);
                tickTimer = null;
            }

            seen.clear();
            setPending(false);
        },

        setDomains(next) {
            domains = next;
        },

        getDomains() {
            return domains;
        },

        setConnected(next) {
            const wasConnected = connected;
            connected = next;

            if (next) {
                // The stream is back: the client is no longer falling back to polling.
                polling = false;
                // A (re)connected stream is fresh by definition: resetting the staleness clock is
                // what stops a reconnect from being mistaken for a stalled connection.
                lastFrameAt = now();
            }

            publishStatus(statusForState());

            if (!wasConnected && next && pending) {
                // The stream came back with work already queued: apply it now rather than waiting
                // out the window, because the user has been looking at stale data.
                schedule(pendingReason, { immediate: true });
            }
        },

        setVisible(next) {
            if (visible === next) {
                return;
            }

            visible = next;
            publishStatus(statusForState());

            if (!next) {
                // Hidden: hold everything. A hidden tab must not spend requests.
                if (refreshTimer !== null) {
                    clearTimer(refreshTimer);
                    refreshTimer = null;
                }

                return;
            }

            // Becoming visible: ONE authoritative refresh, immediately. This is the guarantee that
            // a tab left open overnight is correct the moment it is looked at again.
            if (pending || !connected) {
                schedule("visibility", { immediate: true });
            }
        },

        setBlocked(next) {
            if (blocked === next) {
                return;
            }

            blocked = next;

            if (!next && pending) {
                // The user committed or abandoned their edit: the held refresh can now be applied.
                schedule(pendingReason);
            }
        },

        noteFrame(at) {
            lastFrameAt = at ?? now();
            polling = false;

            if (!connected) {
                connected = true;
            }

            publishStatus(statusForState());
        },

        ingest(value, origin) {
            const envelope = parseRealtimeEnvelope(value);

            if (envelope === null) {
                return "ignored";
            }

            if (seen.has(envelope.id)) {
                return "duplicate";
            }

            seen.add(envelope.id);

            if (seen.size > SEEN_LIMIT) {
                const oldest = seen.values().next();

                if (!oldest.done) {
                    seen.delete(oldest.value);
                }
            }

            // The relevance test. A page that does not read these domains must not refresh, which
            // is what keeps a dashboard full of tabs from re-rendering on every unrelated change.
            const relevant = envelope.domains.some((domain) => domains.includes(domain));

            if (!relevant) {
                return "ignored";
            }

            schedule(origin === "broadcast" ? "broadcast" : "stream");

            return "accepted";
        },

        isPending() {
            return pending;
        },

        flushPending() {
            if (!pending) {
                return;
            }

            // The user asked: this is the one path that is allowed to refresh while a form is dirty.
            schedule(pendingReason, { immediate: true, force: true });
        },

        discardPending() {
            if (refreshTimer !== null) {
                clearTimer(refreshTimer);
                refreshTimer = null;
            }

            setPending(false);
        },

        status() {
            return status;
        },
    };
}
