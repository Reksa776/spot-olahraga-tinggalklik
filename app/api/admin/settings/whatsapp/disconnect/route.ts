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
        forceReleaseStale: z.boolean().optional(),
        reason: z.string().trim().max(200).optional(),
    })
    .strict();

const LOCK_HELD_MESSAGE =
    "Gateway lain masih memegang koneksi. Hentikan proses gateway lama di host yang ditampilkan, lalu coba lagi.";

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
            const holder = outcome.lock.holder ?? outcome.lockHolder;
            const liveLockMessage = `Lock masih dipegang proses hidup. Hentikan proses ${
                holder?.pid ?? "yang tidak dikenal"
            } di ${holder?.host ?? "host ini"} dulu.`;

            throw new AppError("CONFLICT", {
                message:
                    parsed.data.forceReleaseStale &&
                    outcome.lock.held &&
                    !outcome.lock.stale
                        ? liveLockMessage
                        : LOCK_HELD_MESSAGE,
                details: {
                    lock: outcome.lock,
                    lockHolder: holder,
                },
            });
        }

        return ok({
            status: "DISCONNECTED",
            deletedSession: outcome.deletedSession,
            forceReleased: outcome.forceReleased,
            ...(outcome.alreadyDisconnected
                ? { alreadyDisconnected: true }
                : {}),
        });
    });
}
