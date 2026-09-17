/**
 * ==========================================
 * PHASE 4 — EXIF / GPS STRIPPING (decision D-55)
 * ==========================================
 *
 * D-55 is LOCKED: strip EXIF at MVP, especially GPS, server-side, never trusting
 * client-side stripping, and reject unsupported or malformed images.
 *
 * These tests build real container bytes carrying a real GPS payload and assert on the
 * **payload's absence from the output**, not merely on a header disappearing. A
 * stripper that removed the APP1 header but copied its bytes would pass a structural
 * check and fail here.
 */

import {
    GPS_MARKER,
    SPOOFED_PAYLOADS,
    XMP_MARKER,
    buildJpeg,
    buildPng,
    buildWebp,
} from "./fixtures";
import { detectImageFormat } from "@/lib/images/format";
import {
    MalformedImageError,
    UnsupportedImageError,
    containsBytes,
    stripImageMetadata,
} from "@/lib/images/strip-metadata";

describe("format detection (magic bytes, not the declared MIME type)", () => {
    test("detects a real JPEG, PNG and WebP", () => {
        expect(detectImageFormat(buildJpeg())).toBe("jpeg");
        expect(detectImageFormat(buildPng())).toBe("png");
        expect(detectImageFormat(buildWebp())).toBe("webp");
    });

    test("rejects HTML and SVG payloads pretending to be images", () => {
        expect(detectImageFormat(SPOOFED_PAYLOADS.html)).toBeNull();
        expect(detectImageFormat(SPOOFED_PAYLOADS.svg)).toBeNull();
    });

    test("rejects a RIFF container that is not WebP", () => {
        // A RIFF header alone is also WAVE/AVI. The legacy retail route checks only
        // those four bytes and would accept this; this check requires the WEBP FourCC
        // at offset 8 as well.
        expect(SPOOFED_PAYLOADS.riffNotWebp.subarray(0, 4).toString("latin1")).toBe(
            "RIFF"
        );
        expect(detectImageFormat(SPOOFED_PAYLOADS.riffNotWebp)).toBeNull();
    });

    test("rejects a truncated JPEG stub", () => {
        expect(detectImageFormat(SPOOFED_PAYLOADS.jpegOnlySoi)).toBeNull();
    });
});

