/**
 * ==========================================
 * PIC VERTICAL SLICE — REFERRAL TOKEN (PURE)
 * ==========================================
 *
 * The token module is deliberately pure: deterministic given the secret, no I/O, never
 * throws. These tests pin that contract and the FAIL-CLOSED behaviour (an unset
 * `PIC_REFERRAL_SECRET` must never mint and must never break a real purchase).
 */

import {
    mintPicReferralToken,
    verifyPicReferralToken,
    verifyPicReferralTokenForEvent,
    PIC_REFERRAL_SECRET_ENV,
} from "@/lib/pic/referral";

const SECRET = "pic-referral-test-secret-" + Date.now();
const ORIGINAL = process.env[PIC_REFERRAL_SECRET_ENV];

const PROFILE_ID = "pic_profile_abc123";
const EVENT_ID = "evt_event_xyz789";

beforeEach(() => {
    process.env[PIC_REFERRAL_SECRET_ENV] = SECRET;
});

afterAll(() => {
    if (ORIGINAL === undefined) {
        delete process.env[PIC_REFERRAL_SECRET_ENV];
    } else {
        process.env[PIC_REFERRAL_SECRET_ENV] = ORIGINAL;
    }
});

describe("mint + verify round trip", () => {
    test("a minted token verifies back to the exact payload", () => {
        const token = mintPicReferralToken({
            picProfileId: PROFILE_ID,
            eventId: EVENT_ID,
        });

        expect(token).not.toBeNull();

        const payload = verifyPicReferralToken(token as string);

        expect(payload).toEqual({
            version: "1",
            picProfileId: PROFILE_ID,
            eventId: EVENT_ID,
        });
    });

    test("the token is deterministic for the same secret and payload", () => {
        const a = mintPicReferralToken({ picProfileId: PROFILE_ID, eventId: EVENT_ID });
        const b = mintPicReferralToken({ picProfileId: PROFILE_ID, eventId: EVENT_ID });

        expect(a).toBe(b);
    });

    test("verifyPicReferralTokenForEvent accepts only matching event ids", () => {
        const token = mintPicReferralToken({
            picProfileId: PROFILE_ID,
            eventId: EVENT_ID,
        }) as string;

        expect(verifyPicReferralTokenForEvent(token, EVENT_ID)).not.toBeNull();
        expect(verifyPicReferralTokenForEvent(token, "evt_other")).toBeNull();
    });
});

describe("FAIL-CLOSED: no secret means no token and no verdict", () => {
    test("mint returns null when the secret is unset", () => {
        delete process.env[PIC_REFERRAL_SECRET_ENV];

        expect(
            mintPicReferralToken({ picProfileId: PROFILE_ID, eventId: EVENT_ID })
        ).toBeNull();
    });

    test("verify returns null when the secret is unset", () => {
        const token = mintPicReferralToken({
            picProfileId: PROFILE_ID,
            eventId: EVENT_ID,
        }) as string;

        delete process.env[PIC_REFERRAL_SECRET_ENV];

        expect(verifyPicReferralToken(token)).toBeNull();
        expect(verifyPicReferralTokenForEvent(token, EVENT_ID)).toBeNull();
    });
});

describe("verify rejects every corruption shape without throwing", () => {
    let token: string | null = null;

    beforeEach(() => {
        process.env[PIC_REFERRAL_SECRET_ENV] = SECRET;
        token = mintPicReferralToken({
            picProfileId: PROFILE_ID,
            eventId: EVENT_ID,
        });
    });

    test("a blank secret is treated as unset", () => {
        process.env[PIC_REFERRAL_SECRET_ENV] = "";
        expect(mintPicReferralToken({ picProfileId: PROFILE_ID, eventId: EVENT_ID })).toBeNull();
        expect(verifyPicReferralToken(token as string)).toBeNull();
    });

    test("a token minted under one secret fails under another", () => {
        process.env[PIC_REFERRAL_SECRET_ENV] = SECRET + "-changed";
        expect(verifyPicReferralToken(token as string)).toBeNull();
    });

    test("a tampered MAC fails", () => {
        const [payload, mac] = (token as string).split(".");

        // A 128-bit MAC base64url-encodes to 22 chars where the FINAL char only carries
        // padding bits — toggling it decodes to the same bytes. Flip a full 6-bit group
        // in the middle of the MAC instead, which genuinely changes the presented bytes.
        const idx = Math.floor(mac.length / 2);
        const tamperedMac =
            mac.slice(0, idx) + (mac[idx] === "A" ? "B" : "A") + mac.slice(idx + 1);

        expect(tamperedMac).not.toBe(mac);
        expect(verifyPicReferralToken(`${payload}.${tamperedMac}`)).toBeNull();
    });

    test("malformed token shapes all return null", () => {
        for (const bad of [
            "",
            "not-a-token",
            ".onlymac",
            "onlypayload.",
            "a.b.c",
            "c:\u0000",
        ]) {
            expect(verifyPicReferralToken(bad)).toBeNull();
        }
    });

    test("a token minted for a different event payload cannot be re-signed", () => {
        const other = mintPicReferralToken({
            picProfileId: PROFILE_ID,
            eventId: "evt_other",
        }) as string;

        // The event bindings are fixed inside the raw payload — a pasted token stays the
        // event it was minted for, so event B's URL cannot silently attribute to B.
        expect(verifyPicReferralTokenForEvent(other, EVENT_ID)).toBeNull();
    });

    test("verify never throws on hostile input", () => {
        for (const hostile of ["%00", Buffer.from("fffe").toString("utf8"), ":", "///"]) {
            expect(() => verifyPicReferralToken(hostile)).not.toThrow();
        }
    });
});