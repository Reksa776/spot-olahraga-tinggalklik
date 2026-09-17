import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

/**
 * ==========================================
 * GET /api/uploads/events/[filename]
 * ==========================================
 *
 * Serves **processed** event imagery to the public catalog.
 *
 * PUBLIC by design: an event banner appears on the public catalog and in Open Graph
 * cards, so it cannot require a session. This mirrors the existing
 * `app/api/uploads/products/[filename]` route, which is also public — the affiliate
 * route is the authenticated one because it serves identity documents.
 *
 * Because uploads are stripped before storage (D-55) and the filename is generated
 * server-side, the bytes served here are always metadata-free, and the only file that
 * exists for any upload is the processed one.
 *
 * Path traversal is prevented by reducing the segment to its basename before use, so a
 * request for a name containing separators cannot escape the events directory.
 */

export const runtime = "nodejs";

const MIME_TYPES: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ filename: string }> }
) {
    const { filename } = await params;

    const safeName = path.basename(filename);

    // A name that is not already a bare basename is not one we generated.
    if (safeName !== filename) {
        return NextResponse.json(
            { success: false, message: "Gambar tidak ditemukan." },
            { status: 404 }
        );
    }

    const uploadDir = process.env.UPLOAD_DIR
        ? path.join(process.env.UPLOAD_DIR, "events")
        : path.join(process.cwd(), "storage", "uploads", "events");

    const filePath = path.join(uploadDir, safeName);

    try {
        const fileBuffer = await fs.readFile(filePath);

        const ext = path.extname(safeName).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

        return new NextResponse(new Uint8Array(fileBuffer), {
            status: 200,
            headers: {
                "Content-Type": contentType,
                "Cache-Control": "public, max-age=31536000, immutable",
                // These files are photographs, not documents that should be embedded
                // or scripted against.
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": "inline",
            },
        });
    } catch {
        return NextResponse.json(
            { success: false, message: "Gambar tidak ditemukan." },
            { status: 404 }
        );
    }
}
