import type { NextRequest } from "next/server";
import { handleApi, ok } from "@/lib/api/response";
import { requirePlatformPermission } from "@/lib/authz";
import { PERMISSIONS } from "@/lib/authz/permissions";
import { requireSameOrigin } from "@/lib/csrf";
import { getWhatsAppGatewayForWeb } from "@/lib/whatsapp/gateway/web-runtime";
import { AppError } from "@/lib/api/errors";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const csrf = requireSameOrigin(request); if (csrf.error) return csrf.error;
    await requirePlatformPermission(PERMISSIONS.APPLICATION_SETTINGS);
    const gateway = await getWhatsAppGatewayForWeb();
    if (!gateway) throw AppError.conflict("WhatsApp gateway belum siap. Periksa WA_GATEWAY_ENABLED dan konfigurasi server.");
    return ok(await gateway.beginPairing());
  });
}
