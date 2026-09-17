import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getShippingDiscount, updateShippingDiscount, deleteShippingDiscount } from "@/lib/marketing/shipping-discount";

async function requireAdmin() {
    const session = await auth();
    if (!session?.user?.id) return { error: NextResponse.json({ success: false, message: "Silakan login terlebih dahulu." }, { status: 401 }) };
    if (session.user.role !== "ADMIN") return { error: NextResponse.json({ success: false, message: "Akses ditolak." }, { status: 403 }) };
    return { user: session.user };
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const admin = await requireAdmin();
        if ("error" in admin) return admin.error;
        const { id } = await params;
        const discount = await getShippingDiscount(Number(id));
        return NextResponse.json({ success: true, data: discount });
    } catch (error) {
        const isNotFound = error instanceof Error && error.message.includes("tidak ditemukan");
        return NextResponse.json({ success: false, message: isNotFound ? "Diskon ongkir tidak ditemukan." : "Gagal mengambil data." }, { status: isNotFound ? 404 : 500 });
    }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const admin = await requireAdmin();
        if ("error" in admin) return admin.error;
        const { id } = await params;
        const body = await request.json();
        const data: any = {};
        if (body.name !== undefined) data.name = body.name;
        if (body.code !== undefined) data.code = body.code?.trim().toUpperCase() || null;
        if (body.type !== undefined) data.type = body.type;
        if (body.value !== undefined) data.value = Number(body.value);
        if (body.maxDiscount !== undefined) data.maxDiscount = body.maxDiscount ? Number(body.maxDiscount) : null;
        if (body.minPurchase !== undefined) data.minPurchase = body.minPurchase ? Number(body.minPurchase) : null;
        if (body.quota !== undefined) data.quota = body.quota === null || body.quota === "" ? null : Number(body.quota);
        if (body.maxUsagePerUser !== undefined) data.maxUsagePerUser = body.maxUsagePerUser === null || body.maxUsagePerUser === "" ? null : Number(body.maxUsagePerUser);
        if (body.startAt !== undefined) data.startAt = new Date(body.startAt);
        if (body.endAt !== undefined) data.endAt = new Date(body.endAt);
        if (body.isActive !== undefined) data.isActive = body.isActive;
        const discount = await updateShippingDiscount(Number(id), data);
        return NextResponse.json({ success: true, message: "Berhasil diubah.", data: discount });
    } catch (error) {
        const isNotFound = error instanceof Error && error.message.includes("tidak ditemukan");
        return NextResponse.json({ success: false, message: isNotFound ? "Diskon ongkir tidak ditemukan." : "Gagal mengubah data." }, { status: isNotFound ? 404 : 400 });
    }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const admin = await requireAdmin();
        if ("error" in admin) return admin.error;
        const { id } = await params;
        await deleteShippingDiscount(Number(id));
        return NextResponse.json({ success: true, message: "Berhasil dihapus." });
    } catch (error) {
        const isNotFound = error instanceof Error && error.message.includes("tidak ditemukan");
        return NextResponse.json({ success: false, message: isNotFound ? "Diskon ongkir tidak ditemukan." : "Gagal menghapus data." }, { status: isNotFound ? 404 : 400 });
    }
}
