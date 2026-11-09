import fs from "node:fs/promises";
import path from "node:path";

import { readSmtpAdapterConfig } from "@/lib/notifications/transports/smtp";
import { isWhatsAppManuallyDisconnected } from "@/lib/whatsapp/manual-disconnect";

import { resolveWhatsAppGatewayConfig } from "./config";
import {
    inspectWhatsAppGatewayLock,
    toWhatsAppGatewayLockStatus,
    type WhatsAppGatewayLockStatus,
    type WhatsAppLockHolder,
} from "./lock-inspection";
import { getWhatsAppGatewayForWeb } from "./web-runtime";

export type WhatsAppGatewayStatus = {
    state: string;
    connected: boolean;
    ready: boolean;
    ownershipHeld: boolean;
    sessionPresent: boolean;
    sessionExists: boolean;
    manualDisconnect: boolean;
    lastErrorCode: string | null;
    qr: string | null;
    expiresAt: string | null;
    lock: WhatsAppGatewayLockStatus;
    /** Kept additively for clients that read the flat holder from the first release. */
    lockHolder: WhatsAppLockHolder | null;
    smtp: {
        configured: boolean;
        secure: boolean;
        from: string | null;
    };
};

const FREE_LOCK: WhatsAppGatewayLockStatus = {
    held: false,
    holder: null,
    stale: false,
    heartbeatAgeMs: null,
};

async function sessionFileExists(sessionDir: string): Promise<boolean> {
    try {
        await fs.access(
            path.join(/* turbopackIgnore: true */ sessionDir, "auth.enc")
        );
        return true;
    } catch {
        return false;
    }
}

/**
 * Status is intentionally a read: it never acquires, releases or deletes anything.
 * `manualDisconnect` wins over the socket snapshot so a process that has not yet
 * observed the latch cannot make the dashboard look connected.
 */
export async function getWhatsAppGatewayStatus(): Promise<WhatsAppGatewayStatus> {
    const manualDisconnect = await isWhatsAppManuallyDisconnected();
    const gateway = await getWhatsAppGatewayForWeb();
    const resolved = resolveWhatsAppGatewayConfig();
    const sessionDir =
        resolved.ok && resolved.config.enabled
            ? resolved.config.sessionDir
            : null;

    let sessionExists = false;
    let lock: WhatsAppGatewayLockStatus = FREE_LOCK;

    if (sessionDir) {
        sessionExists = await sessionFileExists(sessionDir);

        try {
            lock = toWhatsAppGatewayLockStatus(
                await inspectWhatsAppGatewayLock(sessionDir)
            );
        } catch {
            // Status must still render when the lease table is momentarily unavailable.
            // Do not invent a stale lock from a failed read.
            lock = FREE_LOCK;
        }
    }

    const snapshot = gateway?.snapshot();
    const pairing = manualDisconnect
        ? { qr: null, expiresAt: null }
        : (gateway?.pairingStatus() ?? { qr: null, expiresAt: null });

    return {
        state: manualDisconnect
            ? "MANUAL_DISCONNECT"
            : (snapshot?.state ?? "UNAVAILABLE"),
        connected: Boolean(snapshot?.connected) && !manualDisconnect,
        ready: Boolean(snapshot?.ready) && !manualDisconnect,
        ownershipHeld: Boolean(snapshot?.ownershipHeld) && !manualDisconnect,
        sessionPresent: snapshot?.sessionPresent ?? sessionExists,
        sessionExists,
        manualDisconnect,
        lastErrorCode: snapshot?.lastErrorCode ?? null,
        qr: pairing.qr,
        expiresAt: pairing.expiresAt,
        lock,
        lockHolder: lock.holder,
        smtp: {
            configured: Boolean(readSmtpAdapterConfig()),
            secure:
                process.env.SMTP_SECURE?.trim().toLowerCase() === "true",
            from: process.env.EMAIL_FROM ?? null,
        },
    };
}
