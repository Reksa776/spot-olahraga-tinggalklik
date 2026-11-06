/**
 * ==========================================
 * NOTIFICATION CONFIGURATION (PHASE 1 — DRY RUN ONLY)
 * ==========================================
 *
 * `NOTIFICATIONS_ENABLED` is a kill switch, and it is OFF unless the value is exactly "true"
 * (surrounding whitespace ignored). A missing, empty, misspelled or numeric value is OFF. This
 * follows the repository's existing fail-closed habit in `lib/payment/config.ts` rather than
 * the usual `Boolean(process.env.X)` trap, where the string "false" is truthy.
 *
 * ── THE HARD PART: A REAL TRANSPORT CANNOT BE SELECTED ────────────────────────────────
 * The owner approved SMTP as the target architecture and Baileys as a prepared adapter, but
 * ONLY as structure. Phase 1 may not open an SMTP connection, authenticate, pair WhatsApp, or
 * send anything. So configuration is resolved in two layers:
 *
 *   requested  — what the environment asks for (`smtp`, `baileys`, …)
 *   effective  — what this build will actually instantiate
 *
 * `PHASE_1_DRY_RUN_ONLY` is a compile-time constant in this file, not an environment variable,
 * so no deployment can flip it. The effective transport is therefore always `dry-run` or
 * `disabled`; a request for `smtp`/`baileys` is RECORDED as a refusal (visible in the worker's
 * startup log) and downgraded. `transports/smtp.ts` and `transports/baileys.ts` exist, but both
 * throw on construction — there is no code path in Phase 1 that can produce a live transport.
 *
 * ── WHY NUMBERS FALL BACK INSTEAD OF THROWING ────────────────────────────────────────
 * A malformed `NOTIFICATION_WORKER_POLL_MS` must not take the worker down: the safe direction
 * for a polling process is to run with a conservative default and say so. The kill switch and
 * the transport clamp are the safety-critical values, and those never fall back to "on".
 */

export type RequestedEmailTransport = "disabled" | "dry-run" | "smtp";
export type RequestedWhatsAppTransport = "disabled" | "dry-run" | "baileys";

/** What the build can actually run in Phase 1. Never a network transport. */
export type EffectiveTransport = "disabled" | "dry-run";

/** Phase 1 constant. Changing it is a code change and an owner decision, not a deployment one. */
export const PHASE_1_DRY_RUN_ONLY = true;

export type NotificationConfig = {
    /** The kill switch as requested. When false, the worker claims nothing. */
    enabled: boolean;
    /** What the environment asked for, kept for the refusal log. */
    requestedEmailTransport: RequestedEmailTransport;
    requestedWhatsAppTransport: RequestedWhatsAppTransport;
    /** What will actually be instantiated. Always dry-run or disabled in Phase 1. */
    emailTransport: EffectiveTransport;
    whatsappTransport: EffectiveTransport;
    /** Human-readable reasons a requested transport was downgraded. Never contains a secret. */
    refusals: string[];
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
    emailConcurrency: number;
    whatsappConcurrency: number;
    /**
     * Conservative WhatsApp policy (Phase 2). Both values are CONFIGURABLE and both have a
     * dry-run default; they are not claims about the production limit, which the owner has not
     * set. The recommended production range is documented in the Phase 2 report.
     */
    whatsappDailyCap: number;
    whatsappSendDelayMs: number;
};

export type NotificationEnvironment = Record<string, string | undefined>;

const EMAIL_TRANSPORTS: readonly RequestedEmailTransport[] = [
    "disabled",
    "dry-run",
    "smtp",
];

const WHATSAPP_TRANSPORTS: readonly RequestedWhatsAppTransport[] = [
    "disabled",
    "dry-run",
    "baileys",
];

function readFlag(env: NotificationEnvironment, name: string): boolean {
    const raw = env[name];

    if (raw === undefined) {
        return false;
    }

    return raw.trim().toLowerCase() === "true";
}

function readChoice<T extends string>(
    env: NotificationEnvironment,
    name: string,
    allowed: readonly T[],
    fallback: T,
    refusals: string[]
): T {
    const raw = env[name]?.trim().toLowerCase();

    if (!raw) {
        return fallback;
    }

    const match = allowed.find((candidate) => candidate === raw);

    if (!match) {
        refusals.push(
            `${name}="${raw}" is not a recognised value; falling back to "${fallback}".`
        );

        return fallback;
    }

    return match;
}

