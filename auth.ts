import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";

import { PrismaAdapter } from "@auth/prisma-adapter";

import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { getClientIp, rateLimiters } from "@/lib/rate-limit";
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
                 * PHASE 3 — D-53 (login rate limiting).
                 *
                 * This is the earliest point available in the credentials flow.
                 * It is NOT assumed: the installed @auth/core beta declares
                 * `authorize: (credentials, request: Request) => Awaitable<User | null>`,
                 * verified in node_modules/@auth/core/providers/credentials.d.ts,
                 * so the original request (and therefore the client IP) is
                 * reachable here without wrapping the route.
                 *
                 * DEPLOYMENT REQUIREMENT: getClientIp() returns the sentinel
                 * "untrusted" when TRUSTED_PROXY is unset, which makes every
                 * client share one bucket. TRUSTED_PROXY is currently unset, so
                 * in production this limiter is global until it is configured
                 * behind the reverse proxy. See TICKETING_PHASE3_REPORT.md §14.
                 */
                const clientIp = getClientIp(request);

                if (!rateLimiters.login(clientIp).allowed) {
                    console.warn(
                        `[auth] login rate limit exceeded (ip bucket: ${clientIp})`
                    );

                    /*
                     * Return null rather than a distinct error: the caller must
                     * not be able to tell "throttled" from "bad credentials".
                     */
                    return null;
                }

                /*
                 * Pastikan identifier dan password
                 * dikirim dari form login.
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
                    return null;
                }

                /*
                 * User berhasil login.
                 *
                 * Role ikut dikirim supaya nanti
                 * bisa dimasukkan ke JWT/session.
                 */
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
