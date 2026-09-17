"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * ==========================================
 * REFRESH ORDER STATUS (brief §21/§22)
 * ==========================================
 *
 * Re-renders the server component, which re-reads `EventOrder.paymentStatus` from the
 * database. That is the ONLY way this page ever learns that a payment succeeded.
 *
 * Deliberately not a client-side "check payment" call: design §31.5 rule 3 makes the
 * verified provider notification the single settlement trigger, and design §26.7 says the
 * polling surface "is explicitly documented as not being an issuance trigger ... If it ever
 * returned 'paid' derived from anything other than the order row, it would become a forgery
 * vector." So this button performs no mutation and reads no gateway — it just asks the
 * server for the current truth.
 *
 * The buyer sees this after returning from the provider's page, because a redirect carries
 * no authority over payment state (brief §22: do not trust `?status=paid` and friends).
 */

type Props = {
    /** Optional label override, so the same control can sit in different panels. */
    label?: string;
};

export default function RefreshOrderStatus({
    label = "Perbarui status",
}: Props) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [clicked, setClicked] = useState(false);

    return (
        <div className="space-y-1">
            <button
                type="button"
                onClick={() => {
                    setClicked(true);
                    startTransition(() => {
                        router.refresh();
                    });
                }}
                disabled={pending}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:bg-gray-100"
            >
                {pending ? "Memperbarui…" : label}
            </button>

            {clicked && !pending ? (
                <p className="text-xs text-gray-500" aria-live="polite">
                    Status diperbarui dari server. Jika pembayaran Anda belum
                    tercatat, tunggu beberapa saat lalu perbarui lagi.
                </p>
            ) : null}
        </div>
    );
}
