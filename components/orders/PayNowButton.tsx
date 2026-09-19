"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { PAYMENT_METHOD_OPTIONS } from "@/lib/ticketing/payment/method-catalog";

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

/**
 * The methods offered are the ones the gateway integration can actually complete.
 *
 * The list is imported from `lib/ticketing/payment/method-catalog` — the SAME module the
 * server validates against — so the picker cannot advertise a method the server would
 * refuse, and adding or retiring a method is a one-file change. The previous hand-written
 * array here named `E_WALLET`, which the gateway never had: e-wallets pay by scanning QRIS,
 * so that tile promised a payment route that did not exist.
 */
const METHODS = PAYMENT_METHOD_OPTIONS;

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

    const [method, setMethod] = useState<string>(METHODS[0]?.method ?? "QRIS");
    const [channel, setChannel] = useState<string | null>(
        METHODS[0]?.defaultChannel ?? null
    );
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const selected = METHODS.find((option) => option.method === method) ?? METHODS[0];

    /**
     * Pick a method. The channel resets to that method's default when the picker changes,
     * because the channels belong to the method: keeping a bank code across a switch to QRIS
     * would send a channel that method does not have, and the server refuses it.
     */
    function chooseMethod(option: (typeof METHODS)[number]) {
        setMethod(option.method);
        setChannel(option.defaultChannel);
    }

    async function pay() {
        setSubmitting(true);
        setError(null);

        try {
            const response = await fetch(
                `/api/ticketing/orders/${encodeURIComponent(orderNumber)}/pay`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    // The method and channel are presentation choices; nothing financial is
                    // sent, and the request schema declares no financial field to send.
                    body: JSON.stringify({
                        method,
                        ...(channel ? { channel } : {}),
                    }),
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

            if (url) {
                // The provider's own hosted page. Its response is informational only.
                window.location.href = url;
                return;
            }

            // ── A DIRECT instruction (QRIS / virtual account / retail code) ───────
            // There is no URL to follow: the instrument is rendered on this page, so the
            // freshly written `Payment` row is read back from the server. The returned
            // payload is NOT used to draw the QR here — the page re-renders the server
            // component, which is the same data every other visitor of this URL sees, and
            // keeps the authoritative rendering in one place. If the row really carries no
            // instruction, the reload shows that state honestly instead of a blank panel.
            router.refresh();
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

                <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                    {METHODS.map((option) => {
                        const isSelected = method === option.method;

                        return (
                            <label
                                key={option.method}
                                className={`cursor-pointer rounded-xl border px-3.5 py-3 transition ${
                                    isSelected
                                        ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500"
                                        : "border-ink-200 bg-white hover:border-ink-300 hover:bg-ink-50"
                                }`}
                            >
                                <input
                                    type="radio"
                                    name="paymentMethod"
                                    value={option.method}
                                    checked={isSelected}
                                    onChange={() => chooseMethod(option)}
                                    className="sr-only"
                                />
                                <span className="block text-sm font-bold text-ink-900">
                                    {option.label}
                                </span>
                                <span className="mt-0.5 block text-xs text-ink-500">
                                    {option.description}
                                </span>
                            </label>
                        );
                    })}
                </div>
            </fieldset>

            {/* The bank picker appears only for a method that actually has channels — the
                list is the gateway's own channel set, not a local guess. */}
            {selected && selected.channels.length > 1 ? (
                <div>
                    <label
                        htmlFor="payment-channel"
                        className="text-xs font-bold tracking-wider text-ink-500 uppercase"
                    >
                        Pilih bank
                    </label>

                    <select
                        id="payment-channel"
                        value={channel ?? ""}
                        onChange={(event) => setChannel(event.currentTarget.value)}
                        className="mt-1.5 w-full rounded-xl border border-ink-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-ink-900 focus-visible:border-brand-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                    >
                        {selected.channels.map((entry) => (
                            <option key={entry.code} value={entry.code}>
                                {entry.label}
                            </option>
                        ))}
                    </select>
                </div>
            ) : null}

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
                {selected?.flow === "REDIRECT"
                    ? "Anda akan diarahkan ke halaman pembayaran penyedia."
                    : "Kode pembayaran akan muncul di halaman ini setelah dibuat oleh penyedia."}{" "}
                Jumlah yang ditagih dihitung di server dari pesanan ini.
            </p>
        </div>
    );
}
