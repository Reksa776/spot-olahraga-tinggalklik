import type { ReactNode } from "react";
import Link from "next/link";

import Brand from "@/components/Brand";
// Type-only: erased at build time, so this module pulls in no server code.
import type { ApplicationBranding } from "@/lib/app-settings";

/**
 * ==========================================
 * LOGIN SHELL — THE FULL-SCREEN AUTH EXPERIENCE
 * ==========================================
 *
 * The frame the SIGN-IN screen sits in. It is intentionally separate from `AuthShell`, which
 * the registration screen still uses: the brief scopes this work to the login surface, so the
 * register page keeps its existing presentation untouched.
 *
 * ── LAYOUT ─────────────────────────────────────────────────────────────────────
 * A two-panel split from `lg` up:
 *
 *   • LEFT (brand panel)  — deep `ink-950` field, the shared `<Brand tone="light" />` lockup,
 *     one headline and three proof points, with a restrained brand glow and a masked grid.
 *     This is what makes the page read as a product rather than an admin template.
 *   • RIGHT (form panel)  — plain white, generous whitespace, and a single `max-w-[26rem]`
 *     column. No card, no heavy shadow: the contrast comes from the panel beside it.
 *
 * Below `lg` the brand panel is removed and the form panel becomes the whole screen, with the
 * shared lockup rendered at the top. Horizontal overflow is impossible because the only flexible
 * axis is a `flex-col`/`flex-row` pair with no fixed side widths below the breakpoint.
 *
 * ── WHY THIS IS A PRESENTATIONAL COMPONENT ──────────────────────────────────────
 * It holds no state and no handlers. It knows nothing about authentication: it renders a
 * frame, a brand lockup and an exit link — no session, no provider, no credentials.
 *
 * ── BRANDING IS PASSED IN, RESOLVED SERVER-SIDE ─────────────────────────────────
 * `branding` is `getApplicationBranding()`'s answer, read by the SERVER page and handed down.
 * The panel therefore paints the configured logo (and configured name) in the first HTML
 * frame — no client fetch, no blank-logo flash. The `Brand` import lives here for the desktop
 * panel and inside the form for the mobile header, so at most one lockup is visible per
 * viewport while the shared component remains the only thing that draws the mark.
 */

/** The three proof points shown beside the form on wide screens. Copy only — no behaviour. */
const PANEL_POINTS = [
    "E-tiket dengan QR yang siap dipindai di pintu masuk",
    "Pembayaran aman dan status pesanan yang jelas",
    "Penjualan dan check-in yang bisa dipantau real-time",
];

export function LoginShell({
    branding,
    children,
    footer,
    backHref = "/",
    backLabel = "Kembali ke Beranda",
}: {
    /** The DB-resolved application branding, read server-side by the page that renders this. */
    branding: ApplicationBranding;
    children: ReactNode;
    /** Below the form: the "belum punya akun?" line. */
    footer?: ReactNode;
    backHref?: string;
    backLabel?: string;
}) {
    return (
        <div className="flex min-h-screen flex-col bg-white lg:flex-row">
            {/* ── BRAND PANEL — desktop only ─────────────────────────────────── */}
            <aside className="relative hidden overflow-hidden bg-ink-950 lg:flex lg:w-[46%] lg:max-w-2xl lg:flex-col lg:justify-between lg:p-12 xl:p-16">
                {/* Decorative only: no content, no meaning. */}
                <div
                    aria-hidden
                    className="login-panel-glow pointer-events-none absolute inset-0"
                />
                <div
                    aria-hidden
                    className="login-panel-grid pointer-events-none absolute inset-0 opacity-[0.08]"
                />

                <div className="relative">
                    <Brand
                        tone="light"
                        logoSrc={branding.logoUrl}
                        name={branding.platformName}
                    />
                </div>

                <div className="relative max-w-md">
                    <h2 className="text-3xl leading-[1.15] font-extrabold tracking-tight text-white xl:text-4xl">
                        Satu akun untuk semua{" "}
                        <span className="text-brand-400">tiket &amp; event</span> Anda.
                    </h2>

                    <p className="mt-4 text-sm leading-relaxed text-ink-200/80">
                        Masuk untuk membeli tiket, memantau penjualan, dan mengelola
                        check-in event dalam satu tempat.
                    </p>

                    <ul className="mt-8 space-y-3">
                        {PANEL_POINTS.map((point) => (
                            <li
                                key={point}
                                className="flex items-start gap-3 text-sm leading-relaxed text-ink-100/90"
                            >
                                <svg
                                    aria-hidden
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="mt-0.5 h-4 w-4 shrink-0 text-brand-400"
                                >
                                    <path d="M20 6 9 17l-5-5" />
                                </svg>
                                {point}
                            </li>
                        ))}
                    </ul>
                </div>

                {/* The configured name, not a literal — same source as the lockup. */}
                <p className="relative truncate text-xs text-ink-400">
                    © {new Date().getFullYear()} {branding.platformName}
                </p>
            </aside>

            {/* ── FORM PANEL ─────────────────────────────────────────────────── */}
            <main className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center justify-end px-5 pt-6 sm:px-8 lg:px-12">
                    {/*
                     * The exit only. The lockup is NOT repeated here on mobile: the form owns
                     * the mobile header (so exactly one mark is visible per viewport), and the
                     * brand panel owns it on desktop.
                     */}
                    <Link
                        href={backHref}
                        className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-ink-500 transition-colors hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                    >
                        <svg
                            aria-hidden
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="h-3.5 w-3.5"
                        >
                            <path d="M19 12H5M12 19l-7-7 7-7" />
                        </svg>
                        {backLabel}
                    </Link>
                </div>

                <div className="flex flex-1 items-center justify-center px-5 py-8 sm:px-8 sm:py-10 lg:px-12">
                    <div className="login-enter w-full max-w-[26rem]">
                        {children}

                        {footer ? (
                            <p className="mt-8 text-center text-sm text-ink-500">
                                {footer}
                            </p>
                        ) : null}
                    </div>
                </div>
            </main>
        </div>
    );
}

export default LoginShell;
