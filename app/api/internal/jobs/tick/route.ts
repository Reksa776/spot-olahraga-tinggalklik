import { timingSafeEqual } from "crypto";

import { runJobsTick } from "@/lib/jobs/tick";

/**
 * ==========================================
 * POST /api/internal/jobs/tick — the scheduler trigger (Phase 15)
 * ==========================================
 *
 * MACHINE-AUTHENTICATED, NOT SESSION-AUTHENTICATED.
 *
 * The caller is the deployment's cron (see the Phase 15 report), which holds no session and
 * cannot obtain one. Its entire authority is the shared secret in
 * `Authorization: Bearer $JOBS_TICK_SECRET`, compared in **constant time** so the comparison
 * cannot be turned into a byte-by-byte oracle.
 *
 * WHY THIS IS CLASSIFIED "PUBLIC" IN `proxy.ts` AND STILL SAFE
 * -----------------------------------------------------------
 * `proxy.ts` runs on the Edge runtime and answers only "is there a session?". This route
 * must be reachable without one, so it is listed there as a pass-through — and the real
 * control lives HERE, in the handler, which refuses everything without the secret. The route
 * is deliberately NOT added to any session-protected matcher, because a session gate would
 * make the route unusable by the scheduler while providing nothing: the scheduler has no
 * session to present, and the secret is strictly stronger than one.
 *
 * WHAT IT EXPOSES
 * ---------------
 * Job counts and timing only. No secret, no configuration, no tenant data, no buyer data.
 * A refusal is a bare `401` — it does not say whether the header was absent, malformed or
 * merely wrong, and it does not log the presented value.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * No business rule is implemented here. The route validates its own authentication, calls
 * `runJobsTick`, and serialises the result: every state predicate, conditional update,
 * transaction and audit row belongs to the service the tick calls (P14-D10 — business logic
 * never lives in cron).
 */

export const dynamic = "force-dynamic";

/** The header value the caller must present: `Bearer $JOBS_TICK_SECRET`. */
const BEARER_PREFIX = "Bearer ";

/** Length-independent constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");

    // `timingSafeEqual` throws on length mismatch, which would itself leak the length. Hash
    // the lengths into the decision instead by comparing padded buffers.
    if (left.length !== right.length) {
        // Still perform a comparison of equal-length buffers so the timing is not a clean
        // "wrong length" signal.
        const filler = Buffer.alloc(left.length, 0);
        timingSafeEqual(left, filler);
        return false;
    }

    return timingSafeEqual(left, right);
}

function isAuthorized(request: Request): boolean {
    const expected = process.env.JOBS_TICK_SECRET;

    // Fail closed when the secret is not configured: an unconfigured deployment must not
    // expose an unauthenticated "run every job" endpoint.
    if (!expected || expected.length === 0) {
        return false;
    }

    const header = request.headers.get("authorization") ?? "";

    if (!header.startsWith(BEARER_PREFIX)) {
        return false;
    }

    const presented = header.slice(BEARER_PREFIX.length).trim();

    return safeEqual(presented, expected);
}

function unauthorized(): Response {
    return Response.json(
        { success: false, code: "UNAUTHORIZED", message: "Akses ditolak." },
        { status: 401 }
    );
}

export async function POST(request: Request): Promise<Response> {
    if (!isAuthorized(request)) {
        return unauthorized();
    }

    const result = await runJobsTick();

    // The tick reports per-job success. The HTTP status stays 200 because the REQUEST
    // succeeded; a job that failed is reported in the body (and on its lease row) rather
    // than by failing the whole tick, which would hide the job that did work.
    return Response.json({ success: true, ...result }, { status: 200 });
}
