import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { listShippingDiscounts, createShippingDiscount } from "@/lib/marketing/shipping-discount";

async function requireAdmin() {
    const session = await auth();
    if (!session?.user?.id) return { error: NextResponse.json({ success: false, message: "Silakan login terlebih dahulu." }, { status: 401 }) };
    if (session.user.role !== "ADMIN") return { error: NextResponse.json({ success: false, message: "Akses ditolak." }, { status: 403 }) };
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

        const result = await listShippingDiscounts({ search, isActive, limit, offset: (page - 1) * limit });
        return NextResponse.json({
            success: true,
            data: { items: result.items, pagination: { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) } },
        });
    } catch (error) {
        console.error("GET /api/admin/shipping-discounts ERROR:", error);
        return NextResponse.json({ success: false, message: "Gagal mengambil data." }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const admin = await requireAdmin();
        if ("error" in admin) return admin.error;
        const body = await request.json();
        const { name, code, type, value, maxDiscount, minPurchase, startAt, endAt, isActive, quota, maxUsagePerUser } = body;

        if (!name?.trim()) return NextResponse.json({ success: false, message: "Nama wajib diisi." }, { status: 400 });
        if (!type || !["PERCENTAGE", "FIXED"].includes(type)) return NextResponse.json({ success: false, message: "Tipe diskon tidak valid." }, { status: 400 });
        if (!value || value <= 0) return NextResponse.json({ success: false, message: "Nilai diskon harus lebih dari 0." }, { status: 400 });
        if (!startAt || !endAt) return NextResponse.json({ success: false, message: "Tanggal wajib diisi." }, { status: 400 });

        const discount = await createShippingDiscount({
            name: name.trim(),
            code: code?.trim() || null,
            type,
            value: Number(value),
            maxDiscount: maxDiscount ? Number(maxDiscount) : null,
            minPurchase: minPurchase ? Number(minPurchase) : null,
            quota: quota !== undefined && quota !== null && quota !== "" ? Number(quota) : null,
            maxUsagePerUser: maxUsagePerUser !== undefined && maxUsagePerUser !== null && maxUsagePerUser !== "" ? Number(maxUsagePerUser) : null,
            startAt: new Date(startAt),
            endAt: new Date(endAt),
            isActive: isActive !== false,
        });

        return NextResponse.json({ success: true, message: "Diskon ongkir berhasil dibuat.", data: discount }, { status: 201 });
    } catch (error) {
        console.error("POST /api/admin/shipping-discounts ERROR:", error);
        return NextResponse.json({ success: false, message: "Gagal membuat diskon ongkir." }, { status: 500 });
    }
}
