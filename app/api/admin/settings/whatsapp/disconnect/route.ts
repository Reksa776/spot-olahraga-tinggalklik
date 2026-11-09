import type { NextRequest } from "next/server";
import { z } from "zod";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok, validationError } from "@/lib/api/response";
import { requirePlatformPermission } from "@/lib/authz";
import { PERMISSIONS } from "@/lib/authz/permissions";
import { requireSameOrigin } from "@/lib/csrf";
import { resolveWhatsAppGatewayConfig } from "@/lib/whatsapp/gateway/config";
import { disconnectWhatsAppGateway } from "@/lib/whatsapp/gateway/disconnect-service";
import { getWhatsAppGatewayForWeb } from "@/lib/whatsapp/gateway/web-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
    .object({
        deleteSession: z.boolean().optional().default(false),
        reason: z.string().trim().max(200).optional(),
    })
    .strict();

const LOCK_HELD_MESSAGE =
    "Gateway lain masih memegang koneksi. Hentikan proses worker/gateway lain dulu (pm2 stop tinggalklik-worker) lalu coba lagi.";

export async function POST(request: NextRequest) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);

        if (csrf.error) {
            return csrf.error;
        }

        const actor = await requirePlatformPermission(
            PERMISSIONS.APPLICATION_SETTINGS
        );

        let raw: unknown = {};

        try {
            const text = await request.text();

            if (text.trim().length > 0) {
                raw = JSON.parse(text);
            }
        } catch {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const parsed = bodySchema.safeParse(raw);

        if (!parsed.success) {
            throw validationError(parsed.error.issues);
        }

        const gateway = await getWhatsAppGatewayForWeb();
        const resolved = resolveWhatsAppGatewayConfig();
        const sessionDir =
            resolved.ok && resolved.config.enabled
                ? resolved.config.sessionDir
                : null;

        const outcome = await disconnectWhatsAppGateway({
            gateway,
            sessionDir,
            input: parsed.data,
            actor,
            request,
        });

        if (outcome.kind === "LOCK_HELD") {
            throw new AppError("CONFLICT", {
                message: LOCK_HELD_MESSAGE,
                details: { lockHolder: outcome.lockHolder },
            });
        }

        return ok({
            status: "DISCONNECTED",
            deletedSession: outcome.deletedSession,
            ...(outcome.alreadyDisconnected
                ? { alreadyDisconnected: true }
                : {}),
        });
    });
}
