import fs from "node:fs/promises";
import path from "node:path";

import {
    resolveNotificationConfig,
    type NotificationConfig,
    type NotificationEnvironment,
} from "./config";

/**
 * ==========================================
 * NOTIFICATION ENABLEMENT FALLBACK
 * ==========================================
 *
 * The worker's kill switch (`NOTIFICATIONS_ENABLED`) is fail-closed by design: only the exact
 * string "true" enables it. That is correct, but it is also the most common reason an operator
 * sees "WhatsApp is paired and reminders are queued, yet nothing is sent": the gateway is live
 * and `NOTIFICATIONS_ENABLED` was never set.
 *
 * This module adds ONE narrow fallback, applied only by the worker entrypoint
 * (`scripts/notification-worker.ts`):
 *
 *   NOTIFICATIONS_ENABLED is not "true"
 *   AND WHATSAPP_TRANSPORT = baileys
 *   AND WA_GATEWAY_ENABLED = "true"
 *   AND WA_GATEWAY_TOKEN has at least 32 characters
 *   AND a persisted gateway session exists (an encrypted `*.enc` file in WA_AUTH_DIR)
 *
 *   ⇒ enable the worker, and say so in one structured log line.
 *
 * Why all five conditions: the fallback exists to cover "the QR was scanned", not to turn a
 * misconfigured deployment on. Without a paired session there is nothing to send through, so
 * the kill switch stays off and the operator is told exactly what is missing. No condition is
 * inferred from a request, a session cookie or a database row.
 *
 * The pure resolver in `config.ts` is deliberately untouched, so its tests and its documented
 * fail-closed contract remain the single source of truth for every other caller.
 */

export type NotificationFallbackReason = "WHATSAPP_SESSION_ACTIVE";

export type NotificationConfigResolution = {
    config: NotificationConfig;
    fallback: NotificationFallbackReason | null;
    /** Human-readable reasons the fallback did not apply. Never contains a secret. */
    notes: string[];
};

function isTrue(value: string | undefined): boolean {
    return value?.trim().toLowerCase() === "true";
}

/** Resolve the session directory exactly the way the gateway does. */
export function whatsAppSessionDir(
    env: NotificationEnvironment = process.env
): string {
    const configured = env.WA_AUTH_DIR?.trim();

    return configured
        ? path.resolve(process.cwd(), configured)
        : path.join(process.cwd(), "storage", "whatsapp-gateway");
}

/**
 * Does a persisted (encrypted) WhatsApp session exist?
 *
 * `EncryptedJsonStore` writes `auth.enc`; accepting any `*.enc` keeps this from depending on
 * an internal filename, while still requiring real persisted credentials rather than merely
 * an existing directory. A read failure means "no session".
 */
async function hasPersistedSession(sessionDir: string): Promise<boolean> {
    try {
        const entries = await fs.readdir(sessionDir);

        return entries.some((entry) => entry.endsWith(".enc"));
    } catch {
        return false;
    }
}

export async function resolveNotificationConfigWithFallback(
    env: NotificationEnvironment = process.env,
    options: { sessionDir?: string } = {}
): Promise<NotificationConfigResolution> {
    const config = resolveNotificationConfig(env);

    if (config.enabled) {
        return { config, fallback: null, notes: [] };
    }

    const notes: string[] = [];

    if (config.requestedWhatsAppTransport !== "baileys") {
        notes.push(
            'Fallback needs WHATSAPP_TRANSPORT="baileys"; it is not set, so the kill switch stays off.'
        );

        return { config, fallback: null, notes };
    }

    if (!isTrue(env.WA_GATEWAY_ENABLED)) {
        notes.push(
            'Fallback needs WA_GATEWAY_ENABLED="true"; the gateway is not enabled, so the kill switch stays off.'
        );

        return { config, fallback: null, notes };
    }

    if ((env.WA_GATEWAY_TOKEN?.trim() ?? "").length < 32) {
        notes.push(
            "Fallback needs WA_GATEWAY_TOKEN with at least 32 characters; it is missing or too short."
        );

        return { config, fallback: null, notes };
    }

    const sessionDir = options.sessionDir ?? whatsAppSessionDir(env);

    if (!(await hasPersistedSession(sessionDir))) {
        notes.push(
            "Fallback found no paired WhatsApp session (no *.enc file in WA_AUTH_DIR); set NOTIFICATIONS_ENABLED=true explicitly once pairing is complete."
        );

        return { config, fallback: null, notes };
    }

    return {
        config: { ...config, enabled: true },
        fallback: "WHATSAPP_SESSION_ACTIVE",
        notes: [
            "NOTIFICATIONS_ENABLED is off, but a paired WhatsApp session and the Baileys gateway configuration are present; enabled the worker automatically.",
        ],
    };
}
