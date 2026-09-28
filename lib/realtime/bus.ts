import {
    audienceKey,
    domainsForEventType,
    type RealtimeAudience,
    type RealtimeDomain,
    type RealtimeEnvelope,
    type RealtimeEventType,
} from "./taxonomy";

/**
 * ==========================================
 * REALTIME BUS — THE ONE PUBLISHER, THE ONE TRANSPORT SEAM
 * ==========================================
 *
 * Every successful mutation in this application announces itself here, and every open realtime
 * stream subscribes here. It is the single point through which change notifications flow, so the
 * whole feature has exactly one publisher API and one delivery path — never a per-page mechanism.
 *
 * ── WHY AN IN-PROCESS BUS IS THE CORRECT TRANSPORT FOR THIS DEPLOYMENT ───────────
 * `ecosystem.config.cjs` pins `instances: 1` / `exec_mode: "fork"`, and it explains why: the
 * application's login rate limiter (`lib/rate-limit.ts`) is an in-memory, per-process bucket, so
 * clustering would silently multiply every limit. One instance is what the code supports. Under
 * that constraint a process-local bus is not a shortcut — it is exactly as correct as a broker,
 * with no Redis, no socket server, no extra port, and no second deployment artifact.
 *
 * The constraint is therefore LOAD-BEARING and is asserted rather than assumed:
 * `__tests__/realtime/deployment.test.ts` fails if the ecosystem file ever moves off a single
 * forked instance, so scaling out forces this decision to be revisited (an outbox or a broker)
 * instead of silently degrading into one-instance-only delivery. The client's fallback poll then
 * bounds staleness for any window in which the stream is not healthy.
 *
 * ── PUBLISH AFTER COMMIT, NEVER INSIDE IT ────────────────────────────────────────
 * `publishRealtimeChange` is called by a service AFTER its `prisma.$transaction` has resolved,
 * never inside the transaction callback. Two consequences, and both matter:
 *
 *   • A transaction that ROLLS BACK publishes nothing, because the call site is never reached.
 *     Publishing early would let a client refresh and observe a state the database never held.
 *   • A publish can never roll a mutation back: the listener loop swallows its own errors, so a
 *     broken subscriber degrades the notification, not the write.
 *
 * ── THE EVENT IS AN INVALIDATION, NOT DATA ───────────────────────────────────────
 * The envelope (see `taxonomy.ts`) carries a type, the affected domains, an opaque entity id for
 * deduplication, and a timestamp. No money, no customer identity, no status, no order number, no
 * token, no signature. A client that renders these must still fetch authoritative server data,
 * which is what keeps the money engine the only authority for money.
 *
 * ── THE PUBLISHER DECLARES THE AUDIENCE ─────────────────────────────────────────
 * `audiences` is required, not optional: a call site that forgets to say who may be told would
 * otherwise broadcast to everyone. The delivery filter intersects it with the caller's
 * server-resolved scope, so a forged client id cannot widen anyone's reach.
 */

/** What a call site provides. Everything optional beyond the type is derived or defaulted. */
export type RealtimeChangeInput = {
    type: RealtimeEventType;
    /** The Prisma model the change concerned, e.g. `EventOrder`. */
    entityType: string;
    /** The affected row, when there is exactly one. Opaque to clients; used for dedup only. */
    entityId?: string | null;
    /** WHO may be told. Empty means "nobody" — an event with no audience is never delivered. */
    audiences: readonly RealtimeAudience[];
    /** Override the derived domains. Almost never needed; the taxonomy already knows. */
    domains?: readonly RealtimeDomain[];
    /** The commit instant. Injectable so tests are deterministic. */
    at?: Date;
    /** Override the generated id. Injectable so a test can assert deduplication. */
    id?: string;
};

/** One published change: the wire envelope plus the audience set it is addressed to. */
export type PublishedRealtimeChange = {
    envelope: RealtimeEnvelope;
    audiences: readonly RealtimeAudience[];
};

/** A stream's handler. Receives every published change; returns nothing. */
export type RealtimeBusListener = (change: PublishedRealtimeChange) => void;

