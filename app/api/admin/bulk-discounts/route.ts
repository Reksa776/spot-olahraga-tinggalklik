import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { listBulkDiscounts, createBulkDiscount } from "@/lib/marketing/bulk-discount";

async function requireAdmin() {
    const session = await auth();
    if (!session?.user?.id) {
        return { error: NextResponse.json({ success: false, message: "Silakan login terlebih dahulu." }, { status: 401 }) };
    }
    const role = session.user.role;
    if (role !== "ADMIN") {
        return { error: NextResponse.json({ success: false, message: "Akses ditolak." }, { status: 403 }) };
    }
    return { user: session.user };
}

export async function GET(request: NextRequest) {
    try {
        const admin = await requireAdmin();
        if ("error" in admin) return admin.error;

        const params = request.nextUrl.searchParams;
        const page = Math.max(1, Number(params.get("page")) || 1);
        const limit = Math.min(100, Math.max(1, Number(params.get("limit")) || 20));
        const search = params.get("search") || undefined;
        const isActiveParam = params.get("isActive");
        const isActive = isActiveParam !== null ? isActiveParam === "true" : undefined;
        const productIdParam = params.get("productId");
        const productId = productIdParam ? Number(productIdParam) : undefined;

        const result = await listBulkDiscounts({
            search,
            isActive,
            productId: productId && Number.isFinite(productId) ? productId : undefined,
            limit,
            offset: (page - 1) * limit,
        });

        return NextResponse.json({
            success: true,
            data: {
                items: result.items,
                pagination: { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) },
            },
        });
    } catch (error) {
        console.error("GET /api/admin/bulk-discounts ERROR:", error);
        return NextResponse.json({ success: false, message: "Gagal mengambil data." }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const admin = await requireAdmin();
        if ("error" in admin) return admin.error;

        const body = await request.json();
        const { name, productId, variantId, minQuantity, type, value, maxDiscount, startAt, endAt, isActive } = body;

        if (!name?.trim()) return NextResponse.json({ success: false, message: "Nama wajib diisi." }, { status: 400 });
        if (!productId) return NextResponse.json({ success: false, message: "Produk wajib dipilih." }, { status: 400 });
        if (!minQuantity || minQuantity < 2) return NextResponse.json({ success: false, message: "Minimal quantity adalah 2." }, { status: 400 });
        if (!type || !["PERCENTAGE", "FIXED"].includes(type)) return NextResponse.json({ success: false, message: "Tipe diskon tidak valid." }, { status: 400 });
        if (!value || value <= 0) return NextResponse.json({ success: false, message: "Nilai diskon harus lebih dari 0." }, { status: 400 });
        if (!startAt || !endAt) return NextResponse.json({ success: false, message: "Tanggal mulai dan selesai wajib diisi." }, { status: 400 });

        const discount = await createBulkDiscount({
            name: name.trim(),
            productId: Number(productId),
            variantId: variantId ? Number(variantId) : null,
            minQuantity: Number(minQuantity),
            type,
            value: Number(value),
            maxDiscount: maxDiscount ? Number(maxDiscount) : null,
            startAt: new Date(startAt),
            endAt: new Date(endAt),
            isActive: isActive !== false,
        });

        return NextResponse.json({ success: true, message: "Bulk discount berhasil dibuat.", data: discount }, { status: 201 });
    } catch (error) {
        console.error("POST /api/admin/bulk-discounts ERROR:", error);
        return NextResponse.json({ success: false, message: "Gagal membuat bulk discount." }, { status: 500 });
    }
}
