"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSession, signIn } from "next-auth/react";
import toast from "react-hot-toast";
import { FaEnvelope } from "react-icons/fa";

import AuthError from "@/components/auth/AuthError";
import AuthShell from "@/components/auth/AuthShell";
import GoogleMark from "@/components/auth/GoogleMark";
import PasswordField from "@/components/auth/PasswordField";
import RoleSelector from "@/components/auth/RoleSelector";
import Brand from "@/components/Brand";
import { classifySignInFailure } from "@/lib/auth/sign-in-failure";
import { postLoginDestination } from "@/lib/auth/redirect";
import {
    DEFAULT_LOGIN_ROLE_INTENT,
    LOGIN_ROLE_INTENT_META,
    intentForPlatformRole,
    intentMatchesRole,
    type LoginRoleIntent,
} from "@/lib/auth/roles";

/**
 * ==========================================
 * LOGIN — ONE SYSTEM, FOUR ENTRANCES
 * ==========================================
 *
 * ── WHAT THE ROLE SELECTOR IS, AND IS NOT ───────────────────────────────────────
 * It is UI INTENT. It shapes the copy, and it is used as a navigation default when nothing
 * better is known. It is NEVER sent to the server:
 *
 *     signIn("credentials", { identifier, password, redirect: false })
 *
 * Those three keys are the whole payload. There is no `role`, no `platformRole`, no
 * `permissions` — so a visitor who clicks "Admin" and signs into a customer account gets a
 * customer session, because the only thing that decides a role is `User.platformRole` read
 * from the database by `auth.ts` and re-read on every request by `lib/authz/scope.ts`.
 *
 * ── WHY THE DESTINATION USES THE SERVER'S ROLE, NOT THE CLICKED ONE ─────────────
 * After a successful sign-in the destination is derived from the role the SERVER reported
 * in the session (`intentForPlatformRole(session.user.platformRole)`), falling back to the
 * chosen entrance only when the session could not be read. So the entrance can never route
 * someone into a surface their account does not have — and the destination's own server-side
 * gate is a second, independent refusal.
 *
 * When those two disagree (a customer who clicked "Admin"), the visitor gets one neutral
 * sentence naming THEIR OWN role. That discloses nothing about any other account — it is
 * their own session — and it removes the "why am I on this page?" confusion without ever
 * confirming or denying that some other account exists.
 *
 * ── WHAT WAS REMOVED, AND WHY ───────────────────────────────────────────────────
 *   • **"Ingat Saya"** — a checkbox that rendered, was clickable, and was never read by
 *     anything. `session.maxAge` is unset, so every session is already 30 days; the control
 *     promised a choice it did not have. A dead control is worse than no control.
 *   • **"Lupa Password?"** — already gone before this phase, because `/forgot-password` has
 *     never existed. A password-reset flow is a feature, not a link.
 *   • **`?next=` support** — the session-gated pages used to build `?next=<path>` and this
 *     form reads `callbackUrl`, so that value was silently dropped and every interrupted
 *     buyer landed on the dashboard. The pages now build the URL with `loginUrlFor()`
 *     (`lib/auth/redirect.ts`), so there is one key and one validator.
 *
 * ── WHAT A FAILED SIGN-IN SAYS (PHASE 27A, F4) ──────────────────────────────────
 * Every CREDENTIAL failure — wrong password, unknown account, Google-only account —
 * produces ONE message, set as inline state rather than a toast: the form must not be
 * able to distinguish them, and `auth.ts` equalises their timing precisely so that it
 * cannot.
 *
 * Two outcomes are deliberately NOT that message, because separating them discloses
 * nothing about any account and because their remedy is different:
 *
 *   • a THROTTLED sign-in (five credential failures per fifteen minutes) says so, so a
 *     locked visitor waits instead of concluding their password is wrong and retrying
 *     into the wall — which is what the previous build made them do;
 *   • a sign-in Auth.js could not complete at all (a `Configuration` error: a missing
 *     secret, an adapter failure) says to retry shortly, rather than sending the visitor
 *     to fix a password that was never the problem.
 *
 * That split lives in `lib/auth/sign-in-failure.ts`, a pure module this form and the
 * tests both import, so the sentences exist in exactly one place. The reasoning behind
 * the uniform credential message is in `components/auth/AuthError.tsx`; the timing half
 * of that guarantee is in `auth.ts`.
 */

/**
 * Read `callbackUrl` from the current URL.
 *
 * Read from `window.location` rather than `useSearchParams()` on purpose: the login page is
 * statically rendered, and `useSearchParams()` would opt it out of that (or force a Suspense
 * boundary) for a value that is only ever needed inside an effect and an event handler — both
 * of which run in the browser, where the query string is available directly.
 *
 * The value is UNTRUSTED and is never navigated to as-is; it is always passed through
 * `postLoginDestination`, which rejects anything that is not a same-origin path.
 */