type BusState = {
    listeners: Set<RealtimeBusListener>;
    /** Monotonic per-process counter, so two changes in the same millisecond get distinct ids. */
    sequence: number;
    /** Identifies THIS process run, so ids from a previous run cannot collide with this one. */
    epoch: string;
};

/**
 * Canonicalise the audience set: one entry per recipient.
 *
 * Several publishers compose their audience from two builders that EACH include the platform
 * audience (`tenantAudience(...)` plus `buyerAudience(...)`, say), which is correct to express and
 * useless to deliver twice. Normalising here rather than in each publisher means the set a
 * subscriber inspects is always the minimal one, and a future publisher cannot reintroduce the
 * duplication. It is semantically safe either way — delivery is a `Set` intersection — which is
 * exactly why it would otherwise go unnoticed.
 */
function canonicalAudiences(audiences: readonly RealtimeAudience[]): RealtimeAudience[] {
    const seen = new Set<string>();
    const result: RealtimeAudience[] = [];

    for (const audience of audiences) {
        const key = audienceKey(audience);

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(audience);
    }

    return result;
}

/**
 * The process-wide state.
 *
 * Stashed on `globalThis` exactly like `lib/prisma.ts` does with the client, for the same reason:
 * Next's dev server re-evaluates modules on every hot reload, and a module-local `Set` would drop
 * every open stream's subscription on each edit — the stream would look connected while silently
 * receiving nothing. The identity of the bus must outlive module re-evaluation.
 */
const GLOBAL_KEY = "__tinggalklik_realtime_bus__";

type GlobalWithBus = typeof globalThis & {
    [GLOBAL_KEY]?: BusState;
};

function state(): BusState {
    const globalScope = globalThis as GlobalWithBus;

    globalScope[GLOBAL_KEY] ??= {
        listeners: new Set(),
        sequence: 0,
        epoch: `${process.pid.toString(36)}-${Date.now().toString(36)}`,
    };

    return globalScope[GLOBAL_KEY];
}

/**
 * Subscribe to every published change.
 *
 * Returns the unsubscribe function, and the caller MUST use it: a stream that never unsubscribes
 * keeps its listener alive for the life of the process, and `Set` membership would then retain
 * the closed response stream and its whole closure.
 */
export function subscribeRealtimeBus(listener: RealtimeBusListener): () => void {
    const current = state();
    current.listeners.add(listener);

    return () => {
        current.listeners.delete(listener);
    };
}

/** How many streams are currently attached. For tests and for an operator probing a live process. */
export function realtimeListenerCount(): number {
    return state().listeners.size;
}

/**
 * Announce one committed change.
 *
 * Never throws, and returns the published change so a caller (or a test) can inspect exactly what
 * was sent. A listener that throws is isolated: its failure is logged and the remaining listeners
 * still receive the change, because one broken subscriber must not deny every other tab its
 * invalidation — and, more importantly, must never propagate into the write path.
 */
export function publishRealtimeChange(input: RealtimeChangeInput): PublishedRealtimeChange {
    const current = state();
    current.sequence += 1;

    const at = input.at ?? new Date();

    const change: PublishedRealtimeChange = {
        envelope: {
            id: input.id ?? `rt_${current.epoch}_${current.sequence}`,
            type: input.type,
            domains: input.domains ?? domainsForEventType(input.type),
            entityType: input.entityType,
            entityId: input.entityId ?? null,
            at: at.toISOString(),
        },
        audiences: canonicalAudiences(input.audiences),
    };

    for (const listener of [...current.listeners]) {
        try {
            listener(change);
        } catch (error) {
            console.error("REALTIME_LISTENER_ERROR:", error);
        }
    }

    return change;
}

/**
 * Detach every listener and reset the sequence.
 *
 * Test-only, and named so that is unmistakable: production code has no reason to drop every open
 * stream at once, and a caller doing it "to clean up" would be tearing down other requests.
 */
export function __resetRealtimeBusForTests(): void {
    const current = state();
    current.listeners.clear();
    current.sequence = 0;
    current.epoch = `test-${Date.now().toString(36)}`;
}
