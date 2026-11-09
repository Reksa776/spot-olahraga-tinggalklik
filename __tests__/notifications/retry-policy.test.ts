/**
 * ==========================================
 * DELIVERY RETRY POLICY — PURE UNIT
 * ==========================================
 *
 * `queue.ts` owns the attempt budget; this module only answers "is another attempt capable of
 * succeeding?". The distinction is load-bearing: a bad JID or token retried five times delays
 * every later row and hides the real cause behind "will retry" logs.
 *
 * No database is involved — these are the exact rules the worker applies to a thrown error.
 */

import {
    classifyDeliveryError,
    PERMANENT_DELIVERY_ERROR_CODES,
} from "@/lib/notifications/retry-policy";

function errorWithCode(code: string, message = "transport failed"): Error {
    return Object.assign(new Error(message), { code });
}

describe("permanent failures", () => {
    test.each([...PERMANENT_DELIVERY_ERROR_CODES])(
        "%s is classified as permanent",
        (code) => {
            expect(classifyDeliveryError(errorWithCode(code))).toMatchObject({
                code,
                permanent: true,
            });
        }
    );

    test("a dead session or a not-ready gateway is retryable", () => {
        for (const code of [
            "TRANSPORT_ERROR",
            "NOT_READY",
            "ECONNRESET",
            "ETIMEDOUT",
            "SOCKET_CLOSED",
            "SOMETHING_NEW",
        ]) {
            expect(classifyDeliveryError(errorWithCode(code))).toMatchObject({
                code,
                permanent: false,
            });
        }
    });
});

describe("unknown inputs fail safe", () => {
    test("an error without a code is a transient transport error", () => {
        expect(classifyDeliveryError(new Error("boom"))).toEqual({
            code: "TRANSPORT_ERROR",
            permanent: false,
            message: "boom",
        });
    });

    test("a non-object, null or string error never becomes permanent", () => {
        expect(classifyDeliveryError(undefined)).toMatchObject({
            code: "TRANSPORT_ERROR",
            permanent: false,
            message: "Unknown transport error",
        });
        expect(classifyDeliveryError(null)).toMatchObject({
            code: "TRANSPORT_ERROR",
            permanent: false,
        });
        expect(classifyDeliveryError("socket closed")).toMatchObject({
            code: "TRANSPORT_ERROR",
            permanent: false,
            message: "socket closed",
        });
    });

    test("a numeric code is compared as a string and stays transient unless listed", () => {
        expect(classifyDeliveryError({ code: 500 })).toMatchObject({
            code: "500",
            permanent: false,
        });
    });
});

describe("messages are sanitized before they reach a log or delivery row", () => {
    test("email addresses and phone-shaped runs are redacted", () => {
        const classification = classifyDeliveryError(
            new Error("failed for buyer@example.test at +62 812-3456-7890")
        );

        expect(classification.message).toContain("[redacted-email]");
        expect(classification.message).toContain("[redacted-phone]");
        expect(classification.message).not.toContain("buyer@example.test");
        expect(classification.message).not.toContain("812-3456-7890");
    });

    test("credentials embedded in a provider URL are stripped", () => {
        const classification = classifyDeliveryError(
            new Error("connect smtp://user:secret@mail.example.test failed")
        );

        expect(classification.message).not.toContain("user:secret");
        expect(classification.message).toContain("[redacted]@");
    });

    test("a long provider message is truncated", () => {
        const classification = classifyDeliveryError(
            new Error("x".repeat(400))
        );

        expect(classification.message).toHaveLength(300);
    });
});
