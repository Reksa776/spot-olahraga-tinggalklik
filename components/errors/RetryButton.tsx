"use client";

/**
 * ==========================================
 * RETRY BUTTON
 * ==========================================
 *
 * The one interactive part of an error state: a button that re-runs the failed render.
 *
 * ── WHY IT IS ITS OWN COMPONENT ─────────────────────────────────────────────────
 * `ErrorState` is a server-safe presentational component, and a route `error.tsx` boundary is
 * a CLIENT component whose retry mechanism is the `reset()` function it receives. A
 * `reset`-calling button cannot be written inline in a server page, and duplicating it in
 * every `error.tsx` is how the copy drifts. So the interactive part lives here, takes
 * `onClick` as a function prop (legal, because THIS component is the client one), and
 * `ErrorState` renders it through `children`.
 *
 * ── WHY THE LABELS ARE NOT PROP-DRIVEN ──────────────────────────────────────────
 * "Coba lagi" is the same action everywhere and the wording is part of the design system,
 * so it is fixed here. A caller that needs different wording passes `label`.
 */
export function RetryButton({
    onClick,
    label = "Coba lagi",
    loading = false,
    secondary = false,
}: {
    onClick: () => void;
    label?: string;
    loading?: boolean;
    /** Rendered as the quieter variant, beside a primary "back" action. */
    secondary?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={loading}
            className={
                secondary
                    ? "rounded-xl border border-ink-200 bg-white px-4 py-2.5 text-sm font-semibold text-ink-700 transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-60"
                    : "rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-60"
            }
        >
            {loading ? "Memuat..." : label}
        </button>
    );
}

export default RetryButton;
