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
 * Check rate limit for a given key.
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
    const entry = store.get(key);

    if (!entry || now > entry.resetAt) {
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
export const rateLimiters = {
    login: (ip: string) =>
        checkRateLimit(`login:${ip}`, 5, 15 * 60 * 1000), // 5 attempts per 15 min

    register: (ip: string) =>
        checkRateLimit(`register:${ip}`, 3, 60 * 60 * 1000), // 3 per hour

    // Payment creation — prevent rapid-fire payment attempts. Used by the ticketing
    // payment-create route, which is the only payment surface left.
    paymentCreation: (userId: string) =>
        checkRateLimit(`payment:${userId}`, 5, 5 * 60 * 1000), // 5 per 5 min

    // File upload — prevent upload flooding
    upload: (userId: string) =>
        checkRateLimit(`upload:${userId}`, 20, 60 * 1000), // 20 per minute
};
