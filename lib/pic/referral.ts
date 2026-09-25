/**
 * ==========================================
 * PIC REFERRAL TOKEN — mint & verify
 * ==========================================
 *
 * PIC Vertical Slice V1. A referral link must prove, without touching the database, that
 * its `?pic=` value actually names a real, active PIC for the event it sits on — first
 * because the public landing page has no session, and second because a token is the
 * thing users copy, so it must survive being shared around without help from us.
 *
 * The token is a signed handle, not an opaque blob:
 *
 *     raw   = "p1:{picProfileId}:{eventId}"
 *     token = base64url(raw) + "." + base64url( HMAC-SHA256(key, raw)[0..16] )
 *
 * The MAC is truncated to 16 bytes (128 bits) — standard, and more than enough for an
 * offline-forgery budget on a handle whose value to an attacker is only "free money
 * attribution" (no cash, no credentials). Should a future version need more margin, the
 * footer carries `v1` so the verifier can branch on version BEFORE the MAC is recomputed.
 *
 * SECURITY PROPERTIES (what this module guarantees, and what it does NOT) ──────────────
 *   1. `verifyPicReferralToken` NEVER throws and NEVER returns data for attacker input.
 *      It performs no I/O, no database work sequence, nothing beyond the MAC check — a
 *      scanner can throw any byte soup at it and get `null`.
 *   2. The HMAC comparison is constant-time (`timingSafeEqual` on equal-length buffers,
 *      and the length itself is first pinned to the exact expected value, so there is no
 *      length side channel either).
 *   3. `picProfileId` ONLY ever proves "a PIC Profile with this id was granted a signed
 *      token for this event". It is NOT an authorization by itself: the checkout resolver
 *      re-checks profile `status == ACTIVE` and the assignment `isActive == true` against
 *      CURRENT rows, so a revoked/suspended PIC cannot ride a stale-but-signed token.
 *   4. Version + eventId agreement is checked INSIDE the verifier, so a token minted for
 *      event A cannot be pasted into event B's URL and still resolve (the checkout
 *      resolver cross-checks against the event being bought as a second, cheaper guard).
 *
 * OBVIOUS-QR / SELF-REFERRAL NOTE ──────────────────────────────────────────────────────
 * The design (§14.6 / reverse-nod) has an explicit "self-referral" flag for when the
 * buying account IS the PIC's own account. That flag is decided by the CALLER from the
 * authenticated user id (unknown here), so this module stores no such notion.
 *
 * MINTING SECRET ───────────────────────────────────────────────────────────────────────
 * `PIC_REFERRAL_SECRET`. When it is unset this module is FAIL-CLOSED:
 *      - `mintPicReferralToken` returns `null`  → the UI simply exposes no link, and
 *      - `verifyPicReferralToken` returns `null` → a stale link quietly becomes a normal
 *        no-PIC purchase instead of breaking the sale.
 * A missing secret must never mint weak tokens, and must never fail a real purchase.
 * When set, the shared secret is deliberately NOT truncated to an int field size etc. —
 * it is read from the environment, never stored, never logged.
 */

import crypto from "crypto";

/** Current token version. Must stay `1` until the format actually changes. */
export const PIC_REFERRAL_TOKEN_VERSION = "1";

/** Env var that must hold the shared secret. Deliberately the ONLY piece of state. */
export const PIC_REFERRAL_SECRET_ENV = "PIC_REFERRAL_SECRET";

/** Truncated MAC length in bytes (128 bits of the full HMAC-SHA256 output). */
const PIC_REFERRAL_MAC_BYTES = 16;

/** Bounds guard so a pathological (but legal) id can't make a token absurdly long. */
const MAX_RAW_LENGTH = 160;

interface PicReferralPayload {
    version: string;
    picProfileId: string;
    eventId: string;
}

function secret(): string | null {
    const value = process.env[PIC_REFERRAL_SECRET_ENV];
    return typeof value === "string" && value.length > 0 ? value : null;
}

function buildRaw(picProfileId: string, eventId: string): string {
    return `${PIC_REFERRAL_TOKEN_VERSION}:${picProfileId}:${eventId}`;
}

function computeMac(raw: string, key: string): Buffer {
    const digest = crypto.createHmac("sha256", key).update(raw, "utf8").digest();
    // HMAC-SHA256 truncated to 128 bits — standard for an offline-attribution MAC.
    return digest.subarray(0, PIC_REFERRAL_MAC_BYTES);
}

/**
 * Mint a signed referral token for `picProfileId` + `eventId`.
 *
 * @returns the token (base64url + "." + base64url), or `null` when the secret is unset
 *          (fail-closed, see module doc).
 */
export function mintPicReferralToken(input: {
    picProfileId: string;
    eventId: string;
}): string | null {
    const key = secret();
    if (!key) {
        return null;
    }
    const raw = buildRaw(input.picProfileId, input.eventId);
    if (raw.length > MAX_RAW_LENGTH) {
        return null;
    }
    const payload = Buffer.from(raw, "utf8").toString("base64url");
    const mac = computeMac(raw, key).toString("base64url");
    return `${payload}.${mac}`;
}

/**
 * Verify a token and return its authenticated payload.
 *
 * @returns the payload, or `null` for every failure shape (no secret, malformed token,
 *          bad length, bad version, MAC mismatch). Never throws.
 */
export function verifyPicReferralToken(token: string): PicReferralPayload | null {
    if (typeof token !== "string" || token.length === 0) {
        return null;
    }
    const key = secret();
    if (!key) {
        return null;
    }

    const dot = token.lastIndexOf(".");
    if (dot <= 0 || dot === token.length - 1) {
        return null;
    }
    const payloadB64 = token.slice(0, dot);
    const macB64 = token.slice(dot + 1);

    let raw: string;
    let presentedMac: Buffer;
    try {
        raw = Buffer.from(payloadB64, "base64url").toString("utf8");
        presentedMac = Buffer.from(macB64, "base64url");
    } catch {
        return null;
    }

    // Pinned length — the MAC comparison must happen on equal-length buffers.
    const expectedMac = computeMac(raw, key);
    if (
        presentedMac.length !== expectedMac.length ||
        !crypto.timingSafeEqual(presentedMac, expectedMac)
    ) {
        return null;
    }

    const [version, picProfileId, eventId] = raw.split(":");
    if (version !== PIC_REFERRAL_TOKEN_VERSION) {
        return null; // Unknown/older format — never guess.
    }
if (!picProfileId || !eventId || picProfileId.includes(":") || eventId.includes(":")) {
        return null;
    }
    if (raw.length > MAX_RAW_LENGTH) {
        return null;
    }

    return { version, picProfileId, eventId };
}

/** Check a token against the LOCKED event id the checkout is actually for. */
export function verifyPicReferralTokenForEvent(
    token: string,
    eventId: string
): PicReferralPayload | null {
    const payload = verifyPicReferralToken(token);
    if (!payload || payload.eventId !== eventId) {
        return null;
    }
    return payload;
}