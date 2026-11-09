import { handleApi, ok } from "@/lib/api/response";
import { requirePlatformPermission } from "@/lib/authz";
import { PERMISSIONS } from "@/lib/authz/permissions";
import { getWhatsAppGatewayStatus } from "@/lib/whatsapp/gateway/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    return handleApi(async () => {
        await requirePlatformPermission(PERMISSIONS.APPLICATION_SETTINGS);

        return ok(await getWhatsAppGatewayStatus());
    });
}
