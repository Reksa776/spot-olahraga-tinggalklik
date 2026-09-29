import NextAuth, { CredentialsSignin } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";

import { PrismaAdapter } from "@auth/prisma-adapter";

import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { clientRateLimitKey, hasTrustworthyClientKey, rateLimiters } from "@/lib/rate-limit";
import { LOGIN_RATE_LIMITED_CODE } from "@/lib/auth/sign-in-failure";
import { isScopeStale, resolveAuthzScope } from "@/lib/authz/scope";

/*
 * PHASE 3 — timing-equalisation hash.
 *
 * The previous value was the literal string
 * "$2a$12$x dummy hash to prevent timing attack", which is NOT a valid bcrypt
 * hash. bcryptjs rejects it structurally and returns immediately, so the
 * "constant-time response" comment above it was not true: measured on this
 * machine, comparing against a real cost-12 hash takes ~253 ms/op while the
 * malformed string takes ~0.000 ms — roughly 3.2 million times faster. An
 * attacker could therefore distinguish "no such user" from "wrong password"
 * with a trivial timing measurement, which is exactly the user enumeration the
 * code intended to prevent.
 *
 * This is a real cost-12 hash of a value nobody knows, so the comparison
 * performs the same work as a genuine one and always fails.
 */
const TIMING_EQUALISATION_HASH =
    "$2b$12$NbUxsQnwo76rOz4aUIkXyukR8QmhbZAkJmLKJkbHEqAr.qtC24Vo2";

/*
 * PHASE 27A — F3/F4. The ONE authentication failure that is not a credential
 * failure.
 *
 * Returning `null` from `authorize` is how this file reports "wrong password",
 * "no such account" and "OAuth-only account" — and Auth.js collapses all three into
 * the same `CredentialsSignin`, so the browser cannot tell a locked bucket from a
 * typo. Throwing this instead is the whole fix:
 * `@auth/core/index.js` reads the code off the thrown instance
 * (`if (error instanceof CredentialsSignin) params.set("code", error.code)`) and
 * `next-auth/react` surfaces it as `result.code`, so `lib/auth/sign-in-failure.ts`
 * can answer "tunggu beberapa menit" for a locked bucket while a wrong password
 * keeps the one uniform sentence.
 *
 * The value is a machine token, never a sentence: it travels in a URL query string
 * (see the note on `CredentialsSignin.code` in @auth/core/errors.js), so it names no
 * identifier, no account and no password state.
 */
class LoginRateLimited extends CredentialsSignin {
    code = LOGIN_RATE_LIMITED_CODE;
}


