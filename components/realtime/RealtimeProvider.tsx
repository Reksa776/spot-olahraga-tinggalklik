"use client";

import { usePathname, useRouter } from "next/navigation";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";

import {
    createRealtimeCore,
    nextBackoffMs,
    parseChannelMessage,
    parseRealtimeEnvelope,
    toChangeMessage,
    toPresenceMessage,
    type RealtimeConnectionStatus,
    type RealtimeCore,
} from "@/lib/realtime/client-core";
import { anyGuardDirty, isEditingTarget, shouldHoldRefresh } from "@/lib/realtime/dirty-state";
import { PEER_TTL_MS, createPeerRegistry, createTabId, isLeaderTab } from "@/lib/realtime/leader";
import {
    REALTIME_CHANNEL_NAME,
    REALTIME_HEARTBEAT_MS,
    REALTIME_RECONNECT_MAX_MS,
    REALTIME_RECONNECT_MIN_MS,
    REALTIME_STREAM_PATH,
    domainsForPath,
    type RealtimeDomain,
} from "@/lib/realtime/taxonomy";

import { RealtimeIndicator } from "./RealtimeIndicator";
import { RealtimeRefreshBanner } from "./RealtimeRefreshBanner";

/**
 * ==========================================
 * REALTIME PROVIDER — THE ONE CLIENT MANAGER
 * ==========================================
 *
 * There is exactly one of these per document, mounted once in the root layout, and every page in
 * the application — dashboard, PIC, and customer alike — is covered by it. No page implements its
 * own polling, its own socket, or its own `setInterval`; a page that needs to be more specific
 * calls `useRealtimeDomains`, and a form that must not be overwritten calls
 * `useRealtimeFormGuard`. Both are thin wrappers over the machinery here.
 *
 * ── WHAT IT DOES, IN ORDER ───────────────────────────────────────────────────────
 *
 *   1. RESOLVES the current page's data domains from `usePathname()` (`domainsForPath`), so the
 *      dependency map lives in one auditable table rather than in each page.
 *   2. ELECTS one tab per browser (`lib/realtime/leader.ts`) and opens the SSE stream there. Every
 *      other tab receives the same invalidation over a `BroadcastChannel` — so opening the orders
 *      page in a second tab does NOT open a second connection.
 *   3. FEEDS every envelope into the pure policy core (`lib/realtime/client-core.ts`), which
 *      validates it, deduplicates it, checks it against this page's domains, and coalesces a burst
 *      into ONE `router.refresh()`.
 *   4. PROTECTS unsaved work: a focused editable control, or a registered dirty form, holds the
 *      refresh and shows a non-blocking banner with an explicit choice.
 *   5. SURVIVES transport failure: a down stream starts a bounded fallback refresh, a hidden tab
 *      stops spending requests entirely, and returning to a tab applies one authoritative refresh.
 *
 * ── WHY `router.refresh()` AND NOT A RELOAD ──────────────────────────────────────
 * `router.refresh()` re-renders the SERVER components of the current route and leaves client state,
 * scroll position and focus untouched. `window.location.reload()` would do the opposite, which is
 * why it appears nowhere in this module: a realtime update is a data refresh, not a navigation.
 */

type RealtimeContextValue = {
    /** Connection state, for the indicator. */
    status: RealtimeConnectionStatus;
    /** True while a refresh is held (either inside the coalescing window or by a dirty form). */
    pending: boolean;
    /** True while an automatic refresh is being held back to protect input. */
    held: boolean;
    /** Apply the held refresh now. */
    refreshNow: () => void;
    /** Drop the held refresh until something changes again. */
    dismiss: () => void;
    /** Register unsaved-work state for one form. Keyed by the caller's stable id. */
    setFormDirty: (key: string, dirty: boolean) => void;
    /** Add domains for the current page, beyond those its route implies. */
    addDomains: (domains: readonly RealtimeDomain[]) => void;
};

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

/** Routes that show the indicator. Marketing pages stay clean; working surfaces get the signal. */
const INDICATOR_PREFIXES = ["/dashboard", "/ticketing", "/orders"];

function showsIndicator(pathname: string): boolean {
    return INDICATOR_PREFIXES.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    );
}

