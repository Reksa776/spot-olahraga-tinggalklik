"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
    isSessionExpired,
    redirectToLoginForExpiredSession,
} from "@/lib/auth/client-session";

/**
 * ==========================================
 * MATERIALISE TICKETS FOR A PAID ORDER (brief §B4)
 * ==========================================
 *
 * Posts to `/api/ticketing/orders/{orderNumber}/issue`, which is ownership-scoped server-side,
 * requires the order to have been settled by the verified provider webhook (`status = PAID`,
 * `paymentStatus = PAID`, `paidAt` set), and is idempotent at the database level.
 *
 * ── WHY A BUTTON AND NOT AUTOMATIC ──────────────────────────────────────────────
 * Issuance is a state-changing operation, so it is an explicit POST rather than a side effect of
 * rendering a page: brief §23's flow reaches the wallet through a request the buyer makes, and a
 * GET that creates rows would be both uncacheable and surprising.
 *
 * ── WHAT THIS COMPONENT CANNOT DO ───────────────────────────────────────────────
 * It cannot pay, cannot settle, cannot change an amount and cannot pick a quantity. It sends NO
 * body at all — not a ticket count, not a ticket type, not a user id. The server derives the number
 * of tickets from `EventOrderItem.quantity` on the order it resolves from the session (brief §6),
 * so a tampered client cannot ask for more tickets than were bought. `ticketCount` below is
 * display-only text the caller derived from the server payload; it is never sent.
 *
 * ── THE RESPONSE IS NOT TRUSTED EITHER ──────────────────────────────────────────
 * On success the page is refreshed from the server rather than updated locally, so what the buyer
 * sees comes from the database. `ALREADY_ISSUED` is a success, not an error: it is what a second
 * click, a refresh or a retried request returns, and it is reported as "sudah diterbitkan" rather
 * than as a failure.
 */

type Props = {
    orderNumber: string;
    /**
     * How many tickets the server's own order lines say should exist. Presentation only — used to
     * tell the buyer what is about to happen before they click.
     */
    ticketCount?: number;
};

type Result = { outcome: "ISSUED" | "ALREADY_ISSUED"; ticketsIssued: number };

export default function IssueTicketsButton({ orderNumber, ticketCount }: Props) {
    const router = useRouter();

    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<Result | null>(null);

    async function issue() {
        setSubmitting(true);
        setError(null);
        setResult(null);

        try {
            const response = await fetch(
                `/api/ticketing/orders/${encodeURIComponent(orderNumber)}/issue`,
                { method: "POST" }
            );

            const payload = await response.json().catch(() => null);

            /*
             * The session ended while this page was open. NOT "issuance failed": no ticket was
             * created and none was refused. The buyer signs in and returns to this order, where
             * the button is offered again — which is safe, because issuance is idempotent.
             */
            if (isSessionExpired(response.status, payload)) {
                redirectToLoginForExpiredSession();
                return;
            }

            if (!response.ok) {
                // The server's message is shown verbatim — including for the `FULFILMENT_BLOCKED`
                // case, where the buyer genuinely needs to be told that an operator is looking at
                // their order.
                setError(
                    payload?.message ??
                        "Tiket belum dapat diterbitkan untuk pesanan ini."
                );
                router.refresh();
                return;
            }

            setResult({
                outcome: payload?.data?.outcome === "ALREADY_ISSUED"
                    ? "ALREADY_ISSUED"
                    : "ISSUED",
                ticketsIssued: Number(payload?.data?.ticketsIssued ?? 0),
            });

            // Re-render the server component so the page reflects the committed rows.
            router.refresh();
        } catch {
            setError("Koneksi terputus. Silakan coba lagi.");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="rounded-2xl border border-ink-200 bg-white p-4">
            <h3 className="text-sm font-extrabold text-ink-900">
                Tiket siap diterbitkan
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
                {ticketCount && ticketCount > 0
                    ? `${ticketCount} e-tiket akan dibuat sesuai jumlah yang Anda beli pada pesanan ini.`
                    : "E-tiket akan dibuat sesuai jumlah yang Anda beli pada pesanan ini."}{" "}
                Setelah diterbitkan, tiket bisa dibuka kapan saja di menu Tiket saya.
            </p>

            {error ? (
                <p
                    role="alert"
                    className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700"
                >
                    {error}
                </p>
            ) : null}

            {result ? (
                <div
                    role="status"
                    className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5"
                >
                    <p className="text-sm font-bold text-emerald-800">
                        {result.outcome === "ALREADY_ISSUED"
                            ? "Tiket Anda sudah diterbitkan sebelumnya."
                            : `Tiket berhasil diterbitkan${
                                  result.ticketsIssued > 0
                                      ? ` (${result.ticketsIssued} tiket)`
                                      : ""
                              }.`}
                    </p>
                    <Link
                        href="/ticketing/tickets"
                        className="mt-2 inline-block rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                    >
                        Buka tiket saya
                    </Link>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={issue}
                    disabled={submitting}
                    className="mt-3 w-full rounded-xl bg-brand-600 px-5 py-3.5 text-sm font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:text-ink-500 sm:w-auto"
                >
                    {submitting ? "Menerbitkan tiket…" : "Terbitkan tiket saya"}
                </button>
            )}
        </div>
    );
}
