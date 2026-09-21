/**
 * ==========================================
 * RATE LIMITER (In-Memory)
 * ==========================================
 *
 * Simple sliding-window rate limiter using
 * in-memory Map.
 *
 * PRODUCTION NOTE:
 * For multi-instance deployments (Kubernetes,
 * serverless, clustered), this in-memory
 * implementation is per-instance. Each instance
 * maintains its own counters.
 *
 * To use distributed rate limiting, set
 * REDIS_URL environment variable and install
 * @upstash/ratelimit or ioredis.
 *
 * When REDIS_URL is set, this module logs a
 * warning to remind about single-instance
 * limitation.
 */

const isProduction = process.env.NODE_ENV === "production";
const hasRedisUrl = Boolean(process.env.REDIS_URL);

if (isProduction && hasRedisUrl) {
    console.warn(
        "[RATE_LIMIT] REDIS_URL is set but Redis rate limiting " +
        "is not configured. Using in-memory rate limiter which " +
        "is per-instance. Install @upstash/ratelimit for " +
        "distributed rate limiting."
    );
}

type RateLimitEntry = {
    count: number;
    resetAt: number;
};

const store = new Map<string, RateLimitEntry>();

// Cleanup expired entries every 5 minutes
if (typeof setInterval !== "undefined") {
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of store) {
            if (now > entry.resetAt) {
                store.delete(key);
            }
        }
    }, 5 * 60 * 1000);
}

export type RateLimitResult = {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
};

/**
 * Read the window currently open for `key`, without changing it.
 *
 * An expired window is deleted here, so `null` means "no window is open" — which is
 * exactly the state a fresh window is created from. Returns `null` rather than a
 * zeroed entry so a caller cannot accidentally count into a dead window.
 */
function openWindow(key: string): RateLimitEntry | null {
    const entry = store.get(key);

    if (!entry) {
        return null;
    }

    if (Date.now() > entry.resetAt) {
        store.delete(key);
        return null;
    }

    return entry;
}

/**
 * Check rate limit for a given key, CONSUMING one allowance.
 *
 * This is the right primitive for an endpoint that should allow N requests per
 * window — an upload, a payment attempt. It is the wrong one for a limiter whose
 * allowance must be spent by a specific OUTCOME rather than by a request at all; see
 * `rateLimiters.login`, which pairs `peekRateLimit` with `recordRateLimitFailure`.
 *
 * @param key - Unique identifier (e.g., "login:192.168.1.1")
 * @param maxRequests - Maximum requests allowed in window
 * @param windowMs - Time window in milliseconds
 * @returns Rate limit result
 */
export function checkRateLimit(
    key: string,
    maxRequests: number = 10,
    windowMs: number = 60 * 1000
): RateLimitResult {
    const now = Date.now();
    const entry = openWindow(key);

    if (!entry) {
        // New window
        store.set(key, {
            count: 1,
            resetAt: now + windowMs,
        });
        return {
            allowed: true,
            remaining: maxRequests - 1,
            retryAfterMs: 0,
        };
    }

    if (entry.count >= maxRequests) {
        return {
            allowed: false,
            remaining: 0,
            retryAfterMs: entry.resetAt - now,
        };
    }

    entry.count++;
    return {
        allowed: true,
        remaining: maxRequests - entry.count,
        retryAfterMs: 0,
    };
}

/**
 * Read the allowance remaining for `key` WITHOUT consuming any.
 *
 * ── WHY A READ-ONLY PROBE HAS TO EXIST (Phase 27A, F3) ──────────────────────────
 * The login limiter is checked BEFORE the password is verified — that ordering is
 * the point, because it is what stops a brute-force loop from ever reaching bcrypt —
 * but the allowance must be spent by the FAILED VERIFICATION, not by the request.
 * A single "check and count" call cannot express that: it would charge a successful
 * sign-in the same as a wrong password, which is how five of the operator's own
 * logins could lock the bucket.
 *
 * An empty window reports the full allowance (`remaining: maxRequests`), not
 * `maxRequests - 1`: nothing has been spent yet.
 *
 * `_windowMs` is accepted only so the signature stays symmetrical with
 * `checkRateLimit`: a peek never OPENS a window, so the length is genuinely unread here
 * — the recorder is what creates the window the caller's `maxRequests` applies to.
 */
