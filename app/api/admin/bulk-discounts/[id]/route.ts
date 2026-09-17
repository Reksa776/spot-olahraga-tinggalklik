import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getBulkDiscount, updateBulkDiscount, deleteBulkDiscount } from "@/lib/marketing/bulk-discount";

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
        const discount = await getBulkDiscount(Number(id));
        return NextResponse.json({ success: true, data: discount });
    } catch (error) {
        const isNotFound = error instanceof Error && error.message.includes("tidak ditemukan");
        return NextResponse.json({ success: false, message: isNotFound ? "Bulk discount tidak ditemukan." : "Gagal mengambil data." }, { status: isNotFound ? 404 : 500 });
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
        if (body.minQuantity !== undefined) data.minQuantity = Number(body.minQuantity);
        if (body.type !== undefined) data.type = body.type;
        if (body.value !== undefined) data.value = Number(body.value);
        if (body.maxDiscount !== undefined) data.maxDiscount = body.maxDiscount ? Number(body.maxDiscount) : null;
        if (body.startAt !== undefined) data.startAt = new Date(body.startAt);
        if (body.endAt !== undefined) data.endAt = new Date(body.endAt);
        if (body.isActive !== undefined) data.isActive = body.isActive;
        const discount = await updateBulkDiscount(Number(id), data);
        return NextResponse.json({ success: true, message: "Bulk discount berhasil diubah.", data: discount });
    } catch (error) {
        const isNotFound = error instanceof Error && error.message.includes("tidak ditemukan");
        return NextResponse.json({ success: false, message: isNotFound ? "Bulk discount tidak ditemukan." : "Gagal mengubah data." }, { status: isNotFound ? 404 : 400 });
    }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const admin = await requireAdmin();
        if ("error" in admin) return admin.error;
        const { id } = await params;
        await deleteBulkDiscount(Number(id));
        return NextResponse.json({ success: true, message: "Bulk discount berhasil dihapus." });
    } catch (error) {
        const isNotFound = error instanceof Error && error.message.includes("tidak ditemukan");
        return NextResponse.json({ success: false, message: isNotFound ? "Bulk discount tidak ditemukan." : "Gagal menghapus data." }, { status: isNotFound ? 404 : 400 });
    }
}