export const {
    handlers,
    auth,
    signIn,
    signOut,
} = NextAuth({
    adapter: PrismaAdapter(prisma),

    session: {
        strategy: "jwt",
    },

    pages: {
        signIn: "/login",
    },

    providers: [
        /*
         * GOOGLE
         */
        Google({
            clientId:
                process.env.GOOGLE_CLIENT_ID!,

            clientSecret:
                process.env.GOOGLE_CLIENT_SECRET!,
            // SECURITY: Set to false to prevent OAuth account takeover.
            // When true, a Google login with email X auto-links to the
            // existing credentials account with email X — allowing an
            // attacker who knows a victim's email to link their own
            // Google account and take over the credentials account.
            allowDangerousEmailAccountLinking: false,
        }),

        /*
         * CREDENTIALS
         */
        Credentials({
            name: "Credentials",

            credentials: {
                identifier: {
                    label: "Email / Nomor HP",
                    type: "text",
                },

                password: {
                    label: "Password",
                    type: "password",
                },
            },

            async authorize(credentials, request) {
                /*
                 * PHASE 3 — D-53 (login rate limiting), reworked by PHASE 27A — F3.
                 *
                 * The VALUES are unchanged: five failures per fifteen minutes,
                 * owned by `lib/rate-limit.ts`. What changed is what is counted and
                 * what a refusal looks like.
                 *
                 *   1. `check` is a READ-ONLY probe, so a request costs nothing by
                 *      existing. The allowance is spent further down, at each FAILED
                 *      verification — the only outcome a brute-force attempt can
                 *      produce. The previous limiter counted every call, so five of
                 *      the operator's own SUCCESSFUL logins could lock the bucket,
                 *      and a request carrying no credentials at all counted too.
                 *   2. A refusal THROWS rather than returning null, so the browser can
                 *      tell it from bad credentials — while the sentence shown never
                 *      says anything about any account. Returning null (the old
                 *      behaviour) made a locked visitor believe their password was
                 *      wrong and retry into the wall. `lib/auth/sign-in-failure.ts`
                 *      owns the three messages; `LoginRateLimited` above owns the
                 *      code.
                 *   3. The bucket key comes from `clientRateLimitKey`, which is
                 *      `getClientIp`'s answer in production and a labelled bucket of
                 *      its own in development. See that function for why nothing on
                 *      this path is a trustworthy peer address, and why reading
                 *      `x-forwarded-for` here would undo the M2 fix.
                 *
                 * `authorize` is still the earliest point available: the installed
                 * @auth/core beta declares
                 * `authorize: (credentials, request: Request) => Awaitable<User | null>`
                 * (node_modules/@auth/core/providers/credentials.d.ts), so the
                 * original request — and therefore the client key — is reachable
                 * here without wrapping the route.
                 */
                /*
                 * F-03 — THE PER-CLIENT REFUSAL IS APPLIED ONLY WHEN THERE IS A CLIENT.
                 *
                 * `clientRateLimitKey` returns the shared sentinel "untrusted" in production
                 * when no valid TRUSTED_PROXY (F-02) produced a client address, and in that
                 * case every visitor shares ONE key. Refusing on that key is not a per-client
                 * limit at all — it is a platform-wide lockout that five wrong passwords from
                 * one stranger can trigger, which was F-03.
                 *
                 * So the refusal requires `hasTrustworthyClientKey`: a real address (or
                 * development's labelled bucket) keeps the five-per-fifteen-minutes refusal
                 * exactly as it was, byte for byte. Without one, the per-account and global
                 * throttles below are the protection — neither of which can lock anybody out —
                 * and `getClientIp` has already warned the operator, once per value, that
                 * TRUSTED_PROXY is not doing its job.
                 */
                const loginKey = clientRateLimitKey(request);
                const hasClientIdentity = hasTrustworthyClientKey(request);

                if (
                    hasClientIdentity &&
                    !rateLimiters.login.check(loginKey).allowed
                ) {
                    console.warn(
                        `[auth] login rate limit exceeded (bucket: login:${loginKey})`
                    );

                    throw new LoginRateLimited();
                }

                /*
                 * Pastikan identifier dan password
                 * dikirim dari form login.
                 */
                /*
                 * PHASE 27A — NOT counted against the allowance. An empty field is a
                 * malformed request, not a credential failure, and charging it would
                 * let a client exhaust its own bucket with requests that could never
                 * have authenticated.
                 */
                if (
                    !credentials?.identifier ||
                    !credentials?.password
                ) {
                    return null;
                }

                const identifier =
                    String(
                        credentials.identifier
                    ).trim();

                const password =
                    String(
                        credentials.password
                    );

                /*
                 * F-03 — THE PER-ACCOUNT FAILURE BUCKET.
                 *
                 * Keyed by an HMAC of the submitted identifier (never the identifier
                 * itself), so the same account always lands in the same bucket whether or
                 * not it exists, and so nothing in memory names an account. See
                 * `lib/rate-limit.ts` for why this control can never lock an account and
                 * why its bucket is unreadable across processes.
                 */
                const accountKey = rateLimiters.login.accountKey(identifier);

                /*
                 * F-03 — THE THROTTLE, BEFORE ANY VERIFICATION.
                 *
                 * Two bounded delays, summed and capped by each control: the identifier's
                 * own accumulated failures, plus the platform-wide safeguard. Neither can
                 * refuse the request, so a correct password always signs in — it may only
                 * wait. Placed before the user lookup so a guess costs the attacker the
                 * delay as well as the bcrypt comparison.
                 */
                const throttleMs =
                    rateLimiters.login.accountThrottleMs(accountKey) +
                    rateLimiters.loginGlobal.throttleMs();

                if (throttleMs > 0) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, throttleMs)
                    );
                }

                /*
                 * ONE PLACE CHARGES A FAILED CREDENTIAL, so no refusal branch can forget
                 * one of the counters — and the two branches that must NOT charge (a
                 * malformed request, a success) cannot charge by accident either.
                 *
                 * The per-client bucket is charged only when there is a client identity to
                 * charge it to; the account and global counters are always charged, because
                 * they are what protects the endpoint when there is no identity.
                 */
                const chargeLoginFailure = () => {
                    if (hasClientIdentity) {
                        rateLimiters.login.recordFailure(loginKey);
                    }

                    rateLimiters.login.recordAccountFailure(accountKey);
                    rateLimiters.loginGlobal.recordFailure();
                };

                /*
                 * Cari user berdasarkan:
                 *
                 * email ATAU nomor HP
                 */
                const user =
                    await prisma.user.findFirst({
                        where: {
                            OR: [
                                {
                                    email: identifier,
                                },
                                {
                                    phone: identifier,
                                },
                            ],
                        },
                    });

                /*
                 * SECURITY: Constant-time response
                 * to prevent user enumeration.
                 * Always run verifyPassword even if
                 * user not found, to ensure same
                 * response time.
                 */

                /*
                 * User tidak ditemukan
                 */
                if (!user) {
                    /*
                     * Run the dummy verify so this path costs the same as a
                     * wrong password (see TIMING_EQUALISATION_HASH).
                     */
                    await verifyPassword(password, TIMING_EQUALISATION_HASH);

                    /* PHASE 27A — an unknown identifier IS a credential failure. */
                    chargeLoginFailure();

                    return null;
                }

                /*
                 * PHASE 33 — a deactivated account cannot sign in.
                 *
                 * The check sits BEFORE password verification and reads the SAME timing-
                 * equalisation treatment as the other refusal paths: the disabled account
                 * costs a dummy verify and counts as a credential failure, indistinguishable
                 * from "wrong password" to the caller (never "your account is disabled" —
                 * that would be account-state enumeration). Reactivation by an ADMIN
                 * restores access with no data change.
                 */
                if (user.disabledAt) {
                    await verifyPassword(password, TIMING_EQUALISATION_HASH);

                    chargeLoginFailure();

                    return null;
                }

                /*
                 * User tidak mempunyai password.
                 *
                 * Biasanya bisa terjadi pada user
                 * yang dibuat melalui OAuth/Google.
                 */
                if (!user.password) {
                    /*
                     * Same timing treatment: an OAuth-only account must be
                     * indistinguishable from a non-existent one.
                     */
                    await verifyPassword(password, TIMING_EQUALISATION_HASH);

                    /* PHASE 27A — an account with no password cannot be signed into
                     * by a password, so this is a credential failure too. The count
                     * is what protects the endpoint, not the outcome's name. */
                    chargeLoginFailure();

                    return null;
                }

                /*
                 * Verifikasi password
                 */
                const valid =
                    await verifyPassword(
                        password,
                        user.password
                    );

                if (!valid) {
                    /* PHASE 27A — the canonical credential failure. */
                    chargeLoginFailure();

                    return null;
                }

                /*
                 * User berhasil login.
                 *
                 * Role ikut dikirim supaya nanti
                 * bisa dimasukkan ke JWT/session.
                 */
                /*
                 * F-03 — A SUCCESSFUL VERIFICATION CLEARS THE IDENTIFIER'S FAILURES.
                 *
                 * The person who knows the password is not the attacker, so the delay an
                 * attacker's guesses built up ends here. This is also the second reason the
                 * account control can never lock an account out: the correct password always
                 * clears it. Note what this path does NOT do — it charges no counter at all.
                 */
                rateLimiters.login.clearAccountFailures(accountKey);

                return {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    image: user.image,
                    role: user.role,
                };
            },
        }),
    ],

    callbacks: {
        /*
         * SIGN IN
         *
         * Credentials:
         * langsung izinkan jika authorize()
         * berhasil.
         *
         * Google:
         * izinkan login selama Google memberikan
         * email.
         */
        async signIn({
            user,
            account,
        }) {
            /*
             * Credentials login
             */
            if (
                account?.provider !==
                "google"
            ) {
                return true;
            }

            /*
             * Google harus memberikan email.
             */
            if (!user.email) {
                return false;
            }

            /*
             * PHASE 3 — cleanup, behaviour unchanged.
             *
             * This block used to look up the user by email and then return
             * `true` on BOTH branches, so the query could not affect the
             * outcome. It is removed: Google sign-in still requires an email,
             * still returns true, and the PrismaAdapter still handles OAuth user
             * creation. The only difference is one fewer pointless database
             * round-trip per Google sign-in.
             */
            return true;
        },

        /*
         * JWT
         *
         * Simpan ID dan ROLE user ke token.
         */
        async jwt({
            token,
            user,
        }) {
            if (user) {
                if (user.id) {
                    token.id = user.id;
                }

                /*
                 * PHASE 3 — no `as any`. `user.role` is typed by
                 * types/next-auth.d.ts, so a wrong claim name is a compile
                 * error instead of a silently-undefined token field.
                 */
                token.role = user.role ?? "CUSTOMER";
            }

            if (!token.id) {
                return token;
            }

            /*
             * PHASE 3 — D-48 (scope staleness ≤60 s, with invalidation on
             * revocation).
             *
             * The platform role is mirrored into the token for cheap
             * routing/UI gating and refreshed from the database once the copy
             * is stale. It is deliberately NOT the authority for authorization:
             * every guard in lib/authz re-resolves memberships and grants from
             * the database per request, so a revocation takes effect
             * immediately there and can never be 60 s late.
             */
            if (isScopeStale(token.authzScopeRefreshedAt)) {
                const scope = await resolveAuthzScope(token.id);

                token.platformRole = scope?.platformRole ?? null;
                token.authzScopeRefreshedAt = Date.now();
            }

            return token;
        },

        /*
         * SESSION
         *
         * Masukkan ID dan ROLE dari JWT
         * ke session.user.
         */
        async session({
            session,
            token,
        }) {
            if (session.user) {
                if (token.id) {
                    session.user.id = token.id;
                }

                session.user.role = token.role ?? "CUSTOMER";
                session.user.platformRole = token.platformRole ?? null;
            }

            return session;
        },
    },
});
