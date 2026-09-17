import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import {
    getBroadcast,
    registerBroadcastQueueWorker,
} from "@/lib/marketing/broadcast";
import { getNotificationQueue } from "@/lib/notification/queue";
import { rateLimiters } from "@/lib/rate-limit";

/**
 * F26 FIX: register the background broadcast worker once.
 *
 * sendBroadcast no longer runs synchronously inside the HTTP request
 * (for large audiences the 500ms per-message delay could block the
 * request for minutes). Sending is now dispatched onto the in-memory
 * NotificationQueue and drained by the worker.
 */
registerBroadcastQueueWorker();

async function requireAdmin() {
    const session = await auth();
    if (!session?.user?.id) return { error: NextResponse.json({ success: false, message: "Silakan login terlebih dahulu." }, { status: 401 }) };
    if (session.user.role !== "ADMIN") return { error: NextResponse.json({ success: false, message: "Akses ditolak." }, { status: 403 }) };
    return { user: session.user };
}

/**
 * POST /api/admin/broadcasts/[id]/send
 *
 * Triggers broadcast delivery to all audience members.
 * The broadcast is enqueued onto the in-memory queue and the request
 * returns immediately. The background worker runs `sendBroadcast`,
 * whose atomic CAS (DRAFT/SCHEDULED → SENDING) prevents concurrent
 * or duplicate sends.
 */
export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const admin = await requireAdmin();
        if ("error" in admin) return admin.error;

        // Rate limiting
        const rateLimit = rateLimiters.broadcastSend(admin.user.id!);
        if (!rateLimit.allowed) {
            return NextResponse.json(
                { success: false, message: "Terlalu banyak permintaan. Coba lagi nanti." },
                { status: 429 }
            );
        }

        const { id } = await params;
        const broadcastId = Number(id);

        if (!Number.isInteger(broadcastId) || broadcastId <= 0) {
            return NextResponse.json(
                { success: false, message: "ID broadcast tidak valid." },
                { status: 400 }
            );
        }

        let broadcast;
        try {
            broadcast = await getBroadcast(broadcastId);
        } catch {
            return NextResponse.json(
                { success: false, message: "Broadcast tidak ditemukan." },
                { status: 404 }
            );
        }

        // Confirm-guard: only DRAFT/SCHEDULED broadcasts can start sending.
        if (broadcast.status !== "DRAFT" && broadcast.status !== "SCHEDULED") {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Broadcast sedang dikirim atau sudah selesai/digagalkan. " +
                        "Ubah status kembali ke draft terlebih dahulu untuk mengirim ulang.",
                },
                { status: 409 }
            );
        }

        // Enqueue without awaiting the actual send work.
        getNotificationQueue().enqueue(
            { broadcastId },
            { maxAttempts: 1 }
        );

        return NextResponse.json({
            success: true,
            message:
                "Broadcast dikirim ke antrean. Proses pengiriman berjalan di latar belakang.",
            data: { broadcastId, queued: true },
        });
    } catch (error: any) {
        return NextResponse.json(
            { success: false, message: "Gagal mengirim broadcast." },
            { status: 500 }
        );
    }
}