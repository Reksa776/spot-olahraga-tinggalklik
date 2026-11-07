import "dotenv/config";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseSessionKey, resolveWhatsAppGatewayConfig } from "../lib/whatsapp/gateway/config";
import { WhatsAppGateway } from "../lib/whatsapp/gateway/gateway";
import { structuredLog } from "../lib/notifications/logger";

/** Create a private persistent key on first startup so operators do not need to hand-copy one. */
async function ensureSessionEncryptionKey(): Promise<void> {
    if (process.env.WA_GATEWAY_ENABLED?.trim().toLowerCase() !== "true") return;
    if (parseSessionKey(process.env.WA_SESSION_ENCRYPTION_KEY)) return;

    const sessionDir = path.resolve(
        process.cwd(),
        process.env.WA_AUTH_DIR?.trim() || path.join("storage", "whatsapp-gateway")
    );
    await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(sessionDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new Error("WhatsApp session directory must be a real directory.");
    }
    await fs.chmod(sessionDir, 0o700);

    const keyPath = path.join(sessionDir, ".session-key");
    try {
        const stat = await fs.lstat(keyPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error("WhatsApp session key must be a regular file.");
        }
        await fs.chmod(keyPath, 0o600);
        const key = await fs.readFile(keyPath);
        if (key.length !== 32) throw new Error("Stored WhatsApp session key is invalid.");
        process.env.WA_SESSION_ENCRYPTION_KEY = key.toString("base64");
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const key = randomBytes(32);
    try {
        const handle = await fs.open(keyPath, "wx", 0o600);
        try {
            await handle.writeFile(key);
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch (error) {
        // Another gateway startup may have created the key concurrently; use that one.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await fs.readFile(keyPath);
        if (existing.length !== 32) throw new Error("Stored WhatsApp session key is invalid.");
        process.env.WA_SESSION_ENCRYPTION_KEY = existing.toString("base64");
        return;
    }
    process.env.WA_SESSION_ENCRYPTION_KEY = key.toString("base64");
}

/**
 * Isolated WhatsApp gateway entrypoint (Phase P2).
 *
 * Disabled by default: with `WA_GATEWAY_ENABLED` unset/false this process validates nothing
 * else and exits 0 without opening a socket. When enabled it binds loopback only and waits for
 * SIGTERM/SIGINT. Pairing is started from the authenticated dashboard; QR data is returned
 * only through the token-protected loopback route and never written to logs.
 */

async function main(): Promise<void> {
    try {
        await ensureSessionEncryptionKey();
    } catch {
        structuredLog("error", "whatsapp_gateway_key_setup_failed", {
            code: "SESSION_KEY_SETUP_FAILED",
        });
        process.exitCode = 1;
        return;
    }

    const resolved = resolveWhatsAppGatewayConfig();

    if (!resolved.ok) {
        structuredLog("error", "whatsapp_gateway_config_error", {
            code: resolved.code,
            error: resolved.message,
        });
        process.exitCode = 1;
        return;
    }

    if (!resolved.config.enabled) {
        structuredLog("info", "whatsapp_gateway_disabled", {
            reason: "WA_GATEWAY_ENABLED is not true",
        });
        return;
    }

    const gateway = new WhatsAppGateway(resolved.config);
    const snapshot = await gateway.start();

    structuredLog("info", "whatsapp_gateway_state", {
        state: snapshot.state,
        ready: snapshot.ready,
        ownershipHeld: snapshot.ownershipHeld,
        sessionPresent: snapshot.sessionPresent,
    });

    if (snapshot.state === "CONFLICT") {
        // A second owner must exit, not compete for the socket.
        process.exitCode = 2;
        return;
    }

    if (snapshot.state === "ERROR") {
        process.exitCode = 1;
        return;
    }

    let shuttingDown = false;

    const shutdown = async (signal: "SIGTERM" | "SIGINT") => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        structuredLog("info", "whatsapp_gateway_shutdown", { signal });

        try {
            await gateway.stop();
            process.exitCode = 0;
        } catch {
            structuredLog("error", "whatsapp_gateway_shutdown_failed", {
                code: "SHUTDOWN_FAILED",
            });
            process.exitCode = 1;
        }
    };

    process.on("SIGTERM", () => {
        void shutdown("SIGTERM");
    });
    process.on("SIGINT", () => {
        void shutdown("SIGINT");
    });

    process.on("uncaughtException", () => {
        structuredLog("error", "whatsapp_gateway_uncaught_exception", {
            code: "UNCAUGHT_EXCEPTION",
        });
        process.exitCode = 1;
    });

    process.on("unhandledRejection", () => {
        structuredLog("error", "whatsapp_gateway_unhandled_rejection", {
            code: "UNHANDLED_REJECTION",
        });
        process.exitCode = 1;
    });
}

void main().catch(() => {
    structuredLog("error", "whatsapp_gateway_startup_failed", {
        code: "STARTUP_FAILED",
    });
    process.exitCode = 1;
});
