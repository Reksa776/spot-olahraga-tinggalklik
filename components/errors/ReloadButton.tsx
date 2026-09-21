"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * ==========================================
 * RELOAD BUTTON
 * ==========================================
 *
 * The retry for a SERVER page. `RetryButton` calls an error boundary's `reset()`; a server
 * component has no `reset`, so the honest equivalent is re-running the server render —
 * `router.refresh()` — which re-executes the page (and therefore re-runs the query that
 * failed) without a full browser reload, and without losing scroll position.
 *
 * ── WHY IT EXISTS AT ALL ────────────────────────────────────────────────────────
 * A retryable error state with no retry is a dead end. This is the control that turns
 * "Terjadi gangguan sementara" from a report into an action, and it is the thing the
 * previous behaviour never offered, because a database outage used to be rendered as a 404
 * page whose only suggestion was to check the URL.
 *
 * `useTransition` gives the pending state for free: React keeps the current tree interactive
 * while the refresh is in flight, so the button can disable itself and say so without a
 * second piece of state to keep in sync.
 */
export function ReloadButton({
    label = "Coba lagi",
    secondary = false,
}: {
    label?: string;
    secondary?: boolean;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();

    return (
        <button
            type="button"
            disabled={pending}
            onClick={() => {
                startTransition(() => {
                    router.refresh();
                });
            }}
            className={
                secondary
                    ? "rounded-xl border border-ink-200 bg-white px-4 py-2.5 text-sm font-semibold text-ink-700 transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-60"
                    : "rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-60"
            }
        >
            {pending ? "Memuat…" : label}
        </button>
    );
}

export default ReloadButton;
