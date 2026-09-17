"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import type { PublicTicketType } from "@/lib/events/catalog";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * ==========================================
 * TICKET PURCHASE FORM (design §25.5, brief §A8)
 * ==========================================
 *
 * PHASE 9 changed the *presentation* of this form and nothing else. The request shape, the
 * idempotency model, the client-side minimum check and the navigation behaviour are byte-for-byte
 * what Phase 6 shipped — the ticketing purchase contract is closed and this phase does not reopen
 * it.
 *
 * WHAT THE CLIENT IS NOT ALLOWED TO BE
 * ------------------------------------
 * Brief §25: "Frontend must not be the source of truth for price, inventory, total, ownership,
 * reservation state." The request body carries **only** `eventId`, `ticketTypeId`/`quantity` pairs
 * and the buyer's contact details. No price, no subtotal, no total, no organizer id — and the server
 * strips even those if a tampered client sends them (`lib/ticketing/checkout-validation.ts`).
 *
 * The prices and the "estimasi total" rendered here are informational: they are the catalog's own
 * numbers, multiplied for display. Every amount actually charged is recomputed server-side from
 * `TicketType.price` (design §17.2), and the form says so in as many words rather than presenting an
 * estimate as a commitment.
 *
 * IDEMPOTENCY-KEY STRATEGY (design §30.4) — unchanged
 * ---------------------------------------------------
 * §30.4: "Browser checkout form | Generates one `Idempotency-Key` per submit intent; a network
 * retry reuses it." So the key is derived from the *intent*, not per HTTP attempt:
 *
 *   - retrying the same selection after a network failure → SAME key → the server returns the order
 *     it already created instead of creating a second one;
 *   - changing the selection and submitting again → NEW key → a genuinely new order, rather than
 *     the `409` §30.2 mandates for a reused key with a different payload.
 *
 * `crypto.randomUUID()` is available in every browser this app targets and needs no dependency.
 */

type Props = {
    eventId: string;
    ticketTypes: readonly PublicTicketType[];
    /** False for a DRAFT/CANCELLED event (D-14) — purchase affordances are suppressed. */
    isAvailable: boolean;
    /** Prefill for a signed-in buyer; all three stay editable. */
    defaultBuyer?: {
        name?: string | null;
        email?: string | null;
        phone?: string | null;
    };
};

/** Fallback ceiling when a ticket type has no `maxPerOrder` — UI convenience only. */
const DEFAULT_MAX_PER_SELECTION = 10;

type PendingIntent = { key: string; signature: string };

