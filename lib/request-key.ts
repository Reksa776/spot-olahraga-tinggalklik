/**
 * ==========================================
 * CLIENT REQUEST KEYS
 * ==========================================
 *
 * One unique, opaque string per *intent*: the `Idempotency-Key` a browser sends with a creation
 * request (`components/events/TicketPurchaseForm.tsx`, design §30.4) and, in general, any
 * client-generated value that must be unique without a round trip to the server.
 *
 * ── WHY `crypto.randomUUID()` IS NOT CALLED DIRECTLY ────────────────────────────
 * `Crypto.randomUUID` exists only in a SECURE CONTEXT. `https://` and the loopback origin
 * (`localhost`, `127.0.0.1`) qualify; any other plain-HTTP origin does not — so on
 * `http://192.168.1.20:3000`, or any other LAN address used to open the development server from a
 * phone, `window.crypto` is present but the method is simply missing from it. Calling it there
 * throws `TypeError: crypto.randomUUID is not a function`, which is exactly what happened: the
 * checkout button could not be used at all from a device that reached the dev server over an
 * insecure origin. Nothing about the failure was specific to the form or to the selection — the
 * exception was thrown while building the request, before any network call.
 *
 * `crypto.getRandomValues` carries no such restriction: it is available in insecure contexts in
 * every browser that ships `randomUUID` at all, and what it returns is still cryptographically
 * random. It is therefore the correct primitive for the fallback. `Math.random()` is deliberately
 * NOT used — it is not a safe default for a value the server keys a uniqueness constraint on, and
 * the whole point of the fallback is that a weaker source is never needed.
 *
 * ── WHAT THE VALUE HAS TO SATISFY ───────────────────────────────────────────────
 * Be opaque, be unique, and never throw. Nothing parses it: the idempotency contract stores it as
 * an opaque string scoped to `(userId, scope, key)` (`IdempotencyKey.@@unique`), and
 * `idempotencyKeySchema` accepts any 1–200 character string, so no server contract depends on the
 * format.
 *
 * Both branches below nevertheless return an RFC 4122 version-4 UUID (36 characters, 8-4-4-4-12
 * lowercase hex). That is on purpose: a key minted on an insecure origin is then
 * indistinguishable in shape and length from one minted on `localhost`, so a session that moves
 * between the two — or a future caller that validates the format — cannot end up importing two
 * key shapes for one concept, and no caller has to branch on which branch ran.
 *
 * ── WHEN THE LAST RESORT IS REACHED ─────────────────────────────────────────────
 * Only when `globalThis.crypto` is absent entirely, which no browser that can run this app is.
 * It exists so that the function's contract is "returns a key" rather than "returns a key, or
 * throws inside a submit handler", and it keeps the same 36-character shape. Uniqueness there
 * comes from the millisecond clock plus a counter that advances when two calls land in the same
 * millisecond — enough for the intent-per-submit use, and it is the only branch that is not
 * cryptographically random.
 */

/** 16 random bytes → RFC 4122 v4, or `null` when the platform has no Web Crypto from which to draw. */
function uuidV4FromRandomBytes(): string | null {
    const webCrypto = globalCrypto();

    if (!webCrypto || typeof webCrypto.getRandomValues !== "function") {
        return null;
    }

    const bytes = webCrypto.getRandomValues(new Uint8Array(16));

    // Version 4 in the high nibble of octet 6, and the RFC 4122 variant (10xx) in octet 8, which
    // together are what make the string a *well-formed* v4 UUID rather than 16 arbitrary bytes.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let hex = "";

    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, "0");
    }

    return uuidFromHex(hex);
}

/**
 * Format 32 hex characters as an 8-4-4-4-12 UUID.
 *
 * The version and variant nibbles are supplied by the caller rather than overwritten here,
 * because the two callers know different things: the random branch sets them properly, and the
 * clock branch has to state its own (`4` / `8`) since its digits are not random.
 */
function uuidFromHex(hex: string): string {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(12, 15)}-8${hex.slice(
        15,
        18
    )}-${hex.slice(18, 30)}`;
}

let lastFallbackStamp = -1;
let fallbackCounter = 0;

/** Same 36-character shape, from the clock plus a per-millisecond counter. Never random. */
function uuidShapedFromClock(): string {
    const now = Date.now();

    if (now === lastFallbackStamp) {
        fallbackCounter += 1;
    } else {
        lastFallbackStamp = now;
        fallbackCounter = 0;
    }

    const hex = `${now.toString(16).padStart(12, "0")}${fallbackCounter
        .toString(16)
        .padStart(4, "0")}`.padEnd(32, "0");

    return uuidFromHex(hex);
}

/**
 * A fresh request key.
 *
 * Prefers the platform's own `randomUUID` (it is the fastest and the shape is guaranteed by the
 * browser), then the Web Crypto fallback, then the clock. Never throws.
 */
export function createRequestKey(): string {
    const webCrypto = globalCrypto();

    if (webCrypto && typeof webCrypto.randomUUID === "function") {
        return webCrypto.randomUUID();
    }

    return uuidV4FromRandomBytes() ?? uuidShapedFromClock();
}

/**
 * `globalThis.crypto`, typed down to the two members this module uses.
 *
 * Typed structurally rather than as `Crypto` because the interesting case is the platform where
 * `randomUUID` is *missing*: `Crypto.randomUUID` is declared as always present in the standard
 * lib, so testing for its absence would be a type error against the real interface.
 */
function globalCrypto(): {
    randomUUID?: () => string;
    getRandomValues?: (array: Uint8Array) => Uint8Array;
} | null {
    if (typeof globalThis === "undefined" || !globalThis.crypto) {
        return null;
    }

    return globalThis.crypto;
}
