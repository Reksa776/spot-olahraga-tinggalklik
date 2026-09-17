import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { rajaOngkirFetch } from "@/lib/rajaongkir";

async function isAdmin() {
    const session = await auth();

    return (
        !!session?.user &&
        session.user.role === "ADMIN"
    );
}

type Destination = {
    id: number;
    label?: string;

    province_name?: string;
    city_name?: string;
    district_name?: string;
    subdistrict_name?: string;

    zip_code?: string;
};

export async function GET(
    request: Request
) {
    try {
        if (!(await isAdmin())) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                {
                    status: 401,
                }
            );
        }

        const { searchParams } =
            new URL(request.url);

        const subdistrict =
            searchParams.get(
                "subdistrict"
            )?.trim();

        const postalCode =
            searchParams.get(
                "postalCode"
            )?.trim();

        if (!subdistrict && !postalCode) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Subdistrict atau postalCode wajib diisi.",
                },
                {
                    status: 400,
                }
            );
        }

        // Prioritaskan nama kelurahan/desa.
        // Kalau tidak ada, gunakan kode pos.
        const search =
            subdistrict ||
            postalCode ||
            "";

        const endpoint =
            `/destination/domestic-destination` +
            `?search=${encodeURIComponent(
                search
            )}` +
            `&limit=20` +
            `&offset=0`;

        console.log(
            "RAJAONGKIR DESTINATION REQUEST:",
            endpoint
        );

        const destinations =
            await rajaOngkirFetch<
                Destination[]
            >(endpoint);

        console.log(
            "RAJAONGKIR DESTINATION RESPONSE:",
            destinations
        );

        if (
            !Array.isArray(
                destinations
            ) ||
            destinations.length === 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Destination RajaOngkir tidak ditemukan.",
                },
                {
                    status: 404,
                }
            );
        }

        let destination =
            destinations[0];

        // Kalau mencari berdasarkan nama subdistrict,
        // cari yang namanya benar-benar sama.
        if (subdistrict) {
            const exact =
                destinations.find(
                    (item) =>
                        item.subdistrict_name
                            ?.trim()
                            .toLowerCase() ===
                        subdistrict
                            .trim()
                            .toLowerCase()
                );

            if (exact) {
                destination = exact;
            }
        }

        // Kalau postal code tersedia,
        // prioritaskan hasil yang kode posnya cocok.
        if (
            postalCode &&
            !subdistrict
        ) {
            const exact =
                destinations.find(
                    (item) =>
                        String(
                            item.zip_code ?? ""
                        ) ===
                        String(
                            postalCode
                        )
                );

            if (exact) {
                destination = exact;
            }
        }

        if (!destination?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "ID destination RajaOngkir tidak ditemukan.",
                    data: destinations,
                },
                {
                    status: 404,
                }
            );
        }

        return NextResponse.json({
            success: true,

            data: {
                id: destination.id,

                destinationId:
                    destination.id,

                label:
                    destination.label ??
                    null,

                province:
                    destination.province_name ??
                    null,

                city:
                    destination.city_name ??
                    null,

                district:
                    destination.district_name ??
                    null,

                subdistrict:
                    destination.subdistrict_name ??
                    null,

                postalCode:
                    destination.zip_code ??
                    null,
            },
        });
    } catch (error) {
        console.error(
            "DESTINATION ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message: "Gagal mengambil destination RajaOngkir.",
            },
            {
                status: 500,
            }
        );
    }
}