function readCallbackUrl(): string | null {
    if (typeof window === "undefined") {
        return null;
    }

    return new URLSearchParams(window.location.search).get("callbackUrl");
}

export default function LoginForm() {
    const router = useRouter();

    const [identifier, setIdentifier] = useState("");
    const [password, setPassword] = useState("");

    const [intent, setIntent] = useState<LoginRoleIntent>(DEFAULT_LOGIN_ROLE_INTENT);

    const [loading, setLoading] = useState(false);

    /** Inline, persistent, and uniform. Never a toast on the auth-failure path. */
    const [authError, setAuthError] = useState<string | null>(null);

    /* ==========================================
     * ALREADY AUTHENTICATED?
     * ==========================================
     *
     * The check runs in the background and the form is rendered from the first byte. It used
     * to gate the whole screen behind a "Memeriksa sesi login…" spinner that resolved to
     * nothing on the server, which meant the ONLY thing in the login page's HTML was that
     * spinner — no form field, no label, no Brand lockup, nothing for a client without
     * JavaScript and nothing for a search engine or a screenshot to describe.
     *
     * The trade-off is explicit: an already-signed-in visitor may see the form for a moment
     * before being forwarded to their own surface. That is a far smaller cost than showing
     * every visitor a blank shell, and the redirect still happens exactly as before.
     *
     * ── THIS IS NOW THE FALLBACK, NOT THE GATE ─────────────────────────────────────
     * `app/login/page.tsx` resolves the session SERVER-SIDE and redirects before any HTML is
     * sent, so a signed-in visitor normally never reaches this component at all. The check
     * below remains for the case a server render cannot cover: a session that came into
     * existence after this HTML was delivered (a second tab signing in, or a soft navigation
     * re-using a payload rendered moments earlier). Both paths call the same pure helpers, so
     * they cannot disagree.
     */
    useEffect(() => {
        let mounted = true;

        async function checkSession() {
            try {
                const session = await getSession();

                if (!mounted || !session?.user) {
                    return;
                }

                /*
                 * Already signed in. Go where THIS account belongs — the role the server
                 * reported, not the entrance they clicked on this screen — honouring a valid
                 * interrupted destination first.
                 */
                router.replace(
                    postLoginDestination(readCallbackUrl(), {
                        intentDefault: intentForPlatformRole(
                            session.user.platformRole
                        ),
                    })
                );
            } catch {
                /*
                 * A failed session check is not something the visitor can act on, and the
                 * form is already on screen, so there is nothing to recover from: swallowing
                 * it here IS the correct fallback. Nothing about the session is logged.
                 */
            }
        }

        checkSession();

        return () => {
            mounted = false;
        };
    }, [router]);

    /* ==========================================
     * CREDENTIALS
     * ========================================== */
    async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const trimmedIdentifier = identifier.trim();

        /*
         * Inline validation, in the form's own words. This is a USER error, not an
         * authentication failure: saying "both fields are required" leaks nothing, and it is
         * the only case where a more specific message is both true and safe.
         */
        if (!trimmedIdentifier || !password) {
            setAuthError("Email / Nomor HP dan password wajib diisi.");
            return;
        }

        setAuthError(null);
        setLoading(true);

        try {
            /*
             * THE PAYLOAD IS EXACTLY THIS: an identifier and a password.
             *
             * `intent` is not here, and this is the load-bearing line of the whole role
             * selector. The server cannot be told who the visitor would like to be.
             */
            const result = await signIn("credentials", {
                identifier: trimmedIdentifier,
                password,
                redirect: false,
            });

            /*
             * Authentication failed, was throttled, or could not run. Stay on the login page
             * — a failed sign-in must never navigate anywhere — and show the sentence that
             * belongs to THIS outcome.
             *
             * `result.code` is the `code` Auth.js put in the redirect URL: it is the only
             * thing that distinguishes a locked bucket from a wrong password, because both
             * arrive as `error: "CredentialsSignin"`. `undefined` on every other failure and
             * on success, which is why the classifier takes it as an optional second
             * argument rather than requiring it.
             */
            const failure = classifySignInFailure(
                result?.error,
                result?.code
            );

            if (failure) {
                setAuthError(failure.message);

                setLoading(false);
                return;
            }

            toast.success("Login berhasil");

            /*
             * Signed in. Ask the server who this actually is.
             *
             * `getSession()` reads the session the Auth.js callbacks just created, so the
             * role below is the DATABASE role (`User.platformRole`), not anything the browser
             * supplied. Its failure is handled: the chosen entrance is used as a destination
             * hint and the destination's own gate decides what is rendered.
             */
            const session = await getSession().catch(() => null);

            const actualIntent = session?.user
                ? intentForPlatformRole(session.user.platformRole)
                : intent;

            if (session?.user && !intentMatchesRole(intent, session.user.platformRole)) {
                // One neutral sentence about THEIR OWN account. See the header.
                toast(
                    `Anda masuk sebagai ${LOGIN_ROLE_INTENT_META[actualIntent].label}.`
                );
            }

            router.replace(
                postLoginDestination(readCallbackUrl(), {
                    intentDefault: actualIntent,
                })
            );

            router.refresh();
        } catch {
            /*
             * A transport/JS failure must not masquerade as bad credentials: the visitor is
             * told to try again, not that their password is wrong.
             */
            setAuthError("Terjadi kesalahan saat login. Silakan coba lagi.");
        } finally {
            setLoading(false);
        }
    }

    /* ==========================================
     * GOOGLE
     * ========================================== */
    async function handleGoogleLogin() {
        try {
            setLoading(true);

            await signIn("google", {
                // The same sanitised destination as the credentials path; the chosen
                // entrance is only a fallback, and the destination's gate is authoritative.
                callbackUrl: postLoginDestination(readCallbackUrl(), {
                    intentDefault: intent,
                }),
            });
        } catch {
            setAuthError("Gagal login dengan Google. Silakan coba lagi.");

            setLoading(false);
        }
    }

    return (
        <AuthShell
            footer={
                <>
                    Belum punya akun?{" "}
                    <Link
                        href="/register"
                        className="font-bold text-brand-700 hover:underline"
                    >
                        Daftar sekarang
                    </Link>
                </>
            }
        >
            <header className="mb-7 text-center">
                <div className="mb-5 flex justify-center">
                    <Brand />
                </div>

                <h1 className="text-2xl font-extrabold tracking-tight text-ink-900 sm:text-3xl">
                    Masuk ke akun Anda
                </h1>

                <p className="mt-2 text-sm leading-relaxed text-ink-500">
                    Satu akun untuk membeli tiket dan mengelola event.
                </p>
            </header>

            <form onSubmit={handleLogin} className="space-y-5" noValidate>
                <RoleSelector
                    value={intent}
                    onChange={setIntent}
                    disabled={loading}
                />

                {authError ? <AuthError>{authError}</AuthError> : null}

                {/* ── Identifier ──────────────────────────────────────────────── */}
                <div>
                    <label
                        htmlFor="login-identifier"
                        className="mb-2 block text-sm font-semibold text-ink-700"
                    >
                        Email / Nomor HP
                    </label>

                    <div className="relative">
                        <FaEnvelope
                            size={16}
                            aria-hidden
                            className="absolute top-1/2 left-4 -translate-y-1/2 text-ink-400"
                        />

                        <input
                            id="login-identifier"
                            name="identifier"
                            type="text"
                            value={identifier}
                            onChange={(event) => setIdentifier(event.target.value)}
                            placeholder={
                                intent === "CUSTOMER"
                                    ? "Masukkan email atau nomor HP"
                                    : "Masukkan email Anda"
                            }
                            disabled={loading}
                            autoComplete="username"
                            autoFocus
                            // Not `aria-invalid`: the message this form shows is uniform, so
                            // pointing at a field would imply the other one was fine.
                            className="h-12 w-full rounded-xl border border-ink-200 bg-white pr-4 pl-11 text-[15px] text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-ink-50"
                        />
                    </div>
                </div>

                {/* ── Password ────────────────────────────────────────────────── */}
                <PasswordField
                    label="Password"
                    value={password}
                    onChange={setPassword}
                    disabled={loading}
                    autoComplete="current-password"
                />

                <button
                    type="submit"
                    disabled={loading}
                    className="flex h-12 w-full items-center justify-center rounded-xl bg-brand-600 font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {loading ? "Memproses…" : "Masuk"}
                </button>

                <div className="flex items-center pt-1">
                    <div className="h-px flex-1 bg-ink-200" />
                    <span className="mx-4 text-xs font-semibold tracking-wide text-ink-400 uppercase">
                        atau
                    </span>
                    <div className="h-px flex-1 bg-ink-200" />
                </div>

                <button
                    type="button"
                    onClick={handleGoogleLogin}
                    disabled={loading}
                    className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-ink-200 bg-white font-semibold text-ink-800 transition hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {/* Inline, so `img-src` needs no third-party origin on the sign-in page.
                        See `components/auth/GoogleMark.tsx`. */}
                    <GoogleMark />
                    Lanjutkan dengan Google
                </button>
            </form>
        </AuthShell>
    );
}
