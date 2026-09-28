/**
 * ==========================================
 * MULTI-TAB — ONE STREAM PER BROWSER, DECIDED NOT GUESSED
 * ==========================================
 *
 * The requirement's own scenario: \"Admin opens Orders in tab 1, Admin opens Payments in tab 2.
 * Payment arrives. Both tabs should converge.\" Four streams in four tabs would also converge, but
 * at four connections and four server listeners for one person — and the brief explicitly asks that
 * duplicate subscriptions be avoided.
 *
 * So one tab streams and the rest listen on the channel. That makes the ELECTION a correctness
 * property rather than an optimisation, and it is tested here as one:
 *
 *   • two tabs that see the same peers MUST elect the same tab (no split brain, no double stream);
 *   • the election is STABLE — a tab does not lose leadership merely because a peer mounted;
 *   • a tab that dies without a goodbye is expired by TTL, so the browser cannot be left with no
 *     stream at all;
 *   • expiry happens on READ, so a background tab never wakes up to do bookkeeping.
 */

import {
    PEER_TTL_MS,
    createPeerRegistry,
    createTabId,
    isLeaderTab,
    leaderAmong,
} from "@/lib/realtime/leader";

describe("leaderAmong is pure, total and deterministic", () => {
    test("an empty set has no leader", () => {
        expect(leaderAmong([])).toBeNull();
    });

    test("a tab alone in the browser elects itself", () => {
        expect(leaderAmong(["tab_a"])).toBe("tab_a");
    });

    test("the lowest id wins, regardless of the order the peers were discovered in", () => {
        expect(leaderAmong(["tab_c", "tab_a", "tab_b"])).toBe("tab_a");
        expect(leaderAmong(["tab_a", "tab_b", "tab_c"])).toBe("tab_a");
    });

    test("two tabs seeing the same peer set agree on the leader — no split brain", () => {
        const peerSet = ["tab_z", "tab_m", "tab_b"];

        expect(leaderAmong(["tab_a", ...peerSet])).toBe(leaderAmong(["tab_a", ...[...peerSet].reverse()]));
    });
});

describe("the peer registry forgets dead tabs without a timer", () => {
    test("records, reports and releases peers", () => {
        const registry = createPeerRegistry({ now: () => 1_000 });

        expect(registry.size()).toBe(0);

        registry.note("tab_a");
        registry.note("tab_b", 1_000);

        expect(registry.size()).toBe(2);
        expect(registry.lastSeen("tab_a")).toBe(1_000);
        expect(registry.lastSeen("tab_missing")).toBeNull();
        expect(registry.live().sort()).toEqual(["tab_a", "tab_b"]);

        registry.release("tab_a");

        expect(registry.live()).toEqual(["tab_b"]);
        expect(registry.lastSeen("tab_a")).toBeNull();
    });

    test("a silent peer expires once the TTL passes, and is reaped lazily on read", () => {
        let now = 1_000;
        const registry = createPeerRegistry({ ttlMs: PEER_TTL_MS, now: () => now });

        registry.note("tab_stale");

        now = 1_000 + PEER_TTL_MS - 1;
        expect(registry.live()).toEqual(["tab_stale"]);

        now = 1_000 + PEER_TTL_MS + 1;
        expect(registry.live()).toEqual([]);
        expect(registry.size()).toBe(0);
    });

    test("a peer that keeps announcing stays alive indefinitely", () => {
        let now = 0;
        const registry = createPeerRegistry({ ttlMs: 50_000, now: () => now });

        for (let tick = 0; tick < 10; tick += 1) {
            registry.note("tab_heartbeat");
            now += 25_000;
        }

        expect(registry.live()).toEqual(["tab_heartbeat"]);
    });

    test("clear() empties the registry", () => {
        const registry = createPeerRegistry();

        registry.note("tab_a");
        registry.note("tab_b");
        registry.clear();

        expect(registry.size()).toBe(0);
        expect(registry.live()).toEqual([]);
    });
});

describe("this tab streams only when it is the leader of itself plus its live peers", () => {
    test("alone, it leads", () => {
        const registry = createPeerRegistry({ now: () => 1_000 });

        expect(isLeaderTab("tab_m", registry)).toBe(true);
    });

    test("a LOWER peer takes over, a HIGHER peer does not", () => {
        const registry = createPeerRegistry({ now: () => 1_000 });

        registry.note("tab_a");
        expect(isLeaderTab("tab_m", registry)).toBe(false);

        registry.clear();
        registry.note("tab_z");
        expect(isLeaderTab("tab_m", registry)).toBe(true);
    });

    test("the cluster agrees: exactly ONE tab claims leadership", () => {
        const tabs = ["tab_a", "tab_b", "tab_c"];
        const registries = new Map(
            tabs.map((tabId) => {
                const registry = createPeerRegistry({ now: () => 1_000 });

                for (const other of tabs) {
                    registry.note(other);
                }

                return [tabId, registry] as const;
            })
        );

        const leaders = tabs.filter((tabId) => isLeaderTab(tabId, registries.get(tabId)!));

        expect(leaders).toEqual(["tab_a"]);
    });

    test("when the leader dies, a survivor takes over", () => {
        let now = 1_000;
        const registry = createPeerRegistry({ ttlMs: 50_000, now: () => now });

        registry.note("tab_a");
        expect(isLeaderTab("tab_m", registry)).toBe(false);

        // tab_a closes its tab without a release message: nothing arrives, and the TTL expires it.
        now += 50_001;

        expect(isLeaderTab("tab_m", registry)).toBe(true);
    });

    test("a prompt release re-elects immediately, without waiting out the TTL", () => {
        const registry = createPeerRegistry({ now: () => 1_000 });

        registry.note("tab_a");
        expect(isLeaderTab("tab_m", registry)).toBe(false);

        registry.release("tab_a");

        expect(isLeaderTab("tab_m", registry)).toBe(true);
    });
});

describe("tab identity", () => {
    test("is non-empty and distinct per tab", () => {
        const ids = new Set(Array.from({ length: 50 }, () => createTabId()));

        expect(ids.size).toBe(50);

        for (const id of ids) {
            expect(id.length).toBeGreaterThan(0);
        }
    });
});