describe("JPEG", () => {
    test("the fixture really does contain the GPS payload before stripping", () => {
        // Guards the whole suite against a vacuous pass: if the fixture stopped
        // carrying GPS, every assertion below would be meaningless.
        const input = buildJpeg({ exif: true });

        expect(containsBytes(input, GPS_MARKER)).toBe(true);
    });

    test("removes APP1 (EXIF) and the GPS bytes with it", () => {
        const input = buildJpeg({ exif: true });
        const result = stripImageMetadata(input);

        expect(containsBytes(result.buffer, GPS_MARKER)).toBe(false);
        expect(result.removed).toContain("jpeg:0xFFE1");
        expect(result.format).toBe("jpeg");
    });

    test("removes XMP (a second APP1), COM, and every APPn except APP0", () => {
        const input = buildJpeg({ exif: true, xmp: true, comment: true });
        const result = stripImageMetadata(input);

        expect(containsBytes(result.buffer, GPS_MARKER)).toBe(false);
        expect(containsBytes(result.buffer, XMP_MARKER)).toBe(false);
        expect(containsBytes(result.buffer, Buffer.from("secret comment"))).toBe(
            false
        );
        // Two APP1 markers (EXIF + XMP) plus one COM.
        expect(result.removed.filter((r) => r === "jpeg:0xFFE1")).toHaveLength(2);
        expect(result.removed).toContain("jpeg:0xFFFE");
    });

    test("retains APP0/JFIF so rendering density is preserved", () => {
        const input = buildJpeg({ exif: true });
        const result = stripImageMetadata(input);

        expect(containsBytes(result.buffer, Buffer.from("JFIF"))).toBe(true);
        expect(result.removed).not.toContain("jpeg:0xFFE0");
    });

    test("retains the structural markers and the entropy-coded scan data verbatim", () => {
        const input = buildJpeg({ exif: true });
        const result = stripImageMetadata(input);

        // SOI and EOI
        expect(result.buffer[0]).toBe(0xff);
        expect(result.buffer[1]).toBe(0xd8);
        expect(result.buffer[result.buffer.length - 2]).toBe(0xff);
        expect(result.buffer[result.buffer.length - 1]).toBe(0xd9);

        // SOF0 and SOS still present
        expect(result.buffer.includes(Buffer.from([0xff, 0xc0]))).toBe(true);
        expect(result.buffer.includes(Buffer.from([0xff, 0xda]))).toBe(true);

        // Scan data copied byte-for-byte, including 0xFF00 stuffing and RST0.
        expect(
            containsBytes(
                result.buffer,
                Buffer.from([0x01, 0x02, 0xff, 0x00, 0x03, 0x04, 0xff, 0xd0, 0x05])
            )
        ).toBe(true);
    });

    test("is smaller than the input, and never larger", () => {
        const input = buildJpeg({ exif: true, xmp: true, comment: true });
        const result = stripImageMetadata(input);

        expect(result.bytesRemoved).toBeGreaterThan(0);
        expect(result.buffer.length).toBeLessThan(input.length);
        expect(result.bytesRemoved).toBe(input.length - result.buffer.length);
    });

    test("stripping twice is idempotent", () => {
        const once = stripImageMetadata(buildJpeg({ exif: true })).buffer;
        const twice = stripImageMetadata(once);

        // Nothing further to remove, and the bytes stabilise.
        expect(twice.removed).toEqual([]);
        expect(twice.bytesRemoved).toBe(0);
        expect(twice.buffer.equals(once)).toBe(true);
    });

    test("rejects a JPEG with no Start of Scan", () => {
        // SOI + DQT + EOI, but no SOS: structurally unusable as an image.
        const broken = buildJpeg({ exif: true });
        const sosIndex = broken.indexOf(Buffer.from([0xff, 0xda]));
        const truncated = broken.subarray(0, sosIndex - 4);

        expect(() =>
            stripImageMetadata(Buffer.concat([truncated, Buffer.from([0xff, 0xd9])]))
        ).toThrow(MalformedImageError);
    });

    test("rejects a JPEG whose segment length overruns the file", () => {
        const broken = buildJpeg({ exif: true });
        // Corrupt the APP1 length to claim far more data than exists.
        broken[4] = 0xff;
        broken[5] = 0xff;

        expect(() => stripImageMetadata(broken)).toThrow(MalformedImageError);
    });
});

