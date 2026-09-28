import type { NextRequest } from "next/server";

import { resolveRealtimeAudience } from "@/lib/realtime/audience";
import { subscribeRealtimeBus } from "@/lib/realtime/bus";
import {
    SSE_HEADERS,
    SSE_HEARTBEAT_MS,
    encodeSseChange,
    encodeSseHeartbeat,
    encodeSseOpen,
} from "@/lib/realtime/sse";
import { audiencesIntersect } from "@/lib/realtime/taxonomy";

/**
 * ==========================================
 * GET /api/realtime/stream — THE ONE REALTIME TRANSPORT
 * ==========================================
 *
 * A Server-Sent Events stream. One per browser (the client manager elects a leader tab), same
 * origin, no new dependency, no new port, no websocket upgrade, and no change to how the
 * application is deployed — which is the whole reason SSE was chosen over Socket.IO: there is no
 * custom server here, PM2 runs `next start`, and the audit found no realtime library installed.
 *
 * ── WHAT IT SENDS ────────────────────────────────────────────────────────────────
 * Notifications, not data. Frames carry the envelope from `lib/realtime/taxonomy.ts`: an event
 * type, the affected domains, an opaque entity id and a timestamp. No money, no customer identity,
 * no order number, no status a client could render, no token, no credential. A client that wants
 * to know what actually happened re-reads the server, which keeps the database — and only the
 * database — the authority for every figure on screen.
 *
 * ── SCOPE IS DECIDED HERE, FROM THE SESSION ──────────────────────────────────────
 * `resolveRealtimeAudience()` derives the caller's audience set from the server-side session and
 * the database, and the delivery filter is a set intersection. There is no query parameter on this
 * endpoint at all, so there is nothing for a client to forge: a request cannot ask to hear about
 * another tenant, another buyer, or another PIC, and an anonymous caller (empty audience set)
 * matches nothing.
 *
 * ── WHY THE ROUTE ALSO REFUSES 401 ITSELF ────────────────────────────────────────
 * The Edge proxy already answers an unauthenticated request with 401 JSON, and that is defence in
 * depth rather than duplication: the proxy trusts a cookie, while this handler resolves the real
 * scope. A request that reached here without a resolvable identity must never be handed a
 * long-lived stream, even an empty one.
 *
 * ── CLEANUP IS MANDATORY, NOT POLITE ─────────────────────────────────────────────
 * The bus retains listeners in a `Set`. A stream that closed without unsubscribing would keep its
 * listener, its controller and its closure alive for the process's lifetime — a leak that grows
 * with every tab a user opens and closes. Both exits are covered: the consumer cancelling
 * (`cancel()`), and the request aborting (`request.signal`), plus the write path itself
 * detaching the moment a frame cannot be delivered.
 */

export const runtime = "nodejs";
/** Never cached, never prerendered: it is a live connection. */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    const audiences = await resolveRealtimeAudience();

    if (audiences.length === 0) {
        return new Response(
            JSON.stringify({
                success: false,
                code: "UNAUTHORIZED",
                message: "Silakan login terlebih dahulu.",
            }),
            { status: 401, headers: { "Content-Type": "application/json" } }
        );
    }

    const encoder = new TextEncoder();

    /** Assigned inside `start`; the Streams API calls `cancel()` on the same object. */
    let teardown: () => void = () => {};

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            let closed = false;

            // Declared BEFORE anything can call `teardown`, so an immediate failure on the very
            // first write cannot reach an uninitialized binding.
            let unsubscribe: () => void = () => {};
            let heartbeat: ReturnType<typeof setInterval> | null = null;

            const detach = () => {
                if (closed) {
                    return;
                }

                closed = true;
                unsubscribe();

                if (heartbeat !== null) {
                    clearInterval(heartbeat);
                    heartbeat = null;
                }

                try {
                    controller.close();
                } catch {
                    // Already closed or errored — nothing to do.
                }
            };

            teardown = detach;

            const send = (frame: string): boolean => {
                if (closed) {
                    return false;
                }

                try {
                    controller.enqueue(encoder.encode(frame));
                    return true;
                } catch {
                    // The consumer is gone (tab closed between checks, proxy dropped the
                    // connection). Nothing to report: the abort path does the cleanup.
                    detach();
                    return false;
                }
            };

            // The reconnect hint, and nothing else: opening a stream must not invalidate anything.
            send(encodeSseOpen());

            unsubscribe = subscribeRealtimeBus((change) => {
                if (!audiencesIntersect(audiences, change.audiences)) {
                    return;
                }

                if (!send(encodeSseChange(change.envelope))) {
                    detach();
                }
            });

            heartbeat = setInterval(() => {
                if (!send(encodeSseHeartbeat())) {
                    detach();
                }
            }, SSE_HEARTBEAT_MS);

            /*
             * A heartbeat timer must not be a reason for the process to stay alive. `unref` is
             * present on Node timers and absent on some runtimes, hence the optional call.
             */
            (heartbeat as unknown as { unref?: () => void }).unref?.();

            request.signal.addEventListener("abort", detach, { once: true });
        },

        cancel() {
            teardown();
        },
    });

    return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
