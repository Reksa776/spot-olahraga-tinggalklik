import type { NextRequest } from "next/server";
import { handleApi, ok } from "@/lib/api/response";
import { requirePlatformPermission } from "@/lib/authz";
import { PERMISSIONS } from "@/lib/authz/permissions";
import { requireSameOrigin } from "@/lib/csrf";
import { getWhatsAppGatewayForWeb } from "@/lib/whatsapp/gateway/web-runtime";
import { AppError } from "@/lib/api/errors";
import { setWhatsAppManualDisconnect } from "@/lib/whatsapp/manual-disconnect";

export const runtime = "nodejs";

const LOCK_HELD_MESSAGE =
    "Gateway lain masih memegang koneksi. Hentikan proses worker/gateway lain dulu (pm2 stop tinggalklik-worker) lalu coba lagi.";

export async function POST(request: NextRequest) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) return csrf.error;

        await requirePlatformPermission(PERMISSIONS.APPLICATION_SETTINGS);

        const gateway = await getWhatsAppGatewayForWeb();
        if (!gateway) {
            throw AppError.conflict(
                "WhatsApp gateway belum siap. Periksa WA_GATEWAY_ENABLED dan konfigurasi server."
            );
        }

        /*
         * "Hubungkan ulang" is the explicit operator action that clears the latch. It is
         * written BEFORE the flow starts because the gateway refuses to acquire ownership
         * while latched; if the flow cannot start, the latch is restored so a failed click
         * does not silently re-enable automatic sending.
         */
        await setWhatsAppManualDisconnect(false);

        try {
            // beginPairing() reacquires ownership after a disconnect, removes a dead
            // LOGGED_OUT session, and opens the socket/QR flow in one action.
            const result = await gateway.beginPairing();
            const snapshot = gateway.snapshot();

            /*
             * The latch may only stay cleared when the pairing flow actually owns the
             * session. A competing gateway or a failed start must restore it; otherwise
             * a failed "Hubungkan ulang" would silently re-enable automatic sends.
             */
            if (
                !snapshot.ownershipHeld ||
                snapshot.state === "CONFLICT" ||
                snapshot.state === "ERROR"
            ) {
                await gateway.disconnect().catch(() => undefined);
                await setWhatsAppManualDisconnect(true).catch(() => undefined);

                if (snapshot.state === "CONFLICT") {
                    throw AppError.conflict(LOCK_HELD_MESSAGE);
                }

                throw new AppError("SERVICE_UNAVAILABLE", {
                    message:
                        "Pairing WhatsApp gagal dimulai. Periksa log gateway lalu coba lagi.",
                });
            }

            return ok(result);
        } catch (error) {
            // A throw after a partial start must not leave an unlatched socket behind.
            await gateway.disconnect().catch(() => undefined);
            await setWhatsAppManualDisconnect(true).catch(() => undefined);
            throw error;
        }
    });
}
