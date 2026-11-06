/**
 * ==========================================
 * PURCHASE PROOF — `purchase-proof.v1` (PHASE 2)
 * ==========================================
 *
 * ONE renderer for both channels. Email and WhatsApp read the same stored payload and call the
 * same function, so the two cannot drift into different totals or different wording.
 *
 * ── WHAT THE PAYLOAD MAY CONTAIN ────────────────────────────────────────────────
 * Only what a receipt needs, all of it from the order's own snapshots: the order number, the
 * buyer's name, the line snapshots (name/price/quantity/subtotal frozen at checkout), the
 * stored totals, the payment method/channel/status, the event and venue, the organizer's
 * public name, the store contact when configured, and the PUBLIC ticket codes when they exist.
 *
 * It never contains an internal database id, a payment URL, a QR token or its hash, a session,
 * a credential, an attendee contact field, or any provider identifier. A receipt is not a
 * support console.
 *
 * ── TEXT IS SANITIZED, NOT INTERPOLATED ──────────────────────────────────────────
 * A stored product name is data. Each field is stripped of control characters and collapsed to
 * one line before it reaches the body, so a name containing a newline or an HTML fragment can
 * only appear as literal characters in a plain-text message.
 *
 * ── THE TICKET SECTION AND ITS SECURITY GATE ────────────────────────────────────
 * `Ticket.ticketCode` is a PUBLIC lookup label (`lib/ticketing/tickets/reference.ts`): the
 * wallet QR encodes `TICKET:<ticketCode>`, never `qrTokenHash`/the scanner secret. The owner
 * asked for the QR/ticket code, and this renderer prints only that public pair — never a raw
 * scanner token, never a new token, never an image or attachment.
 *
 * A ticket exists only after the separate issuance step, which settlement deliberately does not
 * run. So in the normal SETTLED flow the snapshot has no tickets and the section is replaced by
 * one factual sentence. That limitation is reported in `docs/PHASE_2_IMPLEMENTATION_REPORT.md`
 * rather than worked around by changing the issuance flow.
 */

export const PURCHASE_PROOF_TEMPLATE_KEY = "purchase-proof.v1";
export const PURCHASE_PROOF_VERSION = "v1";

/** The owner-approved opening sentence, verbatim. */
export const PURCHASE_PROOF_OPENING =
    "Bukti pembelian Anda telah berhasil dikonfirmasi. Simpan pesan ini sebagai referensi transaksi Anda.";

const MAX_ITEMS = 10;
const MAX_ITEM_NAME = 120;
const MAX_TEXT = 200;
const MAX_TICKETS = 20;
const MAX_EMAIL_LENGTH = 254;

export type PurchaseProofItemPayload = {
    name: string;
    quantity: number;
    unitPrice: string;
    subtotal: string;
};

export type PurchaseProofPayload = {
    version: typeof PURCHASE_PROOF_VERSION;
    orderNumber: string;
    buyerName: string;
    /** ISO instant of settlement. */
    paidAt: string;
    /** ISO instant the order was created, used only if `paidAt` is unreadable. */
    createdAt: string;
    currency: string;
    items: PurchaseProofItemPayload[];
    /** Total line count, so a truncated list can say how much it omitted. */
    itemCount: number;
    subtotal: string;
    discount: string;
    total: string;
    paymentMethod: string | null;
    paymentChannel: string | null;
    paymentStatus: string;
    event: {
        title: string;
        startAt: string;
        endAt: string | null;
        timezone: string;
        venueName: string | null;
        venueAddress: string | null;
        venueCity: string | null;
    };
    organizerName: string;
    store: {
        name: string;
        email: string | null;
        phone: string | null;
        address: string | null;
    } | null;
    /** PUBLIC ticket codes only; never the scanner credential. */
    tickets: { ticketCode: string }[];
};

export type RenderedPurchaseProof = {
    subject: string;
    text: string;
};

/* ==========================================
 * SANITIZERS AND FORMATTERS
 * ========================================== */

function clean(value: unknown, max = MAX_TEXT): string {
    if (typeof value !== "string") {
        return "";
    }

    return value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);
}

function isoDate(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? null : value;
}

/**
 * Format a stored decimal string as Indonesian money WITHOUT a binary-float round trip.
 *
 * The snapshot is already a fixed 2-decimal string from `Decimal#toFixed`, so the integer and
 * fraction parts are grouped textually. IDR is printed as `Rp1.234.567`; a non-zero fraction is
 * kept (`Rp1.234.567,50`) rather than rounded away, and a zero fraction is omitted because
 * rupiah has no circulating subunit.
 */
