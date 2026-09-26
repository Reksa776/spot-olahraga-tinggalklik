"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { getSession, signIn, signOut } from "next-auth/react";
import toast from "react-hot-toast";

import AuthError from "@/components/auth/AuthError";
import LoginShell from "@/components/auth/LoginShell";
import GoogleMark from "@/components/auth/GoogleMark";
import PasswordField from "@/components/auth/PasswordField";
import Brand from "@/components/Brand";
import { register as registerAccount } from "@/lib/services/auth";
import {
    registerSchema,
    type RegisterInput,
} from "@/lib/validations/register";
// Type-only: erased at build time, so this client component pulls in no server code.
import type { ApplicationBranding } from "@/lib/app-settings";

/**
 * ==========================================
 * CUSTOMER REGISTRATION
 * ==========================================
 *
 * The public sign-up. It creates a CUSTOMER — always. The form has no role control because
 * the endpoint has no role parameter: `app/api/auth/register/route.ts` builds the `User` row
 * from an explicit allow-list of four fields and sets `platformRole: "CUSTOMER"` itself.
 * A request that sends `{ platformRole: "ADMIN" }` is ignored, and there is a test that
 * proves it (`__tests__/auth-flow/register-customer-only.test.ts`).
 *
 * ── THE FIELDS, AND WHY ─────────────────────────────────────────────────────────
 *   name      required — a ticket is issued to a person
 *   email     optional, but one of email/phone is required (`registerSchema`)
 *   phone     optional, same rule — the buyer's own domain requires an identifier
 *   password  required, with `confirmPassword` — see `registerSchema` for the policy
 *
 * The retail "Kode Referral" field was removed with the affiliate programme; ticketing PIC
 * attribution is recorded per order, never on the account.
 *
 * ── ERROR HANDLING ──────────────────────────────────────────────────────────────
 * Three distinct outcomes, three distinct treatments:
 *
 *   • FIELD errors from `registerSchema` render under their own field, wired through
 *     `aria-describedby` by `PasswordField` and `react-hook-form`'s `aria-invalid`.
 *   • SERVER refusals (duplicate account, weak password, rate limited) render as a single
 *     `AuthError` with the server's own safe Indonesian sentence, which the API envelope
 *     puts in `message`.
 *   • UNEXPECTED failures render a generic retry sentence. The raw error is never shown:
 *     it could carry a database string, and the user cannot act on it anyway.
 *
 * Duplicate accounts are reported as a conflict by the endpoint rather than silently
 * succeeding, because a "we sent you an email" white lie on a system with no mailer would
 * leave the visitor waiting forever. The enumeration trade-off is documented at the route.
 */

/** Where a freshly created CUSTOMER lands. Their own surface, and gated server-side. */
const POST_REGISTER_PATH = "/ticketing/tickets";

