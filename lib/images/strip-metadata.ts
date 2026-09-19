import { detectImageFormat, type ImageFormat } from "./format";

/**
 * ==========================================
 * METADATA STRIPPING (decision D-55)
 * ==========================================
 *
 * D-55 (LOCKED): strip EXIF at MVP, especially GPS, server-side, never trusting
 * client-side removal, preserving acceptable quality, rejecting malformed images,
 * without introducing a broad arbitrary-file upload mechanism.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS HAND-WRITTEN RATHER THAN `sharp`
 * ─────────────────────────────────────────────────────────────────────────────
 * The phase 4 brief §17 allows a dependency but sets three conditions: it must be
 * maintained, compatible with the current Node/Next.js version, and "do not add a
 * large image-processing stack unnecessarily".
 *
 * `sharp` would satisfy correctness, but it is a native binary (libvips, tens of MB
 * per platform) added to a project that currently has no image dependency at all,
 * and it would need a `package-lock.json` change for one function: discard metadata.
 * Re-encoding through a decoder is also the *riskier* primitive here — it must
 * fully understand every codec to preserve pixel data, and a decoder bug corrupts
 * user images.
 *
 * Stripping does not need to decode anything. It needs to remove container
 * segments, which is a structurally simpler and safer operation, and it is
 * inherently fail-safe because it is written as an **allow-list**: only segments and
 * chunks on a known-safe list are copied forward. Anything unrecognised is dropped.
 * A metadata carrier that this code has never heard of is therefore removed rather
 * than retained, and the failure mode of an unknown structure is omission, not
 * leakage.
 *
 * The trade-off is deliberate and is recorded in the Phase 4 report: no pixel data
 * is decoded, so no re-encoding occurs and quality is untouched by definition. The
 * cost is that a future requirement to *resize* images will need a real codec, at
 * which point `sharp` becomes justified on its own merits.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS REMOVED
 * ─────────────────────────────────────────────────────────────────────────────
 *   JPEG  markers 0xFFE1..0xFFEF (APP1..APP15) and 0xFFFE (COM).
 *         APP1 is EXIF (GPS lives here) and XMP; APP13 is Photoshop/IPTC; COM is a
 *         free-text comment. APP0 (JFIF) is RETAINED because it carries only
 *         density/aspect hints that affect rendering, and no metadata.
 *   PNG   every chunk except a rendering allow-list. That removes tEXt, zTXt, iTXt,
 *         eXIf, tIME and every unknown ancillary chunk in one rule.
 *   WebP  the EXIF and XMP chunks, and the corresponding EXIF/XMP presence bits in
 *         the VP8X extended header are cleared so the container stops advertising
 *         metadata it no longer has.
 *
 * A PNG's `eXIf` chunk is the PNG-native EXIF container and is covered by the PNG
 * rule; a JPEG's GPS lives in APP1 and is covered by the JPEG rule. Both are
 * asserted in `__tests__/images/strip-metadata.test.ts`, which builds real files
 * containing GPS coordinates and proves the coordinates are gone from the output.
 */

export class UnsupportedImageError extends Error {
    constructor(message = "Format gambar tidak didukung.") {
        super(message);
        this.name = "UnsupportedImageError";
    }
}

export class MalformedImageError extends Error {
    constructor(message = "Struktur gambar tidak valid.") {
        super(message);
        this.name = "MalformedImageError";
    }
}

