/**
 * ==========================================
 * EVENT DATE/TIME — WIB IS THE OPERATOR'S CLOCK
 * ==========================================
 *
 * The product runs on WIB (Asia/Jakarta, UTC+7, no DST). An organizer may open the
 * dashboard from a laptop set to UTC, or from a phone that travelled; a wall clock they
 * type must still mean the same instant for everyone. So every conversion here is pinned
 * to WIB rather than to `Date#getTimezoneOffset()`:
 *
 *   input  "2026-11-15T19:30" (WIB)  →  stored "2026-11-15T12:30:00.000Z" (UTC)
 *   stored "2026-11-15T12:30:00.000Z" →  shown "Minggu, 15 November 2026, 19:30 WIB"
 *
 * This module is pure and renderer-free, so the same rules are testable without a
 * browser. It is used by the event form (create + edit) and by the Zod schema, which
 * means a `datetime-local` string sent straight to the API is read as WIB too — not as
 * the server process's local time.
 */

export const WIB_TIME_ZONE = "Asia/Jakarta";
export const WIB_OFFSET_MINUTES = 7 * 60;

const WIB_OFFSET_MS = WIB_OFFSET_MINUTES * 60_000;

const DAY_NAMES = [
    "Minggu",
    "Senin",
    "Selasa",
    "Rabu",
    "Kamis",
    "Jumat",
    "Sabtu",
] as const;

const MONTH_NAMES = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
] as const;

/** `YYYY-MM-DDTHH:mm` / `YYYY-MM-DDTHH:mm:ss` — the value a `datetime-local` input yields. */
const LOCAL_INPUT_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

type WibParts = {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    weekday: number;
};

/** Calendar parts of an instant as they appear on a WIB wall clock. */
function wibParts(date: Date): WibParts {
    const shifted = new Date(date.getTime() + WIB_OFFSET_MS);

    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
        weekday: shifted.getUTCDay(),
    };
}

/**
 * Parse a datetime the way the operator meant it.
 *
 * A bare `YYYY-MM-DDTHH:mm[:ss]` is WIB. A string with an explicit designator (`Z` or
 * `+07:00`) is honoured as written, because it already names an instant. Anything else
 * falls back to `Date`'s parser; an impossible date (31 February) is rejected rather
 * than silently rolled forward.
 */
