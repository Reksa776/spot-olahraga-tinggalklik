import type { ReactNode } from "react";
import Link from "next/link";

/**
 * ==========================================
 * ERROR STATE (the one error surface)
 * ==========================================
 *
 * Every "something went wrong" screen in the application renders this. It is deliberately
 * SERVER-SAFE and hook-free, so the same component can be used by
 *
 *   • a server page that classified a failure (`app/not-found.tsx`, the wallet pages),
 *   • a route `error.tsx` boundary (a client component), and
 *   • a route-level `loading`/inline failure block.
 *
 * ── WHAT IT MUST NEVER SHOW ─────────────────────────────────────────────────────
 * No stack trace. No SQL. No Prisma internals. No filesystem path. No secret. No payment
 * signature. Those belong in the server log, correlated by `reference` — which is the one
 * technical detail that is safe and useful to surface, because it is an opaque id whose
 * only meaning lives in our logs.
 *
 * ── WHAT A USER-FACING ERROR MUST ALWAYS OFFER ──────────────────────────────────
 * A next step. An error screen with no way forward is where a purchase journey is
 * abandoned, so `actions` is the point of this component and the copy is written to be
 * honest about what happened rather than to apologise.
 *
 * ── TONE ────────────────────────────────────────────────────────────────────────
 * `warning` is the default because most failures here are transient ("coba lagi"); `danger`
 * is reserved for a refusal the user cannot retry, and `info` for a state the user needs
 * to understand rather than act on (a session that ended).
 */

const TONE = {
    warning: {
        ring: "border-amber-200 bg-amber-50",
        chip: "bg-amber-100 text-amber-700",
        glyph: "!",
    },
    danger: {
        ring: "border-rose-200 bg-rose-50",
        chip: "bg-rose-100 text-rose-700",
        glyph: "×",
    },
    info: {
        ring: "border-ink-200 bg-ink-50",
        chip: "bg-ink-200/70 text-ink-700",
        glyph: "i",
    },
} as const;

export type ErrorStateAction = {
    href: string;
    label: ReactNode;
    variant?: "primary" | "secondary";
};

export function ErrorState({
    title,
    description,
    tone = "warning",
    reference,
    actions = [],
    children,
    /** Renders without the outer card, for use inside an existing panel. */
    flush = false,
}: {
    title: string;
    description?: ReactNode;
    tone?: keyof typeof TONE;
    /** Opaque support code. Safe to display: it is ours, and it is not a secret. */
    reference?: string;
    actions?: readonly ErrorStateAction[];
    /** Extra actions that need to be client components (e.g. a retry that calls `reset`). */
    children?: ReactNode;
    flush?: boolean;
}) {
    const palette = TONE[tone];

    const body = (
        <div className="flex flex-col items-center gap-4 text-center">
            <span
                aria-hidden
                className={`grid h-12 w-12 place-items-center rounded-full text-lg font-bold ${palette.chip}`}
            >
                {palette.glyph}
            </span>

            <h2 className="text-lg font-extrabold tracking-tight text-ink-900">{title}</h2>

            {description ? (
                <div className="max-w-md text-sm leading-relaxed text-ink-600">
                    {description}
                </div>
            ) : null}

            {reference ? (
                <p className="rounded-lg bg-white/70 px-3 py-1.5 font-mono text-xs text-ink-500">
                    Kode referensi: {reference}
                </p>
            ) : null}

            {actions.length > 0 || children ? (
                <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
                    {actions.map((action) => (
                        <Link
                            key={`${action.href}:${String(action.label)}`}
                            href={action.href}
                            className={
                                action.variant === "secondary"
                                    ? "rounded-xl px-4 py-2.5 text-sm font-semibold text-ink-600 transition hover:text-ink-900"
                                    : "rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-ink-800"
                            }
                        >
                            {action.label}
                        </Link>
                    ))}

                    {children}
                </div>
            ) : null}
        </div>
    );

    if (flush) {
        return <div className="px-6 py-12">{body}</div>;
    }

    return (
        <div
            className={`rounded-2xl border px-6 py-12 ${palette.ring}`}
            role="alert"
            data-error-state
        >
            {body}
        </div>
    );
}

export default ErrorState;
