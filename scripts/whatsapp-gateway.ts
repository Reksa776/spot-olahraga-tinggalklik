import "dotenv/config";
import { resolveWhatsAppGatewayConfig } from "../lib/whatsapp/gateway/config";
import { WhatsAppGateway } from "../lib/whatsapp/gateway/gateway";
import { structuredLog } from "../lib/notifications/logger";

/**
 * Isolated WhatsApp gateway entrypoint (Phase P2).
 *
 * Disabled by default: with `WA_GATEWAY_ENABLED` unset/false this process validates nothing
 * else and exits 0 without opening a socket. When enabled it binds loopback only and waits for
 * SIGTERM/SIGINT. There is no pairing command, QR route or real message in this phase.
 */

async function main(): Promise<void> {
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
