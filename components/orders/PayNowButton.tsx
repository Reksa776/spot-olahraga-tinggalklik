"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * ==========================================
 * PAY NOW — CREATE OR RESUME A PAYMENT SESSION (design §26.3 / brief §21)
 * ==========================================
 *
 * Posts to `/api/ticketing/orders/{orderNumber}/pay`, which resolves the order from the
 * session (ownership predicate), re-derives every payable condition and every amount from
 * the database, and returns a provider payment URL.
 *
 * ── WHAT THE BROWSER IS NOT ALLOWED TO DECIDE ────────────────────────────────────
 * Brief §25: "Frontend must not be the source of truth for: price, inventory, total,
 * ownership, reservation state." So this component sends **no amount, no total and no
 * currency** — only the payment method the buyer picked, which cannot move money. The
 * server ignores anything else it might send, because the request schema declares no
 * financial field at all.
 *
 * ── THE REDIRECT IS NOT PROOF OF PAYMENT (brief §21/§22) ─────────────────────────
 * The returned URL is the PROVIDER's own hosted page, and navigating to it proves nothing.
 * When the buyer comes back, the order page re-reads the order from the database and the
 * server's `paymentStatus` — never a query parameter like `?status=paid`, which the page
 * ignores. The `Refresh status` button below re-renders the server component for exactly
 * that reason.
 *
 * ── WHEN NO GATEWAY CALL HAPPENS ─────────────────────────────────────────────────
 * Two server-side refusals are surfaced verbatim rather than retried blindly: a zero-value
 * order (the free-ticket settlement path is `D-26 = DECISION REQUIRED`) and a terminal
 * order (repayment pricing is `D-09 = DECISION REQUIRED`). Both come back as a 409 with a
 * machine-readable `details.reason`, and the message from the server is shown.
 */

type PayMethod = "QRIS" | "BANK_TRANSFER" | "E_WALLET";

const METHODS: { value: PayMethod; label: string; hint: string }[] = [
    { value: "QRIS", label: "QRIS", hint: "Scan dengan aplikasi apa pun" },
    {
        value: "BANK_TRANSFER",
        label: "Transfer bank",
        hint: "Virtual account BCA",
    },
    {
        value: "E_WALLET",
        label: "E-wallet",
        hint: "Lewat halaman QRIS penyedia",
    },
];

type Props = {
    orderNumber: string;
    /**
     * The live session's URL, when one already exists. Rendered as a direct continue link
     * so an existing session is resumed rather than re-created (design §30.1 row 2).
     */
    paymentUrl: string | null;
};

export default function PayNowButton({ orderNumber, paymentUrl }: Props) {
    const router = useRouter();

    const [method, setMethod] = useState<PayMethod>("QRIS");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function pay() {
        setSubmitting(true);
        setError(null);

        try {
            const response = await fetch(
                `/api/ticketing/orders/${encodeURIComponent(orderNumber)}/pay`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    // The method is a presentation choice; nothing financial is sent.
                    body: JSON.stringify({ method }),
                }
            );

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                setError(
                    payload?.message ??
                        "Pembayaran tidak dapat dimulai saat ini."
                );
                // The server may have changed state (for example the window elapsed
                // while this tab was open), so re-read the authoritative order.
                router.refresh();
                return;
            }

            const url: string | null = payload?.data?.paymentUrl ?? null;

            if (!url) {
                // A 2xx with no URL means the session could not be handed over. Do not
                // invent one or navigate anywhere (brief §20).
                setError(
                    "Sesi pembayaran belum tersedia. Silakan muat ulang halaman ini."
                );
                router.refresh();
                return;
            }

            // The provider's own hosted page. Its response is informational only.
            window.location.href = url;
        } catch {
            setError("Koneksi terputus. Silakan coba lagi.");
        } finally {
            setSubmitting(false);
        }
    }

    if (paymentUrl) {
        return (
            <div className="space-y-2.5">
                <a
                    href={paymentUrl}
                    className="inline-flex w-full items-center justify-center rounded-xl bg-brand-600 px-5 py-3.5 text-sm font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 sm:w-auto"
                >
                    Lanjutkan pembayaran
                </a>
                <p className="text-xs leading-relaxed text-ink-500">
                    Sesi pembayaran Anda masih aktif. Setelah membayar, kembali ke
                    halaman ini dan tekan &ldquo;Perbarui status&rdquo;.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <fieldset>
                <legend className="text-sm font-extrabold text-ink-900">
                    Pilih metode pembayaran
                </legend>

                <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
                    {METHODS.map((option) => {
                        const selected = method === option.value;

                        return (
                            <label
                                key={option.value}
                                className={`cursor-pointer rounded-xl border px-3.5 py-3 transition ${
                                    selected
                                        ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500"
                                        : "border-ink-200 bg-white hover:border-ink-300 hover:bg-ink-50"
                                }`}
                            >
                                <input
                                    type="radio"
                                    name="paymentMethod"
                                    value={option.value}
                                    checked={selected}
                                    onChange={() => setMethod(option.value)}
                                    className="sr-only"
                                />
                                <span className="block text-sm font-bold text-ink-900">
                                    {option.label}
                                </span>
                                <span className="mt-0.5 block text-xs text-ink-500">
                                    {option.hint}
                                </span>
                            </label>
                        );
                    })}
                </div>
            </fieldset>

            {error ? (
                <p
                    role="alert"
                    className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700"
                >
                    {error}
                </p>
            ) : null}

            <button
                type="button"
                onClick={pay}
                disabled={submitting}
                className="w-full rounded-xl bg-brand-600 px-5 py-3.5 text-sm font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:text-ink-500 sm:w-auto"
            >
                {submitting ? "Menyiapkan pembayaran…" : "Bayar sekarang"}
            </button>

            <p className="text-xs leading-relaxed text-ink-500">
                Anda akan diarahkan ke halaman pembayaran penyedia. Jumlah yang
                ditagih dihitung di server dari pesanan ini.
            </p>
        </div>
    );
}
