"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * ==========================================
 * REQUEST A REFUND (Phase 10B, D-R01/D-R02)
 * ==========================================
 *
 * Posts to `/api/ticketing/refunds` with only the order number. The server resolves the
 * order by the ownership predicate, selects the order's eligible tickets, derives the
 * amount from the purchase-time price snapshots and applies every policy rule — THIS
 * COMPONENT DECIDES NOTHING. A button that computed eligibility here would become a second
 * source of truth for money, which brief §25 forbids.
 *
 * The request is a full refund of the order's tickets (no `ticketIds`). The page only renders
 * this button when every ticket is still `ISSUED`, so the full-request path cannot include a
 * ticket the policy would refuse; a partially spent order is handled by support rather than
 * by offering a button that would fail.
 *
 * The CSRF control is the server's same-origin check; the browser supplies `Origin`
 * automatically for a same-origin fetch, so nothing extra is added here.
 */

type Props = { orderNumber: string };

export default function RequestRefundButton({ orderNumber }: Props) {
    const router = useRouter();

    const [confirming, setConfirming] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function request() {
        setSubmitting(true);
        setError(null);

        try {
            const response = await fetch("/api/ticketing/refunds", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orderNumber }),
            });

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                setError(
                    payload?.message ??
                        "Permintaan refund tidak dapat diajukan saat ini."
                );
                return;
            }

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
                className="rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-500 transition hover:text-rose-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
            >
                Ajukan refund
            </button>
        );
    }

    return (
        <div className="w-full space-y-3 rounded-xl border border-rose-200 bg-rose-50 p-4">
            <p className="text-sm font-semibold text-rose-800">
                Ajukan refund untuk tiket pesanan ini? Pengajuan akan ditinjau
                oleh penyelenggara. Tiket yang sudah check-in tidak dapat
                direfund.
            </p>

            {error ? (
                <p
                    role="alert"
                    className="rounded-lg border border-rose-300 bg-white px-3.5 py-2.5 text-sm font-medium text-rose-700"
                >
                    {error}
                </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={request}
                    disabled={submitting}
                    className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-rose-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:text-ink-500"
                >
                    {submitting ? "Mengajukan…" : "Ya, ajukan refund"}
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
