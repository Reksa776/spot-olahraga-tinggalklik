"use client";

import { useEffect, useState } from "react";

import type { PaymentInstructionPayload } from "@/lib/ticketing/order-payload";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * ==========================================
 * PAYMENT INSTRUCTION — QRIS / VIRTUAL ACCOUNT / RETAIL OUTLET
 * ==========================================
 *
 * Renders whatever the GATEWAY returned, and nothing else. Every value on this panel comes
 * from `PaymentInstructionPayload`, which is built server-side from the `Payment` row that
 * the gateway's own response populated:
 *
 *   QRIS       `qrImageUrl` (a QR image rendered server-side from the gateway's payload)
 *              + the amount + the iPaymu reference
 *   VA         `number` (the account number the gateway issued) + `paymentName` (its bank)
 *   Retail     `number` (the payment code) + `paymentName`
 *   Redirect   `url` (the provider's own hosted page)
 *
 * ── WHAT THIS COMPONENT MUST NEVER DO ────────────────────────────────────────────
 * It must not synthesise any of those values. There is no local QR generator, no
 * placeholder number and no "sample" code path: if the server sent no `qrImageUrl`, this
 * panel says the code is unavailable instead of drawing something a buyer might try to
 * scan. That is the difference between a payment page and a fake one.
 *
 * It must never render the raw QRIS payload either: `qrString` is not part of the
 * customer payload — the QR image is built server-side — so there is no code to paste
 * and no value a wallet could be misled into using as a manual entry.
 *
 * It must not claim the payment succeeded either. Nothing here reads a URL parameter; the
 * panel shows the instruction and the order's own status, and confirmation arrives only
 * through the provider's verified webhook, which flips `PaymentStatus` to `PAID` and
 * re-renders this page server-side.
 *
 * ── WHY A CLIENT COMPONENT AT ALL ────────────────────────────────────────────────
 * Two genuine browser affordances: the copy button (clipboard API) and the countdown
 * (which must tick without a server round-trip). The countdown is derived from the
 * SERVER's instant — `expiresAt`/`providerExpiredAt` are ISO strings from the database —
 * and is only a display of how much time is left; the server re-checks the window before
 * accepting any payment request (brief §25: the frontend is never the source of truth).
 */

const DATE_TIME = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

/** Remaining time as `mm:ss`, or a coarser `h j m` above an hour. `null` once elapsed. */
function remainingLabel(expiresAt: string, now: number): string | null {
    const diff = new Date(expiresAt).getTime() - now;

    if (!Number.isFinite(diff) || diff <= 0) {
        return null;
    }

    const totalSeconds = Math.floor(diff / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours} jam ${minutes} menit`;
    }

    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * One provider identifier worth showing, in the fixed order the payment card renders them.
 *
 * Pure and exported so the "hide a missing value" and "never show a placeholder" rules can be
 * unit-tested without a browser or a provider.
 */
export type PaymentIdentifier = { label: string; value: string };

/** Whether this attempt was created in iPaymu's sandbox. Drives the demo banner ONLY. */
export function isSandboxPayment(instruction: { environment: string | null }): boolean {
    return instruction.environment === "SANDBOX";
}

/**
 * The identifiers the payment card shows, with absent (null/empty/whitespace) values DROPPED.
 *
 * Order is stable — Reference ID, Transaction ID, Session ID — so a screenshot is comparable
 * between payments. An empty result means the card is not rendered at all.
 */
export function visiblePaymentIdentifiers(instruction: {
    referenceId: string | null;
    providerTransactionId: string | null;
    providerSessionId: string | null;
}): PaymentIdentifier[] {
    const candidates: PaymentIdentifier[] = [
        { label: "Reference ID", value: instruction.referenceId?.trim() ?? "" },
        {
            label: "Transaction ID",
            value: instruction.providerTransactionId?.trim() ?? "",
        },
        { label: "Session ID", value: instruction.providerSessionId?.trim() ?? "" },
    ];

    return candidates.filter((row) => row.value.length > 0);
}

/** Clipboard state for one value. Display-only; a denied clipboard is not an error state. */
function useCopy() {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) {
            return;
        }

        const timer = setTimeout(() => setCopied(false), 2000);

        return () => clearTimeout(timer);
    }, [copied]);

    async function copy(value: string) {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
        } catch {
            // Clipboard access can be denied (insecure context, permissions). The value is
            // already on screen in a selectable element, so this is not an error state —
            // nothing is reported as copied when it was not.
            setCopied(false);
        }
    }

    return { copied, copy };
}

/** A number with a copy button. The value shown is the value copied, never a reformatted one. */
function CopyableValue({ label, value }: { label: string; value: string }) {
    const { copied, copy } = useCopy();

    return (
        <div className="rounded-xl border border-ink-200 bg-white p-3.5">
            <p className="text-xs font-bold tracking-wider text-ink-500 uppercase">
                {label}
            </p>

            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <code className="font-mono text-base font-bold break-all text-ink-900 select-all">
                    {value}
                </code>

                <button
                    type="button"
                    onClick={() => copy(value)}
                    className="rounded-lg border border-ink-200 px-2.5 py-1 text-xs font-bold text-ink-700 transition hover:border-ink-300 hover:bg-ink-50"
                >
                    {copied ? "Tersalin" : "Salin"}
                </button>
            </div>
        </div>
    );
}

/** One identifier row with a copy affordance. Rendered only when its value exists. */
function IdentifierLine({ label, value }: { label: string; value: string }) {
    const { copied, copy } = useCopy();

    return (
        <div className="flex items-center justify-between gap-3 border-b border-ink-100 py-2 last:border-b-0">
            <div className="min-w-0">
                <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-ink-500">
                    {label}
                </p>
                <code className="block truncate font-mono text-sm font-bold text-ink-900 select-all">
                    {value}
                </code>
            </div>

            <button
                type="button"
                onClick={() => copy(value)}
                className="shrink-0 rounded-lg border border-ink-200 px-2.5 py-1 text-xs font-bold text-ink-700 transition hover:border-ink-300 hover:bg-ink-50"
            >
                {copied ? "Tersalin" : "Salin"}
            </button>
        </div>
    );
}

/**
 * The demo/support identifiers, read entirely from the server payload that was built out of
 * the gateway's own response. A row appears only when the provider returned a value; when no
 * identifier exists the whole card is omitted rather than rendered with placeholders.
 */
function PaymentIdentifiers({
    instruction,
}: {
    instruction: PaymentInstructionPayload;
}) {
    const rows = visiblePaymentIdentifiers(instruction);

    if (rows.length === 0) {
        return null;
    }

    return (
        <div className="rounded-xl border border-ink-200 bg-white p-3.5">
            <p className="text-xs font-bold tracking-wider text-ink-500 uppercase">
                Detail Pembayaran
            </p>

            <div className="mt-1.5">
                {rows.map((row) => (
                    <IdentifierLine
                        key={row.label}
                        label={row.label}
                        value={row.value}
                    />
                ))}
            </div>
        </div>
    );
}

export default function PaymentInstruction({
    instruction,
    amount,
    orderNumber,
}: {
    instruction: PaymentInstructionPayload;
    /** The server-derived total, as a decimal string. */
    amount: string;
    orderNumber: string;
}) {
    // Ticks only while a countdown is being shown. It is display state, not authority.
    const [now, setNow] = useState(() => Date.now());

    const hasExpiry = Boolean(instruction.expiresAt);

    useEffect(() => {
        if (!hasExpiry) {
            return;
        }

        const timer = setInterval(() => setNow(Date.now()), 1000);

        return () => clearInterval(timer);
    }, [hasExpiry]);

    const remaining = instruction.expiresAt
        ? remainingLabel(instruction.expiresAt, now)
        : null;
    const expired = hasExpiry && remaining === null;

    return (
        <section className="rounded-2xl border border-ink-200 bg-ink-50/60 p-4 sm:p-5">
            <header className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-extrabold text-ink-900">
                    {instruction.flow === "REDIRECT"
                        ? "Selesaikan pembayaran"
                        : instruction.kind === "QR"
                          ? "Scan QRIS untuk membayar"
                          : "Selesaikan pembayaran"}
                </h2>

                <p className="text-xs text-ink-500">
                    Pesanan{" "}
                    <span className="font-mono font-semibold text-ink-700">
                        {orderNumber}
                    </span>
                </p>
            </header>

            {/* Amount. Read from the order row server-side; this component never sums anything. */}
            <p className="mt-2 text-2xl font-extrabold tracking-tight text-ink-900">
                {formatIdr(Number(amount))}
            </p>

            {/*
             * The environment SNAPSHOT stored on this payment. It is a demo/ops label only —
             * it says nothing about whether the payment succeeded, and the buyer still waits
             * for the provider's verified webhook before the order becomes PAID.
             */}
            {isSandboxPayment(instruction) ? (
                <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    <span className="font-extrabold">🧪 SANDBOX PAYMENT</span>
                    <span>
                        Lingkungan uji iPaymu. Pembayaran tetap PENDING sampai dikonfirmasi.
                    </span>
                </p>
            ) : null}

            {instruction.flow === "REDIRECT" ? (
                instruction.url ? (
                    <div className="mt-4 space-y-2">
                        <a
                            href={instruction.url}
                            className="inline-flex w-full items-center justify-center rounded-xl bg-brand-600 px-5 py-3.5 text-sm font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 sm:w-auto"
                        >
                            Buka halaman pembayaran
                        </a>
                        <p className="text-xs leading-relaxed text-ink-500">
                            Halaman pembayaran di-host oleh penyedia pembayaran. Setelah
                            selesai, kembali ke halaman ini dan tekan &ldquo;Perbarui
                            status&rdquo;.
                        </p>
                    </div>
                ) : (
                    <p className="mt-4 rounded-xl bg-amber-50 p-3.5 text-sm text-amber-800">
                        Tautan pembayaran belum tersedia. Muat ulang halaman ini sebentar
                        lagi.
                    </p>
                )
            ) : null}

            {instruction.flow === "DIRECT" ? (
                <div className="mt-4 space-y-3.5">
                    {/* ── QRIS ─────────────────────────────────────────────────── */}
                    {instruction.kind === "QR" ? (
                        <div className="flex flex-col items-center gap-3 rounded-xl border border-ink-200 bg-white p-4">
                            {instruction.qrImageUrl ? (
                                /* Server-rendered QR image (built from the gateway's own
                                   QrString, so what a wallet decodes is what the gateway
                                   issued). A plain <img> over the data URL: no optimiser may
                                   re-encode the one thing a wallet has to decode. */
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={instruction.qrImageUrl}
                                    alt="Kode QRIS untuk pesanan ini"
                                    width={248}
                                    height={248}
                                    className="h-auto w-[248px] max-w-full"
                                />
                            ) : (
                                <p className="rounded-lg bg-amber-50 px-3 py-2 text-center text-xs font-semibold text-amber-800">
                                    Gambar QR belum tersedia. Perbarui status untuk
                                    mencoba lagi.
                                </p>
                            )}

                            <p className="text-center text-xs leading-relaxed text-ink-500">
                                Buka aplikasi bank atau e-wallet, pilih bayar dengan QRIS,
                                lalu scan kode di atas.
                            </p>
                        </div>
                    ) : null}

                    {/* ── Virtual account / retail outlet code ─────────────────── */}
                    {instruction.kind === "NUMBER" && instruction.number ? (
                        <CopyableValue
                            label={
                                instruction.method === "RETAIL_OUTLET"
                                    ? `Kode pembayaran ${instruction.paymentName ?? ""}`.trim()
                                    : `Nomor Virtual Account ${instruction.paymentName ?? ""}`.trim()
                            }
                            value={instruction.number}
                        />
                    ) : null}

                    {/* An instruction with neither a QR nor a number is not shown as one. */}
                    {!instruction.qrImageUrl && !instruction.number ? (
                        <p className="rounded-xl bg-amber-50 p-3.5 text-sm text-amber-800">
                            Instruksi pembayaran dari penyedia belum lengkap. Perbarui
                            status untuk mencoba lagi.
                        </p>
                    ) : null}

                    {instruction.method === "RETAIL_OUTLET" ? (
                        <p className="text-xs leading-relaxed text-ink-500">
                            Sebutkan kode pembayaran di kasir Alfamart atau Indomaret.
                            Simpan struk sebagai bukti sampai tiket terbit.
                        </p>
                    ) : null}

                    {instruction.method === "VIRTUAL_ACCOUNT" ? (
                        <p className="text-xs leading-relaxed text-ink-500">
                            Transfer tepat sebesar nominal di atas ke nomor Virtual
                            Account tersebut, dari rekening apa pun.
                        </p>
                    ) : null}
                </div>
            ) : null}

            {/* ── Demo/support identifiers ─────────────────────────────────────── */}
            {/* Rendered for every flow: a reference is what a demo operator quotes to the
                provider, and for a hosted page it is the only handle that exists. */}
            <div className="mt-3.5">
                <PaymentIdentifiers instruction={instruction} />
            </div>

            {/* ── Expiry and status ────────────────────────────────────────────── */}
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-200 pt-3 text-xs">
                {instruction.expiresAt ? (
                    expired ? (
                        <span className="font-bold text-red-700">
                            Instruksi ini sudah kedaluwarsa. Minta pembayaran baru.
                        </span>
                    ) : (
                        <span className="text-ink-500">
                            Berlaku{" "}
                            <span className="font-semibold text-ink-700 tabular-nums">
                                {remaining}
                            </span>{" "}
                            lagi
                            {instruction.providerExpiredAt
                                ? ` · batas dari penyedia ${DATE_TIME.format(new Date(instruction.providerExpiredAt))} WIB`
                                : ""}
                        </span>
                    )
                ) : (
                    <span className="text-ink-500">
                        Batas waktu pembayaran belum ditetapkan penyedia.
                    </span>
                )}

                <span className="text-ink-500">
                    Status pembayaran belum lunas. Halaman ini akan berubah setelah
                    pembayaran dikonfirmasi penyedia.
                </span>
            </div>
        </section>
    );
}
