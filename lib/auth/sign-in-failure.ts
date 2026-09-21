/**
 * ==========================================
 * SIGN-IN FAILURE CLASSIFICATION (PURE)
 * ==========================================
 *
 * One function that turns what `signIn()` returns into the sentence the login form
 * shows. It exists because "the sign-in did not succeed" is three different events
 * with three different remedies, and until Phase 27A the form rendered all of them
 * as "password salah" (F4).
 *
 * ── THE THREE OUTCOMES ─────────────────────────────────────────────────────────
 *
 *   1. CREDENTIALS_FAILED — a wrong password, an unknown account, or an OAuth-only
 *      account. ONE sentence, deliberately: the account's existence, its password
 *      hash and its authentication method must all be indistinguishable from the
 *      browser. `auth.ts` equalises the timing of the same three paths, so the
 *      sentence is the only thing left that could leak, and it does not.
 *
 *   2. RATE_LIMITED — `auth.ts` refused to verify any credential because the client's
 *      bucket is exhausted (five failures per fifteen minutes, D-53). Telling the
 *      visitor this is not a disclosure: nothing about the account, the identifier or
 *      the password is involved, and the alternative is what used to happen — a
 *      locked-out visitor retrying into a wall while being told their password is
 *      wrong. The remedy is different, so the message is different.
 *
 *   3. UNAVAILABLE — Auth.js could not complete the flow at all (a `Configuration`
 *      error: a missing secret, a provider misconfiguration, an adapter/database
 *      failure). Reporting this as bad credentials would send the visitor to fix a
 *      password that was never the problem.
 *
 * ── HOW EACH IS RECOGNISED, FROM THE WIRE ──────────────────────────────────────
 * `signIn("credentials", { redirect: false })` resolves to
 * `{ error, code, status, ok, url }`, where `error` and `code` are read from the
 * query string Auth.js builds in `@auth/core/index.js`:
 *
 *     const type = isClientSafeErrorType ? error.type : "Configuration";
 *     const params = new URLSearchParams({ error: type });
 *     if (error instanceof CredentialsSignin) params.set("code", error.code);
 *
 * So:
 *   • a THROWN `CredentialsSignin` subclass keeps `error: "CredentialsSignin"` and
 *     carries its own `code` — which is how `RATE_LIMITED` arrives (`auth.ts`'s
 *     `LoginRateLimited.code` is `LOGIN_RATE_LIMITED_CODE` below, kept in ONE place
 *     so the server and the client cannot drift);
 *   • anything Auth.js does not consider client-safe is rewritten to
 *     `error: "Configuration"`, which is the `UNAVAILABLE` case;
 *   • `null`/absent `error` means the sign-in succeeded.
 *
 * ── WHY EVERY UNRECOGNISED VALUE FAILS TOWARDS CREDENTIALS_FAILED ─────────────
 * A new Auth.js error type — there are a dozen in `@auth/core/errors.js` — would
 * otherwise be rendered as a temporary server problem to a visitor whose password was
 * simply wrong. Unknown values are therefore treated as the generic credential
 * sentence, which is true of every authentication failure that is not already named
 * above. The reverse default would be a guess presented as a diagnosis.
 *
 * This module is pure and importable from the client: it holds strings and a switch,
 * no DB, no provider, no environment.
 */

/**
 * The `code` `auth.ts` attaches to a throttled sign-in, and the exact string this
 * module matches. ONE definition, imported by both sides.
 */
export const LOGIN_RATE_LIMITED_CODE = "rate_limited";

/**
 * The single sentence for every credential failure.
 *
 * Byte-for-byte the message the form already showed, so the uniform-failure contract
 * (and the timing guarantee behind it) is unchanged. It names both fields and neither
 * cause, and must never distinguish "no such account" from "wrong password" from
 * "OAuth-only account".
 */
export const CREDENTIALS_FAILED_MESSAGE =
    "Email / Nomor HP atau password salah. Periksa kembali dan coba lagi.";

/**
 * The sentence for an exhausted bucket.
 *
 * It states the remedy and nothing else: no count, no remaining time, no identifier.
 * The client cannot know how long the window has left anyway — `signIn()` does not
 * carry `retryAfterMs` — and inventing a number would be worse than saying "some
 * minutes".
 */
export const LOGIN_RATE_LIMITED_MESSAGE =
    "Terlalu banyak percobaan login. Tunggu beberapa menit, lalu coba lagi.";

/**
 * The sentence for a flow Auth.js could not complete.
 *
 * Deliberately does NOT say "password salah": the visitor should retry rather than
 * reset a password that is not the problem. It also confirms nothing about the
 * account — a misconfiguration is a property of the deployment.
 */
export const LOGIN_UNAVAILABLE_MESSAGE =
    "Layanan login sedang bermasalah. Silakan coba lagi beberapa saat lagi.";

export type SignInFailureKind =
    | "CREDENTIALS_FAILED"
    | "RATE_LIMITED"
    | "UNAVAILABLE";

export type SignInFailure = {
    kind: SignInFailureKind;
    message: string;
};

/**
 * Classify the outcome of a credentials `signIn()` call.
 *
 * @param error The `error` field: `null`/`undefined` on success, otherwise an Auth.js
 *              error TYPE name (`"CredentialsSignin"`, `"Configuration"`, …).
 * @param code  The `code` field: present only for a thrown `CredentialsSignin`.
 * @returns `null` when the sign-in succeeded, otherwise the kind and the sentence.
 */
export function classifySignInFailure(
    error: string | null | undefined,
    code?: string | null
): SignInFailure | null {
    if (!error) {
        return null;
    }

    /*
     * Checked BEFORE the type, because the type is always "CredentialsSignin" here —
     * the code is the only thing that distinguishes a locked bucket from a bad
     * password.
     */
    if (code === LOGIN_RATE_LIMITED_CODE) {
        return {
            kind: "RATE_LIMITED",
            message: LOGIN_RATE_LIMITED_MESSAGE,
        };
    }

    if (error === "Configuration") {
        return {
            kind: "UNAVAILABLE",
            message: LOGIN_UNAVAILABLE_MESSAGE,
        };
    }

    return {
        kind: "CREDENTIALS_FAILED",
        message: CREDENTIALS_FAILED_MESSAGE,
    };
}
