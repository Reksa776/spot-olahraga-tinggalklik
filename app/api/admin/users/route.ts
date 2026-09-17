import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
        }
        const role = session.user.role;
        if (role !== "ADMIN") {
            return NextResponse.json({ success: false, message: "Akses ditolak." }, { status: 403 });
        }

        const params = request.nextUrl.searchParams;
        const page = Math.max(1, Number(params.get("page")) || 1);
        const limit = Math.min(100, Math.max(1, Number(params.get("limit")) || 20));
        const search = params.get("search") || undefined;

        const where: any = {};
        if (search && search.trim()) {
            const term = search.trim();
            where.OR = [
                { name: { contains: term } },
                { email: { contains: term } },
                { phone: { contains: term } },
            ];
        }

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                select: {
                    id: true,
                    name: true,
                    email: true,
                    phone: true,
                    role: true,
                    createdAt: true,
                    _count: { select: { orders: true, addresses: true } },
                },
                orderBy: { createdAt: "desc" },
                take: limit,
                skip: (page - 1) * limit,
            }),
            prisma.user.count({ where }),
        ]);

        return NextResponse.json({
            success: true,
            data: {
                items: users,
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (error) {
        console.error("GET /api/admin/users ERROR:", error);
        return NextResponse.json({ success: false, message: "Gagal mengambil data." }, { status: 500 });
    }
}
