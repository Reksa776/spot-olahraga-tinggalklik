import { prisma } from "@/lib/prisma";

import { normalizeEmail, normalizeIndonesianPhone } from "./contacts";

/**
 * ==========================================
 * STORE CONTACT — A NARROW READ MODEL (PHASE 2)
 * ==========================================
 *
 * The owner asked for the store's contact details in the purchase proof. The Phase 2 audit
 * found that `PlatformSetting.email`, `.phone` and `.address` existed but had no public reader.
 * This module is that reader, and it is deliberately the ONLY one the notification path uses:
 *
 *   • it selects four columns and nothing else — no fee rates, no maintenance state, no logo;
 *   • it is read-only (no writer exists here);
 *   • a missing singleton row yields `null`, never invented contact details;
 *   • a field that is absent, blank or invalid is omitted rather than printed as a placeholder;
 *   • a read error yields `null` so a database hiccup in this decorative block cannot stop a
 *     purchase proof, and cannot make the worker retry a message because of a footer.
 *
 * The platform name is the display name of the store. It is NOT used to fabricate an email,
 * phone number or address: those appear only when the operator actually configured them.
 */

export type NotificationStoreContact = {
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
};

export type StoreContactRow = {
    platformName: string;
    email: string | null;
    phone: string | null;
    address: string | null;
};

const FALLBACK_STORE_NAME = "TinggalKlik.Co";
const MAX_ADDRESS_LENGTH = 500;

/** Pure mapping from a `PlatformSetting` row to what a receipt may print. */
export function buildStoreContact(
    row: StoreContactRow | null
): NotificationStoreContact | null {
    if (!row) {
        return null;
    }

    const name = row.platformName?.trim() || FALLBACK_STORE_NAME;
    const email = normalizeEmail(row.email);
    const phone =
        normalizeIndonesianPhone(row.phone) !== null
            ? (row.phone?.trim() ?? null)
            : null;
    const address = row.address?.trim().slice(0, MAX_ADDRESS_LENGTH) || null;

    // No contact field at all: omit the whole block instead of printing a bare store name
    // under a "Kontak toko" heading that would promise details it does not have.
    if (!email && !phone && !address) {
        return null;
    }

    return { name, email, phone, address };
}

/**
 * Read the singleton row. Never throws: this block is optional information, and a failure to
 * load it must not fail the notification that carries the actual transaction record.
 */
export async function readNotificationStoreContact(
    db: Pick<typeof prisma, "platformSetting"> = prisma
): Promise<NotificationStoreContact | null> {
    try {
        const row = await db.platformSetting.findUnique({
            where: { id: 1 },
            select: {
                platformName: true,
                email: true,
                phone: true,
                address: true,
            },
        });

        return buildStoreContact(row);
    } catch {
        return null;
    }
}
