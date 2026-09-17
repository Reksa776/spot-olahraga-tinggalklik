/**
 * ==========================================
 * IMAGE FIXTURES WITH REAL METADATA
 * ==========================================
 *
 * These builders construct genuinely well-formed containers carrying metadata, so the
 * stripper tests assert on the *actual payload bytes* being gone rather than on a
 * chunk header disappearing. That distinction matters: a stripper that dropped the
 * APP1 header but copied its payload would pass a naive structural check and fail
 * these.
 *
 * Everything is built by hand rather than committed as a binary fixture, so the GPS
 * value is visible in the test source and cannot be mistaken for real customer data.
 */

/** A distinctive GPS payload. Its exact bytes are what the tests search for. */
export const GPS_MARKER = Buffer.from(
    "GPSLatitude  -6.208800 106.845600 GPSLongitude",
    "latin1"
);

export const XMP_MARKER = Buffer.from(
    "xmp:CreatorTool=TinggalKlikPhase4Test",
    "latin1"
);

function u16(value: number): Buffer {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(value, 2 - 2);
    return b;
}

function u32be(value: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value, 0);
    return b;
}

function u32le(value: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value, 0);
    return b;
}

/** A JPEG segment: 0xFF, marker, 2-byte length (payload + 2), payload. */
export function jpegSegment(marker: number, payload: Buffer): Buffer {
    const head = Buffer.alloc(4);
    head[0] = 0xff;
    head[1] = marker;
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([head, payload]);
}

export type JpegOptions = {
    exif?: boolean;
    xmp?: boolean;
    comment?: boolean;
    jfif?: boolean;
};

/**
 * A minimal but structurally valid baseline JPEG.
 *
 * Contains SOI, optional APP0/APP1(×2)/COM, DQT, SOF0, SOS, entropy-coded data
 * (including 0xFF00 stuffing and an RST0 marker, to prove scan data is copied
 * verbatim) and EOI.
 */
export function buildJpeg(options: JpegOptions = {}): Buffer {
    const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]; // SOI

    if (options.jfif !== false) {
        // APP0 / JFIF — must be RETAINED by the stripper (density only, no metadata).
        parts.push(
            jpegSegment(0xe0, Buffer.concat([Buffer.from("JFIF\0", "latin1"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]))
        );
    }

    if (options.exif) {
        // APP1 / EXIF: "Exif\0\0" + a little-endian TIFF header + GPS payload.
        const tiff = Buffer.concat([
            Buffer.from("II", "latin1"),
            u16(42),
            u32le(8),
            GPS_MARKER,
        ]);
        parts.push(jpegSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])));
    }

    if (options.xmp) {
        // A second APP1 with an XMP namespace — also metadata, also removed.
        const xmp = Buffer.concat([
            Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"),
            XMP_MARKER,
        ]);
        parts.push(jpegSegment(0xe1, xmp));
    }

    if (options.comment) {
        parts.push(jpegSegment(0xfe, Buffer.from("secret comment", "latin1")));
    }

    // DQT — structural, retained.
    parts.push(
        jpegSegment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]))
    );

    // SOF0 — structural, retained. 8-bit, 16x16, 1 component.
    parts.push(
        jpegSegment(
            0xc0,
            Buffer.concat([
                Buffer.from([8]),
                u16(16),
                u16(16),
                Buffer.from([1, 1, 0x11, 0]),
            ])
        )
    );

    // SOS — structural, retained. 1 component, then spectral selection.
    parts.push(
        jpegSegment(
            0xda,
            Buffer.concat([Buffer.from([1, 1, 0x00]), Buffer.from([0, 63, 0])])
        )
    );

    // Entropy-coded data: 0xFF00 stuffing and RST0 must survive untouched.
    parts.push(Buffer.from([0x01, 0x02, 0xff, 0x00, 0x03, 0x04, 0xff, 0xd0, 0x05]));

    parts.push(Buffer.from([0xff, 0xd9])); // EOI

    return Buffer.concat(parts);
}

// ─────────────────────────────────────────────────────────────────────────────
// PNG
// ─────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const table = new Int32Array(256);

    for (let n = 0; n < 256; n++) {
        let c = n;

        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }

        table[n] = c;
    }

    return table;
})();

/** Real CRC-32, so the fixtures are valid PNGs rather than loose byte runs. */
export function crc32(buffer: Buffer): number {
    let crc = -1;

    for (const byte of buffer) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ -1) >>> 0;
}

export const PNG_SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function pngChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, "latin1");
    const body = Buffer.concat([typeBytes, data]);

    return Buffer.concat([
        u32be(data.length),
        body,
        u32be(crc32(body)),
    ]);
}

