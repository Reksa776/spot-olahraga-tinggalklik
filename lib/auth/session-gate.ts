import type { PlatformRole } from "@prisma/client";

import { postLoginDestination } from "./redirect";
import { intentForPlatformRole } from "./roles";

/**
 * ==========================================
 * SESSION GATE — "YOU ARE ALREADY SIGNED IN"
 * ==========================================
 *
 * `/login` and `/register` are the only two pages in the application whose correct answer for
 * an authenticated visitor is a REDIRECT rather than a render. Showing them the sign-in form
 * would be a page that cannot do anything useful for them — they are already signed in — and
 * it used to be exactly that: both forms checked the session in a `useEffect`, so a signed-in
 * visitor saw a full form and a frame or two later was moved away.
 *
 * ── WHERE THE ROLE COMES FROM (AND WHERE IT MUST NOT COME FROM) ─────────────────
 * From `resolveAuthzScope(userId)`, i.e. from the `User` row. The caller resolves it; this
 * module only decides. Nothing here reads a query parameter, a cookie value, a form field or
 * the login screen's role selector, so the destination cannot be widened by a client. The role
 * selector remains a presentational intent (`lib/auth/roles.ts`) that names an entrance, and
 * the entrance a visitor clicked confers nothing — this function is not even given it.
 *
 * ── WHY `scope === null` RENDERS THE FORM INSTEAD OF REDIRECTING ────────────────
 * `null` covers two different situations, and both must fall through to the form:
 *
 *   1. **Anonymous.** The normal case.
 *   2. **A session cookie whose user no longer exists.** The session strategy is JWT, so a
 *      deleted account still has a signature-valid token until it expires; `resolveAuthzScope`
 *      is the check that catches it and returns `null` (the guards are fail-closed on the same
 *      value).
 *
 * The second case is why this decision is not `if (session?.user)`. The pages that a signed-in
 * visitor would be redirected TO (`/dashboard`, the ticket wallet) each resolve the same scope
 * and send a `null` back to `/login`. Redirecting that visitor onward again would produce an
 * infinite `/login → /dashboard → /login` loop in the browser, for a visitor who genuinely
 * needs the form — because their account is gone. So: a scope exists → redirect; no scope →
 * render the form. Both branches are pinned in `__tests__/auth-flow/session-gate.test.ts`.
 *
 * ── WHY THE `callbackUrl` STILL WINS ────────────────────────────────────────────
 * A visitor bounced here from a gated page carries `?callbackUrl=`. When they are ALREADY
 * signed in, honouring it returns them to what they were trying to open instead of to their
 * default surface. The value is untrusted and goes through the same validator the login form
 * uses (`resolveSafeCallbackUrl`), so an external or looping value is ignored and the role's
 * default applies.
 */

/** The actor as the database described them. Note: no role from the request, ever. */
export type AuthenticatedVisitor = {
    /** `PlatformRole` from `resolveAuthzScope`, which maps a null column to `"CUSTOMER"`. */
    platformRole: PlatformRole | null;
};

/**
 * What an already-authenticated visitor to `/login` or `/register` should get.
 *
 * A discriminated union rather than a `string | null` so the reason is explicit at the call
 * site: `render-form` is not "no decision", it is the decision that the visitor is anonymous
 * (or no longer has an account).
 */
export type SessionGateDecision =
    | { readonly action: "render-form" }
    | { readonly action: "redirect"; readonly to: string };

/**
 * Decide what an authenticated visitor to an auth page gets.
 *
 * `visitor` is the RESOLVED scope, or `null`/`undefined` when there is no session or the
 * session's user no longer exists. `callbackUrl` is the raw, untrusted query value.
 */
export function decideSessionGate(
    visitor: AuthenticatedVisitor | null | undefined,
    callbackUrl: string | null | undefined
): SessionGateDecision {
    if (!visitor) {
        return { action: "render-form" };
    }

    return {
        action: "redirect",
        to: postLoginDestination(callbackUrl, {
            intentDefault: intentForPlatformRole(visitor.platformRole),
        }),
    };
}

/**
 * Normalise `?callbackUrl=` out of a server page's `searchParams`.
 *
 * The parameter is typed `string | string[] | undefined` because a query can repeat a key.
 * A repeated value is ambiguous, so the FIRST occurrence is taken and the whole value is
 * validated downstream anyway — this function only prevents the array from reaching a helper
 * that expects a string.
 */
export function readCallbackUrlParam(
    value: string | string[] | undefined | null
): string | null {
    if (typeof value === "string") {
        // An empty string is an ABSENT parameter, not a destination. (`?callbackUrl=` is what a
        // hand-edited URL looks like, and treating it as a value would mean carrying "" into a
        // validator whose job is to reject things.)
        return value.length > 0 ? value : null;
    }

    if (Array.isArray(value) && typeof value[0] === "string") {
        return value[0];
    }

    return null;
}
