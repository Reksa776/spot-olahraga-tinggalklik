import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getBroadcast, getBroadcastAudience } from "@/lib/marketing/broadcast";

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
        const audience = await getBroadcastAudience(broadcast.type);

        // Limit response for preview (don't send full user data to admin)
        const preview = audience.slice(0, 50).map((member) => ({
            userId: member.userId,
            name: member.name,
            phone: member.phone ? `${member.phone.substring(0, 6)}***` : null,
            reason: member.reason,
        }));

        return NextResponse.json({
            success: true,
            data: {
                broadcast: {
                    id: broadcast.id,
                    name: broadcast.name,
                    type: broadcast.type,
                    channel: broadcast.channel,
                },
                audienceCount: audience.length,
                preview,
            },
        });
    } catch (error) {
        console.error("GET /api/admin/broadcasts/audience ERROR:", error);
        return NextResponse.json({ success: false, message: "Gagal mengambil audience." }, { status: 500 });
    }
}
