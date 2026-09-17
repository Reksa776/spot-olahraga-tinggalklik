"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * ==========================================
 * CANCEL UNPAID ORDER (design §26.4)
 * ==========================================
 *
 * Posts to `/api/ticketing/orders/{orderNumber}/cancel`, which is ownership-scoped
 * server-side and releases the reservations in the same transaction as the status
 * change. The browser supplies no reason and no order id beyond the URL — `orderNumber`
 * is data, and the server resolves ownership from the session (brief §14).
 *
 * (The path is namespaced because the live retail tree owns `/api/orders/**`; see
 * `app/api/ticketing/checkout/route.ts`.)
 *
 * The CSRF control is the Phase 3 same-origin check on the server; a browser sends
 * `Origin` automatically for a same-origin fetch, so nothing has to be added here, and
 * adding a client-side token would not strengthen it.
 */

type Props = { orderNumber: string };

export default function CancelOrderButton({ orderNumber }: Props) {
    const router = useRouter();

    const [confirming, setConfirming] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function cancel() {
        setSubmitting(true);
        setError(null);

        try {
            const response = await fetch(
                `/api/ticketing/orders/${encodeURIComponent(orderNumber)}/cancel`,
                { method: "POST" }
            );

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                setError(
                    payload?.message ??
                        "Pesanan tidak dapat dibatalkan saat ini."
                );
                return;
            }

            // The server response is authoritative; refresh so the page shows the
            // released state rather than a locally assumed one.
            setConfirming(false);
            router.refresh();
        } catch {
            setError("Koneksi terputus. Silakan coba lagi.");
        } finally {
            setSubmitting(false);
        }
    }

    if (!confirming) {
        return (
            <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-500 transition hover:text-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
            >
                Batalkan pesanan
            </button>
        );
    }

    return (
        <div className="w-full space-y-3 rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-semibold text-red-800">
                Batalkan pesanan ini? Tiket yang ditahan akan dilepas kembali ke
                penjualan dan tidak dapat dikembalikan.
            </p>

            {error ? (
                <p
                    role="alert"
                    className="rounded-lg border border-red-300 bg-white px-3.5 py-2.5 text-sm font-medium text-red-700"
                >
                    {error}
                </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={cancel}
                    disabled={submitting}
                    className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:text-ink-500"
                >
                    {submitting ? "Membatalkan…" : "Ya, batalkan"}
                </button>
                <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={submitting}
                    className="rounded-xl border border-ink-200 bg-white px-4 py-2.5 text-sm font-semibold text-ink-700 transition hover:border-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900 disabled:cursor-not-allowed"
                >
                    Tidak
                </button>
            </div>
        </div>
    );
}
