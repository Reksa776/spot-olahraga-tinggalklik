import {
    REALTIME_HEARTBEAT_MS,
    REALTIME_RECONNECT_MAX_MS,
    type RealtimeEnvelope,
} from "./taxonomy";

/** The named SSE event the client listens for as proof of life. */
export const SSE_CHANGE_EVENT = "change";
export const SSE_HEARTBEAT_EVENT = "heartbeat";

/**
 * ==========================================
 * SSE FRAMING — PURE, SO IT CAN BE TESTED WITHOUT A SERVER
 * ==========================================
 *
 * Server-Sent Events is the transport: one long-lived GET per browser, same origin, no new
 * dependency, no new port, no websocket upgrade to reverse-proxy, and no change to how the
 * application is deployed. `nginx` needs `proxy_buffering off` for the path (documented in
 * `DEPLOYMENT_RUNBOOK.md`), which is a configuration note rather than an architecture change.
 *
 * Frames are built here as STRINGS, and the stream route only writes them. That keeps the protocol
 * decisions (which fields cross the wire, how a heartbeat is framed, what the retry hint is) in a
 * function that a unit test calls directly — no sockets, no fake clock.
 *
 * ── WHY EVERY FRAME IS SINGLE-LINE JSON ──────────────────────────────────────────
 * An SSE `data:` field must not contain a raw newline (the newline ends the field). `JSON.stringify`
 * never emits one for the envelope's scalar fields, and the encoder additionally strips any control
 * character defensively, so a future field could not silently corrupt the framing.
 *
 * ── WHY THE HEARTBEAT IS AN EVENT AND NOT A COMMENT ──────────────────────────────
 * A `: comment` keeps proxies from idling the socket out, but `EventSource` never delivers it to
 * the page — so a client that used frames for liveness could not tell "the connection is healthy
 * and nothing has changed" from "the connection is a half-open corpse". That distinction decides
 * whether the fallback poll runs, and getting it wrong would poll a perfectly healthy idle page
 * forever. So the heartbeat is a real, named event (`heartbeat`) with a timestamp payload, and the
 * client treats receiving it as proof of life.
 */

/** The reconnect hint we advertise. The client also backs off on its own; this is the floor. */
export const SSE_RETRY_MS = 5_000;

/**
 * Response headers for the stream.
 *
 * `no-transform` stops an intermediary from gzipping or buffering the body — a buffered stream is
 * indistinguishable from a dead one to the browser. `X-Accel-Buffering: no` is the nginx-specific
 * half of the same requirement, since nginx does not honour `no-transform` for buffering.
 */
export const SSE_HEADERS: Record<string, string> = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store, no-transform, must-revalidate",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
};

/** Strip anything that would end an SSE field, then serialize. */
function toField(value: unknown): string {
    return JSON.stringify(value).replace(/[\r\n\u2028\u2029]/g, "");
}

/** One invalidation frame. `event: change` lets the client filter at the protocol level. */
export function encodeSseChange(envelope: RealtimeEnvelope): string {
    return `event: ${SSE_CHANGE_EVENT}\ndata: ${toField(envelope)}\n\n`;
}

/**
 * A heartbeat frame.
 *
 * Carries a timestamp and nothing else. It is a named event so `EventSource` actually delivers it —
 * see the module header for why a comment would not do.
 */
export function encodeSseHeartbeat(at: Date = new Date()): string {
    return `event: ${SSE_HEARTBEAT_EVENT}\ndata: ${toField({ at: at.toISOString() })}\n\n`;
}

/**
 * The opening frame: the reconnect hint and NOTHING else.
 *
 * Deliberately not a `change` frame — a freshly opened stream must not invalidate anything by
 * itself. The client already has whatever the server rendered for the request it just made.
 */
export function encodeSseOpen(): string {
    return `retry: ${SSE_RETRY_MS}\n\n`;
}

/** The heartbeat cadence, re-exported so the route and the client share one number. */
export const SSE_HEARTBEAT_MS = REALTIME_HEARTBEAT_MS;

/** The furthest the client should wait before retrying, mirrored for documentation purposes. */
export const SSE_MAX_RETRY_MS = REALTIME_RECONNECT_MAX_MS;
