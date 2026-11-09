import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * WHATSAPP MANUAL DISCONNECT — PERSISTENT LATCH
 * ==========================================
 *
 * A disconnect must survive a process restart. The flag lives on the existing
 * `PlatformSetting` singleton rather than in a file inside `WA_AUTH_DIR` because:
 *
 *   - `PlatformSetting` is already the application-control store (maintenance,
 *     branding), and the settings page reads from the same platform layer;
 *   - the web process and the notification worker both read the same database, so
 *     they cannot disagree about the latch;
 *   - `deleteSession=true` removes the session directory, and a sentinel stored
 *     there would be deleted with it unless special-cased.
 *
 * A read failure does NOT invent a disconnect: the gateway lease and socket are
 * already fail-closed, and silently stopping every send because a settings query
 * failed would turn a transient DB blip into an outage. The destructive path
 * (deleting the session) is separately fail-closed in `session-cleanup.ts`.
 */

export const PLATFORM_SETTING_ID = 1;

/** Stable delivery skip reason; terminal SKIPPED, never retried. */
export const MANUAL_DISCONNECT_SKIP_CODE = "gateway_disconnected_manual";
export const MANUAL_DISCONNECT_SKIP_MESSAGE =
    "WhatsApp is manually disconnected; the delivery was skipped and will not be retried until the operator reconnects.";

type SettingsDb = Pick<PrismaClient, "platformSetting">;

export async function isWhatsAppManuallyDisconnected(
    db: SettingsDb = prisma
): Promise<boolean> {
    try {
        const row = await db.platformSetting.findUnique({
            where: { id: PLATFORM_SETTING_ID },
            select: { whatsappManualDisconnect: true },
        });

        return row?.whatsappManualDisconnect ?? false;
    } catch {
        return false;
    }
}

export async function setWhatsAppManualDisconnect(
    value: boolean,
    db: SettingsDb = prisma
): Promise<void> {
    await db.platformSetting.upsert({
        where: { id: PLATFORM_SETTING_ID },
        create: {
            id: PLATFORM_SETTING_ID,
            whatsappManualDisconnect: value,
        },
        update: {
            whatsappManualDisconnect: value,
        },
    });
}
