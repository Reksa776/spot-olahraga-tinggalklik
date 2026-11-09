import type { WhatsAppTransport } from "../types";

export class BaileysGatewayError extends Error {
    readonly code: string;
    constructor(code: string, message: string) { super(message); this.name = "BaileysGatewayError"; this.code = code; }
}

/** Sends through the internal Next.js endpoint; the worker never owns the Baileys socket. */
export function createBaileysWhatsAppTransport(env: Record<string, string | undefined> = process.env): WhatsAppTransport {
  const base = env.INTERNAL_APP_URL?.trim() || `http://127.0.0.1:${env.PORT?.trim() || "3003"}`;
  const token = env.WA_GATEWAY_TOKEN?.trim() ?? "";
  if (!token || token.length < 32 || !/^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/.test(base)) throw new BaileysGatewayError("GATEWAY_CONFIG_INVALID", "WhatsApp internal application endpoint is missing or unsafe.");
  return {
    name: "baileys-gateway",
    kind: "baileys",
    async send(message, context) {
      const response = await fetch(`${base}/api/internal/whatsapp/dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          deliveryId: context.deliveryId,
          notificationId: context.notificationId,
          to: message.to,
          text: message.text,
          ...(message.media && message.media.length > 0 ? { media: message.media } : {}),
        }),
        cache: "no-store",
        // Larger than a text-only send: a 640px QR PNG data URL and a multi-image batch take
        // longer to persist and transmit than a plain message.
        signal: AbortSignal.timeout(45_000),
      });
      const body = await response.json().catch(() => ({})) as { status?: string; messageId?: string | null; errorCode?: string };
      if (body.status === "SENT") return { simulated: false, providerMessageId: body.messageId ?? undefined };
      throw new BaileysGatewayError(body.errorCode ?? body.status ?? `HTTP_${response.status}`, "WhatsApp gateway did not accept the message.");
    },
  };
}
