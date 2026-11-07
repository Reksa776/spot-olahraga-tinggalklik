import type { NextRequest } from "next/server";
import { handleApi, ok } from "@/lib/api/response";
import { requirePlatformPermission } from "@/lib/authz";
import { PERMISSIONS } from "@/lib/authz/permissions";
import { requireSameOrigin } from "@/lib/csrf";
import { gatewayFetch } from "@/lib/whatsapp/dashboard-client";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const csrf = requireSameOrigin(request); if (csrf.error) return csrf.error;
    await requirePlatformPermission(PERMISSIONS.APPLICATION_SETTINGS);
    return ok(await gatewayFetch("/v1/pairing/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  });
}
