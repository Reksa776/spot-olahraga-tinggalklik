import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { AppError } from "@/lib/api/errors";
import {
    detectImageFormat,
    extensionForFormat,
    mimeForFormat,
    type ImageFormat,
} from "@/lib/images/format";
import {
    MalformedImageError,
    UnsupportedImageError,
    stripImageMetadata,
} from "@/lib/images/strip-metadata";

/**
 * ==========================================
 * PHASE 32 — APPLICATION LOGO STORAGE
 * ==========================================
 *
 * The persistent store for the platform's own logo. It reuses the EXISTING upload
 * architecture rather than introducing a second one:
 *
 *   * the same magic-byte validation (`lib/images/format.ts` — the declared MIME type is
 *     never trusted, because a browser-supplied `image/png` on a `.exe` is exactly the
 *     spoof this rejects);
 *   * the same metadata stripper (`lib/images/strip-metadata.ts`), so a logo cannot carry
 *     EXIF/GPS into a publicly served file;
 *   * the same server-side generated filename (`<timestamp>-<32 hex>.<ext>`) — the original
 *     name never touches the filesystem, so path traversal and extension games are
 *     structurally impossible rather than filtered;
 *   * the same `<UPLOAD_DIR>/…` directory convention, so deployment configuration is
 *     unchanged.
 *
 * ── WHY A SEPARATE DIRECTORY FROM EVENT IMAGERY ─────────────────────────────────
 * `storage/uploads/events` is per-event photography; `storage/uploads/branding` is the
 * platform's own identity asset, replaced rarely and served to EVERY page including the
 * maintenance page. Keeping them apart means the branding asset cannot be enumerated or
 * overwritten through the event-image routes and vice versa, and a future retention policy
 * for event photos cannot accidentally delete the logo.
 *
 * ── WHY SVG IS REJECTED ────────────────────────────────────────────────────────
 * The brief (§11) allows SVG only when an existing sanitizer makes it safe. There is none
 * in this codebase (the only image pipeline is the JPEG/PNG/WebP stripper above, and SGV
 * sanitisation is a genuinely different problem: an SVG is a scriptable document). So SVG
 * is rejected by omission — `detectImageFormat` does not recognise it — rather than being
 * accepted behind a half-built sanitizer.
 *
 * ── WHAT IS DELIBERATELY NOT STORED ────────────────────────────────────────────
 * Not in `.next`, not in `tmp`, not in `node_modules`: only `storage/uploads/branding`
 * (or `UPLOAD_DIR`), which is the same persistent tree the settlement proofs and event
 * banners already survive rebuilds and restarts in. The database stores a URL STRING, never
 * binary data.
 */

/** 5 MB — the same cap as event imagery (D-55) and settlement proofs. */
export const MAX_LOGO_BYTES = 5 * 1024 * 1024;

/** URL prefix the public asset route serves, and the only shape the DB may hold. */
export const BRANDING_LOGO_URL_PREFIX = "/api/uploads/branding/";

export function brandingLogoDir(): string {
    return process.env.UPLOAD_DIR
        ? path.join(process.env.UPLOAD_DIR, "branding")
        : path.join(process.cwd(), "storage", "uploads", "branding");
}

export type StoredBrandingLogo = {
    /** Persistent URL to store in `PlatformSetting.logoUrl`. */
    url: string;
    fileName: string;
    contentType: string;
    size: number;
    /** What the stripper discarded — surfaced for the audit metadata. */
    removedMetadata: string[];
};

/**
 * Validate and store one logo upload, returning the persistent reference.
 *
 * Rejects (rather than repairs): empty body, oversize, unsupported container, malformed
 * structure. A rejection throws and nothing is written, so a failed upload can never leave
 * a half-configured branding.
 */
