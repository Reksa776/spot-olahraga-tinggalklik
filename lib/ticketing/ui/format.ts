/**
 * ==========================================
 * PHASE 9 — DISPLAY FORMATTING (pure)
 * ==========================================
 *
 * One place where ticketing UI turns server values into Indonesian strings. Extracted for the
 * usual two reasons: the pages stay declarative, and `Intl` output is testable without a
 * renderer.
 *
 * These are **display only**. The value of record for money is the `Decimal(14,2)` column and
 * the decimal string in the payload (D-61); nothing here is ever written back, compared, or
 * used in a request. `Number(...)` appears exactly once, inside `formatIdr`, and only for a
 * value the server already computed.
 *
 * Timezone: every formatter pins `Asia/Jakarta`, matching the event payloads' own `timezone`
 * handling and the "WIB" suffix the UI has always shown.
 */

const TIME_ZONE = "Asia/Jakarta";

/** `Rp150.000` — no decimals, which is how IDR ticket prices are quoted in this market. */
const IDR = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
});

/** `Sab, 20 Sep 2026` */
const DATE_SHORT = new Intl.DateTimeFormat("id-ID", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: TIME_ZONE,
});

/** `Sabtu, 20 September 2026` */
const DATE_LONG = new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: TIME_ZONE,
});

/** `20 Sep` — the calendar chip on a card. */
const DATE_COMPACT = new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    timeZone: TIME_ZONE,
});

/** The two halves of the calendar chip, formatted separately so nothing splits a string. */
const DAY_ONLY = new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    timeZone: TIME_ZONE,
});

const MONTH_ONLY = new Intl.DateTimeFormat("id-ID", {
    month: "short",
    timeZone: TIME_ZONE,
});

/** `19.00` */
const TIME = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIME_ZONE,
});

export function formatIdr(value: number): string {
    return IDR.format(value);
}

/**
 * A price label for a card or a ticket tier list.
 *
 * A range is only shown when the upper bound is genuinely higher, so a single-tier event reads
 * as a price rather than as a degenerate range. `null` (no active tier has a price) is stated
 * in words instead of as `Rp0`, which would be a lie.
 */
export function formatPriceRange(from: number | null, to: number | null): string {
    if (from === null) {
        return "Harga menyusul";
    }

    if (to !== null && to > from) {
        return `${IDR.format(from)} – ${IDR.format(to)}`;
    }

    return IDR.format(from);
}

/** `Mulai dari Rp150.000` — the "from" framing used on cards and the sticky bar. */
export function formatPriceFrom(from: number | null): string {
    return from === null ? "Harga menyusul" : `Mulai ${IDR.format(from)}`;
}

export function formatEventDateShort(iso: string): string {
    return DATE_SHORT.format(new Date(iso));
}

export function formatEventDateLong(iso: string): string {
    return DATE_LONG.format(new Date(iso));
}

export function formatEventDateCompact(iso: string): string {
    return DATE_COMPACT.format(new Date(iso));
}

export function formatEventTime(iso: string): string {
    return TIME.format(new Date(iso));
}

/** `20` — the big number in a card's calendar chip. */
export function formatEventDay(iso: string): string {
    return DAY_ONLY.format(new Date(iso));
}

/** `Sep` */
export function formatEventMonthShort(iso: string): string {
    return MONTH_ONLY.format(new Date(iso));
}

/**
 * `Sab, 20 Sep 2026 · 19.00 WIB`, with `– 21.00 WIB` appended when the event has an end time
 * on the same calendar day. An end on another day is shown as a separate date rather than as a
 * misleading time range.
 */
export function formatEventSchedule(startIso: string, endIso: string | null): string {
    const start = new Date(startIso);
    const base = `${DATE_SHORT.format(start)} · ${TIME.format(start)} WIB`;

    if (!endIso) {
        return base;
    }

    const end = new Date(endIso);
    const sameDay = DATE_SHORT.format(end) === DATE_SHORT.format(start);

    return sameDay
        ? `${base} – ${TIME.format(end)} WIB`
        : `${base} – ${DATE_SHORT.format(end)} · ${TIME.format(end)} WIB`;
}

/** `Bandung` from a venue row, or a neutral placeholder. */
export function formatVenue(
    venueName: string | null,
    venueCity: string | null
): string {
    if (venueName && venueCity) {
        return `${venueName}, ${venueCity}`;
    }

    return venueName ?? venueCity ?? "Lokasi menyusul";
}

/**
 * Why an event cannot be bought right now, in the buyer's words. Returns `null` when it can.
 *
 * Reads only the catalog's own `salesState`/`isSoldOut` vocabulary — no new state is invented,
 * and the mapping is one-way (presentation).
 */
export function salesStateLabel(
    salesState: string,
    isSoldOut: boolean,
    isAvailable = true
): string | null {
    if (!isAvailable) {
        return "Tidak tersedia";
    }

    if (isSoldOut || salesState === "SOLD_OUT") {
        return "Tiket habis";
    }

    if (salesState === "NOT_STARTED") {
        return "Belum dibuka";
    }

    if (salesState === "CLOSED") {
        return "Penjualan ditutup";
    }

    return null;
}

/** `2 tiket` / `1 tiket` — small counts read in the wallet and order summaries. */
export function pluralTickets(count: number): string {
    return `${count} tiket`;
}
