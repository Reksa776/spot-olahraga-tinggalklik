import { readFileSync } from "node:fs";
import path from "node:path";

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import {
    describeCameraError,
    environmentFailure,
    isVideoReady,
    readCameraEnvironment,
} from "@/components/organizer/TicketScanner";

/**
 * ==========================================
 * CAMERA PIPELINE — REAL DEVICE FAILURE MODES
 * ==========================================
 *
 * A granted Chrome site permission is not enough: the page must be a secure context, the
 * document's own `Permissions-Policy` must allow the camera for this origin, and the video
 * element must report real pixels before `detect()` runs. Each of those failures has its
 * own diagnostic here, and the header that caused the real-device failure is pinned.
 */

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

describe("camera — runtime environment detection (pure)", () => {
    it("recognises a fully capable secure context", () => {
        expect(
            readCameraEnvironment({
                isSecureContext: true,
                BarcodeDetector: function Detector() {},
                navigator: {
                    mediaDevices: { getUserMedia: () => Promise.resolve() },
                },
            })
        ).toEqual({
            secureContext: true,
            mediaDevices: true,
            getUserMedia: true,
            barcodeDetector: true,
        });
    });

    it("distinguishes insecure context, missing mediaDevices and missing getUserMedia", () => {
        expect(
            readCameraEnvironment({
                isSecureContext: false,
                BarcodeDetector: function Detector() {},
                navigator: { mediaDevices: { getUserMedia: 1 } },
            })
        ).toEqual({
            secureContext: false,
            mediaDevices: true,
            getUserMedia: false,
            barcodeDetector: true,
        });

        expect(
            readCameraEnvironment({ isSecureContext: true, navigator: null })
        ).toEqual({
            secureContext: true,
            mediaDevices: false,
            getUserMedia: false,
            barcodeDetector: false,
        });
    });

    it("maps each environment gap to its own diagnostic (never a generic message)", () => {
        expect(
            environmentFailure({
                secureContext: false,
                mediaDevices: true,
                getUserMedia: true,
                barcodeDetector: true,
            })?.kind
        ).toBe("INSECURE_CONTEXT");

        expect(
            environmentFailure({
                secureContext: true,
                mediaDevices: false,
                getUserMedia: false,
                barcodeDetector: true,
            })?.kind
        ).toBe("NO_MEDIA_DEVICES");

        expect(
            environmentFailure({
                secureContext: true,
                mediaDevices: true,
                getUserMedia: false,
                barcodeDetector: true,
            })?.kind
        ).toBe("NO_GET_USER_MEDIA");

        expect(
            environmentFailure({
                secureContext: true,
                mediaDevices: true,
                getUserMedia: true,
                barcodeDetector: true,
            })
        ).toBeNull();
    });
});

describe("camera — DOMException diagnostics (pure)", () => {
    it("maps every DOMException name to a distinct, actionable message", () => {
        const named = (name: string) =>
            describeCameraError({ name, message: "raw internals" });

        expect(named("NotAllowedError").kind).toBe("PERMISSION_DENIED");
        expect(named("SecurityError").kind).toBe("SECURITY");
        expect(named("NotFoundError").kind).toBe("NO_CAMERA");
        expect(named("NotReadableError").kind).toBe("CAMERA_BUSY");
        expect(named("OverconstrainedError").kind).toBe("CAMERA_CONSTRAINT");
        expect(named("AbortError").kind).toBe("CAMERA_UNAVAILABLE");
        expect(named("SomethingWeird").kind).toBe("UNKNOWN");
        expect(describeCameraError(undefined).kind).toBe("UNKNOWN");
    });

    it("never exposes the raw error text", () => {
        const described = describeCameraError({
            name: "NotAllowedError",
            message: "Internal stack/secret detail",
        });

        expect(described.message).not.toContain("Internal stack/secret detail");
    });
});

describe("camera — video readiness guard (pure)", () => {
    it("requires current data AND non-zero dimensions", () => {
        expect(
            isVideoReady({ readyState: 0, videoWidth: 0, videoHeight: 0 })
        ).toBe(false);
        expect(
            isVideoReady({ readyState: 4, videoWidth: 0, videoHeight: 720 })
        ).toBe(false);
        expect(
            isVideoReady({ readyState: 4, videoWidth: 1080, videoHeight: 0 })
        ).toBe(false);
        expect(
            isVideoReady({ readyState: 1, videoWidth: 1080, videoHeight: 1920 })
        ).toBe(false);
        expect(
            isVideoReady({ readyState: 2, videoWidth: 1080, videoHeight: 1920 })
        ).toBe(true);
        expect(
            isVideoReady({ readyState: 4, videoWidth: 1080, videoHeight: 1920 })
        ).toBe(true);
    });
});

