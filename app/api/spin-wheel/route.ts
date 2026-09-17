import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { checkEligibility } from "@/lib/spin-wheel";

// ==========================================
// GET /api/spin-wheel
// ==========================================
// Check if user is eligible to spin.
// Requires authentication.

export async function GET() {
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

        const eligibility = await checkEligibility(
            session.user.id,
            session.user.role
        );

        return NextResponse.json({
            success: true,
            data: eligibility,
        });
    } catch (error) {
        console.error("SPIN_WHEEL_ELIGIBILITY_ERROR:", error);
        return NextResponse.json(
            {
                success: false,
                message: "Gagal memeriksa kelayakan spin.",
            },
            { status: 500 }
        );
    }
}