function readInteger(
    env: NotificationEnvironment,
    name: string,
    fallback: number,
    minimum: number,
    maximum: number,
    refusals: string[]
): number {
    const raw = env[name]?.trim();

    if (!raw) {
        return fallback;
    }

    const parsed = Number(raw);

    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        refusals.push(
            `${name}="${raw}" is invalid; using ${fallback} (allowed ${minimum}–${maximum}).`
        );

        return fallback;
    }

    return parsed;
}

/**
 * Resolve the runtime configuration.
 *
 * The transports are clamped independently of the kill switch: even with
 * `NOTIFICATIONS_ENABLED=true`, `EMAIL_TRANSPORT=smtp` yields the dry-run transport. SMTP
 * environment variables are never read here at all — they belong to an adapter that Phase 1
 * refuses to construct.
 */
export function resolveNotificationConfig(
    env: NotificationEnvironment = process.env
): NotificationConfig {
    const refusals: string[] = [];

    const enabled = readFlag(env, "NOTIFICATIONS_ENABLED");

    const requestedEmailTransport = readChoice(
        env,
        "EMAIL_TRANSPORT",
        EMAIL_TRANSPORTS,
        "dry-run",
        refusals
    );

    const requestedWhatsAppTransport = readChoice(
        env,
        "WHATSAPP_TRANSPORT",
        WHATSAPP_TRANSPORTS,
        "dry-run",
        refusals
    );

    const emailTransport: EffectiveTransport =
        requestedEmailTransport === "smtp"
            ? "dry-run"
            : requestedEmailTransport;

    const whatsappTransport: EffectiveTransport =
        requestedWhatsAppTransport === "baileys"
            ? "dry-run"
            : requestedWhatsAppTransport;

    if (requestedEmailTransport === "smtp") {
        refusals.push(
            "EMAIL_TRANSPORT=smtp refused: Phase 1 is dry-run only (SMTP is never contacted)."
        );
    }

    if (requestedWhatsAppTransport === "baileys") {
        refusals.push(
            "WHATSAPP_TRANSPORT=baileys refused: Phase 1 is dry-run only (no pairing, no socket)."
        );
    }

    return {
        enabled,
        requestedEmailTransport,
        requestedWhatsAppTransport,
        emailTransport,
        whatsappTransport,
        refusals,
        pollIntervalMs: readInteger(
            env,
            "NOTIFICATION_WORKER_POLL_MS",
            5_000,
            1_000,
            300_000,
            refusals
        ),
        batchSize: readInteger(
            env,
            "NOTIFICATION_BATCH_SIZE",
            20,
            1,
            100,
            refusals
        ),
        leaseMs: readInteger(
            env,
            "NOTIFICATION_LEASE_MS",
            120_000,
            30_000,
            900_000,
            refusals
        ),
        // One WhatsApp socket, so ONE concurrent send. Email can be parallel.
        emailConcurrency: 3,
        whatsappConcurrency: 1,
        // Dry-run defaults, deliberately conservative. A 5 s pause before each WhatsApp
        // send keeps a batch from looking like a broadcast; 20 per day is a ceiling a real
        // account can safely live under, not a value invented for production.
        whatsappDailyCap: readInteger(
            env,
            "WHATSAPP_DAILY_CAP",
            20,
            1,
            1_000,
            refusals
        ),
        whatsappSendDelayMs: readInteger(
            env,
            "WHATSAPP_SEND_DELAY_MS",
            5_000,
            0,
            60_000,
            refusals
        ),
    };
}

/**
 * The subset safe to log at startup. It names no host, no credential and no recipient: an
 * operator can tell whether the worker is enabled and which transports were refused without the
 * log leaking the configuration.
 */
export function describeNotificationConfig(config: NotificationConfig) {
    return {
        notificationsEnabled: config.enabled,
        phase1DryRunOnly: PHASE_1_DRY_RUN_ONLY,
        emailTransport: config.emailTransport,
        requestedEmailTransport: config.requestedEmailTransport,
        whatsappTransport: config.whatsappTransport,
        requestedWhatsAppTransport: config.requestedWhatsAppTransport,
        refusals: config.refusals,
        pollIntervalMs: config.pollIntervalMs,
        batchSize: config.batchSize,
        leaseMs: config.leaseMs,
        whatsappDailyCap: config.whatsappDailyCap,
        whatsappSendDelayMs: config.whatsappSendDelayMs,
    };
}