export function peekRateLimit(
    key: string,
    maxRequests: number = 10,
    _windowMs: number = 60 * 1000
): RateLimitResult {
    const entry = openWindow(key);

    if (!entry) {
        return {
            allowed: true,
            remaining: maxRequests,
            retryAfterMs: 0,
        };
    }

    if (entry.count >= maxRequests) {
        return {
            allowed: false,
            remaining: 0,
            retryAfterMs: entry.resetAt - Date.now(),
        };
    }

    return {
        allowed: true,
        remaining: maxRequests - entry.count,
        retryAfterMs: 0,
    };
}

/**
 * Record ONE failure against `key` and return the window's new failure count.
 *
 * The window semantics are identical to `checkRateLimit`'s: the first failure opens
 * a window that lives `windowMs`, later failures count into it, and an expired window
 * starts again at 1. This counter is never consulted to decide whether a request may
 * proceed — that is `peekRateLimit`'s job — so incrementing it can never lock a
 * caller out mid-request.
 */
export function recordRateLimitFailure(
    key: string,
    windowMs: number
): number {
    const now = Date.now();
    const entry = openWindow(key);

    const count = (entry?.count ?? 0) + 1;

    store.set(key, {
        count,
        resetAt: entry?.resetAt ?? now + windowMs,
    });

    return count;
}

/**
 * Get client IP from request headers.
 *
 * Security (M2 fix):
 * x-forwarded-for and x-real-ip are client-controllable
 * headers. They MUST NOT be trusted unless the application
 * is behind a known trusted reverse proxy.
 *
 * When TRUSTED_PROXY env var is NOT set (default):
 *   Forwarding headers are ignored.
 *   Returns "untrusted" — all clients share this bucket.
 *   This is safe: rate limiting still works, it just groups
 *   all untrusted clients together.
 *
 * When TRUSTED_PROXY env var IS set:
 *   Forwarding headers from the trusted proxy are used.
 *   The first IP in x-forwarded-for is treated as client IP.
 *
 * This prevents an attacker from spoofing x-forwarded-for
 * to obtain a unique rate-limit bucket per request.
 */
export function getClientIp(request: Request): string {
    const trustedProxy = process.env.TRUSTED_PROXY;

    if (trustedProxy) {
        // Only trust forwarding headers when behind a known proxy
        const forwarded = request.headers.get("x-forwarded-for");
        if (forwarded) {
            return forwarded.split(",")[0].trim();
        }

        const realIp = request.headers.get("x-real-ip");
        if (realIp) {
            return realIp;
        }
    }

    // No trusted proxy — forwarding headers are NOT trustworthy
    return "untrusted";
}

/** The production sentinel: every client that cannot be distinguished shares it. */
const UNTRUSTED_CLIENT_KEY = "untrusted";

/**
 * The bucket a DEVELOPMENT server uses when it has no trustworthy peer address.
 *
 * Distinct from the production sentinel on purpose, and reachable in no other
 * environment. See `clientRateLimitKey`.
 */
const DEVELOPMENT_CLIENT_KEY = "dev-local";

/**
 * The bucket key for an unauthenticated, per-client limiter (login, registration).
 *
 * ── WHY THIS IS NOT JUST `getClientIp` ─────────────────────────────────────────
 * `getClientIp` answers one question — "is there a forwarding header I am allowed to
 * believe?" — and answers "untrusted" when there is not. That is the correct
 * fail-closed answer for PRODUCTION, and it is what the M2 fix established: an
 * attacker who can send `x-forwarded-for` must not be handed a fresh bucket per
 * request. But the same sentinel is also what a DEVELOPMENT server produces, because
 * `next dev` run without a reverse proxy forwards nothing — so every local client,
 * including every browser the operator is testing in, collapses into ONE shared
 * `login:untrusted` bucket and five attempts anywhere lock all of them.
 *
 * ── EVIDENCE THAT NO TRUSTWORTHY PEER ADDRESS EXISTS ON THIS PATH ──────────────
 * "Use the connection address when the framework exposes one" was checked against
 * the installed framework rather than assumed:
 *
 *   1. Next fills the header only when the CLIENT DID NOT SEND ONE —
 *      `next/dist/server/base-server.js:612`:
 *
 *          req.headers['x-forwarded-for'] ??= originalRequest?.socket?.remoteAddress;
 *
 *      So a request that sends its own `x-forwarded-for` keeps that value while a
 *      direct request gets its socket address, and by the time a route handler reads
 *      `request.headers` the two are indistinguishable. Reading the header here
 *      would therefore re-introduce exactly the spoofing M2 removed.
 *   2. `NextRequest` exposes no `ip` property in Next 16 —
 *      `next/dist/server/web/spec-extension/request.d.ts` declares none — and a
 *      `Request` has no socket at all.
 *
 * There is consequently no address on this path that can be believed, and this
 * function does not pretend otherwise. What it does instead is keep the two
 * environments from sharing one meaning:
 *
 *   • PRODUCTION — unchanged, to the byte. `getClientIp`'s answer is returned as-is,
 *     so a trusted reverse proxy still yields the real client IP and a missing
 *     TRUSTED_PROXY still fails closed into the shared sentinel bucket.
 *   • DEVELOPMENT — its own labelled bucket (`dev-local`), so the limiter's behaviour
 *     in dev is explicit rather than an accident of production security semantics.
 *     This is bounded to development by the `NODE_ENV` read below; a production
 *     build cannot reach it even if `NODE_ENV` is misspelled as `dev`, because the
 *     test is for `"production"` exactly.
 */