export type StripResult = {
    format: ImageFormat;
    /** The processed bytes. This is what must be stored and served. */
    buffer: Buffer;
    /** Human-readable identifiers of everything discarded (for tests + audit). */
    removed: string[];
    /** Bytes removed. Negative values are impossible and asserted in tests. */
    bytesRemoved: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// JPEG
// ─────────────────────────────────────────────────────────────────────────────

const JPEG_STANDALONE_MARKERS = new Set([
    0x01, // TEM
    0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, // RSTn
    0xd8, // SOI
    0xd9, // EOI
]);

function isMetadataJpegMarker(marker: number): boolean {
    if (marker === 0xfe) {
        return true; // COM
    }

    return marker >= 0xe1 && marker <= 0xef; // APP1..APP15
}

function stripJpeg(input: Buffer): StripResult {
    if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) {
        throw new MalformedImageError("JPEG tidak diawali marker SOI.");
    }

    const parts: Buffer[] = [];
    const removed: string[] = [];

    parts.push(input.subarray(0, 2)); // SOI

    let cursor = 2;
    let sawStartOfScan = false;

    while (cursor < input.length) {
        if (input[cursor] !== 0xff) {
            throw new MalformedImageError(
                `Byte tak terduga pada offset ${cursor}.`
            );
        }

        // Fill bytes: a run of 0xFF is legal padding before a marker.
        let markerIndex = cursor;
        while (
            markerIndex < input.length &&
            input[markerIndex] === 0xff
        ) {
            markerIndex++;
        }

        if (markerIndex >= input.length) {
            throw new MalformedImageError("Marker terpotong.");
        }

        const marker = input[markerIndex];

        if (marker === 0x00) {
            throw new MalformedImageError("Marker 0xFF00 di luar scan data.");
        }

        const afterMarker = markerIndex + 1;

        if (JPEG_STANDALONE_MARKERS.has(marker)) {
            parts.push(input.subarray(cursor, afterMarker));
            cursor = afterMarker;

            if (marker === 0xd9) {
                break; // EOI
            }
            continue;
        }

        if (afterMarker + 2 > input.length) {
            throw new MalformedImageError("Panjang segmen terpotong.");
        }

        const segmentLength = input.readUInt16BE(afterMarker);

        if (segmentLength < 2) {
            throw new MalformedImageError("Panjang segmen tidak valid.");
        }

        const segmentEnd = afterMarker + segmentLength;

        if (segmentEnd > input.length) {
            throw new MalformedImageError("Segmen melampaui akhir file.");
        }

        if (isMetadataJpegMarker(marker)) {
            removed.push(
                `jpeg:0xFF${marker.toString(16).toUpperCase().padStart(2, "0")}`
            );
        } else {
            parts.push(input.subarray(cursor, segmentEnd));
        }

        cursor = segmentEnd;

        if (marker === 0xda) {
            // Start of Scan: everything after the header is entropy-coded data
            // (and may contain 0xFF00 / RSTn sequences). Copy it verbatim; no
            // metadata can live here.
            sawStartOfScan = true;
            parts.push(input.subarray(segmentEnd));
            break;
        }
    }

    if (!sawStartOfScan) {
        throw new MalformedImageError("JPEG tanpa Start of Scan.");
    }

    const buffer = Buffer.concat(parts);

    return {
        format: "jpeg",
        buffer,
        removed,
        bytesRemoved: input.length - buffer.length,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// PNG
// ─────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE_LENGTH = 8;

/**
 * Chunks retained. Split into the four critical chunks and the ancillary chunks that
 * affect how the image is *rendered*. Everything else is dropped — including tEXt,
 * zTXt, iTXt, eXIf and tIME — because the PNG specification requires decoders to
 * ignore unknown ancillary chunks, so dropping one cannot corrupt the image.
 */
const PNG_RETAINED_CHUNKS = new Set([
    // critical
    "IHDR",
    "PLTE",
    "IDAT",
    "IEND",
    // rendering-relevant ancillary
    "tRNS", // transparency
    "gAMA", // gamma
    "cHRM", // chromaticity
    "sRGB", // colour space
    "iCCP", // embedded ICC profile
    "bKGD", // background colour
    "pHYs", // physical pixel dimensions
    "sBIT", // significant bits
]);

function stripPng(input: Buffer): StripResult {
    if (input.length < PNG_SIGNATURE_LENGTH + 12) {
        throw new MalformedImageError("PNG terlalu pendek.");
    }

    const parts: Buffer[] = [input.subarray(0, PNG_SIGNATURE_LENGTH)];
    const removed: string[] = [];

    let cursor = PNG_SIGNATURE_LENGTH;
    let sawHeader = false;
    let sawEnd = false;

    while (cursor < input.length) {
        if (cursor + 12 > input.length) {
            throw new MalformedImageError("Chunk PNG terpotong.");
        }

        const length = input.readUInt32BE(cursor);
        const type = input.toString("latin1", cursor + 4, cursor + 8);

        if (!/^[A-Za-z]{4}$/.test(type)) {
            throw new MalformedImageError(`Nama chunk tidak valid: "${type}".`);
        }

        const end = cursor + 12 + length;

        if (end > input.length) {
            throw new MalformedImageError("Chunk melampaui akhir file.");
        }

        if (type === "IHDR") {
            sawHeader = true;
        }

        if (PNG_RETAINED_CHUNKS.has(type)) {
            parts.push(input.subarray(cursor, end));
        } else {
            removed.push(`png:${type}`);
        }

        cursor = end;

        if (type === "IEND") {
            sawEnd = true;
            break;
        }
    }

    if (!sawHeader) {
        throw new MalformedImageError("PNG tanpa chunk IHDR.");
    }

    if (!sawEnd) {
        throw new MalformedImageError("PNG tanpa chunk IEND.");
    }

    const buffer = Buffer.concat(parts);

    return {
        format: "png",
        buffer,
        removed,
        bytesRemoved: input.length - buffer.length,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// WebP
// ─────────────────────────────────────────────────────────────────────────────

const WEBP_BODY_START = 12;

/** VP8X flag bits for metadata presence (byte 0 of the VP8X payload). */
const VP8X_EXIF_BIT = 0x08;
const VP8X_XMP_BIT = 0x04;

function stripWebp(input: Buffer): StripResult {
    if (
        input.length < 20 ||
        input.toString("latin1", 0, 4) !== "RIFF" ||
        input.toString("latin1", 8, 12) !== "WEBP"
    ) {
        throw new MalformedImageError("Container WebP tidak valid.");
    }

    const parts: Buffer[] = [];
    const removed: string[] = [];

    let cursor = WEBP_BODY_START;
    let sawImagePayload = false;

    while (cursor < input.length) {
        if (cursor + 8 > input.length) {
            throw new MalformedImageError("Chunk WebP terpotong.");
        }

        const fourcc = input.toString("latin1", cursor, cursor + 4);
        const size = input.readUInt32LE(cursor + 4);
        const padded = size + (size % 2); // RIFF chunks are even-padded
        const end = cursor + 8 + padded;

        if (end > input.length) {
            throw new MalformedImageError("Chunk WebP melampaui akhir file.");
        }

        if (fourcc === "EXIF" || fourcc === "XMP ") {
            removed.push(`webp:${fourcc.trim()}`);
        } else {
            let chunk = input.subarray(cursor, end);

            if (fourcc === "VP8X") {
                // Clear the EXIF/XMP presence bits so the container stops
                // advertising metadata that has just been removed. Without this
                // the file would be structurally inconsistent, and some decoders
                // warn or fail on a declared-but-missing chunk.
                chunk = Buffer.from(chunk);
                chunk[8] = chunk[8] & ~(VP8X_EXIF_BIT | VP8X_XMP_BIT);
            }

            if (fourcc === "VP8 " || fourcc === "VP8L") {
                sawImagePayload = true;
            }

            parts.push(chunk);
        }

        cursor = end;
    }

    if (!sawImagePayload) {
        throw new MalformedImageError("WebP tanpa payload gambar.");
    }

    const body = Buffer.concat(parts);

    const header = Buffer.alloc(WEBP_BODY_START);
    header.write("RIFF", 0, "latin1");
    header.writeUInt32LE(body.length + 4, 4); // +4 for the "WEBP" FourCC
    header.write("WEBP", 8, "latin1");

    const buffer = Buffer.concat([header, body]);

    return {
        format: "webp",
        buffer,
        removed,
        bytesRemoved: input.length - buffer.length,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove embedded metadata from a supported image.
 *
 * Throws `UnsupportedImageError` when the bytes are not a supported image and
 * `MalformedImageError` when the container is structurally invalid. Both are
 * rejections, not warnings: D-55 requires malformed images be rejected rather than
 * stored.
 *
 * The returned `buffer` is the only artefact that should ever be persisted. Callers
 * must not retain or write the input, so the unprocessed original cannot end up on a
 * publicly served path (phase 4 brief §17).
 */
export function stripImageMetadata(input: Buffer): StripResult {
    const format = detectImageFormat(input);

    if (!format) {
        throw new UnsupportedImageError();
    }

    switch (format) {
        case "jpeg":
            return stripJpeg(input);
        case "png":
            return stripPng(input);
        case "webp":
            return stripWebp(input);
    }
}

/**
 * Does this buffer still contain the given byte sequence?
 *
 * Test/diagnostic helper. It exists so tests can assert on the *absence of the actual
 * GPS payload* in the output rather than merely on the absence of a chunk header —
 * a distinction that matters, because a stripper that dropped the header but copied
 * the payload would pass a naive structural check and fail this one.
 */
export function containsBytes(haystack: Buffer, needle: Buffer): boolean {
    return haystack.includes(needle);
}