export async function storeBrandingLogo(
    file: File
): Promise<StoredBrandingLogo> {
    if (!(file instanceof File) || file.size === 0) {
        throw AppError.validation("File logo wajib diupload.");
    }

    if (file.size > MAX_LOGO_BYTES) {
        throw AppError.validation("Ukuran logo maksimal 5MB.");
    }

    const input = Buffer.from(await file.arrayBuffer());

    // The declared size is client-supplied; re-check the actual bytes so a chunked request
    // cannot slip past the limit above.
    if (input.length > MAX_LOGO_BYTES) {
        throw AppError.validation("Ukuran logo maksimal 5MB.");
    }

    // Early rejection of an obviously wrong declared type. Never the DECISION.
    if (file.type && !file.type.startsWith("image/")) {
        throw AppError.validation("Format logo harus JPG, PNG, atau WEBP.");
    }

    let stripped: ReturnType<typeof stripImageMetadata>;

    try {
        stripped = stripImageMetadata(input);
    } catch (error) {
        if (error instanceof UnsupportedImageError) {
            throw AppError.validation(
                "Format logo harus JPG, PNG, atau WEBP."
            );
        }

        if (error instanceof MalformedImageError) {
            throw AppError.validation("Struktur gambar logo tidak valid.");
        }

        throw error;
    }

    const outputFormat: ImageFormat | null = detectImageFormat(stripped.buffer);

    if (!outputFormat || outputFormat !== stripped.format) {
        throw AppError.validation("Gagal memproses gambar logo.");
    }

    const uploadDir = brandingLogoDir();

    await fs.mkdir(uploadDir, { recursive: true });

    const randomName = crypto.randomBytes(16).toString("hex");
    const fileName = `${Date.now()}-${randomName}.${extensionForFormat(
        stripped.format
    )}`;

    const filePath = path.join(uploadDir, fileName);
    // Write-then-rename: a partially written asset is never the one the DB points at.
    const tmpPath = `${filePath}.tmp`;

    await fs.writeFile(tmpPath, stripped.buffer);
    await fs.rename(tmpPath, filePath);

    return {
        url: `${BRANDING_LOGO_URL_PREFIX}${fileName}`,
        fileName,
        contentType: mimeForFormat(stripped.format),
        size: stripped.buffer.length,
        removedMetadata: stripped.removed,
    };
}

/**
 * Turn a stored URL back into a filesystem basename, or `null` when it is not a branding
 * asset we generated.
 *
 * This is the ONLY accepted conversion from a DB value to a path. A URL that is not under
 * the branding prefix, or whose tail contains a separator, is refused — so a value that
 * somehow reached the database by hand cannot be used to delete an arbitrary file.
 */
export function brandingLogoFileNameFromUrl(url: string): string | null {
    if (!url.startsWith(BRANDING_LOGO_URL_PREFIX)) {
        return null;
    }

    const tail = url.slice(BRANDING_LOGO_URL_PREFIX.length);

    if (!tail || tail !== path.basename(tail)) {
        return null;
    }

    return tail;
}

/**
 * Does the asset a stored URL points at actually exist on disk?
 *
 * The upload pipeline is written so the database only ever names a file that was just
 * written, which makes a dangling reference impossible to create through the application.
 * This check closes the remaining ways one can appear anyway — the file removed from disk,
 * the upload directory replaced by a deployment, the row edited by hand — and it is what
 * turns "no broken image" from an argument about the writer into a property of the reader.
 *
 * A `null`/unrecognised URL is simply `false`; the caller renders the built-in mark.
 */
export async function brandingLogoExists(
    url: string | null | undefined
): Promise<boolean> {
    if (!url) {
        return false;
    }

    const fileName = brandingLogoFileNameFromUrl(url);

    if (!fileName) {
        return false;
    }

    try {
        await fs.access(path.join(brandingLogoDir(), fileName));
        return true;
    } catch {
        return false;
    }
}

/** Remove a stored logo by its generated basename. Missing files are not an error. */
export async function deleteStoredBrandingLogo(
    fileName: string | null
): Promise<void> {
    if (!fileName) {
        return;
    }

    const safeName = path.basename(fileName);

    if (safeName !== fileName) {
        return;
    }

    try {
        await fs.unlink(path.join(brandingLogoDir(), safeName));
    } catch {
        // Already gone — deletion is idempotent.
    }
}

/** Read a stored logo for the public asset route. `null` when absent. */
export async function readStoredBrandingLogo(
    fileName: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
    if (!fileName) {
        return null;
    }

    const safeName = path.basename(fileName);

    if (safeName !== fileName) {
        return null;
    }

    try {
        const buffer = await fs.readFile(
            path.join(brandingLogoDir(), safeName)
        );

        const ext = path.extname(safeName).toLowerCase();

        return {
            buffer,
            contentType:
                ext === ".jpg" || ext === ".jpeg"
                    ? "image/jpeg"
                    : ext === ".png"
                      ? "image/png"
                      : ext === ".webp"
                        ? "image/webp"
                        : "application/octet-stream",
        };
    } catch {
        return null;
    }
}
