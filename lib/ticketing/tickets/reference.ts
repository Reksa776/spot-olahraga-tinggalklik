import crypto from "crypto";

import { Prisma } from "@prisma/client";

/**
 * ==========================================
 * PHASE 8 — TICKET IDENTITY, CODE AND QR PAYLOAD
 * ==========================================
 *
 * Pure functions only: no database, no framework, no clock of their own (every generator
 * takes `now` or reads from `crypto`). That is what makes the code format testable without
 * MySQL and keeps the randomness in exactly one place.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * THE TWO DISTINCT IDENTIFIERS, AND WHY THEY MUST NOT BE CONFUSED
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 *   ticketCode     PUBLIC. Human-readable, printed on the e-ticket, returned by the wallet
 *                  list endpoint (design §26.5), quoted in an email subject (§23.4). It is
 *                  a LOOKUP code, explicitly not a secret — design line 559: "code for
 *                  manual lookup; token for scanning".
 *
 *   qrToken        SECRET. 32 random bytes, base64url. Only its SHA-256 is persisted
 *                  (`Ticket.qrTokenHash`, design §19.1/§19.3). It is the *scanner*
 *                  credential for the future gate app, and it is revocable per ticket
 *                  precisely because it is stored as a hash rather than signed statelessly.
 *
 * Phase 8 generates the secret, persists only its hash, and returns the raw value exactly
 * once — "the raw token is shown once at issuance" (design §19.1). It never reaches the
 * wallet API, the wallet UI, the QR image, a log line or an audit payload.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * WHY THE WALLET QR ENCODES THE PUBLIC CODE AND NOT THE SECRET
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * Design §26.6 analyses returning the permanent `qrToken` to the browser and marks it
 * **Rejected** ("it lives in the DOM, in browser history, in screenshots, and in any
 * XSS-reachable context; it cannot be revoked per-view"), and §23.4 requires that "the QR
 * must be the wallet-derived image, never a raw token embedded as a scan payload without
 * authentication". Brief §36 puts it plainly: **QR is NOT authorization.**
 *
 * The payload is therefore `TICKET:<ticketCode>` — a stable, opaque, non-PII reference that
 * a future gate scanner resolves server-side (hash/state/event/authorization) before
 * admitting anyone. It is deliberately NOT a URL: brief §25/§37 forbid creating a public
 * ticket page, and a URL in a QR invites exactly that.
 *
 * `DECISION REQUIRED — D-46` (short-lived display token vs server-rendered image) is
 * reported, not silently settled. See the Phase 8 report; the mechanism implemented here is
 * the design's own **recommended** option ("server-rendered image for the web wallet") and
 * the one its §23.4 content rule mandates.
 */

/* ==========================================
 * PUBLIC TICKET CODE
 * ========================================== */

/**
 * Crockford-style alphabet: no `0`/`O`, no `1`/`I`/`L`.
 *
 * A gate usher reads these aloud and types them when a QR will not scan, so the characters
 * that are most often transcribed wrongly are simply not present. 32 symbols also makes the
 * encoding a clean power of two.
 */
export const TICKET_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

const TICKET_CODE_PREFIX = "EVT";
const TICKET_CODE_GROUP_LENGTH = 4;
const TICKET_CODE_GROUPS = 2;

export const TICKET_CODE_PATTERN = /^EVT-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;

/**
 * `EVT-XXXX-XXXX` — the shape design §19.1 gives in its own example (`EVT-7K3M-0A1B`).
 *
 * The design's example shows the last character incrementing per ticket
 * (`…0A1B`, `…0A1C`, `…0A1D`), but the same row says "non-sequential, random suffix". The
 * random reading is the load-bearing one — a sequential code lets anyone who bought one
 * ticket enumerate the whole event's worth — so every character is drawn independently here.
 *
 * `crypto.randomInt` is used rather than `Math.random`: this value is public, but it is the
 * lookup key for a ticket, and a predictable generator would let an observer predict other
 * buyers' codes. Uniqueness is enforced by `Ticket.ticketCode @unique` and retried by the
 * caller, so a collision is caught by the database rather than hoped away.
 */