function isOperatorSurface(pathname: string): boolean {
    return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

export function RealtimeProvider({
    children,
    enabled,
}: {
    children: ReactNode;
    /**
     * Whether a session exists, decided SERVER-SIDE by the root layout. An anonymous visitor must
     * never open a stream: the endpoint would refuse it, and a client that polled anyway would be
     * pure waste. This is a routing hint, not authority — the server re-checks the session.
     */
    enabled: boolean;
}) {
    const pathname = usePathname() ?? "/";
    const router = useRouter();

    const [status, setStatus] = useState<RealtimeConnectionStatus>("connecting");
    const [pending, setPending] = useState(false);
    const [held, setHeld] = useState(false);

    const coreRef = useRef<RealtimeCore | null>(null);
    const refreshRef = useRef<() => void>(() => {});
    const dirtyGuardsRef = useRef<Map<string, boolean>>(new Map());
    const extraDomainsRef = useRef<Set<RealtimeDomain>>(new Set());
    /** Mirrors `held` so the transport effect can read it without re-subscribing. */
    const heldRef = useRef(false);
    /** Set by the dirty-state effect; called whenever a guard's value changes. */
    const recomputeHeldRef = useRef<() => void>(() => {});

    const pageDomains = useMemo(() => domainsForPath(pathname), [pathname]);

    // `router.refresh` is the ONE thing a refresh does. Read through a ref so the core is created
    // once and never torn down because the router object was a different identity this render.
    useEffect(() => {
        refreshRef.current = () => {
            router.refresh();
        };
    }, [router]);

    /* ── Dirty-form protection ─────────────────────────────────────────────────────
     * Computed here rather than inside the transport effect, because both signals are DOM/React
     * concerns: focus lives on `document`, and registered guards live in the page's React tree.
     */
    useEffect(() => {
        if (!enabled || typeof document === "undefined") {
            return;
        }

        let cancelled = false;

        const recompute = () => {
            if (cancelled) {
                return;
            }

            const next = shouldHoldRefresh({
                focusEditing: isEditingTarget(
                    document.activeElement as unknown as {
                        tagName?: string;
                        isContentEditable?: boolean;
                        type?: string;
                    } | null
                ),
                formDirty: anyGuardDirty(dirtyGuardsRef.current),
            });

            heldRef.current = next;
            setHeld(next);
        };

        recomputeHeldRef.current = recompute;

        /*
         * `focusout` fires BEFORE the incoming element receives focus, so recomputing immediately
         * would read the old active element and hold a refresh that should have been released. The
         * microtask deferral lets the browser finish moving focus first.
         */
        const onFocusChange = () => {
            queueMicrotask(recompute);
        };

        document.addEventListener("focusin", onFocusChange);
        document.addEventListener("focusout", onFocusChange);
        recompute();

        return () => {
            cancelled = true;
            recomputeHeldRef.current = () => {};
            document.removeEventListener("focusin", onFocusChange);
            document.removeEventListener("focusout", onFocusChange);
        };
    }, [enabled]);

    // Keep the core's view of "blocked" in step with the DOM/React view of "editing".
    useEffect(() => {
        coreRef.current?.setBlocked(held);
    }, [held]);

    /* ── Domains ───────────────────────────────────────────────────────────────────
     * The route's own domains, plus anything a page registered explicitly. Recomputed on every
     * navigation, which is what makes the map per-PAGE rather than per-application.
     */
    useEffect(() => {
        const merged = [...new Set([...pageDomains, ...extraDomainsRef.current])];

        coreRef.current?.setDomains(merged);
    }, [pageDomains, enabled]);

    /* ── The core, the transport, the channel ──────────────────────────────────────
     * One effect owns the whole lifetime, so there is no ordering question between "create the
     * core" and "wire the transport": nothing else can observe a half-built client.
     */
    useEffect(() => {
        if (!enabled) {
            return;
        }

        const extraAtMount = [...extraDomainsRef.current];

        const core = createRealtimeCore({
            domains: [...new Set([...domainsForPath(pathname), ...extraAtMount])],
            onRefresh: () => refreshRef.current(),
            onStatus: setStatus,
            onPending: setPending,
        });

        coreRef.current = core;
        core.setBlocked(heldRef.current);
        core.start();

        const tabId = createTabId();
        const peers = createPeerRegistry();
        let leading = false;
        let leaderTabId: string | null = null;
        let attempt = 0;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let source: EventSource | null = null;

        const channel =
            typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(REALTIME_CHANNEL_NAME);

        /*
         * `BroadcastChannel` is not universal (older Safari). Without it the application still
         * works — every tab simply elects itself and opens its own stream — so the only thing lost
         * is the shared connection, never correctness. That is why this is a capability check
         * rather than a polyfill.
         */
        const announce = () => {
            channel?.postMessage(toPresenceMessage("presence", tabId, new Date().toISOString()));
        };

        const openStream = () => {
            if (source !== null) {
                return;
            }

            if (typeof EventSource === "undefined") {
                return;
            }

            const next = new EventSource(REALTIME_STREAM_PATH);

            next.addEventListener("open", () => {
                attempt = 0;
                core.setConnected(true);
                announce();
            });

            /*
             * The heartbeat is a named event rather than a comment precisely so it arrives here: it
             * is the only proof that an IDLE connection is still alive, and without it the core
             * would eventually judge a healthy but quiet stream stale and start polling.
             */
            next.addEventListener("heartbeat", () => {
                core.noteFrame();
            });

            next.addEventListener("change", (event) => {
                const payload = (event as MessageEvent<string>).data;

                let parsed: unknown;

                try {
                    parsed = JSON.parse(payload);
                } catch {
                    return;
                }

                core.noteFrame();

                /*
                 * Validated ONCE, then used twice. `parseRealtimeEnvelope` is what turns an
                 * untrusted frame into a `RealtimeEnvelope`, so the value re-broadcast below is
                 * the very same object the core accepted — rather than a cast that would let a
                 * malformed frame be forwarded to every sibling tab after being rejected here.
                 */
                const envelope = parseRealtimeEnvelope(parsed);
                const outcome = core.ingest(envelope, "server");

                // Only a `server` frame is forwarded, and only once: a peer that receives it as
                // `source: "server"` ingests it locally and does NOT broadcast again, so one change
                // crosses the channel exactly one hop however many tabs are open.
                if (outcome === "accepted" && envelope !== null && channel) {
                    channel.postMessage(toChangeMessage(envelope));
                }
            });

            // A transport error means either a network drop or a half-open socket. Either way the
            // connection is not usable, so it is closed and re-opened under our own backoff rather
            // than `EventSource`'s built-in retry (which is a fixed interval and would hammer a
            // refusing endpoint).
            next.addEventListener("error", () => {
                core.setConnected(false);
                next.close();

                if (source === next) {
                    source = null;
                }

                scheduleReconnect();
            });

            source = next;
        };

        const closeStream = () => {
            source?.close();
            source = null;
            core.setConnected(false);
        };

        const scheduleReconnect = () => {
            if (reconnectTimer !== null) {
                return;
            }

            attempt += 1;

            const delay = nextBackoffMs(attempt, {
                minMs: REALTIME_RECONNECT_MIN_MS,
                maxMs: REALTIME_RECONNECT_MAX_MS,
            });

            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;

                if (leading && (typeof document === "undefined" || document.visibilityState === "visible")) {
                    openStream();
                }
            }, delay);

            (reconnectTimer as unknown as { unref?: () => void }).unref?.();
        };

        const evaluateLeadership = () => {
            const shouldLead = isLeaderTab(tabId, peers);

            if (shouldLead === leading) {
                return;
            }

            leading = shouldLead;

            if (leading) {
                peers.note(tabId);
                announce();
                openStream();
                return;
            }

            closeStream();
        };

        /**
         * A non-leading tab has no socket of its own; the BROWSER's stream health is the leader's
         * presence on the channel. Mirroring it into the core is what stops every background tab
         * from starting its own fallback poll — the "N tabs × one interval" storm.
         */
        const mirrorLeaderHealth = () => {
            if (leading) {
                return;
            }

            const seenAt = leaderTabId === null ? null : peers.lastSeen(leaderTabId);
            const alive = seenAt !== null && Date.now() - seenAt <= PEER_TTL_MS;

            core.setConnected(alive);

            if (!alive) {
                leaderTabId = null;
            }
        };

        const onChannelMessage = (event: MessageEvent<unknown>) => {
            const message = parseChannelMessage(event.data);

            if (message === null) {
                return;
            }

            if (message.kind === "presence") {
                peers.note(message.tabId, Date.parse(message.at) || undefined);

                if (message.tabId !== tabId) {
                    leaderTabId = message.tabId;
                    // A peer announcing itself must be able to see US too, so a tab that has just
                    // mounted does not briefly believe it is alone in the browser.
                    announce();
                }

                mirrorLeaderHealth();
                evaluateLeadership();
                return;
            }

            if (message.kind === "release") {
                peers.release(message.tabId);

                if (leaderTabId === message.tabId) {
                    leaderTabId = null;
                }

                evaluateLeadership();
                mirrorLeaderHealth();
                return;
            }

            // A change forwarded by a peer tab. Ingested, and deliberately NOT re-broadcast.
            core.ingest(message.envelope, "broadcast");
        };

        channel?.addEventListener("message", onChannelMessage as EventListener);

        // Announce immediately (so peers can see us) and keep announcing while we live.
        announce();
        evaluateLeadership();

        const heartbeat = setInterval(() => {
            announce();
            evaluateLeadership();
            mirrorLeaderHealth();
        }, REALTIME_HEARTBEAT_MS);

        (heartbeat as unknown as { unref?: () => void }).unref?.();

        const onVisibility = () => {
            const visible = document.visibilityState === "visible";

            core.setVisible(visible);

            if (!visible) {
                return;
            }

            /*
             * A tab coming back from the background re-elects and reconnects FIRST, then the core
             * applies its single authoritative refresh. Doing it in this order means a tab that
             * inherited leadership while hidden connects before it re-reads.
             */
            peers.note(tabId);
            evaluateLeadership();
            mirrorLeaderHealth();
        };

        document.addEventListener("visibilitychange", onVisibility);

        const onPageHide = () => {
            channel?.postMessage(toPresenceMessage("release", tabId, new Date().toISOString()));
        };

        window.addEventListener("pagehide", onPageHide);

        return () => {
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("pagehide", onPageHide);
            onPageHide();

            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }

            clearInterval(heartbeat);

            source?.close();
            source = null;

            channel?.removeEventListener("message", onChannelMessage as EventListener);
            channel?.close();

            peers.clear();
            core.dispose();
            coreRef.current = null;
        };
        // `pathname` is intentionally absent: navigating must NOT rebuild the connection. The
        // domains effect above re-points the core instead, which is what keeps a navigation from
        // dropping the stream and re-electing a leader.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]);

    const value = useMemo<RealtimeContextValue>(
        () => ({
            status,
            pending,
            held,
            refreshNow: () => coreRef.current?.flushPending(),
            dismiss: () => coreRef.current?.discardPending(),
            setFormDirty: (key, dirty) => {
                if (dirty) {
                    dirtyGuardsRef.current.set(key, true);
                } else {
                    dirtyGuardsRef.current.delete(key);
                }

                // A form becoming dirty (or clean) changes whether a refresh may be applied, so the
                // decision is recomputed here rather than waiting for the next focus event.
                recomputeHeldRef.current();
            },
            addDomains: (domains) => {
                for (const domain of domains) {
                    extraDomainsRef.current.add(domain);
                }

                coreRef.current?.setDomains([
                    ...new Set([...domainsForPath(pathname), ...extraDomainsRef.current]),
                ]);
            },
        }),
        [status, pending, held, pathname]
    );

    return (
        <RealtimeContext.Provider value={value}>
            {children}

            {enabled && showsIndicator(pathname) ? (
                <RealtimeIndicator status={status} operator={isOperatorSurface(pathname)} />
            ) : null}

            {enabled && pending && held ? (
                <RealtimeRefreshBanner
                    onRefresh={() => coreRef.current?.flushPending()}
                    onDismiss={() => coreRef.current?.discardPending()}
                />
            ) : null}
        </RealtimeContext.Provider>
    );
}

