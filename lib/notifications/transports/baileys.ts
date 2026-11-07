import type { WhatsAppTransport } from "../types";

export class BaileysGatewayError extends Error {
    readonly code: string;
    constructor(code: string, message: string) { super(message); this.name = "BaileysGatewayError"; this.code = code; }
}

/** Sends text through the isolated loopback Baileys gateway; the worker never owns the socket. */
export function createBaileysWhatsAppTransport(env: Record<string, string | undefined> = process.env): WhatsAppTransport {
  const base = env.WA_GATEWAY_URL?.trim() || `http://127.0.0.1:${env.WA_GATEWAY_PORT?.trim() || "3100"}`;
  const token = env.WA_GATEWAY_TOKEN?.trim() ?? "";
  if (!token || token.length < 32 || !/^http:\/\/(127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(base)) throw new BaileysGatewayError("GATEWAY_CONFIG_INVALID", "WhatsApp gateway configuration is missing or unsafe.");
  return {
    name: "baileys-gateway",
    kind: "baileys",
    async send(message, context) {
      const response = await fetch(`${base}/v1/messages/text`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ deliveryId: context.deliveryId, notificationId: context.notificationId, to: message.to, text: message.text }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => ({})) as { status?: string; messageId?: string | null; errorCode?: string };
      if (body.status === "SENT") return { simulated: false, providerMessageId: body.messageId ?? undefined };
      throw new BaileysGatewayError(body.errorCode ?? body.status ?? `HTTP_${response.status}`, "WhatsApp gateway did not accept the message.");
    },
  };
}
