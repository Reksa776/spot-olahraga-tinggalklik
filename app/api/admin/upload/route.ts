import { NextResponse } from "next/server";
import { auth } from "@/auth";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export const runtime = "nodejs";

export async function POST(request: Request) {
    try {
        const session = await auth();

        if (!session?.user) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                {
                    status: 401,
                }
            );
        }

        const role = session.user.role;

        if (role !== "ADMIN") {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Kamu tidak memiliki akses admin.",
                },
                {
                    status: 403,
                }
            );
        }

        const formData =
            await request.formData();

        const file =
            formData.get("file");

        if (!(file instanceof File)) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "File gambar wajib diupload.",
                },
                {
                    status: 400,
                }
            );
        }

        const allowedTypes: Record<string, string> = {
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
        };

        const extension =
            allowedTypes[file.type];

        if (!extension) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Format gambar harus JPG, PNG, atau WEBP.",
                },
                {
                    status: 400,
                }
            );
        }

        const maxSize =
            5 * 1024 * 1024;

        if (file.size > maxSize) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Ukuran gambar maksimal 5MB.",
                },
                {
                    status: 400,
                }
            );
        }

        /* ==========================================
         * MAGIC BYTE VALIDATION
         * ==========================================
         *
         * Verify actual file content matches claimed
         * MIME type. Prevents HTML/SVG/script uploads
         * disguised as images.
         */

        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        if (buffer.length < 4) {
            return NextResponse.json(
                {
                    success: false,
                    message: "File terlalu kecil.",
                },
                { status: 400 }
            );
        }

        // JPEG: starts with FF D8 FF
        // PNG: starts with 89 50 4E 47 (\x89PNG)
        // WebP: starts with 52 49 46 46 (RIFF)
        const isValidJpeg =
            buffer[0] === 0xff &&
            buffer[1] === 0xd8 &&
            buffer[2] === 0xff;
        const isValidPng =
            buffer[0] === 0x89 &&
            buffer[1] === 0x50 &&
            buffer[2] === 0x4e &&
            buffer[3] === 0x47;
        const isValidWebp =
            buffer[0] === 0x52 &&
            buffer[1] === 0x49 &&
            buffer[2] === 0x46 &&
            buffer[3] === 0x46;

        if (!isValidJpeg && !isValidPng && !isValidWebp) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "File bukan gambar valid (JPEG/PNG/WebP).",
                },
                { status: 400 }
            );
        }

        const uploadDir =
            process.env.UPLOAD_DIR
                ? path.join(process.env.UPLOAD_DIR, "products")
                : path.join(process.cwd(), "storage", "uploads", "products");

        await fs.mkdir(uploadDir, { recursive: true });

        const randomName =
            crypto
                .randomBytes(16)
                .toString("hex");

        const fileName =
            `${Date.now()}-${randomName}.${extension}`;

        const filePath =
            path.join(
                uploadDir,
                fileName
            );

        await fs.writeFile(
            filePath,
            buffer
        );

        const url = `/api/uploads/products/${fileName}`;

        console.log(
            "========== LOCAL IMAGE UPLOAD =========="
        );
        console.log("FILE:", fileName);
        console.log("TYPE:", file.type);
        console.log("SIZE:", file.size);
        console.log("PATH:", filePath);
        console.log("URL:", url);
        console.log(
            "========================================"
        );

        return NextResponse.json(
            {
                success: true,
                message:
                    "Gambar berhasil diupload.",
                url,
                fileName,
            },
            {
                status: 201,
            }
        );
    } catch (error) {
        console.error(
            "========== LOCAL IMAGE UPLOAD ERROR =========="
        );
        console.error(error);
        console.error(
            "==============================================="
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? "Gagal mengupload gambar."
                        : "Gagal mengupload gambar.",
            },
            {
                status: 500,
            }
        );
    }
}