export type PngOptions = {
    text?: boolean;
    exif?: boolean;
    time?: boolean;
    colourProfile?: boolean;
};

/** A 1x1 greyscale PNG, optionally carrying text/eXIf/tIME metadata chunks. */
export function buildPng(options: PngOptions = {}): Buffer {
    const parts: Buffer[] = [PNG_SIGNATURE];

    // IHDR — 1x1, 8-bit greyscale.
    parts.push(
        pngChunk(
            "IHDR",
            Buffer.concat([
                u32be(1),
                u32be(1),
                Buffer.from([8, 0, 0, 0, 0]),
            ])
        )
    );

    if (options.colourProfile) {
        parts.push(pngChunk("gAMA", u32be(45455)));
        parts.push(pngChunk("sRGB", Buffer.from([0])));
    }

    if (options.text) {
        parts.push(
            pngChunk(
                "tEXt",
                Buffer.concat([Buffer.from("Comment\0", "latin1"), GPS_MARKER])
            )
        );
    }

    if (options.exif) {
        // The PNG-native EXIF container.
        parts.push(
            pngChunk(
                "eXIf",
                Buffer.concat([
                    Buffer.from("II", "latin1"),
                    u16(42),
                    u32le(8),
                    GPS_MARKER,
                ])
            )
        );
    }

    if (options.time) {
        parts.push(
            pngChunk("tIME", Buffer.from([0x07, 0xea, 1, 1, 0, 0, 0]))
        );
    }

    // IDAT with zlib-compatible stored data (contents need not decode for these tests).
    parts.push(pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])));

    parts.push(pngChunk("IEND", Buffer.alloc(0)));

    return Buffer.concat(parts);
}

// ─────────────────────────────────────────────────────────────────────────────
// WebP
// ─────────────────────────────────────────────────────────────────────────────

function webpChunk(fourcc: string, data: Buffer): Buffer {
    const padded = data.length + (data.length % 2);
    const body = Buffer.alloc(padded);
    data.copy(body);

    return Buffer.concat([
        Buffer.from(fourcc, "latin1"),
        u32le(data.length),
        body,
    ]);
}

export type WebpOptions = {
    exif?: boolean;
    xmp?: boolean;
    extended?: boolean;
};

/** A RIFF/WEBP file, optionally with an EXIF and/or XMP chunk. */
export function buildWebp(options: WebpOptions = {}): Buffer {
    const chunks: Buffer[] = [];

    if (options.extended) {
        // VP8X: flags byte (bit3 = EXIF, bit2 = XMP), 3 reserved, canvas w/h minus 1.
        const flags = 0x00 | (options.exif ? 0x08 : 0) | (options.xmp ? 0x04 : 0);
        chunks.push(
            webpChunk(
                "VP8X",
                Buffer.concat([
                    Buffer.from([flags]),
                    Buffer.from([0, 0, 0]),
                    Buffer.from([0x0f, 0x00, 0x00]),
                    Buffer.from([0x0f, 0x00, 0x00]),
                ])
            )
        );
    }

    if (options.exif) {
        chunks.push(
            webpChunk(
                "EXIF",
                Buffer.concat([Buffer.from("II", "latin1"), u16(42), u32le(8), GPS_MARKER])
            )
        );
    }

    if (options.xmp) {
        chunks.push(webpChunk("XMP ", XMP_MARKER));
    }

    // VP8L lossless payload — the bit that makes it an image rather than a container.
    chunks.push(
        webpChunk(
            "VP8L",
            Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        )
    );

    const body = Buffer.concat(chunks);

    const header = Buffer.alloc(12);
    header.write("RIFF", 0, "latin1");
    header.writeUInt32LE(body.length + 4, 4);
    header.write("WEBP", 8, "latin1");

    return Buffer.concat([header, body]);
}

/** Non-image payloads that a MIME-spoofing attempt would send. */
export const SPOOFED_PAYLOADS: Record<string, Buffer> = {
    html: Buffer.from(
        "<!DOCTYPE html><html><script>alert(1)</script></html>",
        "latin1"
    ),
    svg: Buffer.from(
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        "latin1"
    ),
    // RIFF container that is NOT a WebP — the legacy retail check would accept this.
    riffNotWebp: Buffer.concat([
        Buffer.from("RIFF", "latin1"),
        u32le(36),
        Buffer.from("WAVEfmt ", "latin1"),
        Buffer.alloc(32, 0),
    ]),
    jpegOnlySoi: Buffer.from([0xff, 0xd8, 0xff]),
};
