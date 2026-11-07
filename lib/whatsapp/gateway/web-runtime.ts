import { structuredLog } from "@/lib/notifications/logger";
import { resolveWhatsAppGatewayConfig } from "./config";
import { WhatsAppGateway } from "./gateway";
import { ensureWhatsAppSessionKey } from "./session-key";

type GatewayRuntimeGlobal = typeof globalThis & {
    __tinggalklikWhatsAppGatewayStart?: Promise<void>;
    __tinggalklikWhatsAppGateway?: WhatsAppGateway;
};

/** Start one in-process gateway for the self-hosted Node.js web server. */
export function startWhatsAppGatewayForWeb(): Promise<void> {
    const runtime = globalThis as GatewayRuntimeGlobal;
    if (runtime.__tinggalklikWhatsAppGatewayStart) return runtime.__tinggalklikWhatsAppGatewayStart;

    runtime.__tinggalklikWhatsAppGatewayStart = (async () => {
        try {
            await ensureWhatsAppSessionKey();
            const resolved = resolveWhatsAppGatewayConfig();
            if (!resolved.ok) {
                structuredLog("error", "whatsapp_gateway_config_error", {
                    code: resolved.code,
                    error: resolved.message,
                });
                return;
            }
            if (!resolved.config.enabled) return;

            const gateway = new WhatsAppGateway(resolved.config, { serveHttp: false });
            runtime.__tinggalklikWhatsAppGateway = gateway;
            const snapshot = await gateway.start();
            structuredLog(snapshot.state === "ERROR" ? "error" : "info", "whatsapp_gateway_web_runtime", {
                state: snapshot.state,
                ready: snapshot.ready,
                ownershipHeld: snapshot.ownershipHeld,
                sessionPresent: snapshot.sessionPresent,
            });

            if (snapshot.state === "CONFLICT") {
                // Preserve the state so the dashboard can report the lock/lease conflict.
                return;
            }

            const stopOnSignal = (signal: NodeJS.Signals) => {
                process.removeListener(signal, stopOnSignal);
                void gateway.stop().finally(() => process.kill(process.pid, signal));
            };
            process.once("SIGTERM", stopOnSignal);
            process.once("SIGINT", stopOnSignal);
        } catch {
            structuredLog("error", "whatsapp_gateway_web_start_failed", {
                code: "WEB_RUNTIME_START_FAILED",
            });
        }
    })();

    return runtime.__tinggalklikWhatsAppGatewayStart;
}

export async function getWhatsAppGatewayForWeb(): Promise<WhatsAppGateway | null> {
    await startWhatsAppGatewayForWeb();
    return (globalThis as GatewayRuntimeGlobal).__tinggalklikWhatsAppGateway ?? null;
}
