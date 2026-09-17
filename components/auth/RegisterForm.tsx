"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import Brand from "@/components/Brand";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import {
    signIn,
    signOut,
    getSession,
} from "next-auth/react";

import toast from "react-hot-toast";

import {
    FaEye,
    FaEyeSlash,
    FaUser,
    FaEnvelope,
    FaPhone,
    FaLock,
    FaGift,
    FaArrowLeft,
    FaCheck,
    FaEdit,
} from "react-icons/fa";

import {
    registerSchema,
    RegisterInput,
} from "@/lib/validations/register";

import { register } from "@/lib/services/auth";

/* ==========================================
 * HELPER: Set JS-readable cookie
 * ========================================== */
function setPublicReferralCookie(code: string) {
    try {
        const maxAge = 60 * 60 * 24 * 30; // 30 days
        const isSecure =
            window.location.protocol === "https:";
        document.cookie =
            `aff_ref_public=${encodeURIComponent(code)}` +
            `; path=/; max-age=${maxAge}; SameSite=Lax` +
            (isSecure ? "; Secure" : "");
    } catch {
        // Non-critical
    }
}

export default function RegisterForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [checkingSession, setCheckingSession] =
        useState(true);

    const [alreadyLoggedIn, setAlreadyLoggedIn] =
        useState(false);

    const [loading, setLoading] = useState(false);

    const [showPassword, setShowPassword] = useState(false);

    const [showConfirmPassword, setShowConfirmPassword] = useState(false);

    /* ==========================================
     * REFERRAL STATE
     * ==========================================
     *
     * referralCode     — the detected/entered code
     * referralDetected — true if auto-detected (not manual)
     * referralLoading  — true while resolving referral
     * referralOverride — true if user chose to enter different code
     * referralInvalid  — true if detected code was invalid
     */
    const [referralCode, setReferralCode] = useState<string | null>(null);
    const [referralDetected, setReferralDetected] = useState(false);
    const [referralLoading, setReferralLoading] = useState(true);
    const [referralOverride, setReferralOverride] = useState(false);
    const [referralInvalid, setReferralInvalid] = useState(false);

    // Prevent re-detection after override
    const referralResolved = useRef(false);

    const {
        register: formRegister,
        handleSubmit,
        setValue,
        watch,
        formState: { errors },
    } = useForm<RegisterInput>({
        resolver: zodResolver(registerSchema),
    });

    // Watch the referralCode field for display
    const watchedReferralCode = watch("referralCode");

    /* ==========================================
     * AUTO-DETECT REFERRAL
     * ==========================================
     *
     * Priority:
     * 1. URL ?ref= param (e.g. /register?ref=ABC123)
     * 2. JS-readable cookie (aff_ref_public)
     * 3. Server-side resolve (reads HTTP-only aff_ref)
     *
     * Once resolved, the input becomes read-only
     * unless user explicitly chooses to override.
     */
    const detectReferral = useCallback(async () => {
        if (referralResolved.current) return;
        referralResolved.current = true;

        setReferralLoading(true);

        try {
            // 1. Check URL ?ref= parameter first
            const urlRef = searchParams.get("ref");
            if (urlRef) {
                setValue("referralCode", urlRef);
                setReferralCode(urlRef);
                setReferralDetected(true);
                setReferralInvalid(false);

                // Persist to JS-readable cookie for future pages
                setPublicReferralCookie(urlRef);

                // Also fire the server-side referral API to set HTTP-only cookie
                try {
                    fetch(
                        `/api/affiliate/referral?ref=${encodeURIComponent(urlRef)}`,
                        { method: "GET" }
                    ).catch(() => {});
                } catch {}

                return;
            }

            // 2. Check JS-readable cookie (aff_ref_public)
            try {
                const cookies = document.cookie.split(";");
                for (const cookie of cookies) {
                    const [name, value] = cookie.trim().split("=");
                    if (name === "aff_ref_public" && value) {
                        const code = decodeURIComponent(value);
                        if (code) {
                            setValue("referralCode", code);
                            setReferralCode(code);
                            setReferralDetected(true);
                            setReferralInvalid(false);
                            return;
                        }
                    }
                }
            } catch {
                // Non-critical
            }

            // 3. Try server-side resolve (reads HTTP-only cookie)
            try {
                const res = await fetch("/api/affiliate/resolve", {
                    method: "GET",
                    cache: "no-store",
                });
                const data = await res.json();
                if (data?.data?.code) {
                    setValue("referralCode", data.data.code);
                    setReferralCode(data.data.code);
                    setReferralDetected(true);
                    setReferralInvalid(false);
                    return;
                }
            } catch {
                // Non-critical
            }

            // No referral found
            setReferralDetected(false);
            setReferralInvalid(false);
        } finally {
            setReferralLoading(false);
        }
    }, [searchParams, setValue]);

    useEffect(() => {
        detectReferral();
    }, [detectReferral]);

    /* ==========================================
     * SESSION CHECK
     * ========================================== */
    useEffect(() => {
        let mounted = true;

        async function checkSession() {
            try {
                const session = await getSession();
                if (!mounted) return;
                if (session?.user) {
                    setAlreadyLoggedIn(true);
                }
            } catch (error) {
                console.error("CHECK REGISTER SESSION ERROR:", error);
            } finally {
                if (mounted) {
                    setCheckingSession(false);
                }
            }
        }

        checkSession();
        return () => { mounted = false; };
    }, []);

    /* ==========================================
     * HANDLERS
     * ========================================== */
    async function handleLogout() {
        try {
            setLoading(true);
            await signOut({ redirect: false });
            toast.success("Berhasil logout.");
            setAlreadyLoggedIn(false);
            router.refresh();
        } catch (error) {
            console.error("LOGOUT ERROR:", error);
            toast.error("Gagal logout.");
        } finally {
            setLoading(false);
        }
    }

    function handleOverrideReferral() {
        setReferralOverride(true);
        setReferralDetected(false);
        // Keep the current value but allow editing
        setValue("referralCode", watchedReferralCode || "");
    }

    function handleCancelOverride() {
        if (referralCode) {
            setReferralOverride(false);
            setReferralDetected(true);
            setValue("referralCode", referralCode);
        }
    }

    async function onSubmit(data: RegisterInput) {
        try {
            setLoading(true);
            await register(data);
            toast.success("Register berhasil");

            const identifier =
                data.email?.trim() || data.phone?.trim();

            await signIn("credentials", {
                identifier,
                password: data.password,
                redirect: false,
            });

            router.push("/home");
        } catch (error: any) {
            toast.error(
                error?.response?.data?.message ??
                "Terjadi kesalahan."
            );
            // NOTE: referralCode is NOT cleared on error
            // react-hook-form preserves form values on submit error
        } finally {
            setLoading(false);
        }
    }

    /* ==========================================
     * LOADING STATE
     * ========================================== */
    if (checkingSession) {
        return (
            <section className="flex min-h-screen items-center justify-center bg-gradient-to-b from-ink-50 via-white to-brand-50 px-5 py-10">
                <div className="w-full max-w-md rounded-3xl border border-gray-100 bg-white p-8 text-center shadow-xl">
                    <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-100">
                        <span className="text-3xl">🔐</span>
                    </div>
                    <h1 className="text-2xl font-bold text-ink-900">
                        Memeriksa sesi...
                    </h1>
                    <p className="mt-2 text-sm text-gray-500">
                        Tunggu sebentar.
                    </p>
                </div>
            </section>
        );
    }

    /* ==========================================
     * ALREADY LOGGED IN
     * ========================================== */
    if (alreadyLoggedIn) {
        return (
            <section className="flex min-h-screen items-center justify-center bg-gradient-to-b from-ink-50 via-white to-brand-50 px-5 py-10">
                <div className="w-full max-w-md rounded-3xl border border-gray-100 bg-white p-8 text-center shadow-xl">
                    <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-100">
                        <span className="text-3xl">⚠️</span>
                    </div>
                    <h1 className="text-2xl font-bold text-ink-900">
                        Kamu Sudah Login
                    </h1>
                    <p className="mt-3 text-sm leading-6 text-gray-500">
                        Kamu tidak dapat membuat akun baru
                        saat masih login.
                        <br />
                        Silakan logout terlebih dahulu.
                    </p>
                    <div className="mt-6 space-y-3">
                        <button
                            type="button"
                            onClick={handleLogout}
                            disabled={loading}
                            className="flex h-12 w-full items-center justify-center rounded-xl bg-brand-600 font-semibold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {loading ? "Logout..." : "Logout Terlebih Dahulu"}
                        </button>
                        <button
                            type="button"
                            onClick={() => router.back()}
                            className="flex h-12 w-full items-center justify-center rounded-xl border border-gray-300 bg-white font-semibold text-gray-700 transition hover:bg-gray-50"
                        >
                            Kembali
                        </button>
                    </div>
                </div>
            </section>
        );
    }

    /* ==========================================
     * RENDER FORM
     * ========================================== */
    const showAutoDetected = referralDetected && !referralOverride && !referralLoading;
    const showManualInput = !referralDetected || referralOverride || referralLoading;

    return (
        <section className="flex min-h-screen items-center justify-center bg-gradient-to-b from-ink-50 via-white to-brand-50 px-5 py-10">
            <div className="w-full max-w-md rounded-3xl border border-gray-100 bg-white p-8 shadow-xl">
                <Link
                    href="/"
                    className="mb-6 inline-flex items-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50"
                >
                    <FaArrowLeft className="text-xs" />
                    Kembali ke Beranda
                </Link>

                <div className="mb-8 text-center">
                    <div className="mb-6 flex justify-center">
                        <Brand />
                    </div>
                    <h1 className="text-3xl font-bold text-ink-900">
                        Buat Akun
                    </h1>
                    <p className="mt-2 text-sm leading-6 text-gray-500">
                        Daftar sekarang untuk membeli tiket,
                        mengelola pesanan, dan mengikuti event favoritmu.
                    </p>
                </div>

                <form
                    onSubmit={handleSubmit(onSubmit)}
                    className="space-y-5"
                >
                    {/* Nama */}
                    <div>
                        <label className="mb-2 block text-sm font-medium text-gray-700">
                            Nama Lengkap
                        </label>
                        <div className="relative">
                            <FaUser className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                            <input
                                {...formRegister("name")}
                                placeholder="Masukkan nama lengkap"
                                className="h-12 w-full rounded-xl border border-gray-300 bg-white pl-11 pr-4 text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none"
                            />
                        </div>
                        {errors.name && (
                            <p className="mt-1 text-xs text-red-500">
                                {errors.name.message}
                            </p>
                        )}
                    </div>

                    {/* Email */}
                    <div>
                        <label className="mb-2 block text-sm font-medium text-gray-700">
                            Email
                        </label>
                        <div className="relative">
                            <FaEnvelope className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                            <input
                                type="email"
                                {...formRegister("email")}
                                placeholder="Masukkan email"
                                className="h-12 w-full rounded-xl border border-gray-300 bg-white pl-11 pr-4 text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none"
                            />
                        </div>
                        {errors.email && (
                            <p className="mt-1 text-xs text-red-500">
                                {errors.email.message}
                            </p>
                        )}
                    </div>

                    {/* Nomor HP */}
                    <div>
                        <label className="mb-2 block text-sm font-medium text-gray-700">
                            Nomor HP
                        </label>
                        <div className="relative">
                            <FaPhone className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                            <input
                                {...formRegister("phone")}
                                placeholder="08xxxxxxxxxx"
                                className="h-12 w-full rounded-xl border border-gray-300 bg-white pl-11 pr-4 text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none"
                            />
                        </div>
                        {errors.phone && (
                            <p className="mt-1 text-xs text-red-500">
                                {errors.phone.message}
                            </p>
                        )}
                    </div>

                    {/* Password */}
                    <div>
                        <label className="mb-2 block text-sm font-medium text-gray-700">
                            Password
                        </label>
                        <div className="relative">
                            <FaLock className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                            <input
                                type={showPassword ? "text" : "password"}
                                {...formRegister("password")}
                                placeholder="Masukkan password"
                                className="h-12 w-full rounded-xl border border-gray-300 bg-white pl-11 pr-10 text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none"
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword(!showPassword)}
                                className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500"
                            >
                                {showPassword ? <FaEyeSlash /> : <FaEye />}
                            </button>
                        </div>
                        {errors.password && (
                            <p className="mt-1 text-xs text-red-500">
                                {errors.password.message}
                            </p>
                        )}
                    </div>

                    {/* Konfirmasi Password */}
                    <div>
                        <label className="mb-2 block text-sm font-medium text-gray-700">
                            Konfirmasi Password
                        </label>
                        <div className="relative">
                            <FaLock className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                            <input
                                type={showConfirmPassword ? "text" : "password"}
                                {...formRegister("confirmPassword")}
                                placeholder="Ulangi password"
                                className="h-12 w-full rounded-xl border border-gray-300 bg-white pl-11 pr-10 text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none"
                            />
                            <button
                                type="button"
                                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                                className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500"
                            >
                                {showConfirmPassword ? <FaEyeSlash /> : <FaEye />}
                            </button>
                        </div>
                        {errors.confirmPassword && (
                            <p className="mt-1 text-xs text-red-500">
                                {errors.confirmPassword.message}
                            </p>
                        )}
                    </div>

                    {/* ==========================================
                        REFERRAL CODE
                        ========================================== */}
                    <div>
                        <label className="mb-2 block text-sm font-medium text-gray-700">
                            Kode Referral{" "}
                            <span className="text-gray-400">(Opsional)</span>
                        </label>

                        {/* Auto-detected referral — read-only badge */}
                        {showAutoDetected && referralCode && (
                            <div className="space-y-2">
                                <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                                    <FaCheck className="text-emerald-500" />
                                    <span className="flex-1 text-sm font-medium text-emerald-700">
                                        {referralCode}
                                    </span>
                                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-600">
                                        Otomatis
                                    </span>
                                </div>
                                <p className="flex items-center gap-1.5 text-xs text-emerald-600">
                                    <span>✅</span>
                                    <span>
                                        Referral dari affiliator{" "}
                                        <strong>{referralCode}</strong>{" "}
                                        terdeteksi otomatis.
                                    </span>
                                </p>
                                <button
                                    type="button"
                                    onClick={handleOverrideReferral}
                                    className="flex items-center gap-1.5 text-xs text-gray-400 transition hover:text-gray-600"
                                >
                                    <FaEdit className="text-[10px]" />
                                    Gunakan kode referral lain
                                </button>

                                {/* Hidden input to ensure value is submitted */}
                                <input
                                    type="hidden"
                                    {...formRegister("referralCode")}
                                    value={referralCode}
                                />
                            </div>
                        )}

                        {/* Manual input — shown when no referral, loading, or overriding */}
                        {showManualInput && (
                            <div className="space-y-2">
                                <div className="relative">
                                    <FaGift className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                                    <input
                                        {...formRegister("referralCode")}
                                        placeholder="Masukkan kode referral"
                                        readOnly={referralLoading}
                                        className="h-12 w-full rounded-xl border border-gray-300 bg-white pl-11 pr-4 text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none"
                                    />
                                </div>

                                {referralLoading && (
                                    <p className="flex items-center gap-1.5 text-xs text-gray-400">
                                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
                                        <span>Mendeteksi referral...</span>
                                    </p>
                                )}

                                {referralOverride && referralCode && (
                                    <button
                                        type="button"
                                        onClick={handleCancelOverride}
                                        className="flex items-center gap-1.5 text-xs text-gray-400 transition hover:text-gray-600"
                                    >
                                        ← Kembali ke kode referral{" "}
                                        <strong>{referralCode}</strong>
                                    </button>
                                )}
                            </div>
                        )}

                        {errors.referralCode && (
                            <p className="mt-1 text-xs text-red-500">
                                {errors.referralCode.message}
                            </p>
                        )}
                    </div>

                    {/* Button Register */}
                    <button
                        type="submit"
                        disabled={loading}
                        className="flex h-12 w-full items-center justify-center rounded-xl bg-brand-600 font-semibold text-white transition-all duration-200 hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {loading ? (
                            <div className="flex items-center gap-2">
                                <svg
                                    className="h-5 w-5 animate-spin"
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                >
                                    <circle
                                        className="opacity-30"
                                        cx="12"
                                        cy="12"
                                        r="10"
                                        stroke="currentColor"
                                        strokeWidth="4"
                                    />
                                    <path
                                        className="opacity-100"
                                        fill="currentColor"
                                        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                                    />
                                </svg>
                                <span>Memproses...</span>
                            </div>
                        ) : (
                            "Buat Akun"
                        )}
                    </button>

                    {/* Divider */}
                    <div className="flex items-center py-2">
                        <div className="h-px flex-1 bg-gray-200" />
                        <span className="mx-4 text-sm text-gray-400">atau</span>
                        <div className="h-px flex-1 bg-gray-200" />
                    </div>

                    {/* Google Login */}
                    <button
                        type="button"
                        onClick={() =>
                            signIn("google", {
                                callbackUrl: "/home",
                            })
                        }
                        className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-gray-300 bg-white font-medium text-gray-700 transition hover:bg-gray-50"
                    >
                        <img
                            src="https://www.svgrepo.com/show/475656/google-color.svg"
                            alt="Google"
                            className="h-5 w-5"
                        />
                        Lanjutkan dengan Google
                    </button>

                    {/* Footer */}
                    <div className="pt-3 text-center text-sm text-gray-600">
                        Sudah punya akun?{" "}
                        <Link
                            href="/login"
                            className="ml-1 font-semibold text-brand-600 hover:underline"
                        >
                            Masuk
                        </Link>
                    </div>
                </form>
            </div>
        </section>
    );
}
