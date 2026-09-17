import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { listBroadcasts, createBroadcast, BROADCAST_TYPE_LABELS } from "@/lib/marketing/broadcast";
import { rateLimiters } from "@/lib/rate-limit";

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
        const type = params.get("type") || undefined;
        const status = params.get("status") || undefined;

        const result = await listBroadcasts({
            search,
            type: type as any || undefined,
            status: status as any || undefined,
            limit,
            offset: (page - 1) * limit,
        });

        return NextResponse.json({
            success: true,
            data: { items: result.items, pagination: { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) } },
        });
    } catch (error: any) {
        console.error("GET /api/admin/broadcasts ERROR:", error?.message);
        return NextResponse.json({ success: false, message: "Gagal mengambil data." }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const admin = await requireAdmin();
        if ("error" in admin) return admin.error;

        // Rate limiting
        const rateLimit = rateLimiters.broadcastCreate(admin.user.id!);
        if (!rateLimit.allowed) {
            return NextResponse.json(
                { success: false, message: "Terlalu banyak permintaan. Coba lagi nanti." },
                { status: 429 }
            );
        }

        const body = await request.json();
        const { name, type, channel, subject, message, imageUrl, link, scheduledAt } = body;

        if (!name?.trim()) return NextResponse.json({ success: false, message: "Nama wajib diisi." }, { status: 400 });
        if (!type) return NextResponse.json({ success: false, message: "Tipe broadcast wajib dipilih." }, { status: 400 });
        if (!Object.keys(BROADCAST_TYPE_LABELS).includes(type)) {
            return NextResponse.json({ success: false, message: "Tipe broadcast tidak valid." }, { status: 400 });
        }
        if (!message?.trim()) return NextResponse.json({ success: false, message: "Pesan wajib diisi." }, { status: 400 });

        const broadcast = await createBroadcast({
            name: name.trim(),
            type,
            channel: channel || "whatsapp",
            subject: subject?.trim() || null,
            message: message.trim(),
            imageUrl: imageUrl?.trim() || null,
            link: link?.trim() || null,
            scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        });

        return NextResponse.json({ success: true, message: "Broadcast berhasil dibuat.", data: broadcast }, { status: 201 });
    } catch (error: any) {
        console.error("POST /api/admin/broadcasts ERROR:", error?.message);
        return NextResponse.json({ success: false, message: "Gagal membuat broadcast." }, { status: 400 });
    }
}
