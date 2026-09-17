import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { rajaOngkirFetch } from "@/lib/rajaongkir";

async function isAdmin() {
    const session = await auth();

    return (
        !!session?.user &&
        session.user.role === "ADMIN"
    );
}
function nullableNumber(
    value: unknown
): number | null {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    const numberValue =
        Number(value);

    return Number.isFinite(numberValue)
        ? numberValue
        : null;
}

/**
 * Ambil RajaOngkir destination ID berdasarkan
 * data wilayah toko.
 *
 * Kita tidak menerima destination ID dari frontend.
 * Backend yang menentukan dan menyimpannya.
 */
async function resolveRajaOngkirDestination(
    subdistrictId: number | null,
    cityId: number | null,
    districtId: number | null
) {
    if (!subdistrictId) {
        return null;
    }

    /**
     * Sesuaikan endpoint ini dengan endpoint
     * destination/search RajaOngkir v2 yang sudah
     * kamu gunakan di project.
     *
     * Karena data subdistrict kita sudah punya ID,
     * kita coba cari destination berdasarkan
     * subdistrict ID.
     */
    try {
        const result = await rajaOngkirFetch(
            `/destination/domestic-destination?search=${subdistrictId}`
        );

        if (
            Array.isArray(result) &&
            result.length > 0
        ) {
            const destination = result.find(
                (item: any) =>
                    Number(item.subdistrict_id) ===
                    Number(subdistrictId)
            );

            if (destination?.id) {
                return Number(destination.id);
            }

            if (result[0]?.id) {
                return Number(result[0].id);
            }
        }
    } catch (error) {
        console.error(
            "RAJAONGKIR DESTINATION RESOLVE ERROR:",
            error
        );
    }

    return null;
}

export async function GET() {
    try {
        if (!(await isAdmin())) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        const setting =
            await prisma.storeSetting.findUnique({
                where: {
                    id: 1,
                },
            });

        return NextResponse.json({
            success: true,
            data: setting,
        });
    } catch (error) {
        console.error(
            "GET STORE SETTINGS ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal mengambil pengaturan toko.",
            },
            { status: 500 }
        );
    }
}

export async function PUT(
    request: Request
) {
    try {
        if (!(await isAdmin())) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        const body =
            await request.json();

        const provinceId =
            body.provinceId
                ? Number(body.provinceId)
                : null;

        const cityId =
            body.cityId
                ? Number(body.cityId)
                : null;

        const districtId =
            body.districtId
                ? Number(body.districtId)
                : null;

        const subdistrictId =
            body.subdistrictId
                ? Number(
                    body.subdistrictId
                )
                : null;

        /**
         * Jangan percaya destination ID
         * yang dikirim frontend.
         *
         * Backend yang generate.
         */
        let rajaOngkirDestinationId =
            null;

        if (subdistrictId) {
            rajaOngkirDestinationId =
                await resolveRajaOngkirDestination(
                    subdistrictId,
                    cityId,
                    districtId
                );
        }

        const setting =
            await prisma.storeSetting.upsert({
                where: {
                    id: 1,
                },

                create: {
                    id: 1,

                    storeName:
                        body.storeName?.trim() ||
                        "",

                    phone:
                        body.phone?.trim() ||
                        null,

                    email:
                        body.email?.trim() ||
                        null,

                    logo:
                        body.logo?.trim() ||
                        null,

                    address:
                        body.address?.trim() ||
                        "",
                    tiktokPixelId:
                        body.tiktokPixelId?.trim() ||
                        null,

                    provinceId,

                    province:
                        body.province?.trim() ||
                        null,

                    cityId,

                    city:
                        body.city?.trim() ||
                        null,

                    districtId,

                    district:
                        body.district?.trim() ||
                        null,

                    subdistrictId,

                    subdistrict:
                        body.subdistrict?.trim() ||
                        null,

                    postalCode:
                        body.postalCode?.trim() ||
                        null,

                    rajaOngkirDestinationId:
                        nullableNumber(
                            body.rajaOngkirDestinationId
                        ),

                    latitude:
                        body.latitude !== null &&
                            body.latitude !==
                            undefined &&
                            body.latitude !== ""
                            ? Number(
                                body.latitude
                            )
                            : null,

                    longitude:
                        body.longitude !== null &&
                            body.longitude !==
                            undefined &&
                            body.longitude !== ""
                            ? Number(
                                body.longitude
                            )
                            : null,
                },

                update: {
                    storeName:
                        body.storeName?.trim() ||
                        "",

                    phone:
                        body.phone?.trim() ||
                        null,

                    email:
                        body.email?.trim() ||
                        null,

                    logo:
                        body.logo?.trim() ||
                        null,

                    address:
                        body.address?.trim() ||
                        "",
                    tiktokPixelId:
                        body.tiktokPixelId?.trim() ||
                        null,

                    provinceId,

                    province:
                        body.province?.trim() ||
                        null,

                    cityId,

                    city:
                        body.city?.trim() ||
                        null,

                    districtId,

                    district:
                        body.district?.trim() ||
                        null,

                    subdistrictId,

                    subdistrict:
                        body.subdistrict?.trim() ||
                        null,

                    postalCode:
                        body.postalCode?.trim() ||
                        null,

                    rajaOngkirDestinationId:
                        nullableNumber(
                            body.rajaOngkirDestinationId
                        ),

                    latitude:
                        body.latitude !== null &&
                            body.latitude !==
                            undefined &&
                            body.latitude !== ""
                            ? Number(
                                body.latitude
                            )
                            : null,

                    longitude:
                        body.longitude !== null &&
                            body.longitude !==
                            undefined &&
                            body.longitude !== ""
                            ? Number(
                                body.longitude
                            )
                            : null,
                },
            });

        return NextResponse.json({
            success: true,
            message:
                "Pengaturan toko berhasil disimpan.",
            data: setting,
        });
    } catch (error) {
        console.error(
            "UPDATE STORE SETTINGS ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message: "Gagal menyimpan pengaturan toko.",
            },
            { status: 500 }
        );
    }
}