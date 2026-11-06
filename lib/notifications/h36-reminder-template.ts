/**
 * ==========================================
 * PHASE 4 — H-36 REMINDER TEMPLATE (`reminder.h36.v1`)
 * ==========================================
 *
 * A plain-text reminder that an event starts in 36 hours. Pure: no database, no clock of its
 * own, no transport. The payload is built by `h36-reminder.ts` and stored as JSON; this module
 * only renders what it is given.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────────
 * No ticket code, no QR token, no phone, no email, no user id, no order number, no internal
 * id. A reminder is not a credential, and a forwarded message must not expose one. The
 * recipient address lives on the queue row, not in the rendered body.
 *
 * ── TIMEZONE ────────────────────────────────────────────────────────────────────
 * `Event.startAt` is a UTC instant; `Event.timezone` is an IANA zone used ONLY for display.
 * The due calculation never reads it. An invalid instant/zone is refused when the payload is
 * built; the renderer is defensive anyway and falls back to the ISO instant plus the zone
 * label rather than silently showing a guessed local time.
 */

export const H36_REMINDER_TEMPLATE_KEY = "reminder.h36.v1";
export const H36_REMINDER_VERSION = "v1";

export type H36ReminderPayload = {
    version: typeof H36_REMINDER_VERSION;
    event: {
        title: string;
        startAt: string;
        timezone: string;
        venueName: string | null;
        venueAddress: string | null;
        venueCity: string | null;
    };
};

/** Is this an IANA zone the runtime can actually format with? */
export function isValidTimeZone(timezone: string): boolean {
    if (typeof timezone !== "string" || timezone.trim().length === 0) {
        return false;
    }

    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}

/**
 * Format a start instant in the event's zone.
 *
 * A bad instant yields an honest phrase, and an unformattable zone yields the ISO instant plus
 * the zone name. Neither path invents a Jakarta time for an event that is not in Jakarta.
 */
export function formatH36EventTime(
    startAtIso: string,
    timezone: string
): string {
    const date = new Date(startAtIso);

    if (Number.isNaN(date.getTime())) {
        return "waktu yang dijadwalkan";
    }

    try {
        return new Intl.DateTimeFormat("id-ID", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: timezone,
        }).format(date);
    } catch {
        return `${startAtIso} (${timezone})`;
    }
}

/**
 * Build the stored payload, or `null` when the event cannot produce an honest reminder.
 *
 * `null` is not an error to swallow silently: the sweep counts it as ineligible, so an invalid
 * timestamp cannot become a message claiming the wrong time.
 */
export function buildH36ReminderPayload(input: {
    event: {
        title: string;
        startAt: Date;
        timezone: string;
        venue: { name: string; address: string | null; city: string | null } | null;
    };
}): H36ReminderPayload | null {
    const { event } = input;

    if (Number.isNaN(event.startAt.getTime())) {
        return null;
    }

    if (!isValidTimeZone(event.timezone)) {
        return null;
    }

    const title = event.title.trim();

    if (title.length === 0) {
        return null;
    }

    return {
        version: H36_REMINDER_VERSION,
        event: {
            title: title.slice(0, 160),
            startAt: event.startAt.toISOString(),
            timezone: event.timezone,
            venueName: event.venue?.name ?? null,
            venueAddress: event.venue?.address ?? null,
            venueCity: event.venue?.city ?? null,
        },
    };
}

function text(value: unknown, max: number): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

/**
 * Render the reminder.
 *
 * The template is deliberately calm and transactional: it is a reminder for a ticket the
 * recipient already owns, not marketing. There is no opt-out promise, because no preference
 * model exists in this phase.
 */
export function renderH36Reminder(
    payload: Record<string, unknown>
): { subject: string; text: string } {
    const rawEvent =
        typeof payload.event === "object" && payload.event !== null
            ? (payload.event as Record<string, unknown>)
            : {};

    const title = text(rawEvent.title, 160) ?? "Event kamu";
    const startAt = text(rawEvent.startAt, 40);
    const timezone = text(rawEvent.timezone, 64) ?? "Asia/Jakarta";

    const when = startAt
        ? formatH36EventTime(startAt, timezone)
        : "waktu yang dijadwalkan";

    const venueName = text(rawEvent.venueName, 120);
    const venueCity = text(rawEvent.venueCity, 80);
    const venueAddress = text(rawEvent.venueAddress, 200);

    const venue = [venueName, venueAddress, venueCity]
        .filter((part): part is string => part !== null)
        .join(", ");

    const lines = [
        "Halo,",
        "",
        `Ini pengingat otomatis untuk event "${title}".`,
        `Event dijadwalkan mulai dalam 36 jam, pada ${when}.`,
        ...(venue ? [`Lokasi: ${venue}.`] : []),
        "",
        "Tunjukkan tiket dan kode QR kamu di pintu masuk.",
        "",
        "Pesan ini dikirim otomatis oleh TinggalKlik.Co.",
    ];

    return {
        subject: `Pengingat: ${title} dimulai dalam 36 jam`,
        text: lines.join("\n"),
    };
}
