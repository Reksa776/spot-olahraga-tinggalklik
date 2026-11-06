/**
 * ==========================================
 * PHASE 1 — THE KILL SWITCH AND THE TRANSPORT CLAMP
 * ==========================================
 *
 * These are pure tests. They exist because the two safety properties that matter most in
 * Phase 1 are both configuration properties, and a mis-parsed flag cannot be caught by an
 * integration test that helpfully sets the flag correctly.
 */

import {
    PHASE_1_DRY_RUN_ONLY,
    resolveNotificationConfig,
} from "@/lib/notifications/config";

describe("NOTIFICATIONS_ENABLED is OFF unless it is explicitly true", () => {
    test.each([
        ["absent", undefined],
        ["empty", ""],
        ["whitespace", "   "],
        ["false", "false"],
        ["FALSE", "FALSE"],
        ["zero", "0"],
        ["one", "1"],
        ["yes", "yes"],
        ["on", "on"],
        ["enabled", "enabled"],
    ])("%s stays OFF", (_label, value) => {
        const config = resolveNotificationConfig(
            value === undefined ? {} : { NOTIFICATIONS_ENABLED: value }
        );

        expect(config.enabled).toBe(false);
    });

    test("only \"true\" (case/whitespace tolerated) enables the worker", () => {
        expect(
            resolveNotificationConfig({ NOTIFICATIONS_ENABLED: "true" }).enabled
        ).toBe(true);

        expect(
            resolveNotificationConfig({ NOTIFICATIONS_ENABLED: " TRUE " }).enabled
        ).toBe(true);
    });
});

describe("a real transport can never be selected in Phase 1", () => {
    test("the dry-run clamp is a code constant, not an environment variable", () => {
        expect(PHASE_1_DRY_RUN_ONLY).toBe(true);
    });

    test("default configuration is dry-run and performs no network transport", () => {
        const config = resolveNotificationConfig({});

        expect(config.emailTransport).toBe("dry-run");
        expect(config.whatsappTransport).toBe("dry-run");
        expect(config.refusals).toEqual([]);
    });

    test("EMAIL_TRANSPORT=smtp is recorded as a refusal and downgraded", () => {
        const config = resolveNotificationConfig({
            NOTIFICATIONS_ENABLED: "true",
            EMAIL_TRANSPORT: "smtp",
            // Present to prove these credentials do not change the outcome.
            SMTP_HOST: "smtp.example.test",
            SMTP_USER: "user@example.test",
            SMTP_PASS: "not-a-real-password",
            EMAIL_FROM: "no-reply@example.test",
        });

        expect(config.requestedEmailTransport).toBe("smtp");
        expect(config.emailTransport).toBe("dry-run");
        expect(config.refusals.join(" ")).toMatch(/smtp/i);
    });

    test("WHATSAPP_TRANSPORT=baileys is recorded as a refusal and downgraded", () => {
        const config = resolveNotificationConfig({
            NOTIFICATIONS_ENABLED: "true",
            WHATSAPP_TRANSPORT: "baileys",
            WA_AUTH_DIR: "/var/lib/tinggalklik/whatsapp-auth",
        });

        expect(config.requestedWhatsAppTransport).toBe("baileys");
        expect(config.whatsappTransport).toBe("dry-run");
        expect(config.refusals.join(" ")).toMatch(/baileys/i);
    });

    test("an unknown transport value falls back to dry-run", () => {
        const config = resolveNotificationConfig({
            EMAIL_TRANSPORT: "sendgrid-http",
            WHATSAPP_TRANSPORT: "cloud-api",
        });

        expect(config.emailTransport).toBe("dry-run");
        expect(config.whatsappTransport).toBe("dry-run");
        expect(config.refusals.length).toBe(2);
    });

    test("disabled is honoured: no transport is instantiated at all", () => {
        const config = resolveNotificationConfig({
            EMAIL_TRANSPORT: "disabled",
            WHATSAPP_TRANSPORT: "disabled",
        });

        expect(config.emailTransport).toBe("disabled");
        expect(config.whatsappTransport).toBe("disabled");
    });

    test("no combination of environment values yields smtp or baileys", () => {
        const combinations = [
            {},
            { EMAIL_TRANSPORT: "smtp", WHATSAPP_TRANSPORT: "baileys" },
            { EMAIL_TRANSPORT: "SMTP", WHATSAPP_TRANSPORT: "BAILEYS" },
            { NOTIFICATIONS_ENABLED: "true", EMAIL_TRANSPORT: "smtp" },
        ];

        for (const env of combinations) {
            const config = resolveNotificationConfig(env);

            expect(["disabled", "dry-run"]).toContain(config.emailTransport);
            expect(["disabled", "dry-run"]).toContain(config.whatsappTransport);
        }
    });
});

describe("numeric settings fall back rather than taking the worker down", () => {
    test("invalid poll/batch/lease values use conservative defaults and are reported", () => {
        const config = resolveNotificationConfig({
            NOTIFICATION_WORKER_POLL_MS: "soon",
            NOTIFICATION_BATCH_SIZE: "-5",
            NOTIFICATION_LEASE_MS: "12.5",
        });

        expect(config.pollIntervalMs).toBe(5_000);
        expect(config.batchSize).toBe(20);
        expect(config.leaseMs).toBe(120_000);
        expect(config.refusals).toHaveLength(3);
    });

    test("valid values are honoured within their bounds", () => {
        const config = resolveNotificationConfig({
            NOTIFICATION_WORKER_POLL_MS: "2500",
            NOTIFICATION_BATCH_SIZE: "7",
            NOTIFICATION_LEASE_MS: "90000",
        });

        expect(config.pollIntervalMs).toBe(2_500);
        expect(config.batchSize).toBe(7);
        expect(config.leaseMs).toBe(90_000);
    });

    test("WhatsApp concurrency is one — a single socket, deliberately serialised", () => {
        expect(resolveNotificationConfig({}).whatsappConcurrency).toBe(1);
    });
});
