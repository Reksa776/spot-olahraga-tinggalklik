import {
    TICKET_QR_PREFIX,
    buildTicketQrPayload,
    isTicketCode,
} from "@/lib/ticketing/tickets/reference";

/**
 * ==========================================
 * PHASE 3B — CHECK-IN QR PAYLOAD VALIDATION
 * ==========================================
 *
 * Turns whatever a scanner or a keyboard produced into either a canonical ticket code or an
 * explicit refusal. It performs **no** admission decision: existence, event match, status,
 * refund state and duplicate detection all need a database row and belong to the check-in
 * service (Phase 3C). This module only answers "is this text a well-formed ticket reference?".
 *
 * ── THE FORMAT IS NOT DEFINED HERE ──────────────────────────────────────────────
 * The payload is the locked `TICKET:<ticketCode>` of
 * `lib/ticketing/tickets/reference.ts#buildTicketQrPayload` (decision `P14-D17`, Phase 14
 * lock §24). Nothing here invents a second format, a token field, a URL or a checksum: the
 * parser consumes the one contract the wallet already renders, through the same
 * `isTicketCode` / `buildTicketQrPayload` helpers, so a payload the wallet produces is a
 * payload this module accepts, and a payload it would refuse can never be "canonicalised"
 * into one.
 *
 * ── WHY IT ALSO ACCEPTS THE BARE CODE ───────────────────────────────────────────
 * `normalizeCode` in `lib/ticketing/checkin/service.ts` — the code the gate runs today —
 * trims, strips an optional `TICKET:` prefix (case-insensitively), upper-cases, and then
 * requires `isTicketCode`. A gate usher reads a code aloud and types it; a keyboard-wedge
 * scanner types the full payload into the same field. Phase 3C will wire this parser in
 * place of that function, so it must accept **exactly** what the current path accepts and
 * refuse exactly what it refuses — otherwise the swap would silently change admission for
 * inputs nobody thought to test. The parity rules are: trim, optional namespace, case fold,
 * then the code pattern. The one addition is a *classification* of the refusal (which the
 * current function collapses to `null`), so a caller can distinguish an unsupported format
 * from a malformed code without the response ever telling the client which.
 *
 * ── WHY THE REFUSAL CARRIES NO TICKET ID ────────────────────────────────────────
 * A rejection names only the reason. It never echoes the input, so a malformed scan cannot
 * be reflected into a log line, an audit payload or a UI message that would let a caller
 * probe the code space (design §20.2 check 1: malformed ≡ unknown).
 *
 * ── SIDE-EFFECT FREE ────────────────────────────────────────────────────────────
 * No Prisma client, no `@/lib/prisma`, no service import, no session, no clock, no
 * randomness, no environment, no module state. A string in, a decision out — which is what
 * lets the whole matrix be tested without a database.
 */

/**
 * The request schema's `code` bound (`lib/ticketing/checkin/validation.ts`: `.max(120)`).
 * A payload longer than this cannot be a ticket reference and is refused before any parsing.
 */
export const MAX_CHECKIN_QR_PAYLOAD_LENGTH = 120;

/**
 * Why a payload was refused.
 *
 * These are INTERNAL classifications. The check-in route must keep answering every one of
 * them with the same `NOT_FOUND` / `INVALID_TICKET` shape (design §20.2 check 1), so a
 * scanner cannot distinguish "wrong namespace" from "unknown ticket".
 */
export type CheckInQrRejection =
    | "NOT_A_STRING"
    | "EMPTY_PAYLOAD"
    | "PAYLOAD_TOO_LONG"
    | "UNSUPPORTED_FORMAT"
    | "MISSING_CODE"
    | "INVALID_CODE_FORMAT";

/** A payload that named a well-formed ticket. */
export type CheckInQrAccepted = {
    readonly valid: true;
    /** The stored form of the code — upper-case, canonical. */
    readonly ticketCode: string;
    /** Exactly what the wallet would encode for this code, rebuilt by the locked builder. */
    readonly canonicalPayload: string;
    /**
     * How it arrived. Informational only: it says nothing about authenticity, and it must
     * never be used to choose a `CheckInMethod` (see `./method.ts`).
     */
    readonly presentedAs: "TICKET_PREFIX" | "BARE_CODE";
};

/** A payload that did not. */
export type CheckInQrRejected = {
    readonly valid: false;
    readonly reason: CheckInQrRejection;
};

export type CheckInQrPayloadResult = CheckInQrAccepted | CheckInQrRejected;

function reject(reason: CheckInQrRejection): CheckInQrRejected {
    return { valid: false, reason };
}

/** The locked namespace, compared exactly as the gate's original normaliser compared it. */
const NAMESPACE_PREFIX = TICKET_QR_PREFIX;

/**
 * Validate one presented payload.
 *
 * Accepts `unknown` rather than `string` on purpose: the value arrives from a JSON body, a
 * camera decode or a form field, so at the boundary it really is `unknown` and the refusal
 * for a non-string is part of the contract rather than a type error the caller must
 * pre-empt.
 */
export function parseCheckInQrPayload(raw: unknown): CheckInQrPayloadResult {
    if (typeof raw !== "string") {
        return reject("NOT_A_STRING");
    }

    const trimmed = raw.trim();

    if (trimmed.length === 0) {
        return reject("EMPTY_PAYLOAD");
    }

    if (trimmed.length > MAX_CHECKIN_QR_PAYLOAD_LENGTH) {
        return reject("PAYLOAD_TOO_LONG");
    }

    let presentedAs: CheckInQrAccepted["presentedAs"];
    let codeText: string;

    // PHASE 3C — EXACT PARITY WITH THE GATE'S ORIGINAL NORMALISER.
    // The namespace test is deliberately `startsWith`, not "split at the first colon". That is
    // precisely how `normalizeCode` recognised the payload, so `TICKET :EVT-…` (a space before
    // the colon) stays refused rather than being admitted by the parser alone. Swapping the
    // gate onto this parser must not widen the set of inputs it admits.
    if (trimmed.toUpperCase().startsWith(NAMESPACE_PREFIX)) {
        presentedAs = "TICKET_PREFIX";
        codeText = trimmed.slice(NAMESPACE_PREFIX.length).trim();
    } else if (trimmed.includes(":")) {
        // A URL, a mailto:, another product's payload, or a code followed by junk. It is not
        // "a ticket with a typo" — it is a payload this system does not speak.
        return reject("UNSUPPORTED_FORMAT");
    } else {
        // A bare code — the manual-entry path, and the shape a keyboard-wedge gun produces when
        // it is configured to strip the namespace.
        presentedAs = "BARE_CODE";
        codeText = trimmed;
    }

    // Case folding mirrors `normalizeCode`: a buyer's phone may render the payload in lower
    // case, and the stored code is upper-case. Folding happens only here, never in the
    // payload builder.
    const ticketCode = codeText.toUpperCase();

    if (ticketCode.length === 0) {
        return reject("MISSING_CODE");
    }

    if (!isTicketCode(ticketCode)) {
        return reject("INVALID_CODE_FORMAT");
    }

    return {
        valid: true,
        ticketCode,
        // Built by the locked helper, so a "canonical" payload is by construction one the
        // wallet could have produced — including its own internal validation.
        canonicalPayload: buildTicketQrPayload(ticketCode),
        presentedAs,
    };
}