export function parseEventDateTime(value: string): Date | null {
    const trimmed = value.trim();

    if (!trimmed) return null;

    const local = LOCAL_INPUT_PATTERN.exec(trimmed);

    if (local) {
        const [, year, month, day, hour, minute, second] = local;
        const date = new Date(
            Date.UTC(
                Number(year),
                Number(month) - 1,
                Number(day),
                Number(hour),
                Number(minute),
                Number(second ?? 0)
            ) - WIB_OFFSET_MS
        );

        const parts = wibParts(date);

        if (
            parts.year !== Number(year) ||
            parts.month !== Number(month) ||
            parts.day !== Number(day) ||
            parts.hour !== Number(hour) ||
            parts.minute !== Number(minute)
        ) {
            return null;
        }

        return date;
    }

    const parsed = new Date(trimmed);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** ISO instant (or `Date`) → the `datetime-local` value a WIB operator should see. */
export function toWibInputValue(
    value: string | Date | null | undefined
): string {
    if (!value) return "";

    const date = typeof value === "string" ? parseEventDateTime(value) : value;

    if (!date || Number.isNaN(date.getTime())) return "";

    const parts = wibParts(date);

    return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(
        parts.hour
    )}:${pad(parts.minute)}`;
}

/** `datetime-local` WIB value → the ISO instant sent to the server. */
export function wibInputToIso(value: string): string | undefined {
    return parseEventDateTime(value)?.toISOString();
}

/** `Sabtu, 15 November 2026, 19:30 WIB` — the readable echo beside the input. */
export function formatWibDateTime(
    value: string | Date | null | undefined
): string {
    if (!value) return "";

    const date = typeof value === "string" ? parseEventDateTime(value) : value;

    if (!date || Number.isNaN(date.getTime())) return "";

    const parts = wibParts(date);

    return `${DAY_NAMES[parts.weekday]}, ${parts.day} ${
        MONTH_NAMES[parts.month - 1]
    } ${parts.year}, ${pad(parts.hour)}:${pad(parts.minute)} WIB`;
}

/** Today's WIB date as a `datetime-local` minimum (`YYYY-MM-DDTHH:mm`). */
export function wibDateTimeMin(now: Date = new Date()): string {
    return toWibInputValue(now);
}

export type EventTimingValues = {
    startAt: string;
    endAt: string;
    salesStartAt: string;
    salesEndAt: string;
};

export type EventTimingField = keyof EventTimingValues;

export type EventTimingErrors = Partial<Record<EventTimingField, string>>;

export type EventTimingOptions = {
    mode: "create" | "edit";
    /** The start already stored on the event; an unchanged past start is legitimate. */
    originalStartAt?: string;
    now?: Date;
};

/**
 * Client-side schedule rules with operator-facing messages.
 *
 * This is convenience, never the control: the same rules are enforced by the Zod schema
 * and again by the service against the stored values. Its value is that an obviously
 * impossible window turns red under the field before a round trip.
 *
 * Empty optional fields are legitimate (`endAt` may be filled before publication,
 * `salesStartAt`/`salesEndAt` are inheritable defaults), so only filled values are
 * compared. `mode: "edit"` exempts the unchanged start from the "not in the past" rule,
 * which is what allows an organizer to edit an event that has already begun.
 */
export function eventTimingErrors(
    values: EventTimingValues,
    options: EventTimingOptions
): EventTimingErrors {
    const errors: EventTimingErrors = {};

    // A new event always needs a start; edit mode keeps the stored one filled in.
    if (!values.startAt) {
        errors.startAt = "Tanggal mulai wajib diisi.";
    }

    const start = values.startAt ? parseEventDateTime(values.startAt) : null;
    const end = values.endAt ? parseEventDateTime(values.endAt) : null;
    const salesStart = values.salesStartAt
        ? parseEventDateTime(values.salesStartAt)
        : null;
    const salesEnd = values.salesEndAt
        ? parseEventDateTime(values.salesEndAt)
        : null;

    if (values.startAt && !start) {
        errors.startAt = "Format tanggal mulai tidak valid.";
    }

    if (values.endAt && !end) {
        errors.endAt = "Format tanggal selesai tidak valid.";
    }

    if (values.salesStartAt && !salesStart) {
        errors.salesStartAt = "Format tanggal mulai penjualan tidak valid.";
    }

    if (values.salesEndAt && !salesEnd) {
        errors.salesEndAt = "Format tanggal akhir penjualan tidak valid.";
    }

    if (start) {
        const unchanged =
            options.mode === "edit" &&
            options.originalStartAt !== undefined &&
            options.originalStartAt === values.startAt;

        if (
            !unchanged &&
            start.getTime() <= (options.now ?? new Date()).getTime()
        ) {
            errors.startAt = "Tanggal mulai tidak boleh di masa lalu.";
        }
    }

    if (start && end && end.getTime() <= start.getTime()) {
        errors.endAt = "Tanggal selesai harus setelah tanggal mulai.";
    }

    if (start && salesStart && salesStart.getTime() >= start.getTime()) {
        errors.salesStartAt = "Penjualan harus dimulai sebelum event.";
    }

    if (start && salesEnd && salesEnd.getTime() > start.getTime()) {
        errors.salesEndAt = "Penjualan harus berakhir sebelum event dimulai.";
    }

    if (
        !errors.salesEndAt &&
        salesStart &&
        salesEnd &&
        salesEnd.getTime() < salesStart.getTime()
    ) {
        errors.salesEndAt =
            "Penjualan harus berakhir setelah waktu mulai penjualan.";
    }

    return errors;
}
