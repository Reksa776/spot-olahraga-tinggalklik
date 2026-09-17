/**
 * ==========================================
 * PHASE 4 — IMAGE PIPELINE, ON DISK (D-55)
 * ==========================================
 *
 * `strip-metadata.test.ts` covers the pure stripper. This suite covers what the
 * *pipeline* writes: it runs real `File` objects through `processAndStoreEventImage`
 * and then reads the bytes that actually landed on disk — the exact bytes
 * `GET /api/uploads/events/[filename]` serves.
 *
 * That distinction is the point. A pipeline that stripped metadata and then wrote the
 * ORIGINAL buffer would pass every pure-stripper assertion and still leak GPS
 * coordinates to the public internet. Only reading back the stored file catches that.
 *
 * `UPLOAD_DIR` is redirected to a temporary directory so the suite neither pollutes
 * `storage/uploads/events` nor depends on it being writable.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";

import { AppError } from "@/lib/api/errors";
import {
    MAX_EVENT_IMAGE_BYTES,
    deleteStoredEventImage,
    eventImageFileNameFromUrl,
    processAndStoreEventImage,
} from "@/lib/images/process";

import {
    GPS_MARKER,
    SPOOFED_PAYLOADS,
    XMP_MARKER,
    buildJpeg,
    buildPng,
    buildWebp,
} from "./fixtures";

const EXIF_TAG = Buffer.from("Exif");

let uploadRoot: string;

function storedPath(fileName: string): string {
    return path.join(uploadRoot, "events", fileName);
}

async function readStored(fileName: string): Promise<Buffer> {
    return fs.readFile(storedPath(fileName));
}

beforeAll(async () => {
    uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tinggalklik-p4-images-"));
    process.env.UPLOAD_DIR = uploadRoot;
});

afterAll(async () => {
    await fs.rm(uploadRoot, { recursive: true, force: true });
    delete process.env.UPLOAD_DIR;
});

describe("the stored file is the processed file", () => {
    test("GPS, EXIF and XMP are absent from the bytes on disk", async () => {
        // `exif: true` is what carries the GPS payload — see `buildJpeg` in fixtures.
        const source = buildJpeg({ exif: true, xmp: true });

        // Precondition: the fixture really does carry the metadata we are testing for.
        expect(source.includes(GPS_MARKER)).toBe(true);
        expect(source.includes(XMP_MARKER)).toBe(true);
        expect(source.includes(EXIF_TAG)).toBe(true);

        const stored = await processAndStoreEventImage(
            new File([new Uint8Array(source)], "banner.jpg", { type: "image/jpeg" })
        );

        const onDisk = await readStored(stored.fileName);

        expect(onDisk.includes(GPS_MARKER)).toBe(false);
        expect(onDisk.includes(XMP_MARKER)).toBe(false);
        expect(onDisk.includes(EXIF_TAG)).toBe(false);

        // Still a structurally complete JPEG: SOI at the head, EOI at the tail.
        expect(onDisk[0]).toBe(0xff);
        expect(onDisk[1]).toBe(0xd8);
        expect(onDisk[onDisk.length - 2]).toBe(0xff);
        expect(onDisk[onDisk.length - 1]).toBe(0xd9);

        // The stored size is the processed size, never the upload's.
        expect(stored.size).toBe(onDisk.length);
        expect(stored.size).toBeLessThan(source.length);

        await deleteStoredEventImage(stored.fileName);
    });

    test("PNG ancillary metadata chunks do not survive to disk", async () => {
        const source = buildPng({ text: true, exif: true });

        expect(source.includes(Buffer.from("tEXt"))).toBe(true);
        expect(source.includes(GPS_MARKER)).toBe(true);

        const stored = await processAndStoreEventImage(
            new File([new Uint8Array(source)], "banner.png", { type: "image/png" })
        );

        const onDisk = await readStored(stored.fileName);

        expect(onDisk.includes(Buffer.from("tEXt"))).toBe(false);
        expect(onDisk.includes(Buffer.from("eXIf"))).toBe(false);
        expect(onDisk.includes(GPS_MARKER)).toBe(false);

        // Structural chunks survive, so the PNG is still a PNG.
        expect(onDisk.includes(Buffer.from("IHDR"))).toBe(true);
        expect(onDisk.includes(Buffer.from("IEND"))).toBe(true);

        await deleteStoredEventImage(stored.fileName);
    });

    test("WebP EXIF/XMP chunks do not survive to disk", async () => {
        const source = buildWebp({ exif: true, xmp: true });

        const stored = await processAndStoreEventImage(
            new File([new Uint8Array(source)], "banner.webp", { type: "image/webp" })
        );

        const onDisk = await readStored(stored.fileName);

        expect(onDisk.includes(GPS_MARKER)).toBe(false);
        expect(onDisk.includes(XMP_MARKER)).toBe(false);

        await deleteStoredEventImage(stored.fileName);
    });

    test("the stripped container is preserved rather than converted", async () => {
        const jpeg = await processAndStoreEventImage(
            new File([new Uint8Array(buildJpeg())], "a.jpg", { type: "image/jpeg" })
        );
        const png = await processAndStoreEventImage(
            new File([new Uint8Array(buildPng())], "b.png", { type: "image/png" })
        );

        expect(jpeg.contentType).toBe("image/jpeg");
        expect(jpeg.fileName.endsWith(".jpg")).toBe(true);
        expect(png.contentType).toBe("image/png");
        expect(png.fileName.endsWith(".png")).toBe(true);

        await deleteStoredEventImage(jpeg.fileName);
        await deleteStoredEventImage(png.fileName);
    });
});

describe("the stored name is generated server-side", () => {
    test("a hostile original filename never reaches the filesystem path", async () => {
        const stored = await processAndStoreEventImage(
            new File([new Uint8Array(buildJpeg())], "../../../../etc/passwd", {
                type: "image/jpeg",
            })
        );

        // The generated name contains no separators and no trace of the input.
        expect(stored.fileName).not.toContain("/");
        expect(stored.fileName).not.toContain("\\");
        expect(stored.fileName).not.toContain("..");
        expect(stored.fileName).not.toContain("passwd");

        // And it really resolved inside the events directory, one level deep.
        expect(path.dirname(storedPath(stored.fileName))).toBe(
            path.join(uploadRoot, "events")
        );

        // The file exists where the URL says it does.
        expect(eventImageFileNameFromUrl(stored.url)).toBe(stored.fileName);
        await expect(readStored(stored.fileName)).resolves.toBeInstanceOf(Buffer);

        await deleteStoredEventImage(stored.fileName);
    });

    test("two uploads of identical bytes get different names", async () => {
        const bytes = new Uint8Array(buildJpeg());

        const first = await processAndStoreEventImage(
            new File([bytes], "same.jpg", { type: "image/jpeg" })
        );
        const second = await processAndStoreEventImage(
            new File([bytes], "same.jpg", { type: "image/jpeg" })
        );

        expect(first.fileName).not.toBe(second.fileName);

        await deleteStoredEventImage(first.fileName);
        await deleteStoredEventImage(second.fileName);
    });

    test("deleteStoredEventImage refuses a path-bearing name and is idempotent", async () => {
        const stored = await processAndStoreEventImage(
            new File([new Uint8Array(buildJpeg())], "x.jpg", { type: "image/jpeg" })
        );

        // A traversal-shaped name must be ignored, not unlinked.
        await deleteStoredEventImage(`../../${stored.fileName}`);
        await expect(readStored(stored.fileName)).resolves.toBeInstanceOf(Buffer);

        // Real deletion works, and repeating it is not an error.
        await deleteStoredEventImage(stored.fileName);
        await expect(readStored(stored.fileName)).rejects.toThrow();
        await expect(
            deleteStoredEventImage(stored.fileName)
        ).resolves.toBeUndefined();
    });
});

describe("rejection happens before anything is written", () => {
    test.each(Object.keys(SPOOFED_PAYLOADS))(
        "a %s payload declaring image/jpeg is rejected and stores nothing",
        async (key) => {
            const before = await fs.readdir(path.join(uploadRoot, "events"));

            await expect(
                processAndStoreEventImage(
                    new File([new Uint8Array(SPOOFED_PAYLOADS[key])], "evil.jpg", {
                        type: "image/jpeg",
                    })
                )
            ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

            const after = await fs.readdir(path.join(uploadRoot, "events"));

            expect(after).toEqual(before);
        }
    );

    test("a non-image declared content type is rejected", async () => {
        await expect(
            processAndStoreEventImage(
                new File([new Uint8Array(buildJpeg())], "notes.txt", {
                    type: "text/plain",
                })
            )
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    test("an empty upload is rejected", async () => {
        await expect(
            processAndStoreEventImage(
                new File([new Uint8Array()], "empty.jpg", { type: "image/jpeg" })
            )
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    test("an oversize upload is rejected on the declared size", async () => {
        const oversize = Buffer.alloc(MAX_EVENT_IMAGE_BYTES + 1, 0x41);

        await expect(
            processAndStoreEventImage(
                new File([new Uint8Array(oversize)], "big.jpg", { type: "image/jpeg" })
            )
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    test("a truncated JPEG is rejected as malformed rather than repaired", async () => {
        const truncated = buildJpeg({ exif: true }).subarray(0, 40);

        const rejection = await processAndStoreEventImage(
            new File([new Uint8Array(truncated)], "cut.jpg", { type: "image/jpeg" })
        ).catch((error: unknown) => error);

        expect(rejection).toBeInstanceOf(AppError);
        expect((rejection as AppError).code).toBe("VALIDATION_ERROR");
    });
});
