import { createHmac, randomBytes } from "crypto";

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

/**
 * Upper bound on the number of live windows.
 *
 * The cleanup below runs every five minutes, which is long enough for a client that
 * controls its own bucket key to insert a very large number of windows in between two
 * sweeps. That key is attacker-controlled on exactly one path — the F-03 login account
 * bucket, keyed by an HMAC of the submitted identifier, where every invented identifier
 * is a new key. A `Map` of a few hundred thousand entries is tens of megabytes of
 * process-lifetime memory for no benefit, so the store is capped.
 *
 * THE EVICTION IS SAFE IN THE DIRECTION THAT MATTERS: evicting the OLDEST window can
 * only ever FORGET failures, which loosens a limit. It can never invent one. Under a
 * flood of distinct keys the oldest windows are the ones closest to expiry anyway.
 */
const MAX_STORE_ENTRIES = 50_000;

/** Drop every expired window. Shared by the sweeper, the cap and the probes. */
function sweepExpired(now: number): void {
    for (const [key, entry] of store) {
        if (now > entry.resetAt) {
            store.delete(key);
        }
    }
}

/**
 * Insert one window, keeping the store bounded.
 *
 * At the cap the OLDEST insertion is evicted. `Map` iterates in insertion order, so
 * `keys().next()` is the oldest key and the whole operation is O(1).
 *
 * ── WHY THE EVICTION DOES NOT SWEEP FIRST ─────────────────────────────────────
 * Sweeping expired windows here would be the obvious first move, and it is the wrong one:
 * `sweepExpired` is O(n), and the cap exists precisely for the case where an attacker is
 * inserting faster than windows expire — so a sweep per insert would turn the defence into
 * 50,000 iterations of CPU per attacker request, which is a worse denial of service than
 * the memory it prevents. Expiry is already handled by the interval sweeper below; the
 * hottest path stays O(1).
 */
function setEntry(key: string, entry: RateLimitEntry): void {
    // `store.has` first: an UPDATE to a key that is already stored costs no memory, so at
    // the cap it must not pay with somebody else's window.
    if (store.size >= MAX_STORE_ENTRIES && !store.has(key)) {
        const oldest = store.keys().next();

        if (!oldest.done) {
            store.delete(oldest.value);
        }
    }

    store.set(key, entry);
}