export default function RegisterForm({
    branding,
}: {
    /**
     * The DB-resolved application branding, read SERVER-SIDE by `app/register/page.tsx` and
     * handed down. The sign-up screen therefore paints the SAME configured logo and name as
     * the sign-in screen, in the first HTML frame — no client fetch, no blank-logo flash.
     */
    branding: ApplicationBranding;
}) {
    const router = useRouter();

    const [alreadyLoggedIn, setAlreadyLoggedIn] = useState(false);
    const [loading, setLoading] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);

    const {
        register: field,
        handleSubmit,
        formState: { errors },
    } = useForm<RegisterInput>({
        resolver: zodResolver(registerSchema),
        // Validate on blur, not on every keystroke: shouting "password must contain a
        // number" at someone halfway through typing it is noise, not help.
        mode: "onBlur",
    });

    /* ==========================================
     * SESSION CHECK
     * ==========================================
     *
     * Runs in the background; the form renders from the first byte. Gating the page behind
     * the check left the server-rendered HTML with nothing but a spinner in it — no fields,
     * no labels, no Brand lockup — so the sign-up form did not exist for a client without
     * JavaScript. The cost is a brief flash of the form for someone who is already signed in,
     * after which the panel below replaces it.
     *
     * ── THIS IS NOW THE FALLBACK, NOT THE GATE ─────────────────────────────────────
     * `app/register/page.tsx` resolves the session SERVER-SIDE and redirects an authenticated
     * visitor to their own surface before any HTML is sent, so the panel below is reached only
     * when a session appeared after this page was delivered. Both paths use the same server
     * scope and the same pure redirect helpers.
     */
    useEffect(() => {
        let mounted = true;

        async function checkSession() {
            try {
                const session = await getSession();

                if (mounted && session?.user) {
                    setAlreadyLoggedIn(true);
                }
            } catch {
                // A failed session check must not block registration: the endpoint
                // authenticates nothing, and the account is created either way. The form is
                // already on screen, so there is nothing to recover from.
            }
        }

        checkSession();

        return () => {
            mounted = false;
        };
    }, []);

    /* ==========================================
     * HANDLERS
     * ========================================== */
    async function handleLogout() {
        try {
            setLoading(true);
            await signOut({ redirect: false });
            toast.success("Berhasil keluar.");
            setAlreadyLoggedIn(false);
            router.refresh();
        } catch {
            toast.error("Gagal keluar. Silakan coba lagi.");
        } finally {
            setLoading(false);
        }
    }

    async function onSubmit(data: RegisterInput) {
        setServerError(null);
        setLoading(true);

        try {
            await registerAccount(data);

            /*
             * Account created. Sign in with the credentials just used, then hand over to the
             * buyer surface. The sign-in result is checked: if it failed (a throttled IP, for
             * instance) the account still exists, so the visitor is sent to login rather than
             * being shown a success screen for a session they do not have.
             */
            const identifier = data.email?.trim() || data.phone?.trim() || "";

            const result = await signIn("credentials", {
                identifier,
                password: data.password,
                redirect: false,
            });

            if (result?.error) {
                toast.success("Akun berhasil dibuat. Silakan masuk.");
                router.push("/login");
                return;
            }

            toast.success("Akun berhasil dibuat. Selamat datang!");
            router.push(POST_REGISTER_PATH);
            router.refresh();
        } catch (error: unknown) {
            setServerError(serverMessage(error));
        } finally {
            setLoading(false);
        }
    }

    /* ==========================================
     * ALREADY SIGNED IN
     * ========================================== */
    if (alreadyLoggedIn) {
        return (
            <LoginShell branding={branding} backHref="/" backLabel="Kembali ke Beranda">
                <div className="text-center">
                    {/* Mobile only: on `lg` the brand panel beside the form renders the lockup. */}
                    <div className="mb-6 flex justify-center lg:hidden">
                        <Brand
                            logoSrc={branding.logoUrl}
                            name={branding.platformName}
                        />
                    </div>

                    <h1 className="text-2xl font-extrabold tracking-tight text-ink-900">
                        Anda sudah masuk
                    </h1>

                    <p className="mt-3 text-sm leading-relaxed text-ink-500">
                        Akun baru tidak dapat dibuat saat Anda masih masuk dengan akun lain.
                        Keluar terlebih dahulu, lalu buat akun Anda.
                    </p>

                    <div className="mt-6 space-y-3">
                        <button
                            type="button"
                            onClick={handleLogout}
                            disabled={loading}
                            className="flex h-12 w-full items-center justify-center rounded-xl bg-brand-600 font-semibold text-white shadow-sm shadow-brand-600/20 transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70"
                        >
                            {loading ? "Keluar…" : "Keluar dari akun ini"}
                        </button>

                        <Link
                            href={POST_REGISTER_PATH}
                            className="flex h-12 w-full items-center justify-center rounded-xl border border-ink-200 bg-white font-semibold text-ink-700 shadow-sm transition hover:border-ink-300 hover:bg-ink-50"
                        >
                            Lanjut ke tiket saya
                        </Link>
                    </div>
                </div>
            </LoginShell>
        );
    }

    /* ==========================================
     * THE FORM
     * ========================================== */
    return (
        <LoginShell
            branding={branding}
            footer={
                <>
                    Sudah punya akun?{" "}
                    <Link
                        href="/login"
                        className="font-semibold text-brand-700 hover:underline"
                    >
                        Masuk
                    </Link>
                </>
            }
        >
            <header className="mb-8 text-center lg:text-left">
                {/* Mobile only: on `lg` the brand panel beside the form renders the lockup. */}
                <div className="mb-6 flex justify-center lg:hidden">
                    <Brand
                        logoSrc={branding.logoUrl}
                        name={branding.platformName}
                    />
                </div>

                <h1 className="text-2xl font-extrabold tracking-tight text-ink-900 sm:text-[1.75rem]">
                    Buat akun pembeli
                </h1>

                <p className="mt-2 text-sm leading-relaxed text-ink-500">
                    Beli tiket, simpan e-tiket, dan lihat riwayat pesanan Anda di satu tempat.
                </p>
            </header>

            <form
                onSubmit={handleSubmit(onSubmit)}
                className="space-y-5"
                noValidate
            >
                {serverError ? <AuthError>{serverError}</AuthError> : null}

                {/* ── Nama ────────────────────────────────────────────────────── */}
                <div>
                    <label
                        htmlFor="register-name"
                        className="mb-2 block text-sm font-semibold text-ink-700"
                    >
                        Nama lengkap
                    </label>

                    <div className="relative">
                        <svg
                            aria-hidden
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-ink-400"
                        >
                            <circle cx="12" cy="8" r="4" />
                            <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" />
                        </svg>

                        <input
                            id="register-name"
                            type="text"
                            autoComplete="name"
                            placeholder="Nama sesuai identitas"
                            disabled={loading}
                            aria-invalid={errors.name ? true : undefined}
                            aria-describedby={errors.name ? "register-name-error" : undefined}
                            {...field("name")}
                            className="h-12 w-full rounded-xl border border-ink-200 bg-white pr-4 pl-11 text-[15px] text-ink-900 transition-[border-color,box-shadow] duration-150 placeholder:text-ink-400 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 focus:outline-none disabled:cursor-not-allowed disabled:bg-ink-50"
                        />
                    </div>

                    {errors.name ? (
                        <p
                            id="register-name-error"
                            role="alert"
                            className="mt-1.5 text-xs text-ink-600"
                        >
                            {errors.name.message}
                        </p>
                    ) : null}
                </div>

                {/* ── Email ───────────────────────────────────────────────────── */}
                <div>
                    <label
                        htmlFor="register-email"
                        className="mb-2 block text-sm font-semibold text-ink-700"
                    >
                        Email{" "}
                        <span className="font-normal text-ink-400">(opsional)</span>
                    </label>

                    <div className="relative">
                        <svg
                            aria-hidden
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-ink-400"
                        >
                            <rect width="18" height="12" x="3" y="5" rx="2" />
                            <path d="m3 7 9 6 9-6" />
                        </svg>

                        <input
                            id="register-email"
                            type="email"
                            autoComplete="email"
                            placeholder="nama@email.com"
                            disabled={loading}
                            aria-invalid={errors.email ? true : undefined}
                            aria-describedby={
                                errors.email ? "register-email-error" : "register-identifier-hint"
                            }
                            {...field("email")}
                            className="h-12 w-full rounded-xl border border-ink-200 bg-white pr-4 pl-11 text-[15px] text-ink-900 transition-[border-color,box-shadow] duration-150 placeholder:text-ink-400 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 focus:outline-none disabled:cursor-not-allowed disabled:bg-ink-50"
                        />
                    </div>

                    {errors.email ? (
                        <p
                            id="register-email-error"
                            role="alert"
                            className="mt-1.5 text-xs text-ink-600"
                        >
                            {errors.email.message}
                        </p>
                    ) : (
                        <p
                            id="register-identifier-hint"
                            className="mt-1.5 text-xs text-ink-400"
                        >
                            Isi email atau nomor HP — minimal salah satu.
                        </p>
                    )}
                </div>

                {/* ── Nomor HP ────────────────────────────────────────────────── */}
                <div>
                    <label
                        htmlFor="register-phone"
                        className="mb-2 block text-sm font-semibold text-ink-700"
                    >
                        Nomor HP{" "}
                        <span className="font-normal text-ink-400">(opsional)</span>
                    </label>

                    <div className="relative">
                        <svg
                            aria-hidden
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-ink-400"
                        >
                            <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.4 2.1L8.1 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.6 2Z" />
                        </svg>

                        <input
                            id="register-phone"
                            type="tel"
                            autoComplete="tel"
                            inputMode="tel"
                            placeholder="08xxxxxxxxxx"
                            disabled={loading}
                            aria-invalid={errors.phone ? true : undefined}
                            aria-describedby={errors.phone ? "register-phone-error" : undefined}
                            {...field("phone")}
                            className="h-12 w-full rounded-xl border border-ink-200 bg-white pr-4 pl-11 text-[15px] text-ink-900 transition-[border-color,box-shadow] duration-150 placeholder:text-ink-400 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 focus:outline-none disabled:cursor-not-allowed disabled:bg-ink-50"
                        />
                    </div>

                    {errors.phone ? (
                        <p
                            id="register-phone-error"
                            role="alert"
                            className="mt-1.5 text-xs text-ink-600"
                        >
                            {errors.phone.message}
                        </p>
                    ) : null}
                </div>

                {/* ── Password ────────────────────────────────────────────────── */}
                {/*
                    ONE input per password field, and it is both the visible control and the
                    one react-hook-form validates: `registration` spreads RHF's
                    `name`/`onChange`/`onBlur`/`ref` straight onto the input `PasswordField`
                    renders. There is no styled twin and no hidden mirror — see the note in
                    `components/auth/PasswordField.tsx` for why that distinction matters.
                */}
                <PasswordField
                    label="Password"
                    registration={field("password")}
                    disabled={loading}
                    autoComplete="new-password"
                    error={errors.password?.message}
                    placeholder="Minimal 8 karakter"
                    hint="Minimal 8 karakter, dengan huruf besar, huruf kecil, dan angka."
                />

                <PasswordField
                    label="Konfirmasi password"
                    registration={field("confirmPassword")}
                    disabled={loading}
                    autoComplete="new-password"
                    error={errors.confirmPassword?.message}
                    placeholder="Ulangi password"
                />

                <button
                    type="submit"
                    disabled={loading}
                    aria-busy={loading}
                    className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 font-semibold text-white shadow-sm shadow-brand-600/20 transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70"
                >
                    {loading ? (
                        <>
                            {/* Same inline spinner as the sign-in button, so the two screens
                                share one loading language. No animation dependency. */}
                            <svg
                                aria-hidden
                                viewBox="0 0 24 24"
                                className="h-4 w-4 animate-spin"
                            >
                                <circle
                                    cx="12"
                                    cy="12"
                                    r="9"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="3"
                                    opacity="0.25"
                                />
                                <path
                                    d="M21 12a9 9 0 0 0-9-9"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="3"
                                    strokeLinecap="round"
                                />
                            </svg>
                            Memproses…
                        </>
                    ) : (
                        "Buat akun"
                    )}
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
                    onClick={() => signIn("google", { callbackUrl: POST_REGISTER_PATH })}
                    disabled={loading}
                    className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-ink-200 bg-white font-semibold text-ink-800 shadow-sm transition hover:border-ink-300 hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {/* Inline, so `img-src` needs no third-party origin on the sign-up page.
                        See `components/auth/GoogleMark.tsx`. */}
                    <GoogleMark />
                    Daftar dengan Google
                </button>

                <p className="pt-1 text-center text-xs leading-relaxed text-ink-400">
                    Dengan membuat akun, Anda menyetujui ketentuan layanan dan kebijakan
                    privasi TinggalKlik.Co.
                </p>
            </form>
        </LoginShell>
    );
}

/**
 * Turn a thrown API failure into a sentence the visitor can act on.
 *
 * The API's error envelope puts a curated Indonesian message in `message`, and that is what
 * is shown — it is written for a user. Anything else (a network drop, a JS failure, a
 * 500 with no envelope) becomes the generic retry sentence, because the real cause is
 * neither safe nor useful to display.
 */
function serverMessage(error: unknown): string {
    const message = (
        error as { response?: { data?: { message?: unknown } } }
    )?.response?.data?.message;

    if (typeof message === "string" && message.trim().length > 0) {
        return message;
    }

    return "Terdaftar gagal karena gangguan sementara. Silakan coba lagi.";
}
