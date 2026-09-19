"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

/**
 * ==========================================
 * RESERVATION COUNTDOWN (design §11.4, brief §26)
 * ==========================================
 *
 * Brief §26 is precise about what this component may and may not do:
 *
 *   "If the design defines a reservation expiry visible to the customer: display the
 *    **server-derived** expiry timestamp. Do not trust the browser timer as the source
 *    of truth. When the countdown reaches zero: frontend must refresh/revalidate server
 *    state. Do not release inventory merely because a browser timer reached zero.
 *    Server-side state controls the reservation."
 *
 * So:
 *
 *   - the deadline is the `expiresAt` **string the server returned** (§11.4's
 *     `now + TTL`), not a duration computed here;
 *   - reaching zero calls `router.refresh()`, which re-renders the server component and
 *     re-reads the order from the database — the authoritative state;
 *   - reaching zero calls **no** mutation endpoint. A tab left open on a laptop that
 *     was asleep for an hour must not be able to release seats, and the browser clock
 *     is trivially manipulable. Expiry is the reaper's job (server-side).
 *
 * The remaining time is rendered only after mount, because the server and the browser
 * would otherwise disagree on "now" by a few hundred milliseconds and React would report
 * a hydration mismatch on the very first paint.
 *
 * ── WHY THE CLOCK IS A `useSyncExternalStore` (PHASE 11) ──────────────────────────
 * This used to call `setState` synchronously inside the effect body and read `Date.now()`
 * during render. Both are flagged by the React 19 rules: a synchronous `setState` in an
 * effect triggers a cascading render, and reading the clock during render is impure.
 * The clock is an EXTERNAL SYSTEM, which is exactly what `useSyncExternalStore` models:
 * `Date.now()` is read in the snapshot function, the subscription is a one-second
 * interval, and the server snapshot is `null` so the first paint is the placeholder and
 * hydration cannot mismatch. Behaviour is unchanged — still server-derived deadline,
 * still `router.refresh()` at zero, still no mutation.
 */

type Props = {
    /** ISO-8601 instant from the server (`EventOrder.expiresAt`). */
    expiresAt: string;
};

function formatRemaining(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Cached per whole second so repeated `getSnapshot` reads within one render are stable —
 * a snapshot that changed on every read would make React warn and could loop.
 */
let cachedSecond = -1;
let cachedSecondStart = 0;

function secondSnapshot(): number {
    const second = Math.floor(Date.now() / 1000);

    if (second !== cachedSecond) {
        cachedSecond = second;
        cachedSecondStart = second * 1000;
    }

    return cachedSecondStart;
}

/** Server snapshot: `null` means "not mounted yet", which renders the placeholder. */
function serverClockSnapshot(): number | null {
    return null;
}

function subscribeToSecond(onStoreChange: () => void): () => void {
    const timer = setInterval(onStoreChange, 1000);

    return () => clearInterval(timer);
}

export default function ReservationCountdown({ expiresAt }: Props) {
    const router = useRouter();

    // `null` during SSR/first paint, the current epoch-second on the client afterwards.
    const now = useSyncExternalStore(
        subscribeToSecond,
        secondSnapshot,
        serverClockSnapshot
    );

    const deadline = new Date(expiresAt).getTime();
    const remainingMs = now === null ? null : deadline - now;

    // Refresh the server component ONCE when the deadline is reached. A ref keyed to the
    // deadline prevents the still-ticking interval from calling `router.refresh()` every
    // second after expiry.
    const refreshedForRef = useRef<string | null>(null);

    useEffect(() => {
        if (
            remainingMs !== null &&
            remainingMs <= 0 &&
            refreshedForRef.current !== expiresAt
        ) {
            refreshedForRef.current = expiresAt;
            // Revalidate against the server. This is a read, never a release.
            router.refresh();
        }
    }, [remainingMs, expiresAt, router]);

    if (remainingMs === null) {
        return (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-xs font-bold tracking-wide text-amber-700 uppercase">
                    Sisa waktu pembayaran
                </p>
                <p className="mt-1 font-mono text-xl font-extrabold text-amber-900">
                    —:—
                </p>
            </div>
        );
    }

    if (remainingMs <= 0) {
        return (
            <div
                role="status"
                aria-live="polite"
                className="rounded-2xl border border-ink-200 bg-ink-50 px-4 py-3"
            >
                <p className="text-sm font-bold text-ink-700">
                    Waktu pembayaran sudah habis.
                </p>
                <p className="mt-0.5 text-xs text-ink-500">
                    Memperbarui status pesanan…
                </p>
            </div>
        );
    }

    const urgent = remainingMs <= 5 * 60 * 1000;

    return (
        // `role="timer"` is a live region with `aria-live="off"` by default, which is
        // exactly right: a countdown announced every second is unusable. Only the
        // expired state above is announced.
        <div
            role="timer"
            className={`rounded-2xl border px-4 py-3 ${
                urgent
                    ? "border-red-200 bg-red-50"
                    : "border-amber-200 bg-amber-50"
            }`}
        >
            <p
                className={`text-xs font-bold tracking-wide uppercase ${
                    urgent ? "text-red-700" : "text-amber-700"
                }`}
            >
                Sisa waktu pembayaran
            </p>
            <p
                className={`mt-1 font-mono text-xl font-extrabold ${
                    urgent ? "text-red-800" : "text-amber-900"
                }`}
            >
                {formatRemaining(remainingMs)}
            </p>
            <p className="mt-0.5 text-xs text-ink-500">
                Tiket ditahan sampai waktu ini habis.
            </p>
        </div>
    );
}
