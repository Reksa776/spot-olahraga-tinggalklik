import type { NextRequest } from "next/server";
import { z } from "zod";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok, validationError } from "@/lib/api/response";
import { requirePlatformPermission } from "@/lib/authz";
import { PERMISSIONS } from "@/lib/authz/permissions";
import { requireSameOrigin } from "@/lib/csrf";
import { connectWhatsAppGateway } from "@/lib/whatsapp/gateway/connect-service";
import { getWhatsAppGatewayForWeb } from "@/lib/whatsapp/gateway/web-runtime";

export const runtime = "nodejs";

const bodySchema = z
    .object({
        force: z.boolean().optional(),
    })
    .strict();

/**
 * Pairing shares the explicit connect service, so both endpoints reset the latch and
 * write the same `whatsapp.connect` audit event. A failed pairing does not restore the
 * latch; see `connect-service.ts`.
 */
export async function POST(request: NextRequest) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) return csrf.error;

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

        return ok(
            await connectWhatsAppGateway({
                gateway,
                actor,
                request,
                source: "pairing",
            })
        );
    });
}
