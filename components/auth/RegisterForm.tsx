"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

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
    FaArrowLeft,
} from "react-icons/fa";

import {
    registerSchema,
    RegisterInput,
} from "@/lib/validations/register";

import { register } from "@/lib/services/auth";

/**
 * ==========================================
 * CUSTOMER REGISTRATION
 * ==========================================
 *
 * The retail affiliate "Kode Referral" section was removed with the affiliate system. Ticking PIC
 * attribution is recorded per event order, not on the account, so nothing about it belongs on this
 * form. What remains is exactly the information required to create a buyer account: name, email,
 * phone and password.
 */
export default function RegisterForm() {
    const router = useRouter();

    const [checkingSession, setCheckingSession] =
        useState(true);

    const [alreadyLoggedIn, setAlreadyLoggedIn] =
        useState(false);

    const [loading, setLoading] = useState(false);

    const [showPassword, setShowPassword] = useState(false);

    const [showConfirmPassword, setShowConfirmPassword] = useState(false);

    const {
        register: formRegister,
        handleSubmit,
        formState: { errors },
    } = useForm<RegisterInput>({
        resolver: zodResolver(registerSchema),
    });

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

            router.push("/");
        } catch (error: unknown) {
            const message =
                (
                    error as {
                        response?: { data?: { message?: string } };
                    }
                )?.response?.data?.message ??
                "Terjadi kesalahan.";

            toast.error(message);
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
                        menyimpan e-tiket, dan mengikuti event favoritmu.
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
                                callbackUrl: "/",
                            })
                        }
                        className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-gray-300 bg-white font-medium text-gray-700 transition hover:bg-gray-50"
                    >
                        <img
                            src="https://www.svgrepo.com/show/445645/google-color.svg"
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
