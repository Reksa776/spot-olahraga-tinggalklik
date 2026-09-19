import { prisma } from "@/lib/prisma";

export type PublicStoreSetting = {
    storeName: string;
    email: string | null;
    phone: string | null;
    address: string;
    province: string | null;
    city: string | null;
    district: string | null;
    subdistrict: string | null;
    postalCode: string | null;
};

/**
 * Fetch public store setting (singleton, id=1).
 *
 * Only exposes fields that are safe for public
 * pages: footer, contact, legal pages.
 *
 * The model no longer carries the retail-only columns (analytics
 * pixel ids, geo coordinates, the courier destination id) — those
 * were removed with the retail application, and the select below is
 * the whole of the remaining public surface.
 */
export async function getPublicStoreSetting(): Promise<PublicStoreSetting> {
    const setting = await prisma.storeSetting.findUnique({
        where: { id: 1 },
        select: {
            storeName: true,
            email: true,
            phone: true,
            address: true,
            province: true,
            city: true,
            district: true,
            subdistrict: true,
            postalCode: true,
        },
    });

    if (!setting) {
        return {
            storeName: "Toko Kami",
            email: null,
            phone: null,
            address: "",
            province: null,
            city: null,
            district: null,
            subdistrict: null,
            postalCode: null,
        };
    }

    return setting;
}

/**
 * Build a formatted full address string from
 * StoreSetting fields.
 */
export function formatFullAddress(setting: PublicStoreSetting): string {
    const parts: string[] = [];

    if (setting.address) {
        parts.push(setting.address);
    }

    if (setting.subdistrict) {
        parts.push(setting.subdistrict);
    }

    if (setting.district) {
        parts.push(setting.district);
    }

    if (setting.city) {
        parts.push(setting.city);
    }

    if (setting.province) {
        parts.push(setting.province);
    }

    if (setting.postalCode) {
        parts.push(setting.postalCode);
    }

    return parts.join(", ");
}
