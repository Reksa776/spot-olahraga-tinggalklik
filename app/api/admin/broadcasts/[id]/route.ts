import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getBroadcast, updateBroadcast, deleteBroadcast } from "@/lib/marketing/broadcast";

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
        const broadcast = await getBroadcast(Number(id));
        return NextResponse.json({ success: true, data: broadcast });
    } catch (error) {
        const isNotFound = error instanceof Error && error.message.includes("tidak ditemukan");
        return NextResponse.json({ success: false, message: isNotFound ? "Broadcast tidak ditemukan." : "Gagal mengambil data." }, { status: isNotFound ? 404 : 500 });
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
        if (body.subject !== undefined) data.subject = body.subject?.trim() || null;
        if (body.message !== undefined) data.message = body.message;
        if (body.imageUrl !== undefined) data.imageUrl = body.imageUrl?.trim() || null;
        if (body.link !== undefined) data.link = body.link?.trim() || null;
        if (body.scheduledAt !== undefined) data.scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
        if (body.status !== undefined) data.status = body.status;
        const broadcast = await updateBroadcast(Number(id), data);
        return NextResponse.json({ success: true, message: "Berhasil diubah.", data: broadcast });
    } catch (error) {
        return NextResponse.json({ success: false, message: "Gagal mengubah broadcast." }, { status: 500 });
    }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const admin = await requireAdmin();
        if ("error" in admin) return admin.error;
        const { id } = await params;
        await deleteBroadcast(Number(id));
        return NextResponse.json({ success: true, message: "Berhasil dihapus." });
    } catch (error) {
        const isNotFound = error instanceof Error && error.message.includes("tidak ditemukan");
        return NextResponse.json({ success: false, message: isNotFound ? "Broadcast tidak ditemukan." : "Gagal menghapus data." }, { status: isNotFound ? 404 : 400 });
    }
}