export function formatPurchaseProofMoney(
    value: unknown,
    currency: string
): string {
    const raw =
        typeof value === "string"
            ? value.trim()
            : typeof value === "number" && Number.isFinite(value)
              ? value.toFixed(2)
              : "";

    if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) {
        return "—";
    }

    const negative = raw.startsWith("-");
    const unsigned = negative ? raw.slice(1) : raw;
    const [integer, fraction = "00"] = unsigned.split(".");
    const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const amount = fraction === "00" ? grouped : `${grouped},${fraction}`;
    const prefix = currency.toUpperCase() === "IDR" ? "Rp" : `${currency} `;

    return `${negative ? "-" : ""}${prefix}${amount}`;
}

export function formatPurchaseProofDate(
    iso: string | null,
    timeZone: string | null = "Asia/Jakarta"
): string {
    if (!iso) {
        return "—";
    }

    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) {
        return "—";
    }

    try {
        return new Intl.DateTimeFormat("id-ID", {
            dateStyle: "long",
            timeStyle: "short",
            timeZone: timeZone || "Asia/Jakarta",
        }).format(date);
    } catch {
        return new Intl.DateTimeFormat("id-ID", {
            dateStyle: "long",
            timeStyle: "short",
            timeZone: "Asia/Jakarta",
        }).format(date);
    }
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
    BANK_TRANSFER: "Transfer bank",
    VIRTUAL_ACCOUNT: "Transfer bank (Virtual Account)",
    QRIS: "QRIS",
    E_WALLET: "Dompet digital",
    CREDIT_CARD: "Kartu kredit / debit",
    RETAIL_OUTLET: "Gerai retail",
    COD: "Bayar di tempat",
    OTHER: "Metode lain",
};

export function purchaseProofPaymentMethod(
    method: unknown,
    channel: unknown
): string | null {
    const key = clean(method, 40);
    const label = PAYMENT_METHOD_LABELS[key] ?? (key ? key.replace(/_/g, " ") : "");

    if (!label) {
        return null;
    }

    const channelLabel = clean(channel, 40);

    return channelLabel ? `${label} — ${channelLabel.toUpperCase()}` : label;
}

function paymentStatusLabel(status: unknown): string {
    return clean(status, 30) === "PAID" ? "Lunas" : clean(status, 30) || "—";
}

/** Only a code matching the public ticket format is printed. No other identifier qualifies. */
const PUBLIC_TICKET_CODE =
    /^EVT-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;

function publicTicketCodes(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const codes: string[] = [];
    const seen = new Set<string>();

    for (const entry of value) {
        const candidate =
            typeof entry === "string"
                ? clean(entry, 32)
                : typeof entry === "object" && entry !== null
                  ? clean((entry as { ticketCode?: unknown }).ticketCode, 32)
                  : "";

        if (PUBLIC_TICKET_CODE.test(candidate) && !seen.has(candidate)) {
            seen.add(candidate);
            codes.push(candidate);
        }

        if (codes.length >= MAX_TICKETS) {
            break;
        }
    }

    return codes;
}

function itemsOf(value: unknown): PurchaseProofItemPayload[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((entry) => {
            if (typeof entry !== "object" || entry === null) {
                return null;
            }

            const row = entry as Record<string, unknown>;
            const name = clean(row.name, MAX_ITEM_NAME);
            const quantity =
                typeof row.quantity === "number" && Number.isSafeInteger(row.quantity)
                    ? row.quantity
                    : 0;

            if (!name || quantity <= 0) {
                return null;
            }

            return {
                name,
                quantity,
                unitPrice: clean(row.unitPrice, 40),
                subtotal: clean(row.subtotal, 40),
            };
        })
        .filter((entry): entry is PurchaseProofItemPayload => entry !== null);
}

/* ==========================================
 * THE RENDERER
 * ========================================== */

