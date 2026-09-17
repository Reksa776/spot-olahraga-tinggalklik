/**
 * ==========================================
 * IMAGE FORMAT DETECTION (magic bytes)
 * ==========================================
 *
 * Phase 4 brief §16 requires event images to be validated by **actual content**,
 * not by the client-supplied MIME type: "validate magic bytes; reject spoofed MIME;
 * reject unsupported types".
 *
 * This is deliberately stricter than the legacy retail check in
 * `app/api/admin/upload/route.ts`, which decides WebP by testing only the first four
 * bytes are `RIFF`. A `RIFF` header is also used by WAV and AVI, so that check alone
 * accepts a non-image. Here the container is confirmed twice: `RIFF` at offset 0 AND
 * the `WEBP` FourCC at offset 8.
 *
 * The legacy route was NOT changed (phase 4 brief §25 — no retail rewrites). This
 * module is the Phase 4 path; unifying the two is a documented cleanup candidate.
 *
 * The signature check is a *cheap pre-filter only*. It proves the declared container
 * matches reality; it does not prove the file is a well-formed image. That second job
 * belongs to the metadata stripper, which walks the container structure and throws on
 * anything malformed — so an image that passes here but is corrupt is rejected there
 * rather than being stored and served.
 */

export const IMAGE_FORMATS = ["jpeg", "png", "webp"] as const;

export type ImageFormat = (typeof IMAGE_FORMATS)[number];

const PNG_SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Canonical MIME type for a detected format. */
const MIME_BY_FORMAT: Record<ImageFormat, string> = {
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
};

/** File extension (no dot) used for stored filenames. */
const EXTENSION_BY_FORMAT: Record<ImageFormat, string> = {
    jpeg: "jpg",
    png: "png",
    webp: "webp",
};

export function mimeForFormat(format: ImageFormat): string {
    return MIME_BY_FORMAT[format];
}

export function extensionForFormat(format: ImageFormat): string {
    return EXTENSION_BY_FORMAT[format];
}

/**
 * Detect the real image format from content, or `null` when the bytes are not a
 * supported image. Never throws — callers decide how to report rejection.
 */
export function detectImageFormat(buffer: Buffer): ImageFormat | null {
    if (buffer.length < 12) {
        return null;
    }

    // JPEG: SOI marker, then any 0xFF marker byte.
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return "jpeg";
    }

    // PNG: the full 8-byte signature, not just the first four bytes.
    if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return "png";
    }

    // WebP: RIFF container AND the WEBP FourCC. Checking both rejects WAV/AVI,
    // which share the RIFF magic.
    if (
        buffer.toString("latin1", 0, 4) === "RIFF" &&
        buffer.toString("latin1", 8, 12) === "WEBP"
    ) {
        return "webp";
    }

    return null;
}

/** MIME types accepted for event imagery, as a display-ready list. */
export const ACCEPTED_IMAGE_MIME_TYPES: readonly string[] = Object.values(
    MIME_BY_FORMAT
);