// Cleanup expired entries every 5 minutes
if (typeof setInterval !== "undefined") {
    setInterval(() => {
        sweepExpired(Date.now());
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
        setEntry(key, {
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
 * The number of live windows this process is holding.
 *
 * Observability for the one property of an in-memory limiter that cannot be seen from the
 * outside: its memory. `MAX_STORE_ENTRIES` bounds it, and this is how a test (or an
 * operator's debug endpoint, if one is ever added) can prove the bound holds under a flood
 * of distinct keys — which is exactly the shape of the F-03 account bucket, where the key
 * is derived from an attacker-supplied identifier.
 */
export function rateLimitStoreSize(): number {
    return store.size;
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

    setEntry(key, {
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
 * When TRUSTED_PROXY is NOT configured — which is now a question of whether it parses
 * (see `parseTrustedProxy`), not of whether it is a non-empty string (F-02):
 *   Forwarding headers are ignored.
 *   Returns "untrusted" — all clients share this bucket.
 *   This is safe: rate limiting still works, it just groups
 *   all untrusted clients together.
 *
 * When TRUSTED_PROXY IS configured with a real address or CIDR:
 *   Forwarding headers from the trusted proxy are used.
 *   The first IP in x-forwarded-for is treated as client IP, and a value that is not an
 *   IP at all is discarded rather than used as a bucket key.
 *
 * This prevents an attacker from spoofing x-forwarded-for
 * to obtain a unique rate-limit bucket per request.
 */
export function getClientIp(request: Request): string {
    const raw = process.env.TRUSTED_PROXY;
    const trustedProxy = parseTrustedProxy(raw);

    if (trustedProxy) {
        // Only trust forwarding headers when behind a known proxy
        const forwarded = firstClientAddress(
            request.headers.get("x-forwarded-for")
        );

        if (forwarded) {
            return forwarded;
        }

        const realIp = firstClientAddress(request.headers.get("x-real-ip"));

        if (realIp) {
            return realIp;
        }
    } else if (raw?.trim()) {
        /*
         * A value is present and did NOT parse. It is not silently ignored, because that
         * is how this trap was first set: an operator who writes TRUSTED_PROXY=false to
         * turn proxy trust OFF must be told that the variable is not a switch. The
         * warning is emitted once per distinct value so a request loop cannot flood the
         * log.
         */
        warnInvalidTrustedProxy(raw.trim());
    }

    // No trusted proxy — forwarding headers are NOT trustworthy
    return UNTRUSTED_CLIENT_KEY;
}

/* ============================================================================
 * TRUSTED_PROXY — AN EXPLICIT ADDRESS ALLOW-LIST, NEVER A TRUTHINESS TEST (F-02)
 * ============================================================================
 *
 * WHAT WAS WRONG
 * --------------
 * Proxy trust was decided by `if (process.env.TRUSTED_PROXY)`. Every string that is not
 * empty is truthy, so the values an operator is most likely to reach for when trying to
 * switch the feature off — `false`, `no`, `0`, `off` — turned it ON, as did junk like
 * `nginx` or `yes`. The result was the exact hole the M2 fix closed: the first
 * client-supplied `x-forwarded-for` value became the rate-limit bucket key, so an
 * attacker who rotated that header got a fresh login allowance per request.
 *
 * WHAT REPLACES IT
 * --------------
 * The variable must NAME the reverse proxy: one IPv4 address, one IPv6 address, or a
 * CIDR block, comma-separated for several. Anything else — including the truthy strings
 * above, a wildcard, and `0.0.0.0/0`/`::/0` (which would assert trust in every source
 * and therefore validate nothing) — fails to parse and leaves trust OFF.
 *
 * ── WHAT THIS CONFIGURATION DOES AND DOES NOT PROVE ─────────────────────────
 * It proves that trust was GRANTED DELIBERATELY and in a format that names a host: the
 * silent coercion is gone. It CANNOT prove that the request actually arrived from that
 * host, because there is no peer address on this code path to compare against — Next
 * fills `x-forwarded-for` from the socket ONLY when the client did not send one
 * (`next/dist/server/base-server.js:612`), so a socket value and a spoofed one are
 * indistinguishable by the time a handler reads the headers, and `NextRequest` declares
 * no `ip` in Next 16. That is why the header is read only after a valid configuration,
 * and why the interface contract (.env.example, DEPLOYMENT_RUNBOOK.md) states that the
 * process must be reachable only through the proxy: nginx binding the public port is
 * what makes the header trustworthy, and the configuration is the operator telling this
 * process that such a proxy exists.
 */

/** IPv4 with four numeric octets. Range-checked by `isIpv4`, not by the expression. */
const IPV4_ENTRY = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Hexadecimal groups and colons only — every character an IPv6 literal can contain. */
const IPV6_ENTRY = /^[0-9a-fA-F:]{2,45}$/;

function isIpv4(value: string): boolean {
    const match = IPV4_ENTRY.exec(value);

    if (!match) {
        return false;
    }

    return match.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * A deliberately conservative IPv6 check: the character set, a colon, at most one `::`,
 * groups of at most four hex digits, and a GROUP COUNT that a real address can have —
 * eight explicit groups, or seven or fewer alongside a `::` (which stands in for the
 * rest).
 *
 * It is not a full RFC 4291 parser and does not need to be: the value is never used to
 * ROUTE anything, it is only the operator's declaration that a proxy exists. What it must
 * not do is accept `false`, `nginx`, `*`, an empty string, or a nine-group address.
 */
function isIpv6(value: string): boolean {
    if (!IPV6_ENTRY.test(value) || !value.includes(":")) {
        return false;
    }

    if (value.includes(":::")) {
        return false;
    }

    const withElision = value.split("::");

    if (withElision.length > 2) {
        return false;
    }

    const explicitGroups = value.split(":").filter((group) => group.length > 0);

    if (!explicitGroups.every((group) => group.length <= 4)) {
        return false;
    }

    return withElision.length === 2
        ? explicitGroups.length <= 7
        : explicitGroups.length === 8;
}

/**
 * Normalise one configured entry, or `null` when it is not an address/CIDR.
 *
 * Accepted: `10.0.0.1`, `203.0.113.9`, `10.0.0.0/8`, `::1`, `[::1]`, `2001:db8::/32`.
 * Rejected: everything else, including `*`, `true`, `false`, `yes`, `no`, `off`,
 * `nginx`, `0.0.0.0/0`, `::/0`, a prefix outside the family's width, and a bare hostname.
 */
export function normaliseProxyEntry(entry: string): string | null {
    const parts = entry.split("/");

    if (parts.length > 2 || parts[0].length === 0) {
        return null;
    }

    const rawHost = parts[0];
    const host =
        rawHost.startsWith("[") && rawHost.endsWith("]")
            ? rawHost.slice(1, -1)
            : rawHost;

    const ipv4 = isIpv4(host);

    if (!ipv4 && !isIpv6(host)) {
        return null;
    }

    if (parts.length === 1) {
        return host;
    }

    const prefix = parts[1];

    if (!/^\d{1,3}$/.test(prefix)) {
        return null;
    }

    const bits = Number(prefix);
    const width = ipv4 ? 32 : 128;

    // `/0` names every possible source, so it is not a restriction at all.
    if (bits === 0 || bits > width) {
        return null;
    }

    return `${host}/${bits}`;
}

/**
 * Parse the whole variable: a comma-separated list of addresses/CIDRs.
 *
 * Returns `null` — "no usable configuration, do not trust headers" — for an unset,
 * empty, or ANY-invalid value. One malformed member invalidates the whole list rather
 * than being skipped: a typo must not quietly reduce the set the operator believes they
 * configured.
 */
export function parseTrustedProxy(
    raw: string | undefined | null
): readonly string[] | null {
    const value = raw?.trim();

    if (!value) {
        return null;
    }

    const entries = value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    if (entries.length === 0) {
        return null;
    }

    const normalised: string[] = [];

    for (const entry of entries) {
        const parsed = normaliseProxyEntry(entry);

        if (!parsed) {
            return null;
        }

        normalised.push(parsed);
    }

    return normalised;
}

/** The first forwarding value, but only when it actually is an IP address. */
function firstClientAddress(header: string | null): string | null {
    if (!header) {
        return null;
    }

    const first = header.split(",")[0]?.trim();

    if (!first) {
        return null;
    }

    const bare =
        first.startsWith("[") && first.endsWith("]")
            ? first.slice(1, -1)
            : first;

    return isIpv4(bare) || isIpv6(bare) ? bare : null;
}

/** Distinct invalid values already reported, so a request loop cannot flood the log. */
const warnedProxyValues = new Set<string>();

function warnInvalidTrustedProxy(raw: string): void {
    const shown = raw.length > 48 ? `${raw.slice(0, 48)}…` : raw;

    if (warnedProxyValues.has(shown)) {
        return;
    }

    warnedProxyValues.add(shown);

    console.warn(
        `[RATE_LIMIT] TRUSTED_PROXY is not a valid address/CIDR list (got "${shown}"). ` +
            "Proxy trust stays OFF and forwarded headers are ignored. TRUSTED_PROXY is " +
            "not a switch: name the reverse proxy's address, e.g. 10.0.0.1 or " +
            "172.16.0.0/12 (comma-separate several). Values such as true, false, yes, no " +
            "and nginx are invalid and never enable trust."
    );
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
 * Is the key `clientRateLimitKey` returned a PER-CLIENT identity, or the shared sentinel?
 *
 * ── WHY A CALLER MUST ASK THIS (F-03) ──────────────────────────────────────────
 * In production with no valid `TRUSTED_PROXY`, EVERY client shares one key. A bucket
 * built on that key is not a per-client limit at all — it is a platform-wide counter,
 * and a HARD refusal on it means five wrong passwords from one stranger stop every
 * other person from signing in. That was F-03.
 *
 * So the login limiter (and the register limiter, which had the same shape) now asks
 * this first: with a real identity the five-per-fifteen-minutes refusal applies exactly
 * as before, and without one the refusal is NOT applied, because the only thing it could
 * bound is the whole platform. What protects the endpoint when there is no identity is
 * the per-account and global throttles in `rateLimiters.login` / `rateLimiters.loginGlobal`,
 * neither of which can lock a person out.
 *
 * Development returns `true` (its bucket is the labelled `dev-local`), which preserves
 * the existing development behaviour to the byte.
 */
export function hasTrustworthyClientKey(request: Request): boolean {
    return clientRateLimitKey(request) !== UNTRUSTED_CLIENT_KEY;
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

/* ============================================================================
 * LOGIN ABUSE CONTROL WHEN NO CLIENT IDENTITY CAN BE BELIEVED (F-03)
 * ============================================================================
 *
 * F-03 was an availability defect with two halves that had to be fixed together:
 *
 *   1. no valid TRUSTED_PROXY (or a truthy-but-invalid one, F-02) meant every anonymous
 *      client shared `login:untrusted`, so five failures anywhere locked out everywhere;
 *   2. nothing bounded guessing against ONE account from many addresses, so "just raise
 *      the shared bucket" would have traded a lockout for a brute-force window.
 *
 * The two controls below are what replace it. NEITHER OF THEM REFUSES A REQUEST, and that
 * is the point: any hard threshold keyed on something an attacker can drive is a lockout
 * primitive (that is precisely what F-03 was, one identity wider), and the brief is
 * explicit that an attacker must not be able to lock an account. A bounded DELAY is the
 * one control that keeps working while nobody can be denied service with it — the
 * legitimate owner waits at most a second and then signs in normally.
 *
 * PER-ACCOUNT (the brute-force control)
 * -------------------------------------
 * Failures are counted per IDENTIFIER — price of a wrong password against one account —
 * under a key that is an HMAC-SHA256 of the normalised identifier:
 *
 *   • the identifier itself is never stored, so the bucket cannot be read as "who is
 *     being attacked" (the HMAC key is a per-process random value, so the digests are
 *     also not comparable across restarts or processes — an unsalted hash of an email
 *     would be reversible by anyone who could read the map);
 *   • unknown identifiers accumulate a bucket exactly like real ones, so no observation
 *     of this counter — timing included, since the delay is derived from it — can tell
 *     whether an account exists;
 *   • the first LOGIN_ACCOUNT_FREE_FAILURES attempts cost nothing, and each failure
 *     beyond that adds LOGIN_ACCOUNT_STEP_MS, capped at LOGIN_ACCOUNT_MAX_DELAY_MS.
 *     Bounded, monotone, and identical for a real and an invented account.
 *
 * GLOBAL (the availability safeguard)
 * -----------------------------------
 * A coarse platform-wide failure counter. Above LOGIN_GLOBAL_ALERT_FAILURES in a short
 * window every sign-in attempt — correct password included — is delayed by a bounded
 * amount and the operator is warned in the log. It cannot lock anyone out; it exists so
 * a distributed credential-stuffing flood buys a slower platform instead of unbounded
 * bcrypt work. A REFUSING global cap was considered and rejected: at any threshold it is
 * the same global lockout as F-03, merely more expensive to reach.
 */

/** Bucket namespace for the per-identifier login window. */
const LOGIN_ACCOUNT_LABEL = "login-account";

/** Same window as the per-client allowance, so one failure accounting story holds. */
const LOGIN_ACCOUNT_WINDOW_MS = LOGIN_WINDOW_MS;

/** Failures that cost nothing, matching the per-client allowance's shape. */
const LOGIN_ACCOUNT_FREE_FAILURES = 5;

/** Added per failure beyond the free allowance. 150 ms x 10 = the cap below. */
const LOGIN_ACCOUNT_STEP_MS = 150;

/** Ceiling on the per-identifier delay: slow enough to hurt guessing, short enough to live with. */
const LOGIN_ACCOUNT_MAX_DELAY_MS = 1500;

/** Bucket namespace for the platform-wide failure counter. */
const LOGIN_GLOBAL_LABEL = "login-global";

/** Short window: the safeguard must decay quickly once a flood stops. */
const LOGIN_GLOBAL_WINDOW_MS = 5 * 60 * 1000;

/** Failures in the window before the platform-wide delay starts. */
const LOGIN_GLOBAL_ALERT_FAILURES = 200;

/** Added per further LOGIN_GLOBAL_ALERT_FAILURES failures. */
const LOGIN_GLOBAL_STEP_MS = 250;

/** Ceiling on the platform-wide delay. */
const LOGIN_GLOBAL_MAX_DELAY_MS = 1000;

/**
 * The per-process HMAC key for account buckets.
 *
 * Generated at module load and never persisted: the digest is only ever compared with
 * itself inside this process's `Map`, so a stable key would add nothing — while a key
 * that leaves the process (an env var, a hardcoded constant) would turn the digests into
 * an offline-testable fingerprint of an identifier. Rotating on every start is the point.
 */
const LOGIN_ACCOUNT_KEY_SECRET = randomBytes(32);

/**
 * The bucket key for one identifier: HMAC-SHA256, truncated to 96 bits.
 *
 * Normalised (trimmed, lower-cased) so `User@Example.com` and `user@example.com` are the
 * same bucket — otherwise case alone would multiply an attacker's allowance. Truncation
 * is safe: this is a bucket label, not a MAC that anybody verifies.
 */
export function loginAccountKey(identifier: string): string {
    return createHmac("sha256", LOGIN_ACCOUNT_KEY_SECRET)
        .update(identifier.trim().toLowerCase())
        .digest("hex")
        .slice(0, 24);
}

/**
 * How long this attempt should wait before verification, based on the account's failures
 * in the current window. `0` for a fresh or successful account.
 */
export function loginAccountThrottleMs(accountKey: string): number {
    const entry = openWindow(`${LOGIN_ACCOUNT_LABEL}:${accountKey}`);
    const failures = entry?.count ?? 0;
    const beyond = Math.max(0, failures - LOGIN_ACCOUNT_FREE_FAILURES);

    return Math.min(beyond * LOGIN_ACCOUNT_STEP_MS, LOGIN_ACCOUNT_MAX_DELAY_MS);
}

/** Charge ONE failed verification to the identifier's window. Returns the new count. */
export function recordLoginAccountFailure(accountKey: string): number {
    return recordRateLimitFailure(
        `${LOGIN_ACCOUNT_LABEL}:${accountKey}`,
        LOGIN_ACCOUNT_WINDOW_MS
    );
}

/**
 * Forget an identifier's failures — called after a SUCCESSFUL verification.
 *
 * The person who knows the password is not the attacker, so the throttle they inherited
 * from the attacker's guesses ends here. This is also the second reason the account
 * control can never lock an account: the correct password always clears it.
 */
export function clearLoginAccountFailures(accountKey: string): void {
    store.delete(`${LOGIN_ACCOUNT_LABEL}:${accountKey}`);
}

/** Timestamp of the last platform-wide warning, so the log cannot be flooded. */
let lastGlobalLoginWarningAt = 0;

/**
 * How long EVERY sign-in should wait while the platform-wide failure counter is elevated.
 * Never refuses: it is a throughput cap, not a gate.
 */
export function loginGlobalThrottleMs(): number {
    const entry = openWindow(LOGIN_GLOBAL_LABEL);
    const failures = entry?.count ?? 0;

    if (failures < LOGIN_GLOBAL_ALERT_FAILURES) {
        return 0;
    }

    const now = Date.now();

    if (now - lastGlobalLoginWarningAt > 60_000) {
        lastGlobalLoginWarningAt = now;

        console.warn(
            `[RATE_LIMIT] login failures across the platform are elevated ` +
                `(${failures} in ${Math.round(LOGIN_GLOBAL_WINDOW_MS / 60_000)} min); ` +
                "sign-ins are being slowed. Check TRUSTED_PROXY and the auth logs."
        );
    }

    const steps = Math.floor(failures / LOGIN_GLOBAL_ALERT_FAILURES);

    return Math.min(steps * LOGIN_GLOBAL_STEP_MS, LOGIN_GLOBAL_MAX_DELAY_MS);
}

/** Charge ONE failed verification to the platform-wide window. Returns the new count. */
export function recordLoginGlobalFailure(): number {
    return recordRateLimitFailure(LOGIN_GLOBAL_LABEL, LOGIN_GLOBAL_WINDOW_MS);
}

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

        /*
         * F-03 — the per-identifier control. Deliberately NOT a `check`/`recordFailure`
         * pair like the bucket above: there is no refusal to make, so the API is a delay
         * to apply and a failure to charge. A caller cannot ask "is this account over the
         * limit?", because that question has no safe answer.
         */
        accountKey: (identifier: string) => loginAccountKey(identifier),
        accountThrottleMs: (accountKey: string) =>
            loginAccountThrottleMs(accountKey),
        recordAccountFailure: (accountKey: string) =>
            recordLoginAccountFailure(accountKey),
        clearAccountFailures: (accountKey: string) =>
            clearLoginAccountFailures(accountKey),
    },

    /**
     * F-03 — the platform-wide availability safeguard. Same shape as the account control
     * and for the same reason: it slows, it never refuses.
     */
    loginGlobal: {
        throttleMs: () => loginGlobalThrottleMs(),
        recordFailure: () => recordLoginGlobalFailure(),
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
