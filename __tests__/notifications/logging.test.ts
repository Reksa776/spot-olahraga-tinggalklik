/**
 * ==========================================
 * PHASE 1 — STRUCTURED LOG REDACTION
 * ==========================================
 *
 * The worker's log is the most likely place for a credential to escape, so redaction is tested
 * rather than trusted. `recipient` is masked, secret-named keys are replaced, and a connection
 * string pasted into free text is stripped.
 */

import {
    maskRecipient,
    sanitizeErrorMessage,
    sanitizeLogFields,
    structuredLog,
} from "@/lib/notifications/logger";

describe("recipients are masked, not printed", () => {
    test("an email keeps only its first character and its domain", () => {
        expect(maskRecipient("buyer@example.test")).toBe("b***@example.test");
    });

    test("a phone number keeps at most its last two digits", () => {
        expect(maskRecipient("081234567890")).toBe("***90");
        expect(maskRecipient("123")).toBe("***");
        expect(maskRecipient("   ")).toBe("[empty]");
    });
});

describe("secret-named fields are redacted whatever their value", () => {
    test("password, token, credential, apiKey and authorization are replaced", () => {
        const fields = sanitizeLogFields({
            password: "hunter2",
            smtpPass: "hunter2",
            token: "abc",
            credential: "abc",
            apiKey: "abc",
            authorization: "Bearer abc",
            privateKey: "abc",
            cookie: "session=abc",
        });

        for (const value of Object.values(fields)) {
            expect(value).toBe("[redacted]");
        }
    });

    test("a credential inside a plain message is stripped", () => {
        const fields = sanitizeLogFields({
            error: "upstream smtp://mailer:s3cret@host:587 rejected",
        });

        expect(fields.error).toBe("upstream smtp://[redacted]@host:587 rejected");
    });

    test("strings are truncated so a payload cannot flood the log", () => {
        const fields = sanitizeLogFields({ note: "x".repeat(500) });

        expect(String(fields.note)).toHaveLength(200);
    });
});

describe("structuredLog writes one JSON line and leaks nothing", () => {
    test("the emitted line contains ids but no credential or full recipient", () => {
        const lines: string[] = [];

        structuredLog(
            "info",
            "notification.dispatch.simulated",
            {
                deliveryId: "delivery-1",
                notificationId: 7,
                // Attempts to smuggle a credential and personal data through the sink.
                recipient: "buyer@example.test",
                smtpPass: "super-secret-password",
                error: "smtp://user:super-secret-password@smtp.example.test",
            },
            (line) => lines.push(line)
        );

        expect(lines).toHaveLength(1);

        const parsed = JSON.parse(lines[0]) as Record<string, unknown>;

        expect(parsed.event).toBe("notification.dispatch.simulated");
        expect(parsed.deliveryId).toBe("delivery-1");
        expect(parsed.notificationId).toBe(7);
        expect(parsed.smtpPass).toBe("[redacted]");
        expect(parsed.recipient).not.toBe("buyer@example.test");

        expect(lines[0]).not.toContain("super-secret-password");
        expect(lines[0]).not.toContain("buyer@example.test");
    });

    test("sanitizeErrorMessage strips connection credentials and bounds the message", () => {
        const message = sanitizeErrorMessage(
            new Error("smtp://mailer:secret@host:587 " + "y".repeat(500))
        );

        expect(message).not.toContain("secret");
        expect(message.startsWith("smtp://[redacted]@host:587")).toBe(true);
        expect(message.length).toBeLessThanOrEqual(300);
    });
});