/** The shared client, or `null` outside a provider (which is a no-op, never a crash). */
export function useRealtime(): RealtimeContextValue | null {
    return useContext(RealtimeContext);
}

/**
 * Declare extra data domains for the page that calls this.
 *
 * Route coverage lives in `PAGE_DOMAIN_MAP`, and it is deliberately conservative (over-invalidating
 * is safe, under-invalidating is the bug). This hook is the escape hatch for a page whose template
 * reads a family its route does not imply — for example a client component that renders a
 * settlement summary on the overview.
 */
export function useRealtimeDomains(domains: readonly RealtimeDomain[]): void {
    const context = useContext(RealtimeContext);
    const key = domains.join(",");

    useEffect(() => {
        if (!context || domains.length === 0) {
            return;
        }

        context.addDomains(domains);
        // `key` stands in for the array identity, so a caller that passes an inline literal does
        // not re-register on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [context, key]);
}

/**
 * Protect the form that calls this from being overwritten by an automatic refresh.
 *
 * `isDirty` must be the form's OWN notion of unsaved work. While true, a realtime change no longer
 * triggers a silent re-render; the banner appears instead, and the user decides. `useId` is the
 * registry key: stable across renders, unique per component instance, and it needs no
 * caller-supplied name that could collide.
 */
export function useRealtimeFormGuard(isDirty: boolean): void {
    const context = useContext(RealtimeContext);
    const key = useId();

    useEffect(() => {
        if (!context) {
            return;
        }

        context.setFormDirty(key, isDirty);
    }, [context, key, isDirty]);

    useEffect(() => {
        if (!context) {
            return;
        }

        return () => {
            context.setFormDirty(key, false);
        };
    }, [context, key]);
}

/**
 * Whether automatic refreshing is currently held back.
 *
 * Exposed so a surface can explain itself ("penyegaran otomatis dijeda saat Anda mengetik") without
 * duplicating the decision.
 */
export function useRealtimeHeld(): boolean {
    return useRealtime()?.held ?? false;
}

/** Re-exported so callers of this module do not need a second import for the type. */
export type { RealtimeConnectionStatus };

/** A convenience for places that want to force one refresh through the shared manager. */
export function useRealtimeRefreshNow(): () => void {
    const context = useContext(RealtimeContext);

    return useCallback(() => context?.refreshNow(), [context]);
}
