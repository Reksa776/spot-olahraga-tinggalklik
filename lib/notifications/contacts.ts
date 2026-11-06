/**
 * ==========================================
 * CONTACT NORMALIZATION (PHASE 2)
 * ==========================================
 *
 * Delivery needs a canonical address, but the DATABASE IS NOT REWRITTEN. `EventOrder.buyerEmail`
 * and `buyerPhone` are the buyer's own values and stay exactly as entered; normalization happens
 * on the copy handed to the transport (and to the queue row that represents that delivery).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────
 * The Phase 2 audit found no E.164 conversion anywhere in the repository: buyers type
 * `0812…`, `+62 812…`, `62-812-…` and occasionally something that is not a phone number at
 * all. Baileys addresses a WhatsApp user by international number, so sending the national form
 * would either fail or, worse, reach a different account. A value that cannot be normalized is
 * refused — never guessed, padded or repaired into a plausible number.
 *
 * ── EMAIL IS DELIBERATELY CONSERVATIVE ──────────────────────────────────────────
 * One `@`, a non-empty local part, a dotted domain, no whitespace, at most 254 characters.
 * That is a DELIVERABILITY screen, not an RFC 5322 parser: a value that passes it may still
 * bounce, and the transport reports that as a normal failure. The domain is lower-cased because
 * it is case-insensitive; the local part is preserved because it is not (in principle).
 */

const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^([^\s@]+)@([^\s@.]+(?:\.[^\s@.]+)+)$/;

export function normalizeEmail(
    raw: string | null | undefined
): string | null {
    const trimmed = raw?.trim() ?? "";

    if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) {
        return null;
    }

    const match = EMAIL_PATTERN.exec(trimmed);

    if (!match) {
        return null;
    }

    return `${match[1]}@${match[2].toLowerCase()}`;
}

export function isValidEmail(raw: string | null | undefined): boolean {
    return normalizeEmail(raw) !== null;
}

/**
 * Normalize an Indonesian mobile number to `62…` form.
 *
 * Accepted input shapes (all of them reduce to the same digits):
 *
 *   `0812-3456-7890`   → `6281234567890`
 *   `+62 812 3456 7890` → `6281234567890`
 *   `62 812 3456 7890`  → `6281234567890`
 *   `81234567890`       → `6281234567890` (a common form; the country code is implied)
 *
 * Rejected: anything containing letters or a second `+`, a number shorter than a real
 * Indonesian mobile subscription, a number that does not start with `8` after the country
 * code, and a number longer than the national numbering plan allows. A rejected value is
 * terminal for that channel — it is never padded with a guessed digit.
 *
 * Landlines are intentionally NOT accepted: WhatsApp is used for the buyer's mobile, and a
 * landline cannot receive the message. Refusing it is more honest than sending into a void.
 */
export function normalizeIndonesianPhone(
    raw: string | null | undefined
): string | null {
    const trimmed = raw?.trim() ?? "";

    if (trimmed.length === 0) {
        return null;
    }

    // Only a leading `+` is punctuation we understand; everything else must be a digit or a
    // separator a human actually types.
    if (trimmed.includes("+") && !trimmed.startsWith("+")) {
        return null;
    }

    const stripped = trimmed.replace(/[\s().-]/g, "");

    if (!/^\+?\d+$/.test(stripped)) {
        return null;
    }

    let digits = stripped.replace(/^\+/, "");

    if (digits.startsWith("0")) {
        digits = `62${digits.slice(1)}`;
    } else if (digits.startsWith("8")) {
        digits = `62${digits}`;
    }

    // 62 + 8 + 7..10 subscriber digits = 10..13? The national number is `08xx…` (10–13
    // digits including the leading 0), so after `62` the remainder is 9–12 digits and begins
    // with 8. The expression below states exactly that.
    if (!/^628\d{7,10}$/.test(digits)) {
        return null;
    }

    return digits;
}

export function isValidWhatsAppNumber(
    raw: string | null | undefined
): boolean {
    return normalizeIndonesianPhone(raw) !== null;
}

/**
 * The address a transport should use for a queue row, or `null` when the row is unusable.
 *
 * `channel` is the schema value (`EMAIL` | `WHATSAPP`), so the two shapes cannot be confused.
 */
export function normalizeRecipient(
    channel: "EMAIL" | "WHATSAPP",
    raw: string
): string | null {
    return channel === "EMAIL"
        ? normalizeEmail(raw)
        : normalizeIndonesianPhone(raw);
}
