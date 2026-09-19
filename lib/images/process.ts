import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

import { AppError, ERROR_CODES } from "@/lib/api/errors";

import {
    detectImageFormat,
    extensionForFormat,
    mimeForFormat,
} from "./format";
import {
    MalformedImageError,
    UnsupportedImageError,
    stripImageMetadata,
} from "./strip-metadata";

/**
 * ==========================================
 * EVENT IMAGE PIPELINE (decision D-55)
 * ==========================================
 *
 * The order of operations is fixed by the phase 4 brief §31 and must never be
 * reversed:
 *
 *   upload → validate → process → strip EXIF → store processed output → serve
 *
 * Every step here happens in memory. The original bytes are never written anywhere,
 * so there is no window in which an unprocessed file exists at a servable path, and
 * no cleanup step is needed to avoid one (brief §17: "do not accidentally retain the
 * original unprocessed image in a publicly accessible path").
 */

/** D-55 / brief §16: 5 MB, matching the existing retail upload limit. */
export const MAX_EVENT_IMAGE_BYTES = 5 * 1024 * 1024;

export type StoredEventImage = {
    /** URL the public catalog and admin UI reference. */
    url: string;
    fileName: string;
    contentType: string;
    size: number;
    /** What was discarded — surfaced so the audit log can record it. */
    removedMetadata: string[];
};

/**
 * Directory for processed event imagery.
 *
 * Keeps the shared upload convention (`UPLOAD_DIR` override, otherwise
 * `storage/uploads/...`) so deployment configuration keeps working unchanged. The
 * `events` folder is now the only image tree the application writes: the retail
 * `products` and `affiliate` trees were deleted with the retail application.
 */
function eventImageDir(): string {
    return process.env.UPLOAD_DIR
        ? path.join(process.env.UPLOAD_DIR, "events")
        : path.join(process.cwd(), "storage", "uploads", "events");
}

/**
 * Validate and store one event image.
 *
 * Rejects, rather than repairs: wrong content type, oversize, unsupported container,
 * malformed structure. A rejection throws and nothing is written.
 */
export async function processAndStoreEventImage(
    file: File
): Promise<StoredEventImage> {
    if (!(file instanceof File) || file.size === 0) {
        throw AppError.validation("File gambar wajib diupload.");
    }

    if (file.size > MAX_EVENT_IMAGE_BYTES) {
        throw AppError.validation("Ukuran gambar maksimal 5MB.");
    }

    const input = Buffer.from(await file.arrayBuffer());

    if (input.length > MAX_EVENT_IMAGE_BYTES) {
        // The declared size is client-supplied; re-check the actual bytes so a
        // chunked request cannot slip past the limit above.
        throw AppError.validation("Ukuran gambar maksimal 5MB.");
    }

    // The client-declared MIME type is not trusted for the decision (brief §16).
    // It is only checked when present, to reject an obvious mismatch early.
    if (file.type && !file.type.startsWith("image/")) {
        throw AppError.validation(
            "Format gambar harus JPG, PNG, atau WEBP."
        );
    }

    let stripped: ReturnType<typeof stripImageMetadata>;

    try {
        stripped = stripImageMetadata(input);
    } catch (error) {
        if (error instanceof UnsupportedImageError) {
            throw AppError.validation(
                "File bukan gambar valid (JPEG/PNG/WebP)."
            );
        }

        if (error instanceof MalformedImageError) {
            throw AppError.validation(
                "Struktur gambar tidak valid atau rusak."
            );
        }

        throw error;
    }

    // The output must still be a valid image of the same container. If stripping
    // produced something unrecognisable, that is a bug in the stripper and the
    // upload must fail rather than store a broken file.
    const outputFormat = detectImageFormat(stripped.buffer);

    if (!outputFormat || outputFormat !== stripped.format) {
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
            message: "Gagal memproses gambar.",
            expose: false,
        });
    }

    const uploadDir = eventImageDir();

    await fs.mkdir(uploadDir, { recursive: true });

    // The filename is generated entirely server-side (random, not derived from the
    // original name), so a hostile filename cannot influence the stored path and
    // path traversal is structurally impossible. The original name is never used for
    // the filesystem and is never persisted.
    const randomName = crypto.randomBytes(16).toString("hex");
    const fileName = `${Date.now()}-${randomName}.${extensionForFormat(
        stripped.format
    )}`;

    const filePath = path.join(uploadDir, fileName);

    await fs.writeFile(filePath, stripped.buffer);

    return {
        url: `/api/uploads/events/${fileName}`,
        fileName,
        contentType: mimeForFormat(stripped.format),
        size: stripped.buffer.length,
        removedMetadata: stripped.removed,
    };
}

/** Remove a stored event image. Missing files are not an error. */
export async function deleteStoredEventImage(fileName: string): Promise<void> {
    if (!fileName) {
        return;
    }

    // Never trust a caller-supplied path: reduce to a basename first. The stored
    // names are generated, so anything containing a separator is not ours.
    const safeName = path.basename(fileName);

    if (safeName !== fileName) {
        return;
    }

    try {
        await fs.unlink(path.join(eventImageDir(), safeName));
    } catch {
        // Already gone — deletion is idempotent.
    }
}

/** Turn a stored URL back into a filesystem basename, or `null` if it is not ours. */
export function eventImageFileNameFromUrl(url: string): string | null {
    const prefix = "/api/uploads/events/";

    if (!url.startsWith(prefix)) {
        return null;
    }

    return path.basename(url.slice(prefix.length));
}
