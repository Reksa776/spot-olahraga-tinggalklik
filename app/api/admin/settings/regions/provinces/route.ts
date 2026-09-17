import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { rajaOngkirFetch } from "@/lib/rajaongkir";

type Province = {
    id: number;
    name: string;
};

export async function GET() {
    try {
        const session = await auth();

        if (!session?.user) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized",
                },
                {
                    status: 401,
                }
            );
        }

        const role = session.user.role;

        if (role !== "ADMIN") {
            return NextResponse.json(
                {
                    success: false,
                    message: "Forbidden",
                },
                {
                    status: 403,
                }
            );
        }

        const provinces =
            await rajaOngkirFetch<Province[]>(
                "/destination/province"
            );

        return NextResponse.json({
            success: true,
            data: provinces,
        });
    } catch (error) {
        console.error(
            "GET PROVINCES ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message: "Gagal mengambil provinsi.",
            },
            {
                status: 500,
            }
        );
    }
}