export default function TicketPurchaseForm({
    eventId,
    ticketTypes,
    isAvailable,
    defaultBuyer,
}: Props) {
    const router = useRouter();

    const [quantities, setQuantities] = useState<Record<string, number>>({});
    const [buyerName, setBuyerName] = useState(defaultBuyer?.name ?? "");
    const [buyerEmail, setBuyerEmail] = useState(defaultBuyer?.email ?? "");
    const [buyerPhone, setBuyerPhone] = useState(defaultBuyer?.phone ?? "");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** One key per submit intent — see the module note above. */
    const pendingIntent = useRef<PendingIntent | null>(null);

    const sellable = ticketTypes.filter(
        (type) => type.salesState === "OPEN" && !type.isSoldOut
    );

    /**
     * Display-only estimate. Deliberately named an estimate in the UI: it is the sum of the catalog
     * prices the buyer can see, and the server's figure is the one that counts.
     */
    const estimate = useMemo(
        () =>
            ticketTypes.reduce(
                (total, type) => total + type.price * (quantities[type.id] ?? 0),
                0
            ),
        [ticketTypes, quantities]
    );

    const selectedCount = Object.values(quantities).reduce(
        (total, quantity) => total + quantity,
        0
    );

    function setQuantity(ticketTypeId: string, next: number) {
        setQuantities((current) => ({ ...current, [ticketTypeId]: next }));
    }

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(null);

        const items = Object.entries(quantities)
            .map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity }))
            .filter((item) => item.quantity > 0);

        if (items.length === 0) {
            setError("Pilih jumlah tiket terlebih dahulu.");
            return;
        }

        // A local echo of the server's per-type limits, so the buyer gets an immediate hint. The
        // server re-validates both against the database and is authoritative (brief §10: "Do not
        // trust frontend validation").
        for (const item of items) {
            const type = ticketTypes.find((t) => t.id === item.ticketTypeId);

            if (type && item.quantity < type.minPerOrder) {
                setError(
                    `${type.name}: minimal pembelian ${type.minPerOrder} tiket.`
                );
                return;
            }

            if (type && type.maxPerOrder && item.quantity > type.maxPerOrder) {
                setError(`${type.name}: maksimal ${type.maxPerOrder} tiket.`);
                return;
            }
        }

        const signature = JSON.stringify({
            eventId,
            items: [...items].sort((a, b) =>
                a.ticketTypeId < b.ticketTypeId ? -1 : 1
            ),
            buyerName: buyerName.trim(),
            buyerEmail: buyerEmail.trim(),
            buyerPhone: buyerPhone.trim(),
        });

        if (
            !pendingIntent.current ||
            pendingIntent.current.signature !== signature
        ) {
            pendingIntent.current = {
                key: crypto.randomUUID(),
                signature,
            };
        }

        setSubmitting(true);

        try {
            const response = await fetch("/api/ticketing/checkout", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "Idempotency-Key": pendingIntent.current.key,
                },
                body: JSON.stringify({
                    eventId,
                    items,
                    buyerName: buyerName.trim(),
                    buyerEmail: buyerEmail.trim(),
                    buyerPhone: buyerPhone.trim(),
                }),
            });

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                if (response.status === 401) {
                    router.push(
                        `/login?next=${encodeURIComponent(window.location.pathname)}`
                    );
                    return;
                }

                setError(
                    payload?.message ??
                        "Pemesanan gagal. Silakan coba lagi sebentar lagi."
                );
                return;
            }

            // The intent is fulfilled, so the key must not be reused for a later order.
            pendingIntent.current = null;

            const orderNumber = payload?.data?.orderNumber;

            if (orderNumber) {
                router.push(`/ticketing/orders/${orderNumber}`);
            } else {
                router.refresh();
            }
        } catch {
            // A network failure leaves the key in place, so pressing the button again replays the
            // same intent instead of creating a duplicate order (§30.4).
            setError(
                "Koneksi terputus. Coba kirim ulang — pemesanan yang sama tidak akan ganda."
            );
        } finally {
            setSubmitting(false);
        }
    }

    if (!isAvailable) {
        return (
            <p className="mt-3 rounded-xl bg-ink-50 p-3 text-sm text-ink-600">
                Pembelian tiket tidak tersedia untuk event ini.
            </p>
        );
    }

    if (ticketTypes.length === 0) {
        return (
            <p className="mt-3 rounded-xl bg-ink-50 p-3 text-sm text-ink-600">
                Jenis tiket belum dibuka untuk event ini.
            </p>
        );
    }

    return (
        <form onSubmit={submit} className="mt-4 space-y-4">
            <ul className="space-y-3">
                {ticketTypes.map((type) => {
                    const purchasable =
                        type.salesState === "OPEN" && !type.isSoldOut;
                    const max = type.maxPerOrder ?? DEFAULT_MAX_PER_SELECTION;
                    const quantity = quantities[type.id] ?? 0;
                    const inputId = `qty-${type.id}`;

                    return (
                        <li
                            key={type.id}
                            className={`rounded-xl border p-3.5 transition ${
                                quantity > 0
                                    ? "border-brand-300 bg-brand-50/40"
                                    : "border-ink-200 bg-white"
                            }`}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    {/*
                                     * A `<label for>` when the tier can be bought, and plain text
                                     * when it cannot — an associated label pointing at no control
                                     * (or at a disabled one) is worse for a screen reader than no
                                     * association at all.
                                     */}
                                    {purchasable ? (
                                        <label
                                            htmlFor={inputId}
                                            className="block text-sm font-bold text-ink-900"
                                        >
                                            {type.name}
                                        </label>
                                    ) : (
                                        <span className="block text-sm font-bold text-ink-500">
                                            {type.name}
                                        </span>
                                    )}

                                    {type.description ? (
                                        <p className="mt-1 text-xs leading-relaxed text-ink-500">
                                            {type.description}
                                        </p>
                                    ) : null}

                                    {purchasable ? (
                                        <p className="mt-1 text-[0.7rem] font-semibold text-ink-400">
                                            {type.minPerOrder > 1
                                                ? `Min. ${type.minPerOrder}`
                                                : "Min. 1"}
                                            {" · "}
                                            {type.maxPerOrder
                                                ? `Maks. ${type.maxPerOrder}`
                                                : `Maks. ${DEFAULT_MAX_PER_SELECTION}`}{" "}
                                            per pesanan
                                        </p>
                                    ) : null}
                                </div>

                                <p className="shrink-0 text-sm font-extrabold text-ink-900">
                                    {formatIdr(type.price)}
                                </p>
                            </div>

                            {purchasable ? (
                                <div className="mt-3 flex items-center justify-between gap-3">
                                    <span className="text-xs font-semibold text-ink-500">
                                        Jumlah
                                    </span>

                                    <div className="flex items-center gap-1.5">
                                        <Stepper
                                            label={`Kurangi ${type.name}`}
                                            disabled={quantity <= 0}
                                            onClick={() =>
                                                setQuantity(
                                                    type.id,
                                                    Math.max(0, quantity - 1)
                                                )
                                            }
                                        >
                                            −
                                        </Stepper>

                                        <input
                                            id={inputId}
                                            type="number"
                                            inputMode="numeric"
                                            min={0}
                                            max={max}
                                            step={1}
                                            value={quantity}
                                            onChange={(e) =>
                                                setQuantity(
                                                    type.id,
                                                    Math.max(
                                                        0,
                                                        Math.min(
                                                            max,
                                                            Number(
                                                                e.target.value || 0
                                                            )
                                                        )
                                                    )
                                                )
                                            }
                                            className="h-10 w-14 rounded-xl border border-ink-200 text-center text-sm font-bold text-ink-900 focus:border-ink-900 focus:outline-none focus:ring-4 focus:ring-ink-900/5"
                                        />

                                        <Stepper
                                            label={`Tambah ${type.name}`}
                                            disabled={quantity >= max}
                                            onClick={() =>
                                                setQuantity(
                                                    type.id,
                                                    Math.min(max, quantity + 1)
                                                )
                                            }
                                        >
                                            +
                                        </Stepper>
                                    </div>
                                </div>
                            ) : (
                                <p className="mt-2 inline-block rounded-full bg-ink-100 px-2.5 py-1 text-[0.7rem] font-bold text-ink-600">
                                    {type.isSoldOut
                                        ? "Habis"
                                        : type.salesState === "NOT_STARTED"
                                          ? "Belum dibuka"
                                          : "Penjualan ditutup"}
                                </p>
                            )}
                        </li>
                    );
                })}
            </ul>

            {sellable.length > 0 ? (
                <fieldset className="space-y-2.5 rounded-xl border border-ink-200 bg-white p-3.5">
                    <legend className="px-1 text-xs font-bold tracking-wide text-ink-500 uppercase">
                        Data pembeli
                    </legend>

                    <BuyerField
                        id="buyer-name"
                        label="Nama lengkap"
                        type="text"
                        value={buyerName}
                        onChange={setBuyerName}
                        placeholder="Nama sesuai identitas"
                        autoComplete="name"
                    />
                    <BuyerField
                        id="buyer-email"
                        label="Email"
                        type="email"
                        value={buyerEmail}
                        onChange={setBuyerEmail}
                        placeholder="nama@email.com"
                        autoComplete="email"
                    />
                    <BuyerField
                        id="buyer-phone"
                        label="Nomor WhatsApp"
                        type="tel"
                        value={buyerPhone}
                        onChange={setBuyerPhone}
                        placeholder="08xxxxxxxxxx"
                        autoComplete="tel"
                    />
                </fieldset>
            ) : null}

            {selectedCount > 0 ? (
                <div className="rounded-xl bg-ink-50 p-3.5">
                    <div className="flex items-center justify-between text-sm">
                        <span className="font-semibold text-ink-600">
                            Estimasi total ({selectedCount} tiket)
                        </span>
                        <span className="text-base font-extrabold text-ink-900">
                            {formatIdr(estimate)}
                        </span>
                    </div>
                    <p className="mt-1.5 text-[0.7rem] leading-relaxed text-ink-500">
                        Estimasi ini hanya untuk gambaran. Total akhir, harga per
                        tiket, dan ketersediaan dihitung ulang oleh server saat
                        pemesanan dibuat.
                    </p>
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
                type="submit"
                disabled={submitting || sellable.length === 0}
                className="w-full rounded-xl bg-brand-600 px-5 py-3.5 text-sm font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:text-ink-500"
            >
                {submitting ? "Memproses…" : "Pesan tiket"}
            </button>

            <p className="text-center text-[0.7rem] leading-relaxed text-ink-500">
                Tiket ditahan sementara setelah Anda memesan. Pembayaran dilakukan
                pada langkah berikutnya.
            </p>
        </form>
    );
}

function Stepper({
    label,
    disabled,
    onClick,
    children,
}: {
    label: string;
    disabled: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="grid h-10 w-10 place-items-center rounded-xl border border-ink-200 text-lg leading-none font-bold text-ink-700 transition hover:border-ink-900 hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:border-ink-100 disabled:text-ink-300"
        >
            {children}
        </button>
    );
}

function BuyerField({
    id,
    label,
    type,
    value,
    onChange,
    placeholder,
    autoComplete,
}: {
    id: string;
    label: string;
    type: string;
    value: string;
    onChange: (next: string) => void;
    placeholder: string;
    autoComplete: string;
}) {
    return (
        <div className="flex flex-col gap-1">
            <label htmlFor={id} className="text-xs font-semibold text-ink-600">
                {label}
            </label>
            <input
                id={id}
                type={type}
                required
                value={value}
                autoComplete={autoComplete}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full rounded-xl border border-ink-200 px-3 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:border-ink-900 focus:outline-none focus:ring-4 focus:ring-ink-900/5"
            />
        </div>
    );
}
