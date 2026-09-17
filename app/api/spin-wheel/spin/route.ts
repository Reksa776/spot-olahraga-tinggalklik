import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { executeSpin } from "@/lib/spin-wheel";

// ==========================================
// POST /api/spin-wheel/spin
// ==========================================
// Execute a spin for the authenticated user.
// Server determines the reward — never trust client.

export async function POST() {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Silakan login terlebih dahulu.",
                },
                { status: 401 }
            );
        }

        const result = await executeSpin(
            session.user.id,
            session.user.role
        );

        if (!result.success) {
            return NextResponse.json(
                {
                    success: false,
                    message: result.message,
                },
                { status: 400 }
            );
        }

        return NextResponse.json({
            success: true,
            data: {
                spinId: result.spinId,
                reward: result.reward,
            },
        });
    } catch (error) {
        console.error("SPIN_WHEEL_SPIN_ERROR:", error);
        return NextResponse.json(
            {
                success: false,
                message: "Gagal melakukan spin. Silakan coba lagi.",
            },
            { status: 500 }
        );
    }
}
