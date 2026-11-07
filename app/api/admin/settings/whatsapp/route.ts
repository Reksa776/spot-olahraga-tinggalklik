import { handleApi, ok } from "@/lib/api/response";
import { requirePlatformPermission } from "@/lib/authz";
import { PERMISSIONS } from "@/lib/authz/permissions";
import { getWhatsAppGatewayForWeb } from "@/lib/whatsapp/gateway/web-runtime";
import { readSmtpAdapterConfig } from "@/lib/notifications/transports/smtp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleApi(async () => {
    await requirePlatformPermission(PERMISSIONS.APPLICATION_SETTINGS);
    const smtp = { configured: Boolean(readSmtpAdapterConfig()), secure: process.env.SMTP_SECURE?.trim().toLowerCase() === "true", from: process.env.EMAIL_FROM ?? null };
    const gateway = await getWhatsAppGatewayForWeb();
    const state: Record<string, unknown> = gateway
      ? { ...gateway.snapshot(), ...gateway.pairingStatus() }
      : { state: "UNAVAILABLE", connected: false, ready: false, sessionPresent: false, qr: null };
    return ok({ ...state, smtp });
  });
}
