"use client";

import { useEffect, useState } from "react";
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

export default function ReservationCountdown({ expiresAt }: Props) {
    const router = useRouter();

    const [mounted, setMounted] = useState(false);
    const [remainingMs, setRemainingMs] = useState<number | null>(null);

    useEffect(() => {
        const deadline = new Date(expiresAt).getTime();

        setMounted(true);
        setRemainingMs(deadline - Date.now());

        const timer = setInterval(() => {
            const next = deadline - Date.now();

            setRemainingMs(next);

            if (next <= 0) {
                clearInterval(timer);
                // Revalidate against the server. This is a read, never a release.
                router.refresh();
            }
        }, 1000);

        return () => clearInterval(timer);
    }, [expiresAt, router]);

    if (!mounted || remainingMs === null) {
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
        // expired state below is announced.
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
