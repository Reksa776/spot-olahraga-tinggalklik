import {
    TICKET_QR_PREFIX,
    assertQrPayloadIsSafe,
    buildTicketQrPayload,
    hashQrToken,
    isTicketCode,
} from "@/lib/ticketing/tickets/reference";

/**
 * ==========================================
 * PHASE 16 — THE QR PAYLOAD CONTRACT
 * ==========================================
 *
 * The wallet QR is the one place a credential leaves the server and lands in a camera-readable
 * image, so its contract is asserted here on its own rather than incidentally: the payload is
 * **exactly** `TICKET:<ticketCode>`, it is deterministic, and it can carry no personal,
 * financial, URL or token material — no matter what a future edit feeds it.
 *
 * Phase 14 closed D-46 by RATIFYING this mechanism (`TICKET:<ticketCode>` + `MANUAL` check-in),
 * and Phase 16 was explicitly forbidden from reinterpreting it. These tests are what makes that
 * locked decision enforceable: a change of payload shape, or a change that let a secret into the
 * image, fails here first.
 *
 * NOT a rendering test — `qrcode.react`'s own output is asserted in
 * `__tests__/ticketing-ui/wallet-qr-presentation.test.ts`. This file is about the string.
 */

describe("P16-QR1. the payload is exactly TICKET:<ticketCode>", () => {
    test("carries the locked prefix and the code, and nothing else", () => {
        const payload = buildTicketQrPayload("EVT-2345-6789");

        expect(payload).toBe("TICKET:EVT-2345-6789");
        expect(payload).toBe(`${TICKET_QR_PREFIX}EVT-2345-6789`);
        // Exactly one separator, exactly two segments.
        expect(payload.split(":")).toHaveLength(2);
        expect(payload.split(":")[0]).toBe("TICKET");
    });

    test("follows the ticket code's own validated alphabet for every legal code", () => {
        // Every character of the alphabet, in a real code shape. The alphabet deliberately
        // excludes 0/O/1/I/L because a usher reads these aloud when a QR will not scan.
        const codes = [
            "EVT-2345-6789",
            "EVT-ABCD-EFGH",
            "EVT-JKMN-PQRS",
            "EVT-TVWX-YZ23",
            "EVT-9999-2222",
        ];

        for (const code of codes) {
            expect(isTicketCode(code)).toBe(true);
            expect(buildTicketQrPayload(code)).toBe(`TICKET:${code}`);
        }
    });

    test("treats a lowercase code as invalid rather than silently normalising it", () => {
        // The check-in path uppercases what a human types; the QR is generated from the stored
        // row, so a lowercase value here means the caller built a payload from untrusted input.
        // Throwing is the point: a silently-normalised payload would encode a code the database
        // does not have, and the gate would refuse a ticket the buyer was told was valid.
        expect(() => buildTicketQrPayload("evt-2345-6789")).toThrow();
    });
});

describe("P16-QR2. the payload is deterministic", () => {
    test("returns the same string for the same code, every time", () => {
        const code = "EVT-ABCD-2345";
        const first = buildTicketQrPayload(code);

        for (let attempt = 0; attempt < 50; attempt += 1) {
            expect(buildTicketQrPayload(code)).toBe(first);
        }
    });

    test("is derived from the code alone — no clock, no randomness, no session", () => {
        // Same input, different times and a different process-wide state, same output: the
        // value is a pure function of the ticket code (which is why the QR is stable across
        // every read rather than re-minted per render, as Phase 14 requires).
        const code = "EVT-2345-6789";

        expect(buildTicketQrPayload(code)).toBe(buildTicketQrPayload(code));
        expect(buildTicketQrPayload(code)).toBe(`TICKET:${code}`);
    });
});

describe("P16-QR3. the payload carries no PII, no URL and no token", () => {
    test("has no email, phone, name, order number, money or URL shape", () => {
        const payload = buildTicketQrPayload("EVT-2345-6789");

        for (const forbidden of [
            "@",
            "http",
            "://",
            "www.",
            "+62",
            "081",
            ".com",
            "Rp",
            "IDR",
            "$",
            "?",
            "&",
            "#",
            "/",
            "=",
            " ",
        ]) {
            expect(payload).not.toContain(forbidden);
        }
    });

    test("cannot contain the scanner secret, because it never sees one", () => {
        // The raw token is 32 random base64url bytes and only its SHA-256 is persisted. The
        // payload builder takes a ticket CODE; there is no argument through which a token could
        // reach it, and this pins that: a 43-character base64url token is not a code.
        const token = "Zm9vYmFyLXNlY3JldC10b2tlbi0xMjM0NTY3ODkwYWJjZGVm";

        expect(isTicketCode(token)).toBe(false);
        expect(() => buildTicketQrPayload(token)).toThrow();

        // And the hash of a real token is not encodable either.
        const hash = hashQrToken("some-raw-token");
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(() => buildTicketQrPayload(hash)).toThrow();
    });

    test("the safety assertion accepts the real payload and rejects anything wider", () => {
        expect(() => assertQrPayloadIsSafe("TICKET:EVT-2345-6789")).not.toThrow();

        for (const unsafe of [
            "EVT-2345-6789",
            "TICKET:",
            "TICKET:EVT-2345-6789?k=secret",
            "TICKET:https://example.test/t",
            "TICKET:buyer@example.test",
            "TICKET:EVT-2345-6789 EVT-2345-6789",
            "ticket:EVT-2345-6789",
        ]) {
            expect(() => assertQrPayloadIsSafe(unsafe)).toThrow();
        }
    });
});

describe("P16-QR4. malformed input fails loudly instead of encoding nonsense", () => {
    test.each([
        "",
        "EVT-2345",
        "EVT-2345-67890",
        "EVT-0000-0000",
        "EVT-OOOO-IIII",
        "evt-2345-6789",
        "TICKET:EVT-2345-6789",
        "../../etc/passwd",
        "'; DROP TABLE ticket; --",
    ])("refuses %p", (candidate) => {
        expect(() => buildTicketQrPayload(candidate)).toThrow();
    });
});
