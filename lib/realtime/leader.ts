/**
 * ==========================================
 * MULTI-TAB LEADERSHIP — ONE STREAM PER BROWSER, DETERMINED, NOT LUCK
 * ==========================================
 *
 * Every open tab would otherwise open its own `EventSource`. That is not a correctness problem —
 * each stream is scoped server-side — but it is a resource one: a back-office user with the orders,
 * payments, PIC and customer tabs open would hold four connections and four server-side listeners
 * for the same browser, and the brief explicitly asks that duplicate subscriptions be avoided.
 *
 * So exactly ONE tab per browser holds the stream. The others learn about changes over a
 * `BroadcastChannel`, which is what makes "Payment arrives. Both tabs should converge to the same
 * server state." true without a second connection.
 *
 * ── HOW LEADERSHIP IS DECIDED (AND WHY THIS WAY) ─────────────────────────────────
 * The leader is the LOWEST tab id among the tabs that have announced themselves recently. The rule
 * is a pure function of the peer set, so:
 *
 *   • two tabs that see the same peers elect the same tab (no split brain),
 *   • the election is STABLE — an existing leader is not replaced just because another tab
 *     mounted, unless the newcomer's id sorts lower,
 *   • a tab that dies without saying goodbye is removed by TTL, and the survivors re-elect on
 *     their next evaluation, so a crashed tab cannot leave the browser leaderless.
 *
 * Tab ids are random strings, so "lowest" is arbitrary but total — which is all an election needs.
 * No localStorage, no locks, no server involvement: a peer registry and a comparison.
 *
 * ── NO LOOPS ─────────────────────────────────────────────────────────────────────
 * The channel carries three things and nothing else: a tab's announcement, its release, and a
 * change notification tagged `source: "server"`. A broadcast-sourced change is never re-broadcast
 * (see `client-core.ts`), so a change crosses the channel exactly once however many tabs are open.
 */

/** How long a silent tab is assumed dead. Two heartbeat intervals. */
export const PEER_TTL_MS = 50_000;

export type PeerRegistry = {
    /** Record that a tab is alive (its announcement, heartbeat or release-notice sibling). */
    note: (tabId: string, at?: number) => void;
    /** Record that a tab is going away. Used for prompt re-election. */
    release: (tabId: string) => void;
    /** Live peer ids, excluding the caller's own. */
    live: (at?: number) => string[];
    /** When the given peer was last heard from, or `null`. */
    lastSeen: (tabId: string) => number | null;
    size: () => number;
    clear: () => void;
};

/**
 * A tiny session-scoped peer registry.
 *
 * TTL expiry is applied on READ rather than by a timer: there is no reason for a tab that is
 * looking at a hidden page to wake up just to expire a peer, and a lazy sweep cannot leak beyond
 * the number of tabs that ever announced themselves in this browser session.
 */
export function createPeerRegistry(options: { ttlMs?: number; now?: () => number } = {}): PeerRegistry {
    const ttlMs = options.ttlMs ?? PEER_TTL_MS;
    const now = options.now ?? (() => Date.now());
    const peers = new Map<string, number>();

    return {
        note(tabId, at) {
            peers.set(tabId, at ?? now());
        },

        release(tabId) {
            peers.delete(tabId);
        },

        live(at) {
            const current = at ?? now();

            for (const [tabId, seenAt] of peers) {
                if (current - seenAt > ttlMs) {
                    peers.delete(tabId);
                }
            }

            return [...peers.keys()];
        },

        lastSeen(tabId) {
            return peers.get(tabId) ?? null;
        },

        size() {
            return peers.size;
        },

        clear() {
            peers.clear();
        },
    };
}

/**
 * The leader of a set of tabs.
 *
 * Pure, total and deterministic: the lexicographically smallest id wins, and a tab alone in the
 * browser elects itself. An empty set has no leader, which the caller treats as "no tab is
 * streaming yet" (a transient state during mount, never a permanent one).
 */
export function leaderAmong(tabIds: readonly string[]): string | null {
    if (tabIds.length === 0) {
        return null;
    }

    return [...tabIds].sort()[0] ?? null;
}

/** Whether THIS tab should hold the stream: it is the leader of itself plus its live peers. */
export function isLeaderTab(
    tabId: string,
    peers: PeerRegistry,
    at?: number
): boolean {
    return leaderAmong([tabId, ...peers.live(at)]) === tabId;
}

/** A per-tab identity. Random rather than sequential, because it only needs to be total-ordered. */
export function createTabId(): string {
    return `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
