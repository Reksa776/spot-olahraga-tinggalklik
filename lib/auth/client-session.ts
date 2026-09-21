import { loginUrlFor } from "./redirect";

/**
 * ==========================================
 * CLIENT-SIDE SESSION EXPIRY (HTTP 401)
 * ==========================================
 *
 * The buyer's order page is a set of client buttons that POST to ownership-scoped API routes
 * (`/pay`, `/cancel`, `/issue`, `/api/ticketing/refunds`). A session can end while that page is
 * open — `session.maxAge` elapses on a tab left overnight, the cookie is cleared in another
 * tab, or the account is signed out somewhere else — and the proxy answers the next POST with
 * `401`.
 *
 * ── WHAT USED TO HAPPEN ─────────────────────────────────────────────────────────
 * Each button had one failure branch, so a 401 rendered the server's JSON `message` beside the
 * button as an inline error: "Silakan login terlebih dahulu." The buyer was left on a page that
 * could not work, looking at a red box next to "Bayar sekarang", with no way forward but to
 * guess that they should open /login. Worse, the phrasing sits where a payment error sits, so a
 * buyer could read it as the payment having been attempted and refused.
 *
 * ── WHAT HAPPENS NOW ────────────────────────────────────────────────────────────
 * A 401 is treated as neither a business failure nor a payment failure — it is a SESSION state.
 * The visitor is sent to `/login` with this page as the return path, so one sign-in puts them
 * back exactly where they were, on the same order. Nothing is claimed about the action, and no
 * local state is mutated as if it had permanently failed.
 *
 * ── WHY THE RETURN PATH CANNOT BE HOSTILE ───────────────────────────────────────
 * `loginUrlFor` is the SAME validator the server pages use (`resolveSafeCallbackUrl`): it
 * accepts only a same-origin PATH, rejects absolute and protocol-relative URLs, and rejects
 * `/login`/`/register` so the redirect cannot loop. The value handed to it is built from
 * `window.location.pathname` + `search` — never `window.location.href`, which is the
 * attacker-influenced form this deliberately avoids, and never a query parameter a caller could
 * choose. So the only thing this can ever produce is `/login?callbackUrl=<a path on this site>`.
 *
 * ── WHY A FULL NAVIGATION, NOT `router.replace` ─────────────────────────────────
 * The session cookie has changed on the server (it is gone or expired). A soft client
 * navigation would re-use the router cache and the in-memory React tree for a page whose server
 * render was produced for the previous session. A document load is what guarantees the login
 * page is server-gated correctly and that the post-login destination has a fresh session to
 * read. It also stops any queued client work on a page that can no longer act.
 */

/** The status the proxy and the guards use for "no valid session". */
export const SESSION_EXPIRED_STATUS = 401;

/** The API code that means the same thing, for clients that branch on `code`. */
export const UNAUTHORIZED_CODE = "UNAUTHORIZED";

/** The shape of the fields this module reads out of an API error envelope. */
type ErrorEnvelope = { code?: unknown } | null | undefined;

/**
 * Does this response mean the session ended, rather than "your action was refused"?
 *
 * `code` is checked first because the API contract says clients branch on it; the status is
 * the fallback, so a 401 that arrives without an envelope (the proxy writes one, but a future
 * rewrite might not) is still handled as an expiry rather than rendered as a business error.
 *
 * Deliberately strict: only 401 (or the explicit `UNAUTHORIZED` code) qualifies. A 403 is an
 * authorization decision, a 409 is a business state, a 5xx is a system fault — none of them is
 * "you need to sign in", and treating any of them as one would hide a real refusal behind a
 * login screen.
 */
export function isSessionExpired(status: number, payload?: ErrorEnvelope): boolean {
    if (payload && payload.code === UNAUTHORIZED_CODE) {
        return true;
    }

    return status === SESSION_EXPIRED_STATUS;
}

/** The bits of `window.location` this module needs. Narrow on purpose, so it is testable. */
export type LocationLike = { pathname: string; search?: string };

/**
 * The login URL that returns the visitor to the current page.
 *
 * Takes an explicit location so the decision is a pure function under test; in the browser the
 * caller omits it and `window.location` is used. With no location at all (a server render, or a
 * test that passes nothing) it degrades to a bare `/login`, which the login page's own default
 * destination handles.
 */
export function loginUrlForCurrentPage(
    location?: LocationLike | null
): string {
    const target = location ?? browserLocation();

    if (!target) {
        return "/login";
    }

    return loginUrlFor(`${target.pathname}${target.search ?? ""}`);
}

function browserLocation(): LocationLike | null {
    if (typeof window === "undefined") {
        return null;
    }

    return { pathname: window.location.pathname, search: window.location.search };
}

/**
 * Navigate to login, preserving the page the visitor was on.
 *
 * Safe to call from any client component; a no-op outside the browser (a server render never
 * reaches it, but the guard costs one comparison and removes a class of "cannot happen" bugs).
 */
export function redirectToLoginForExpiredSession(): void {
    if (typeof window === "undefined") {
        return;
    }

    window.location.assign(loginUrlForCurrentPage());
}
