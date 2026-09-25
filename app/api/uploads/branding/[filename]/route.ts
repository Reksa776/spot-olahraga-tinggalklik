import { NextResponse, type NextRequest } from "next/server";
import path from "path";

import { readStoredBrandingLogo } from "@/lib/branding/logo";

/**
 * ==========================================
 * GET /api/uploads/branding/[filename]
 * ==========================================
 *
 * Serves the configured application logo.
 *
 * PUBLIC by design: the logo appears on the public landing page, in the dashboard lockup
 * and — critically — ON THE MAINTENANCE PAGE ITSELF. A session-gated asset route would make
 * the product unbranded exactly when it is closed, which is the one moment a visitor most
 * needs to recognise the site, and would also be unreachable for an anonymous visitor on
 * the landing page. This mirrors `/api/uploads/events/[filename]`, which is public for the
 * same reason (it feeds the public catalogue).
 *
 * ── WHAT MAKES IT SAFE ──────────────────────────────────────────────────────────
 *   traversal   the segment is reduced to its basename and rejected outright if that
 *               changed it, so a name containing a separator can never escape the branding
 *               directory. The reader repeats the same check, so the guarantee does not
 *               depend on this route remembering to do it.
 *   arbitrary   only files in `<UPLOAD_DIR|storage>/uploads/branding` are addressable, and
 *   reads       the stored names are server-generated (`<timestamp>-<32 hex>.<ext>`), so a
 *               name that was not produced by the upload pipeline simply does not exist.
 *   executable  the bytes were validated by magic signature and metadata-stripped at upload,
 *   content     and they are served with `X-Content-Type-Options: nosniff` plus an explicit
 *               `Content-Disposition: inline` — so a spoofed extension cannot talk a browser
 *               into interpreting the response as script or HTML.
 *   MIME        the content type is derived from the STORED extension, which the server
 *               chose, never from the request.
 *
 * A miss is a 404 with no filesystem detail and no directory listing.
 */

export const runtime = "nodejs";

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ filename: string }> }
) {
    const { filename } = await params;

    const safeName = path.basename(filename);

    // A name that is not already a bare basename is not one we generated.
    if (safeName !== filename) {
        return NextResponse.json(
            { success: false, message: "Logo tidak ditemukan." },
            { status: 404 }
        );
    }

    const file = await readStoredBrandingLogo(safeName);

    if (!file) {
        return NextResponse.json(
            { success: false, message: "Logo tidak ditemukan." },
            { status: 404 }
        );
    }

    return new NextResponse(new Uint8Array(file.buffer), {
        status: 200,
        headers: {
            "Content-Type": file.contentType,
            // The logo is replaced rarely and is referenced from every page, so a short
            // public cache is correct; `must-revalidate` keeps a replaced logo from being
            // pinned for a year the way an immutable event banner legitimately is.
            "Cache-Control": "public, max-age=300, must-revalidate",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": "inline",
        },
    });
}