describe("PNG", () => {
    test("the fixture really does contain the GPS payload before stripping", () => {
        expect(containsBytes(buildPng({ text: true, exif: true }), GPS_MARKER)).toBe(
            true
        );
    });

    test("removes tEXt, eXIf and tIME, and the GPS bytes with them", () => {
        const result = stripImageMetadata(
            buildPng({ text: true, exif: true, time: true })
        );

        expect(containsBytes(result.buffer, GPS_MARKER)).toBe(false);
        expect(result.removed).toContain("png:tEXt");
        expect(result.removed).toContain("png:eXIf");
        expect(result.removed).toContain("png:tIME");
        expect(result.format).toBe("png");
    });

    test("retains the critical chunks and the colour profile", () => {
        const result = stripImageMetadata(
            buildPng({ text: true, exif: true, colourProfile: true })
        );

        for (const chunk of ["IHDR", "IDAT", "IEND", "gAMA", "sRGB"]) {
            expect(result.removed).not.toContain(`png:${chunk}`);
            expect(containsBytes(result.buffer, Buffer.from(chunk, "latin1"))).toBe(
                true
            );
        }
    });

    test("retains the PNG signature", () => {
        const result = stripImageMetadata(buildPng({ text: true }));

        expect(result.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    });

    test("rejects a PNG with no IEND", () => {
        const png = buildPng({ text: true });
        // Cut the trailing IEND chunk (12 bytes: length + type + crc).
        const withoutIend = png.subarray(0, png.length - 12);

        expect(() => stripImageMetadata(withoutIend)).toThrow(MalformedImageError);
    });

    test("rejects a PNG with no IHDR", () => {
        const png = buildPng();
        const ihdrStart = 8;
        const idatIndex = png.indexOf(Buffer.from("IDAT", "latin1"));
        const broken = Buffer.concat([
            png.subarray(0, 8),
            png.subarray(idatIndex - 4),
        ]);

        expect(ihdrStart).toBe(8);
        expect(() => stripImageMetadata(broken)).toThrow(MalformedImageError);
    });
});

describe("WebP", () => {
    test("the fixture really does contain the GPS payload before stripping", () => {
        expect(containsBytes(buildWebp({ exif: true }), GPS_MARKER)).toBe(true);
    });

    test("removes the EXIF chunk and the GPS bytes with it", () => {
        const result = stripImageMetadata(buildWebp({ exif: true, extended: true }));

        expect(containsBytes(result.buffer, GPS_MARKER)).toBe(false);
        expect(result.removed).toContain("webp:EXIF");
        expect(result.format).toBe("webp");
    });

    test("removes the XMP chunk too", () => {
        const result = stripImageMetadata(buildWebp({ exif: true, xmp: true }));

        expect(containsBytes(result.buffer, XMP_MARKER)).toBe(false);
        expect(result.removed).toContain("webp:XMP");
    });

    test("clears the EXIF and XMP presence bits in the VP8X extended header", () => {
        const input = buildWebp({ exif: true, xmp: true, extended: true });
        const result = stripImageMetadata(input);

        // Locate VP8X and read its flags byte (offset 8 within the chunk).
        const vp8x = result.buffer.indexOf(Buffer.from("VP8X", "latin1"));
        expect(vp8x).toBeGreaterThanOrEqual(0);

        const flags = result.buffer[vp8x + 8];

        expect(flags & 0x08).toBe(0); // EXIF bit cleared
        expect(flags & 0x04).toBe(0); // XMP bit cleared
    });

    test("keeps the RIFF header consistent with the new body length", () => {
        const result = stripImageMetadata(buildWebp({ exif: true, extended: true }));

        expect(result.buffer.toString("latin1", 0, 4)).toBe("RIFF");
        expect(result.buffer.toString("latin1", 8, 12)).toBe("WEBP");

        const declared = result.buffer.readUInt32LE(4);
        expect(declared).toBe(result.buffer.length - 8);
    });

    test("keeps the image payload", () => {
        const result = stripImageMetadata(buildWebp({ exif: true }));

        expect(containsBytes(result.buffer, Buffer.from("VP8L", "latin1"))).toBe(
            true
        );
    });

    test("rejects a WebP with no image payload", () => {
        // VP8X + EXIF only — a container with metadata but no image.
        const broken = buildWebp({ exif: true, extended: true });
        const vp8l = broken.indexOf(Buffer.from("VP8L", "latin1"));
        const withoutPayload = broken.subarray(0, vp8l);
        const withSize = Buffer.from(withoutPayload);
        withSize.writeUInt32LE(withSize.length - 8, 4);

        expect(() => stripImageMetadata(withSize)).toThrow(MalformedImageError);
    });
});

describe("unsupported input", () => {
    test("throws UnsupportedImageError for non-image bytes", () => {
        expect(() => stripImageMetadata(SPOOFED_PAYLOADS.html)).toThrow(
            UnsupportedImageError
        );
        expect(() => stripImageMetadata(SPOOFED_PAYLOADS.svg)).toThrow(
            UnsupportedImageError
        );
        expect(() => stripImageMetadata(SPOOFED_PAYLOADS.riffNotWebp)).toThrow(
            UnsupportedImageError
        );
        expect(() => stripImageMetadata(Buffer.alloc(0))).toThrow(
            UnsupportedImageError
        );
    });

    test("the two error types are distinguishable, so the route can map them", () => {
        // The upload pipeline turns Unsupported into "not a valid image" and Malformed
        // into "corrupt image". If these collapsed into one class the API could not
        // report them differently.
        expect(new UnsupportedImageError()).not.toBeInstanceOf(MalformedImageError);
        expect(new MalformedImageError()).not.toBeInstanceOf(UnsupportedImageError);
    });
});
