/**
 * ==========================================
 * STRUCTURED LOGGING WITHOUT SECRETS (PHASE 1)
 * ==========================================
 *
 * The worker is the only process that will ever hold SMTP/WhatsApp configuration, so its log is
 * the most likely place for a credential to escape. Two rules are enforced here rather than left
 * to call-site discipline:
 *
 *   1. Deny-listed keys (`password`, `secret`, `token`, `credential`, `apiKey`, `authorization`,
 *      …) are replaced with `[redacted]` before serialisation, whatever their value.
 *   2. Recipient-shaped keys (`recipient`, `to`, `phone`, `email`, `buyerPhone`, …) are MASKED,
 *      because a delivery id is enough to investigate a failure and the recipient is personal
 *      data that the queue row already holds.
 *
 * Provider error messages are additionally sanitised: nodemailer/SMTP errors can embed a URL of
 * the form `smtp://user:password@host`, so any `scheme://…@` prefix is stripped and the message
 * is truncated. Error text is never echoed raw into `notificationdelivery.errorMessage`.
 */

const REDACTED = "[redacted]";

const SECRET_KEY_PATTERN =
    /pass(word)?|secret|token|credential|authorization|api[_-]?key|private[_-]?key|cookie/i;

const RECIPIENT_KEY_PATTERN = /^(recipient|to|email|phone|buyerphone|recipientemail|whatsapp)$/i;

const MAX_STRING_LENGTH = 200;

export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

/** Mask an address so an operator can recognise it without reading it in full. */
export function maskRecipient(value: string): string {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
        return "[empty]";
    }

    const at = trimmed.indexOf("@");

    if (at > 0) {
        const local = trimmed.slice(0, at);
        const domain = trimmed.slice(at + 1);

        return `${local.slice(0, 1)}***@${domain}`;
    }

    if (trimmed.length <= 4) {
        return "***";
    }

    return `***${trimmed.slice(-2)}`;
}

/** Remove `scheme://user:password@` credentials from a provider error, then truncate. */
export function sanitizeErrorMessage(error: unknown): string {
    const raw =
        error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Unknown transport error";

    const withoutCredentials = raw
        // `smtp://user:password@host` → `smtp://[redacted]@host`
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
        // A provider error can echo the address it failed to reach. The delivery row already
        // identifies the notification; the address is personal data and is not needed here.
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
        // Phone-shaped runs (with optional +, spaces, dashes).
        .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-phone]");

    return withoutCredentials.slice(0, 300);
}

function sanitizeValue(key: string, value: unknown): unknown {
    if (value === undefined || value === null) {
        return value;
    }

    if (SECRET_KEY_PATTERN.test(key)) {
        return REDACTED;
    }

    if (RECIPIENT_KEY_PATTERN.test(key) && typeof value === "string") {
        return maskRecipient(value);
    }

    if (typeof value === "string") {
        // Defence in depth: a credential pasted into a message, or a connection string smuggled
        // into a field whose name does not look secret.
        const withCredentialsStripped = value
            .replace(
                /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi,
                "$1[redacted]@"
            )
            // PII can be pasted into an otherwise innocent string field. Redact the
            // address shapes this application handles without mangling ids or timestamps.
            .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
            .replace(/(?:\+?62|0)8\d{7,11}/g, "[redacted-phone]");

        return withCredentialsStripped.slice(0, MAX_STRING_LENGTH);
    }

    if (Array.isArray(value)) {
        return value.slice(0, 10).map((item) =>
            typeof item === "string" ? item.slice(0, MAX_STRING_LENGTH) : item
        );
    }

    return value;
}

export function sanitizeLogFields(fields: LogFields): LogFields {
    const output: LogFields = {};

    for (const [key, value] of Object.entries(fields)) {
        output[key] = sanitizeValue(key, value);
    }

    return output;
}

/**
 * Emit one JSON line. `sink` is injectable so tests can assert that no secret reaches a log
 * without touching stdout.
 */
export function structuredLog(
    level: LogLevel,
    event: string,
    fields: LogFields = {},
    sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): void {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        ...sanitizeLogFields(fields),
    });

    sink(line);
}