export function clientRateLimitKey(request: Request): string {
    const ip = getClientIp(request);

    if (ip !== UNTRUSTED_CLIENT_KEY) {
        return ip;
    }

    if (process.env.NODE_ENV === "production") {
        return UNTRUSTED_CLIENT_KEY;
    }

    return DEVELOPMENT_CLIENT_KEY;
}

/**
 * Pre-configured rate limiters for sensitive endpoints.
 */
/**
 * Named buckets, so a caller cannot invent a key or a window.
 *
 * NINE BUCKETS WERE DELETED WITH THE RETAIL APPLICATION: `voucherValidation`,
 * `orderCreation`, `broadcastSend`, `broadcastCreate`, `spin`, `affiliatePayout`,
 * `refundRequest`, `repayment` and `shippingCost`. Each one existed for exactly one
 * retail endpoint, and every one of those endpoints is gone — a repository-wide search
 * for each name returned zero references after the deletion. Leaving them would have
 * kept a paid-provider limiter (RajaOngkir) and a spin/affiliate limiter alive as
 * documentation of features that no longer exist.
 *
 * `checkRateLimit` itself stays exported: it is the primitive, it is covered by
 * `__tests__/security/m2-ip-spoofing.test.ts`, and a new route should still use a named
 * bucket rather than hand-rolling a key.
 */
/**
 * D-53's login allowance. The values are UNCHANGED — five failures per fifteen
 * minutes. Phase 27A changed what is counted, not how much.
 */
const LOGIN_BUCKET = "login";
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export const rateLimiters = {
    /**
     * Credential failures per client bucket.
     *
     * ── THIS BUCKET IS SPENT BY AN OUTCOME, NOT BY A REQUEST (Phase 27A, F3) ────
     * `check` is a read-only probe and `recordFailure` is the only way to spend the
     * allowance, so the caller controls which events count. `auth.ts` spends it on
     * a failed verification — unknown identifier, passwordless account, wrong
     * password — and NOT on a malformed request or on a successful sign-in.
     *
     * `clientKey` rather than `ip` because the caller passes what
     * `clientRateLimitKey` returned, which is not an IP in development.
     */
    login: {
        check: (clientKey: string) =>
            peekRateLimit(
                `${LOGIN_BUCKET}:${clientKey}`,
                LOGIN_MAX_FAILURES,
                LOGIN_WINDOW_MS
            ),
        recordFailure: (clientKey: string) =>
            recordRateLimitFailure(
                `${LOGIN_BUCKET}:${clientKey}`,
                LOGIN_WINDOW_MS
            ),
        maxFailures: LOGIN_MAX_FAILURES,
        windowMs: LOGIN_WINDOW_MS,
    },

    register: (clientKey: string) =>
        checkRateLimit(`register:${clientKey}`, 3, 60 * 60 * 1000), // 3 per hour

    // Payment creation — prevent rapid-fire payment attempts. Used by the ticketing
    // payment-create route, which is the only payment surface left.
    paymentCreation: (userId: string) =>
        checkRateLimit(`payment:${userId}`, 5, 5 * 60 * 1000), // 5 per 5 min

    // File upload — prevent upload flooding
    upload: (userId: string) =>
        checkRateLimit(`upload:${userId}`, 20, 60 * 1000), // 20 per minute
};
