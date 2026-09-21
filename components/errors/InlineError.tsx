import type { ReactNode } from "react";

/**
 * ==========================================
 * INLINE ERROR
 * ==========================================
 *
 * The small, local error for a form field group, a single widget or one card — as opposed
 * to `ErrorState`, which replaces a whole region.
 *
 * ── WHY IT IS NOT A TOAST ───────────────────────────────────────────────────────
 * A toast disappears. For a field error or a widget that failed, the message has to stay
 * next to the thing that failed, be reachable by a screen reader after the fact, and be
 * still there when the user looks back. Toasts are for confirmations.
 *
 * ── ACCESSIBILITY ───────────────────────────────────────────────────────────────
 * `role="alert"` makes assistive technology announce the text the moment it appears, which
 * is exactly right for a failure the user just triggered. It is NOT used for anything
 * static: an alert that renders on load is noise.
 */
export function InlineError({
    children,
    /** Stable code, rendered small and mono so support can quote it. */
    code,
    className = "",
}: {
    children: ReactNode;
    code?: string;
    className?: string;
}) {
    return (
        <p
            role="alert"
            className={`rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-relaxed text-rose-700 ${className}`}
        >
            {children}
            {code ? (
                <span className="ml-1 font-mono text-xs text-rose-500/80">[{code}]</span>
            ) : null}
        </p>
    );
}

export default InlineError;
