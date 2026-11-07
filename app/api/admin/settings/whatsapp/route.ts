import { handleApi, ok } from "@/lib/api/response";
import { requirePlatformPermission } from "@/lib/authz";
import { PERMISSIONS } from "@/lib/authz/permissions";
import { gatewayFetch } from "@/lib/whatsapp/dashboard-client";
import { readSmtpAdapterConfig } from "@/lib/notifications/transports/smtp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleApi(async () => {
    await requirePlatformPermission(PERMISSIONS.APPLICATION_SETTINGS);
    const smtp = { configured: Boolean(readSmtpAdapterConfig()), secure: process.env.SMTP_SECURE?.trim().toLowerCase() === "true", from: process.env.EMAIL_FROM ?? null };
    let state: Record<string, unknown> = { state: "UNAVAILABLE", connected: false, ready: false, sessionPresent: false, qr: null };
    try { state = await gatewayFetch("/v1/pairing/status") as Record<string, unknown>; } catch { /* Gateway status is independent from SMTP readiness. */ }
    return ok({ ...state, smtp });
  });
}