describe("camera — pipeline wiring (source)", () => {
    it("checks the environment before requesting the camera", () => {
        expect(SCANNER).toMatch(/readCameraEnvironment\(\)/);
        expect(SCANNER).toMatch(/environmentFailure\(environment\)/);
        // PHASE 21 — a missing `BarcodeDetector` no longer aborts the camera; the detector
        // is chosen with the jsQR fallback instead, so the environment check still runs
        // FIRST but a missing native decoder is not fatal.
        expect(SCANNER).toMatch(/DetectorCtor/);
        expect(SCANNER).not.toMatch(/NO_DETECTOR_FAILURE/);
        expect(SCANNER).toMatch(/decodeMode/);
    });

    it("requests the rear camera without audio, with a safe fallback", () => {
        expect(SCANNER).toMatch(/facingMode: \{ ideal: "environment" \}/);
        expect(SCANNER).toMatch(/audio: false/);
        expect(SCANNER).toMatch(/video: true,\s*\n\s*audio: false/);
    });

    it("attaches the stream, awaits play(), then waits for real pixels", () => {
        expect(SCANNER).toMatch(/video\.srcObject = stream/);
        expect(SCANNER).toMatch(/await video\.play\(\)/);
        expect(SCANNER).toMatch(/await waitForVideoReady\(video\)/);
        expect(SCANNER).toMatch(/if \(!isVideoReady\(video\) \|\| detectingRef\.current\)/);
    });

    it("guards against overlapping detect() calls and never builds a detector per frame", () => {
        expect(SCANNER).toMatch(/detectingRef\.current = true/);
        expect(SCANNER).toMatch(/detectingRef\.current = false/);
        // The detector is constructed once in startScanner, not inside tick().
        const tickBody = SCANNER.slice(SCANNER.indexOf("async function tick()"));
        expect(tickBody.slice(0, tickBody.indexOf("function loop()"))).not.toMatch(
            /new DetectorCtor/
        );
    });

    it("constructs the QR detector with formats and falls back safely", () => {
        expect(SCANNER).toMatch(/new DetectorCtor\(\{ formats: \["qr_code"\] \}\)/);
        expect(SCANNER).toMatch(/new DetectorCtor\(\)/);
    });

    it("uses the video element with the mobile-required attributes", () => {
        const video = SCANNER.slice(SCANNER.indexOf("<video"));
        expect(video).toMatch(/autoPlay/);
        expect(video).toMatch(/playsInline/);
        expect(video).toMatch(/muted/);
    });

    it("retries from a clean slate so streams never accumulate", () => {
        const start = SCANNER.slice(SCANNER.indexOf("async function startScanner()"));
        // releaseCamera is the first action of a (re)start.
        expect(start.slice(0, 400)).toMatch(/releaseCamera\(\)/);
    });

    it("keeps the continuous auto-post and the manual fallback", () => {
        expect(SCANNER).toMatch(/void checkInRef\.current\(payload\)/);
        expect(SCANNER).toMatch(/onSubmit=\{onManualSubmit\}/);
        expect(SCANNER).toMatch(/Check-in manual/);
    });

    it("shows a safe diagnostics panel that never renders the payload", () => {
        expect(SCANNER).toMatch(/Detail teknis/);
        expect(SCANNER).toMatch(/Secure context/);
        expect(SCANNER).toMatch(/BarcodeDetector/);
        expect(SCANNER).not.toMatch(/localStorage|sessionStorage/);
        expect(SCANNER).not.toMatch(/console\./);
    });
});

describe("camera — the Permissions-Policy that blocked the real device", () => {
    it("delegates the camera to this origin (camera=(self)), not camera=()", async () => {
        const nextConfig = (await import("../../next.config")).default as {
            headers?: () => Promise<
                Array<{ source: string; headers: Array<{ key: string; value: string }> }>
            >;
        };

        const entries = await nextConfig.headers!();
        const policy = entries[0].headers.find(
            (header) => header.key === "Permissions-Policy"
        );

        // `camera=()` disables the feature for EVERY document, self included, so
        // getUserMedia rejects with NotAllowedError despite a granted site permission.
        expect(policy?.value).toContain("camera=(self)");
        expect(policy?.value).not.toContain("camera=()");
        expect(policy?.value).toContain("microphone=()");
        expect(policy?.value).toContain("geolocation=()");
    });
});