export function renderPurchaseProof(
    payload: Record<string, unknown>
): RenderedPurchaseProof {
    const orderNumber = clean(payload.orderNumber, 80) || "—";
    const currency = clean(payload.currency, 8) || "IDR";
    const buyerName = clean(payload.buyerName, MAX_TEXT) || "—";
    const items = itemsOf(payload.items);
    const totalLines = Array.isArray(payload.items)
        ? payload.items.length
        : items.length;
    const itemCount =
        typeof payload.itemCount === "number" &&
        Number.isSafeInteger(payload.itemCount) &&
        payload.itemCount > 0
            ? payload.itemCount
            : totalLines;

    const event =
        typeof payload.event === "object" && payload.event !== null
            ? (payload.event as Record<string, unknown>)
            : {};
    const eventTitle = clean(event.title, MAX_TEXT) || "—";
    const timezone = clean(event.timezone, 60) || "Asia/Jakarta";
    const venueName = clean(event.venueName, MAX_TEXT);
    const venueAddress = clean(event.venueAddress, 300);
    const venueCity = clean(event.venueCity, 100);
    const location =
        [venueName, venueAddress, venueCity].filter(Boolean).join(", ");

    const store =
        typeof payload.store === "object" && payload.store !== null
            ? (payload.store as Record<string, unknown>)
            : null;
    const storeName = clean(store?.name, MAX_TEXT);
    const storeEmail = clean(store?.email, MAX_EMAIL_LENGTH);
    const storePhone = clean(store?.phone, 40);
    const storeAddress = clean(store?.address, 300);

    const organizerName = clean(payload.organizerName, MAX_TEXT);
    const method = purchaseProofPaymentMethod(
        payload.paymentMethod,
        payload.paymentChannel
    );
    const paidAt = isoDate(payload.paidAt) ?? isoDate(payload.createdAt);

    const lines: string[] = [
        PURCHASE_PROOF_OPENING,
        "",
        `Nomor transaksi: ${orderNumber}`,
        `Tanggal transaksi: ${formatPurchaseProofDate(paidAt, timezone)}`,
        `Nama pembeli: ${buyerName}`,
        ...(organizerName ? [`Penyelenggara: ${organizerName}`] : []),
        "",
        "Detail pembelian:",
    ];

    const shown = items.slice(0, MAX_ITEMS);

    if (shown.length === 0) {
        lines.push("- Detail item tidak tersedia pada catatan transaksi.");
    } else {
        shown.forEach((item, index) => {
            lines.push(
                `${index + 1}. ${item.name} — ${item.quantity} × ${formatPurchaseProofMoney(
                    item.unitPrice,
                    currency
                )} = ${formatPurchaseProofMoney(item.subtotal, currency)}`
            );
        });

        const omitted = itemCount - shown.length;

        if (omitted > 0) {
            lines.push(`… dan ${omitted} item lainnya.`);
        }
    }

    lines.push(
        "",
        `Subtotal: ${formatPurchaseProofMoney(payload.subtotal, currency)}`
    );

    const discount = formatPurchaseProofMoney(payload.discount, currency);

    if (discount !== "—" && discount !== formatPurchaseProofMoney("0", currency)) {
        lines.push(`Diskon: -${discount}`);
    }

    lines.push(
        `Total pembayaran: ${formatPurchaseProofMoney(payload.total, currency)}`,
        `Metode pembayaran: ${method ?? "Tidak tercatat"}`,
        `Status pembayaran: ${paymentStatusLabel(payload.paymentStatus)}`,
        "",
        `Event: ${eventTitle}`,
        `Jadwal: ${formatPurchaseProofDate(isoDate(event.startAt), timezone)}${
            isoDate(event.endAt)
                ? ` – ${formatPurchaseProofDate(isoDate(event.endAt), timezone)}`
                : ""
        }`,
        `Lokasi: ${location || "Tidak tersedia"}`
    );

    const ticketCodes = publicTicketCodes(payload.tickets);

    lines.push("", "Tiket:");

    if (ticketCodes.length === 0) {
        lines.push(
            "Tiket akan tersedia di halaman pesanan Anda setelah diterbitkan."
        );
    } else {
        for (const code of ticketCodes) {
            // The wallet QR's own payload: the PUBLIC code, namespaced. The scanner secret
            // (`Ticket.qrTokenHash`'s plaintext) is not available to this renderer at all.
            lines.push(`- ${code} (QR: TICKET:${code})`);
        }
    }

    if (store && (storeEmail || storePhone || storeAddress)) {
        lines.push("", `Kontak toko${storeName ? ` — ${storeName}` : ""}:`);

        if (storeEmail) {
            lines.push(`Email: ${storeEmail}`);
        }

        if (storePhone) {
            lines.push(`Telepon: ${storePhone}`);
        }

        if (storeAddress) {
            lines.push(`Alamat: ${storeAddress}`);
        }
    }

    return {
        subject: `Bukti pembelian ${orderNumber} — ${eventTitle}`,
        text: lines.join("\n"),
    };
}
