"use client";

import { useEffect, useState } from "react";
import { FaArrowLeft } from "react-icons/fa";
import Link from "next/link";

import Brand from "@/components/Brand";
import { useRouter } from "next/navigation";
import {
    signIn,
    getSession,
} from "next-auth/react";
import toast from "react-hot-toast";

import {
    FaEnvelope,
    FaLock,
    FaEye,
    FaEyeSlash,
} from "react-icons/fa";

import { postLoginDestination } from "@/lib/auth/redirect";

/**
 * Read `callbackUrl` from the current URL.
 *
 * Read from `window.location` rather than `useSearchParams()` on purpose: the login page is
 * statically rendered, and `useSearchParams()` would opt it out of that (or force a Suspense
 * boundary) for a value that is only ever needed inside an event handler and an effect — both
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

    const [identifier, setIdentifier] =
        useState("");

    const [password, setPassword] =
        useState("");

    const [loading, setLoading] =
        useState(false);

    const [checkingSession, setCheckingSession] =
        useState(true);

    const [showPassword, setShowPassword] =
        useState(false);

    /*
     * ==========================================
     * CEK SESSION SAAT HALAMAN LOGIN DIBUKA
     * ==========================================
     */

    useEffect(() => {
        let mounted = true;

        async function checkSession() {
            try {
                const session =
                    await getSession();

                if (!mounted) {
                    return;
                }

                /*
                 * BELUM LOGIN
                 */

                if (
                    !session?.user
                ) {
                    setCheckingSession(
                        false
                    );

                    return;
                }

                /*
                 * SUDAH LOGIN
                 *
                 * An already-authenticated visitor goes to the same place a fresh login
                 * goes: the page they were interrupted on, or the dashboard. The dashboard
                 * layout is what decides whether they may actually use it, so an account
                 * without back-office access lands on its denial state rather than being
                 * silently dropped somewhere else.
                 */

                router.replace(postLoginDestination(readCallbackUrl()));
            } catch (error) {
                console.error(
                    "CHECK SESSION ERROR:",
                    error
                );

                if (mounted) {
                    setCheckingSession(
                        false
                    );
                }
            }
        }

        checkSession();

        return () => {
            mounted = false;
        };
    }, [router]);
    async function handleLogin(
        e: React.FormEvent<HTMLFormElement>
    ) {
        e.preventDefault();

        if (!identifier || !password) {
            toast.error("Semua field wajib diisi.");
            return;
        }

        setLoading(true);

        try {
            const result = await signIn("credentials", {
                identifier,
                password,
                redirect: false,
            });

            /*
             * Authentication FAILED (or was throttled). Stay on the login page and keep the
             * existing error message — a failed login must never navigate anywhere.
             */
            if (result?.error) {
                toast.error(
                    "Email / Nomor HP atau Password salah."
                );

                setLoading(false);
                return;
            }

            toast.success("Login berhasil 🎉");

            /*
             * AUTHENTICATED — now go to the back office.
             *
             * The destination is the sanitised callback (the page the user was bounced from, e.g.
             * `/dashboard/events`) or `/dashboard`. It is never `/`, `/platform`, `/organizer` or
             * `/admin`: the back office is one dashboard now, and those role-specific landing pages
             * belonged to the retired retail application.
             *
             * Authorization has NOT been decided here. This is navigation; `app/dashboard/layout.tsx`
             * runs the real permission decision on the next render and renders its denial state for an
             * account without back-office access.
             */
            router.replace(postLoginDestination(readCallbackUrl()));

            router.refresh();
        } catch (error) {
            console.error("Login error:", error);

            toast.error(
                "Terjadi kesalahan saat login."
            );
        } finally {
            setLoading(false);
        }
    }

    async function handleGoogleLogin() {
        try {
            setLoading(true);

            await signIn("google", {
                // Same sanitised destination as the credentials path: a valid same-origin
                // callback, otherwise the dashboard.
                callbackUrl: postLoginDestination(readCallbackUrl()),
            });
        } catch (error) {
            console.error(
                "Google login error:",
                error
            );

            toast.error(
                "Gagal login dengan Google."
            );

            setLoading(false);
        }
    }
    /*
 * ==========================================
 * CEK SESSION
 * ==========================================
 */

    if (checkingSession) {
        return (
            <section className="flex min-h-screen items-center justify-center bg-gradient-to-br from-ink-50 via-white to-brand-50 px-5 py-10">
                <div className="rounded-2xl bg-white px-8 py-6 text-center shadow-xl">
                    <p className="font-medium text-gray-900">
                        Memeriksa sesi login...
                    </p>

                    <p className="mt-1 text-sm text-gray-500">
                        Tunggu sebentar.
                    </p>
                </div>
            </section>
        );
    }

    return (
        <section className="flex min-h-screen items-center justify-center bg-gradient-to-br from-ink-50 via-white to-brand-50 px-5 py-10">
            <div className="w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl">

                {/* BACK */}
                <Link
                    href="/"
                    className="mb-6 inline-flex items-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50"
                >
                    <FaArrowLeft className="text-xs" />
                    Kembali ke Beranda
                </Link>

                {/* HEADER */}
                <div className="mb-8 text-center">

                    <div className="mb-6 flex justify-center">
                        <Brand />
                    </div>

                    <h1 className="text-3xl font-bold text-ink-900">
                        Selamat Datang
                    </h1>

                    <p className="mt-2 text-sm text-gray-600">
                        Masuk untuk melanjutkan ke akun TinggalKlik.Co.
                    </p>

                </div>

                {/* FORM */}
                <form
                    onSubmit={handleLogin}
                    className="space-y-5"
                >

                    {/* EMAIL / PHONE */}
                    <div>

                        <label className="mb-2 block text-sm font-semibold text-gray-700">
                            Email / Nomor HP
                        </label>

                        <div className="relative">

                            <FaEnvelope
                                size={18}
                                className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                            />

                            <input
                                type="text"
                                value={identifier}
                                onChange={(e) =>
                                    setIdentifier(
                                        e.target.value
                                    )
                                }
                                placeholder="Masukkan email atau nomor HP"
                                disabled={loading}
                                autoComplete="username"
                                className="h-12 w-full rounded-xl border border-gray-300 bg-white pl-11 pr-4 text-[15px] text-black placeholder:text-gray-400 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-100"
                            />

                        </div>

                    </div>

                    {/* PASSWORD */}
                    <div>

                        <label className="mb-2 block text-sm font-semibold text-gray-700">
                            Password
                        </label>

                        <div className="relative">

                            <FaLock
                                size={18}
                                className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                            />

                            <input
                                type={
                                    showPassword
                                        ? "text"
                                        : "password"
                                }
                                value={password}
                                onChange={(e) =>
                                    setPassword(
                                        e.target.value
                                    )
                                }
                                placeholder="Masukkan password"
                                disabled={loading}
                                autoComplete="current-password"
                                className="h-12 w-full rounded-xl border border-gray-300 bg-white pl-11 pr-12 text-[15px] text-black placeholder:text-gray-400 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-100"
                            />

                            <button
                                type="button"
                                onClick={() =>
                                    setShowPassword(
                                        !showPassword
                                    )
                                }
                                disabled={loading}
                                className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 transition hover:text-brand-600 disabled:cursor-not-allowed"
                            >
                                {showPassword ? (
                                    <FaEyeSlash />
                                ) : (
                                    <FaEye />
                                )}
                            </button>

                        </div>

                    </div>

                    {/*
                        REMEMBER

                        The "Lupa Password?" link was removed: `/forgot-password` has never
                        existed in this application, so the login page was offering a 404. A
                        password-reset flow is a feature, not a link, and inventing a route to
                        point at would be worse than not offering it.
                    */}
                    <div className="flex items-center justify-between text-sm">

                        <label className="flex items-center gap-2 text-gray-700">

                            <input
                                type="checkbox"
                                disabled={loading}
                                className="h-4 w-4 accent-brand-600"
                            />

                            Ingat Saya

                        </label>

                    </div>

                    {/* LOGIN BUTTON */}
                    <button
                        type="submit"
                        disabled={loading}
                        className="flex h-12 w-full items-center justify-center rounded-xl bg-brand-600 font-semibold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {loading
                            ? "Memproses..."
                            : "Login"}
                    </button>

                    {/* DIVIDER */}
                    <div className="flex items-center">

                        <div className="h-px flex-1 bg-gray-300" />

                        <span className="mx-4 text-sm text-gray-500">
                            atau
                        </span>

                        <div className="h-px flex-1 bg-gray-300" />

                    </div>

                    {/* GOOGLE */}
                    <button
                        type="button"
                        onClick={handleGoogleLogin}
                        disabled={loading}
                        className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-gray-300 bg-white font-medium text-gray-800 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >

                        <img
                            src="https://www.svgrepo.com/show/475656/google-color.svg"
                            alt="Google"
                            className="h-5 w-5"
                        />

                        Lanjutkan dengan Google

                    </button>

                    {/* REGISTER */}
                    <p className="pt-2 text-center text-sm text-gray-600">

                        Belum punya akun?

                        <Link
                            href="/register"
                            className="ml-1 font-semibold text-brand-600 hover:underline"
                        >
                            Daftar
                        </Link>

                    </p>

                </form>

            </div>
        </section>
    );
}