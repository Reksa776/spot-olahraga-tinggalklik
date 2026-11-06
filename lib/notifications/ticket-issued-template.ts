/**
 * ==========================================
 * TICKET ISSUED — `ticket-issued.v1`
 * ==========================================
 *
 * One renderer for email and WhatsApp. The payload is a snapshot built by
 * `ticket-issued.ts` from committed rows; this module only formats it.
 *
 * Code-link only: the owner chose `code_link`, so this template never claims a QR image is
 * attached, never renders an ASCII QR, and never touches the transport contract. The wallet
 * link points at the existing authenticated wallet.
 *
 * Security: only public `EVT-XXXX-XXXX` ticket codes are printed. The scanner credential
 * hash and the raw scanner token are not part of the payload and are never selected by the
 * helper.
 */

import { isTicketCode } from "@/lib/ticketing/tickets/reference";

import { formatPurchaseProofDate } from "./purchase-proof-template";

export const TICKET_ISSUED_TEMPLATE_KEY = "ticket-issued.v1";
export const TICKET_ISSUED_VERSION = "v1";
export const TICKET_ISSUED_OPENING =
    "Tiket Anda telah berhasil diterbitkan.";

const MAX_TICKETS = 20;
const MAX_TEXT = 200;
const MAX_URL = 2_000;
const MAX_EMAIL_LENGTH = 254;

export type TicketIssuedPayload = {
    version: typeof TICKET_ISSUED_VERSION;
    orderNumber: string;
    event: {
        title: string;
        startAt: string;
        endAt: string | null;
        timezone: string;
        venueName: string | null;
        venueAddress: string | null;
        venueCity: string | null;
    };
    /** Number of valid ISSUED tickets in the database, not the number printed. */
    ticketCount: number;
    tickets: { ticketCode: string }[];
    /** Authenticated wallet page, or null when no trusted app origin is configured. */
    walletUrl: string | null;
    store: {
        name: string;
        email: string | null;
        phone: string | null;
        address: string | null;
    } | null;
};

export type RenderedTicketIssued = {
    subject: string;
    text: string;
};

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

function safeWalletUrl(value: unknown): string | null {
    const raw = clean(value, MAX_URL);

    if (!raw) {
        return null;
    }

    try {
        const parsed = new URL(raw);

        return parsed.protocol === "https:" || parsed.protocol === "http:"
            ? parsed.toString().replace(/\/+$/, "")
            : null;
    } catch {
        return null;
    }
}

/**
 * Only public ticket codes are printable. A malformed stored value is omitted rather than
 * repaired or truncated into something that looks valid.
 */
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

        if (isTicketCode(candidate) && !seen.has(candidate)) {
            seen.add(candidate);
            codes.push(candidate);
        }
    }

    return codes;
}

export function renderTicketIssued(
    payload: Record<string, unknown>
): RenderedTicketIssued {
    const orderNumber = clean(payload.orderNumber, 80) || "—";
    const event =
        typeof payload.event === "object" && payload.event !== null
            ? (payload.event as Record<string, unknown>)
            : {};

    const eventTitle = clean(event.title, MAX_TEXT) || "—";
    const timezone = clean(event.timezone, 60) || "Asia/Jakarta";
    const startAt = isoDate(event.startAt);
    const endAt = isoDate(event.endAt);
    const venueName = clean(event.venueName, MAX_TEXT);
    const venueAddress = clean(event.venueAddress, 300);
    const venueCity = clean(event.venueCity, 100);
    const location = [venueName, venueAddress, venueCity]
        .filter(Boolean)
        .join(", ");

    const codes = publicTicketCodes(payload.tickets);
    const shown = codes.slice(0, MAX_TICKETS);
    const rawCount =
        typeof payload.ticketCount === "number" &&
        Number.isSafeInteger(payload.ticketCount) &&
        payload.ticketCount > 0
            ? payload.ticketCount
            : codes.length;
    const ticketCount = Math.max(rawCount, codes.length);

    const walletUrl = safeWalletUrl(payload.walletUrl);

    const store =
        typeof payload.store === "object" && payload.store !== null
            ? (payload.store as Record<string, unknown>)
            : null;
    const storeName = clean(store?.name, MAX_TEXT);
    const storeEmail = clean(store?.email, MAX_EMAIL_LENGTH);
    const storePhone = clean(store?.phone, 40);
    const storeAddress = clean(store?.address, 300);

    const lines: string[] = [
        TICKET_ISSUED_OPENING,
        "",
        `Nomor transaksi: ${orderNumber}`,
        `Event: ${eventTitle}`,
        `Jadwal: ${formatPurchaseProofDate(startAt, timezone)}${
            endAt
                ? ` – ${formatPurchaseProofDate(endAt, timezone)}`
                : ""
        }`,
    ];

    if (location) {
        lines.push(`Lokasi: ${location}`);
    }

    lines.push(
        "",
        `Jumlah tiket: ${ticketCount}`,
        "",
        "Kode tiket:"
    );

    if (shown.length === 0) {
        lines.push("- Kode tiket belum tersedia.");
    } else {
        shown.forEach((code, index) => {
            lines.push(`${index + 1}. ${code}`);
        });

        if (ticketCount > shown.length) {
            // Deliberately no omitted count: the full set is reachable in the wallet, and a
            // number here would only invite a support question about codes not shown.
            lines.push(
                "Seluruh tiket dapat dilihat melalui halaman Tiket Saya."
            );
        }
    }

    lines.push("", "Buka e-tiket dan QR Anda:");

    if (walletUrl) {
        lines.push(walletUrl);
    } else {
        lines.push(
            "Buka halaman Tiket Saya di aplikasi untuk melihat e-tiket dan QR Anda."
        );
    }

    lines.push(
        "",
        "Tunjukkan QR pada halaman Tiket Saya di pintu masuk atau sebutkan kode tiket kepada petugas.",
        "E-tiket ini bersifat pribadi. Jangan bagikan tangkapan layarnya."
    );

    if (store && (storeEmail || storePhone || storeAddress)) {
        lines.push(
            "",
            `Kontak toko${storeName ? ` — ${storeName}` : ""}:`
        );

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
        subject: `Tiket Anda — ${eventTitle} (${orderNumber})`,
        text: lines.join("\n"),
    };
}
