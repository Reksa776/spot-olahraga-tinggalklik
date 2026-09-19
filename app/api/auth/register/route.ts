import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { registerSchema } from "@/lib/validations/register";
import { rateLimiters, getClientIp } from "@/lib/rate-limit";
import { requireSameOrigin } from "@/lib/csrf";

/**
 * POST /api/auth/register — create a customer account.
 *
 * The retail affiliate referral block that used to live here was removed with the affiliate
 * system: it resolved a client-supplied `referralCode` against `AffiliateProfile` and stored the
 * result on `User.referredBy`. Neither the model nor those columns exist any more, and ticketing
 * PIC attribution is per-order (`PICAttribution`), never per-account.
 *
 * STATE-CHANGING, SO SAME-ORIGIN IS CHECKED (Phase 3 D-56). This is a mutation reachable
 * without a session, and every other state-changing route in the tree calls `requireSameOrigin`;
 * omitting it here was an inconsistency, not a policy.
 *
 * VALIDATION FAILURES ARE 400, NOT 500. The body is parsed with `safeParse` and mapped onto the
 * platform's error envelope, so a malformed payload (short password, password mismatch, missing
 * email/phone) returns a `VALIDATION_ERROR` with field details instead of falling into the
 * catch-all and being reported as an internal server error.
 */
export async function POST(req: Request) {
    const csrf = requireSameOrigin(req);
    if (csrf.error) {
        return csrf.error;
    }

    try {
        // Rate limiting
        const clientIp = getClientIp(req);
        const rateLimit = rateLimiters.register(clientIp);
        if (!rateLimit.allowed) {
            return NextResponse.json(
                {
                    success: false,
                    code: "RATE_LIMITED",
                    message: "Terlalu banyak permintaan. Coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        const body = await req.json();

        const parsed = registerSchema.safeParse(body);

        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    code: "VALIDATION_ERROR",
                    message:
                        parsed.error.issues[0]?.message ??
                        "Data yang dikirim tidak valid.",
                    details: {
                        fields: parsed.error.issues.map((issue) => ({
                            path: issue.path.join("."),
                            message: issue.message,
                        })),
                    },
                },
                { status: 400 }
            );
        }

        const data = parsed.data;

        if (!data.email && !data.phone) {
            return NextResponse.json(
                {
                    success: false,
                    code: "VALIDATION_ERROR",
                    message:
                        "Email atau nomor HP wajib diisi.",
                },
                { status: 400 }
            );
        }

        const existing = await prisma.user.findFirst({
            where: {
                OR: [
                    ...(data.email
                        ? [{ email: data.email }]
                        : []),

                    ...(data.phone
                        ? [{ phone: data.phone }]
                        : []),
                ],
            },
        });

        if (existing) {
            return NextResponse.json(
                {
                    success: false,
                    code: "CONFLICT",
                    message:
                        "Email atau nomor HP sudah digunakan.",
                },
                { status: 400 }
            );
        }

        const hashedPassword =
            await hashPassword(data.password);

        const user = await prisma.user.create({
            data: {
                name: data.name,
                email: data.email || null,
                phone: data.phone || null,
                password: hashedPassword,
            },
        });

        return NextResponse.json(
            {
                success: true,
                message: "Register berhasil",

                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                },
            },
            { status: 201 }
        );
    } catch (error: unknown) {
        console.error("REGISTER ERROR:", error);

        return NextResponse.json(
            {
                success: false,
                code: "INTERNAL_ERROR",
                message: "Terjadi kesalahan saat registrasi.",
            },
            { status: 500 }
        );
    }
}
