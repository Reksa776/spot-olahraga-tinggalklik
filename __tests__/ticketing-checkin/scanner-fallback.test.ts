/**
 * ==========================================
 * GATE SCANNER — QR DECODE FALLBACK (PHASE 21)
 * ==========================================
 *
 * The scanner used to hard-abort when the browser lacked `BarcodeDetector` (Firefox,
 * Safari, desktop Chrome on Linux/Windows). PHASE 21 adds a pure-JS fallback so a LAPTOP
 * WEBCAM scans there too, while the camera lifecycle, the payload contract
 * (`TICKET:<ticketCode>`), the existing single check-in route and the manual fallback all
 * stay EXACTLY as they were.
 *
 * These tests pin:
 *
 *   • `decodeFrameWithJsQr` actually decodes a real QR bitmap into the payload string,
 *     and returns `null` (never throws) for an unusable frame;
 *   • the fallback only DECODES pixels — it never owns `getUserMedia`, the loop, the
 *     throttle or the cleanup;
 *   • a missing `BarcodeDetector` selects the fallback rather than aborting the camera;
 *   • the decoded string still flows through `sanitizeScannedPayload` → the existing
 *     check-in call, with no `qrToken`/`QR_SCAN` exposure and no second route.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import QRCode from "qrcode";
import { readFileSync } from "node:fs";
import path from "node:path";

import { decodeFrameWithJsQr } from "@/components/organizer/TicketScanner";

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SCANNER = code(read("components/organizer/TicketScanner.tsx"));

/** Render a QR text into an RGBA bitmap jsQR can decode (quiet zone included). */
function qrBitmap(
    text: string,
    scale = 4,
    quiet = 4
): { data: Uint8ClampedArray; dim: number } {
    const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
    const size = qr.modules.size;
    const dim = (size + quiet * 2) * scale;
    const data = new Uint8ClampedArray(dim * dim * 4);

    // White background.
    for (let index = 0; index < data.length; index += 4) {
        data[index] = 255;
        data[index + 1] = 255;
        data[index + 2] = 255;
        data[index + 3] = 255;
    }

    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            if (!qr.modules.get(y, x)) {
                continue;
            }

            for (let dy = 0; dy < scale; dy += 1) {
                for (let dx = 0; dx < scale; dx += 1) {
                    const px = (quiet + x) * scale + dx;
                    const py = (quiet + y) * scale + dy;
                    const index = (py * dim + px) * 4;
                    data[index] = 0;
                    data[index + 1] = 0;
                    data[index + 2] = 0;
                }
            }
        }
    }

    return { data: data as unknown as Uint8ClampedArray, dim };
}

function fakeVideo(width: number, height: number): HTMLVideoElement {
    return { videoWidth: width, videoHeight: height } as unknown as HTMLVideoElement;
}

function fakeCanvas(data: Uint8ClampedArray): HTMLCanvasElement {
    return {
        width: 0,
        height: 0,
        getContext: () => ({
            drawImage: () => undefined,
            getImageData: () => ({ data }),
        }),
    } as unknown as HTMLCanvasElement;
}

describe("PHASE 21 — the jsQR fallback decodes a real payload", () => {
    it("decodes TICKET:<ticketCode> from a canvas frame", () => {
        const { data, dim } = qrBitmap("TICKET:EVT-7K3M-AK9P");

        expect(decodeFrameWithJsQr(fakeVideo(dim, dim), fakeCanvas(data))).toBe(
            "TICKET:EVT-7K3M-AK9P"
        );
    });

    it("returns null (never throws) for a zero-size frame", () => {
        const { data } = qrBitmap("TICKET:EVT-7K3M-AK9P");

        expect(decodeFrameWithJsQr(fakeVideo(0, 0), fakeCanvas(data))).toBeNull();
    });

    it("returns null when the frame carries no QR", () => {
        const dim = 64;
        const blank = new Uint8ClampedArray(dim * dim * 4).fill(255);

        expect(
            decodeFrameWithJsQr(fakeVideo(dim, dim), fakeCanvas(blank))
        ).toBeNull();
    });
});

describe("PHASE 21 — the fallback is a decoder, not a camera owner", () => {
    it("never references getUserMedia / the stream inside the decoder", () => {
        expect(SCANNER).toMatch(/import jsQR from "jsqr"/);
        // The decoder is a pure canvas → ImageData → jsQR function.
        expect(SCANNER).toMatch(/function decodeFrameWithJsQr\(/);
        expect(SCANNER).not.toMatch(/jsQR\([^)]*getUserMedia/);
    });

    it("selects the fallback when BarcodeDetector is missing, without aborting the camera", () => {
        // The old fatal on a missing native detector is gone.
        expect(SCANNER).not.toMatch(/NO_DETECTOR_FAILURE/);
        expect(SCANNER).toMatch(/decodeMode|decodeModeRef/);
        // Both decoders feed the same `raw` the existing loop sanitises and posts.
        expect(SCANNER).toMatch(/decodeFrameWithJsQr\(video, canvas\)/);
        expect(SCANNER).toMatch(/sanitizeScannedPayload\(raw\)/);
    });

    it("keeps the camera lifecycle, throttle, cleanup and manual fallback", () => {
        expect(SCANNER).toMatch(/getUserMedia\(/);
        expect(SCANNER).toMatch(/requestAnimationFrame\(/);
        expect(SCANNER).toMatch(/createScanThrottle/);
        expect(SCANNER).toMatch(/\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
        expect(SCANNER).toMatch(/onSubmit=\{onManualSubmit\}/);
        expect(SCANNER).toMatch(/Check-in manual/);
    });

    it("still posts to the ONE existing check-in route and never exposes a secret", () => {
        expect(SCANNER).toMatch(
            /const endpoint = `\/api\/organizer\/events\/\$\{eventId\}\/check-in`/
        );
        expect(SCANNER.match(/\/api\/[^`"]*/g) ?? []).toEqual([
            "/api/organizer/events/${eventId}/check-in",
        ]);
        expect(SCANNER).not.toMatch(/qrToken|qrTokenHash|QR_SCAN/);
        expect(SCANNER).not.toMatch(/localStorage|sessionStorage|console\./);
    });
});
