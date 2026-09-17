import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import fs from "fs/promises";
import path from "path";

export const runtime = "nodejs";

/* ==========================================
 * GET /api/uploads/affiliate/[...path]
 * ==========================================
 *
 * Serves affiliate uploaded files (KTP, social
 * media) with ownership validation.
 *
 * URL format:
 *   /api/uploads/affiliate/{type}/{userId}/{filename}
 *
 * Security:
 *   - Authentication required
 *   - Customer can only access own files
 *   - ADMIN can access any affiliate file
 *   - Path traversal protection
 *   - File must belong to an AffiliateKyc record
 *
 * Ownership check logic:
 *   1. Extract userId from URL path
 *   2. If requester is ADMIN → allow
 *   3. If requester is customer → userId must match
 *   4. Verify file exists in AffiliateKyc record
 */

const MIME_TYPES: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};

export async function GET(
    request: NextRequest,
    {
        params,
    }: {
        params: Promise<{ path: string[] }>;
    }
) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        const { path: pathSegments } =
            await params;

        /* ==========================================
         * VALIDATE PATH STRUCTURE
         * ==========================================
         *
         * Expected: [type, userId, filename]
         * Example: ["ktp", "clxxx", "1234567890-abc.jpg"]
         */

        if (pathSegments.length !== 3) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Path tidak valid.",
                },
                { status: 400 }
            );
        }

        const [type, fileUserId, filename] =
            pathSegments;

        // Validate type
        if (
            type !== "ktp" && type !== "social"
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Tipe file tidak valid.",
                },
                { status: 400 }
            );
        }

        // Validate userId format (cuid-like, no path traversal)
        if (
            !fileUserId ||
            fileUserId.length > 50 ||
            fileUserId.includes("..") ||
            fileUserId.includes("/") ||
            fileUserId.includes("\\")
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "User ID tidak valid.",
                },
                { status: 400 }
            );
        }

        // Validate filename (no path traversal)
        if (
            !filename ||
            filename.includes("..") ||
            filename.includes("/") ||
            filename.includes("\\")
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Nama file tidak valid.",
                },
                { status: 400 }
            );
        }

        /* ==========================================
         * OWNERSHIP CHECK
         * ==========================================
         *
         * Customer can only access their own files.
         * ADMIN can access any file.
         */

        const isAdmin =
            session.user.role ===
            "ADMIN";

        if (
            !isAdmin &&
            session.user.id !== fileUserId
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Akses ditolak.",
                },
                { status: 403 }
            );
        }

        /* ==========================================
         * VERIFY FILE EXISTS IN DATABASE
         * ==========================================
         *
         * Check that this file path is actually
         * stored in an AffiliateKyc record.
         * This prevents accessing arbitrary files
         * in the uploads directory.
         */

        const expectedUrlPath = `/api/uploads/affiliate/${type}/${fileUserId}/${filename}`;

        const kycRecord =
            await prisma.affiliateKyc.findFirst({
                where: {
                    OR: [
                        {
                            ktpImageUrl:
                                expectedUrlPath,
                        },
                        {
                            socialMediaUrl:
                                expectedUrlPath,
                        },
                    ],
                },
                select: {
                    id: true,
                    affiliateId: true,
                },
            });

        if (!kycRecord) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "File tidak ditemukan.",
                },
                { status: 404 }
            );
        }

        /* ==========================================
         * ADDITIONAL OWNERSHIP VERIFICATION
         * ==========================================
         *
         * For customers: verify the KYC record
         * belongs to their AffiliateProfile.
         */

        if (!isAdmin) {
            const profile =
                await prisma.affiliateProfile.findFirst(
                    {
                        where: {
                            userId: session.user.id,
                            id: kycRecord.affiliateId,
                        },
                        select: { id: true },
                    }
                );

            if (!profile) {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            "Akses ditolak.",
                    },
                    { status: 403 }
                );
            }
        }

        /* ==========================================
         * READ AND SERVE FILE
         * ========================================== */

        const uploadDir =
            process.env.UPLOAD_DIR
                ? path.join(
                      process.env.UPLOAD_DIR,
                      "affiliate"
                  )
                : path.join(
                      process.cwd(),
                      "storage",
                      "uploads",
                      "affiliate"
                  );

        const filePath = path.join(
            uploadDir,
            type,
            fileUserId,
            filename
        );

        try {
            const fileBuffer =
                await fs.readFile(filePath);

            const ext = path
                .extname(filename)
                .toLowerCase();
            const contentType =
                MIME_TYPES[ext] ||
                "application/octet-stream";

            return new NextResponse(fileBuffer, {
                status: 200,
                headers: {
                    "Content-Type": contentType,
                    "Cache-Control":
                        "private, max-age=3600",
                },
            });
        } catch {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "File tidak ditemukan.",
                },
                { status: 404 }
            );
        }
    } catch (error) {
        console.error(
            "AFFILIATE FILE SERVE ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal mengambil file.",
            },
            { status: 500 }
        );
    }
}