export function generateTicketCode(): string {
    const groups: string[] = [];

    for (let group = 0; group < TICKET_CODE_GROUPS; group += 1) {
        let value = "";

        for (let index = 0; index < TICKET_CODE_GROUP_LENGTH; index += 1) {
            value += TICKET_CODE_ALPHABET[
                crypto.randomInt(TICKET_CODE_ALPHABET.length)
            ];
        }

        groups.push(value);
    }

    return `${TICKET_CODE_PREFIX}-${groups.join("-")}`;
}

/** Shape check for route parameters and defensive assertions. */
export function isTicketCode(value: unknown): value is string {
    return typeof value === "string" && TICKET_CODE_PATTERN.test(value);
}

/* ==========================================
 * OPAQUE QR TOKEN (the scanner credential)
 * ========================================== */

/**
 * The number of random bytes in a QR token. Design §19.3: `randomBytes(32)`.
 *
 * 256 bits of entropy is far beyond what a brute-force search could cover, and it is the
 * figure the design fixes, so it is not a tunable.
 */
export const QR_TOKEN_BYTES = 32;

/**
 * `base64url(randomBytes(32))` — design §19.3, verbatim.
 *
 * base64url (not plain base64) because the value ends up in a query string
 * (`…/t/{ticketCode}?k={token}`) and `+`/`/`/`=` would need escaping.
 */
export function generateQrToken(): string {
    return crypto.randomBytes(QR_TOKEN_BYTES).toString("base64url");
}

/**
 * The ONLY representation of the token that is ever persisted.
 *
 * Unsalted SHA-256 is correct here and a password hash is not: the input is 256 bits of
 * uniform randomness, so there is no dictionary to attack and no need for work-factor
 * stretching. The scan path is also the latency-critical lookup in the system (design
 * line 3254 names `qrTokenHash UNIQUE` as exactly that), and a slow KDF would tax every
 * gate scan. Salting would make the indexed lookup impossible.
 */
export function hashQrToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

/* ==========================================
 * WALLET QR PAYLOAD
 * ========================================== */

/** Namespace so a future scanner can tell a ticket payload from any other QR it meets. */
export const TICKET_QR_PREFIX = "TICKET:";

/**
 * The exact string the wallet QR encodes.
 *
 * Deterministic, stable across every read, immutable for the life of the ticket, and
 * containing no PII and no secret — asserted by the Phase 8 tests and by the static guards.
 * The server supplies it (mirroring `GET /api/events/{slug}/share`'s `qr.payload` contract)
 * so the client cannot encode something different.
 */
export function buildTicketQrPayload(ticketCode: string): string {
    if (!isTicketCode(ticketCode)) {
        throw new Error(
            `buildTicketQrPayload: not a ticket code: ${String(ticketCode).slice(0, 40)}`
        );
    }

    return `${TICKET_QR_PREFIX}${ticketCode}`;
}

/**
 * Assert that a value destined for a QR image carries no personal or financial data.
 *
 * Belt-and-braces for the static guard: the payload is built from a validated ticket code,
 * so this can only fire if a future edit widens the input. It is cheap and it fails loudly
 * rather than shipping a credential into a camera-readable image.
 */
export function assertQrPayloadIsSafe(payload: string): void {
    if (!payload.startsWith(TICKET_QR_PREFIX)) {
        throw new Error("QR payload must be namespaced with TICKET:");
    }

    if (!isTicketCode(payload.slice(TICKET_QR_PREFIX.length))) {
        throw new Error("QR payload must carry a ticket code and nothing else");
    }

    // A ticket code is drawn from the ambiguity-free alphabet, so an email, phone number,
    // URL or money value cannot appear here — but assert it rather than assume it.
    if (/[@:+?&#/]/.test(payload.slice(TICKET_QR_PREFIX.length))) {
        throw new Error("QR payload must not contain PII, a URL or a money value");
    }
}

/* ==========================================
 * HELPERS SHARED WITH THE ISSUANCE SERVICE
 * ========================================== */

/** Prisma's unique-violation predicate, narrowed to a named constraint where available. */
export function isUniqueViolation(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        return error.code === "P2002";
    }

    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2002"
    );
}

/** Which unique constraint a `P2002` names, e.g. `["ticketCode"]`. */
export function uniqueViolationTargets(error: unknown): string[] {
    if (!isUniqueViolation(error)) {
        return [];
    }

    const meta = (error as { meta?: { target?: unknown } }).meta;

    if (Array.isArray(meta?.target)) {
        return meta.target.map(String);
    }

    if (typeof meta?.target === "string") {
        return [meta.target];
    }

    return [];
}
