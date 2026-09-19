/**
 * ==========================================
 * POST-AUTHENTICATION DESTINATION
 * ==========================================
 *
 * The back office is ONE dashboard at `/dashboard`, so that is where a successful login
 * lands unless the user was interrupted on their way somewhere else.
 *
 * ── WHY THIS IS ITS OWN MODULE, AND WHY IT IS PURE ───────────────────────────────
 * `callbackUrl` travels through the URL, which means it is attacker-controlled. Redirecting
 * to it blindly is the classic open-redirect: a link to
 * `https://app/login?callbackUrl=https://evil.example` would make the application look like
 * it is handing the user to an attacker's site, and the user's trust in our domain is what
 * carries them there.
 *
 * The decision is therefore a pure function with no I/O, so it can be exhaustively tested
 * (see `__tests__/auth/redirect.test.ts`) rather than being a guard buried in a component.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────
 * A callback is accepted only if it is a **path on this origin**:
 *
 *   "/dashboard/events"        accepted
 *   "/dashboard?tab=orders"    accepted (path + query)
 *   "https://evil.example"     rejected — absolute URL
 *   "//evil.example"           rejected — protocol-relative, resolves to another origin
 *   "javascript:alert(1)"      rejected — not a path
 *   "/\\evil.example"          rejected — backslash is normalised to "/" by some browsers
 *   "/login"                   rejected — would loop the user back to the login page
 *
 * The check is done by PARSING, not by string prefix matching: the value is resolved
 * against a sentinel origin and its origin must still be that sentinel. That is what makes
 * the protocol-relative and backslash cases fall out for free instead of needing a rule
 * each.
 */

/** Where a successful login goes when no usable callback was supplied. */
export const DEFAULT_POST_LOGIN_PATH = "/dashboard";

/**
 * Sentinel origin used only to resolve a relative path. It is `.invalid`, which RFC 2606
 * reserves precisely so it can never resolve to a real host.
 */
const SENTINEL_ORIGIN = "https://internal.invalid";

/** Paths that must never be a post-login destination: redirecting to them loops. */
const LOOP_PATHS = new Set(["/login", "/register"]);

/**
 * Validate a `callbackUrl` and return a safe same-origin path, or `null`.
 *
 * Returning `null` (rather than a fallback) lets the caller decide the default, which keeps
 * this function honest about what it knows.
 */
export function resolveSafeCallbackUrl(
    raw: string | null | undefined
): string | null {
    if (typeof raw !== "string") {
        return null;
    }

    const value = raw.trim();

    if (value.length === 0) {
        return null;
    }

    // Control characters are never part of a path and are a known smuggling vector
    // (`\n`/`\r` in a header, `\0` truncation).
    if (/[\u0000-\u001F\u007F]/.test(value)) {
        return null;
    }

    // Reject anything that does not start with a single "/" before parsing. A bare
    // "dashboard" is a relative path whose base is unknown, and "//host" is an authority.
    if (!value.startsWith("/") || value.startsWith("//")) {
        return null;
    }

    let parsed: URL;

    try {
        parsed = new URL(value, SENTINEL_ORIGIN);
    } catch {
        return null;
    }

    // Parsing is the authority: after resolving, the origin must still be the sentinel.
    // This is what rejects "//evil.example" and any embedded scheme.
    if (parsed.origin !== SENTINEL_ORIGIN) {
        return null;
    }

    if (LOOP_PATHS.has(parsed.pathname)) {
        return null;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * The destination a successful login should navigate to.
 *
 * A valid callback wins (the user asked for a page and was bounced to login); otherwise the
 * dashboard is the default. An INVALID callback is treated as absent — it never reaches the
 * navigation.
 */
export function postLoginDestination(
    raw: string | null | undefined
): string {
    return resolveSafeCallbackUrl(raw) ?? DEFAULT_POST_LOGIN_PATH;
}
