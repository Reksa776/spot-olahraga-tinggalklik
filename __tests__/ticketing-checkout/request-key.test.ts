import { readFileSync } from "node:fs";
import path from "node:path";

import { createRequestKey } from "@/lib/request-key";

/**
 * ==========================================
 * REQUEST KEYS ON INSECURE ORIGINS
 * ==========================================
 *
 * The checkout form mints one `Idempotency-Key` per submit intent (design §30.4). It used to call
 * `crypto.randomUUID()` inline, which works on `https://` and on `localhost` — and nowhere else.
 * `Crypto.randomUUID` is defined only in a SECURE CONTEXT, so on a plain-HTTP origin (the
 * development server opened at a LAN address from a phone, for instance) `window.crypto` exists but
 * has no such method, and pressing the purchase button threw
 *
 *     TypeError: crypto.randomUUID is not a function
 *
 * before any request was sent. The fix keeps the contract — an opaque, unique, 36-character key —
 * and picks a source that exists on insecure origins too.
 *
 * These tests stub `globalThis.crypto` because the interesting platforms are the ones this machine
 * is not: a browser with no `randomUUID`, and (effectively unreachable) one with no Web Crypto at
 * all. The stubbing is what makes "the fallback is what runs there" an assertion rather than a
 * belief.
 */

const ROOT = path.resolve(__dirname, "..", "..");

/** RFC 4122 version 4, lowercase, which is what `crypto.randomUUID()` produces. */
const UUID_V4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type WebCryptoStub = {
    randomUUID?: () => string;
    getRandomValues?: (array: Uint8Array) => Uint8Array;
};

function withWebCrypto(stub: WebCryptoStub | undefined, run: () => void): void {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");

    // `globalThis.crypto` is a configurable accessor in Node, so it can be replaced for the
    // duration of one test and restored exactly as it was.
    Object.defineProperty(globalThis, "crypto", {
        value: stub,
        configurable: true,
        writable: true,
    });

    try {
        run();
    } finally {
        if (original) {
            Object.defineProperty(globalThis, "crypto", original);
        } else {
            delete (globalThis as { crypto?: unknown }).crypto;
        }
    }
}

function readCode(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("createRequestKey: picks the strongest source the platform has", () => {
    it("uses the platform's own randomUUID when it is available", () => {
        const sentinel = "11111111-2222-4333-8444-555555555555";

        withWebCrypto(
            {
                randomUUID: () => sentinel,
                getRandomValues: () => {
                    throw new Error("getRandomValues must not be reached");
                },
            },
            () => {
                expect(createRequestKey()).toBe(sentinel);
            }
        );
    });

    it("falls back to getRandomValues when randomUUID is missing (an insecure origin)", () => {
        const stub: WebCryptoStub = {
            getRandomValues: (array) => {
                for (let index = 0; index < array.length; index += 1) {
                    array[index] = (index * 7 + 3) % 256;
                }
                return array;
            },
        };

        withWebCrypto(stub, () => {
            const key = createRequestKey();

            // Same shape and length as the branch above, so nothing downstream can tell — or has to
            // tell — which origin minted it. The server accepts any 1–200 character key.
            expect(key).toMatch(UUID_V4);
            expect(key).toHaveLength(36);
        });
    });

    it("draws fresh bytes for every key, so a retry is not a replay", () => {
        let calls = 0;

        const stub: WebCryptoStub = {
            getRandomValues: (array) => {
                calls += 1;
                for (let index = 0; index < array.length; index += 1) {
                    array[index] = (calls * 31 + index) % 256;
                }
                return array;
            },
        };

        withWebCrypto(stub, () => {
            const keys = new Set([
                createRequestKey(),
                createRequestKey(),
                createRequestKey(),
            ]);

            expect(keys.size).toBe(3);
            expect(calls).toBe(3);
        });
    });

    it("still returns a key when Web Crypto is absent entirely, and never throws", () => {
        withWebCrypto(undefined, () => {
            const first = createRequestKey();
            const second = createRequestKey();

            expect(first).toMatch(UUID_V4);
            expect(second).toMatch(UUID_V4);
            // Two calls in the same millisecond must still be distinct: the counter covers it.
            expect(first).not.toBe(second);
        });
    });

    it("returns a new key on every call with the real platform implementation", () => {
        const keys = new Set(
            Array.from({ length: 500 }, () => createRequestKey())
        );

        expect(keys.size).toBe(500);

        for (const key of keys) {
            expect(key).toMatch(UUID_V4);
        }
    });
});

describe("the checkout form's idempotency contract is unchanged", () => {
    const form = readCode("components/events/TicketPurchaseForm.tsx");

    it("mints its key through the helper, exactly once, and no longer calls the browser API", () => {
        expect(form).toContain('from "@/lib/request-key"');
        expect(form).toContain("createRequestKey()");
        expect(form).not.toContain("crypto.randomUUID");
        expect(form.match(/createRequestKey\(\)/g)).toHaveLength(1);
    });

    it("mints it only when the submit INTENT changed, so a retry replays the same key", () => {
        // §30.4: a network retry reuses the key of the intent it is retrying, and a changed
        // selection mints a new one. That rule is the signature comparison, not the key source.
        expect(form).toContain("pendingIntent.current.signature !== signature");
        expect(form).toContain("pendingIntent.current = null");
    });

    it("still sends the key as the Idempotency-Key header", () => {
        // The request contract is what the server reads; the key's provenance is not.
        expect(form).toContain('"Idempotency-Key": pendingIntent.current.key');
    });
});
