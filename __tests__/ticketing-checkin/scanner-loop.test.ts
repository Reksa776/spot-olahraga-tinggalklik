import { readFileSync } from "node:fs";
import path from "node:path";

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import {
    NETWORK_BACKOFF_MS,
    RESULT_VISIBLE_MS,
    SAME_QR_COOLDOWN_MS,
    createScanThrottle,
    sanitizeScannedPayload,
    scanFeedbackFor,
} from "@/components/organizer/TicketScanner";

/**
 * ==========================================
 * CONTINUOUS GATE SCANNER — LOOP, THROTTLE, LIFECYCLE
 * ==========================================
 *
 * The scanner must behave like a concert ticket gate: START ONCE, then every QR that
 * enters the frame is submitted automatically and the camera KEEPS RUNNING. These tests
 * pin the properties that make that true:
 *
 *   • the detection loop is a continuous `requestAnimationFrame` loop that re-schedules
 *     itself and never stops after a scan;
 *   • a detected QR is posted to the SAME existing check-in route with no per-scan submit;
 *   • the SAME payload is suppressed for a short cooldown while it lingers in frame, and a
 *     DIFFERENT payload is processed immediately;
 *   • a hidden tab pauses detection, and Stop/unmount releases the frame AND the tracks;
 *   • the raw payload is never persisted or logged, and the manual fallback survives.
 *
 * The loop itself cannot run in `testEnvironment: "node"`, so its pure pieces are exported
 * and exercised directly, and the wiring is asserted from source.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Strip comments so a comment DESCRIBING a pattern is never mistaken for the pattern. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SCANNER = code(read("components/organizer/TicketScanner.tsx"));

describe("continuous scanner — duplicate-frame throttle (pure)", () => {
    it("suppresses the SAME payload inside the cooldown and allows it after", () => {
        const throttle = createScanThrottle(1500);

        expect(throttle.shouldProcess("TICKET:EVT-7K3M-AK9P", 1_000)).toBe(true);
        // The same QR stays in frame for many frames ⇒ no repeated requests.
        expect(throttle.shouldProcess("TICKET:EVT-7K3M-AK9P", 1_100)).toBe(false);
        expect(throttle.shouldProcess("TICKET:EVT-7K3M-AK9P", 2_000)).toBe(false);
        // After the cooldown the same QR may be detected again (the server rejects it).
        expect(throttle.shouldProcess("TICKET:EVT-7K3M-AK9P", 2_600)).toBe(true);
    });

    it("processes a DIFFERENT payload immediately — the queue keeps moving", () => {
        const throttle = createScanThrottle(1500);

        expect(throttle.shouldProcess("TICKET:EVT-AAAA-BBBB", 1_000)).toBe(true);
        expect(throttle.shouldProcess("TICKET:EVT-CCCC-DDDD", 1_001)).toBe(true);
        expect(throttle.shouldProcess("TICKET:EVT-EEEE-FFFF", 1_002)).toBe(true);
    });

    it("treats an empty payload as unprocessable and can be reset", () => {
        const throttle = createScanThrottle();

        expect(throttle.shouldProcess("", 1_000)).toBe(false);

        throttle.shouldProcess("TICKET:EVT-7K3M-AK9P", 1_000);
        expect(throttle.shouldProcess("TICKET:EVT-7K3M-AK9P", 1_100)).toBe(false);

        throttle.reset();
        expect(throttle.shouldProcess("TICKET:EVT-7K3M-AK9P", 1_100)).toBe(true);
    });

    it("keeps the default cooldown short (UX protection, not a lock)", () => {
        expect(SAME_QR_COOLDOWN_MS).toBeGreaterThan(0);
        expect(SAME_QR_COOLDOWN_MS).toBeLessThanOrEqual(2000);
        expect(RESULT_VISIBLE_MS).toBeGreaterThan(0);
        expect(NETWORK_BACKOFF_MS).toBeGreaterThan(0);
    });
});

describe("continuous scanner — result classification (pure)", () => {
    it("maps the server's own codes/reasons to the gate's result states", () => {
        expect(scanFeedbackFor("TICKET_ALREADY_CHECKED_IN")).toBe(
            "ALREADY_CHECKED_IN"
        );
        expect(scanFeedbackFor("CONFLICT", { reason: "EVENT_NOT_OPEN" })).toBe(
            "GATE_CLOSED"
        );
        expect(scanFeedbackFor("CONFLICT", { reason: "REFUND_PENDING" })).toBe(
            "REFUND_PENDING"
        );
        expect(scanFeedbackFor("NOT_FOUND")).toBe("INVALID");
        expect(scanFeedbackFor("FORBIDDEN")).toBe("INVALID");
        expect(scanFeedbackFor("NETWORK_ERROR")).toBe("NETWORK");
        expect(scanFeedbackFor("DATABASE_UNAVAILABLE")).toBe("NETWORK");
    });
});

describe("continuous scanner — the detection loop (source-wired)", () => {
    it("drives detection from a self-rescheduling requestAnimationFrame loop", () => {
        expect(SCANNER).toMatch(/requestAnimationFrame\(/);
        expect(SCANNER).toMatch(/cancelAnimationFrame\(/);
        // The loop re-schedules itself regardless of the outcome of the frame.
        expect(SCANNER).toMatch(/\.finally\(loop\)/);
    });

    it("automatically posts a detected QR — no per-scan submit", () => {
        // A detected payload is handed straight to the existing check-in call.
        expect(SCANNER).toMatch(/void checkInRef\.current\(payload\)/);
        // …and checkIn posts to the SAME route, still with method POST.
        expect(SCANNER).toMatch(/method: "POST"/);
    });

    it("keeps scanning after success, invalid and already-checked-in results", () => {
        // The auto path never calls the stopper; only the explicit Stop button does.
        expect(SCANNER).not.toMatch(/checkIn[\s\S]{0,400}stopScanner\(/);
        // The camera is not torn down by a result: releaseCamera is only reached from
        // stopScanner / the mount cleanup.
        const releaseCalls = SCANNER.match(/releaseCamera\(\)/g) ?? [];
        expect(releaseCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("uses the existing endpoint constant and only that one /api route", () => {
        expect(SCANNER).toMatch(
            /const endpoint = `\/api\/organizer\/events\/\$\{eventId\}\/check-in`/
        );
        expect(SCANNER.match(/\/api\/[^`"]*/g) ?? []).toEqual([
            "/api/organizer/events/${eventId}/check-in",
        ]);
    });
});

describe("continuous scanner — lifecycle (source-wired)", () => {
    it("releases the camera tracks and the frame on stop and on unmount", () => {
        expect(SCANNER).toMatch(/\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
        expect(SCANNER).toMatch(/cancelAnimationFrame\(frameRef\.current\)/);
        // The mount effect returns a cleanup that releases the camera.
        expect(SCANNER).toMatch(/return \(\) => \{[\s\S]*releaseCamera\(\)/);
    });

    it("pauses detection while the tab is hidden and resumes when visible", () => {
        expect(SCANNER).toMatch(/visibilitychange/);
        expect(SCANNER).toMatch(/hiddenRef\.current = document\.visibilityState === "hidden"/);
        // A hidden tab short-circuits the tick but keeps the camera alive.
        expect(SCANNER).toMatch(/hiddenRef\.current \|\|/);
    });

    it("survives a network failure with a short backoff instead of dying", () => {
        expect(SCANNER).toMatch(/backoffUntilRef\.current = Date\.now\(\) \+ NETWORK_BACKOFF_MS/);
        expect(SCANNER).toMatch(/Gagal terhubung ke server/);
    });

    it("maps detection to the browser-native BarcodeDetector", () => {
        expect(SCANNER).toMatch(/\bBarcodeDetector\b/);
        expect(SCANNER).not.toMatch(/import .*(zxing|jsqr|barcode)/i);
    });
});

describe("continuous scanner — privacy and manual fallback", () => {
    it("never persists or logs the raw payload", () => {
        expect(SCANNER).not.toMatch(/localStorage|sessionStorage/);
        expect(SCANNER).not.toMatch(/console\./);
    });

    it("keeps the manual ticket-code fallback", () => {
        // The manual form still exists and still calls the shared checkIn.
        expect(SCANNER).toMatch(/onSubmit=\{onManualSubmit\}/);
        expect(SCANNER).toMatch(/Check-in manual/);
        expect(SCANNER).toMatch(/sanitizeScannedPayload\(manualCode\)/);
    });

    it("sanitizeScannedPayload is still the only client transform", () => {
        expect(sanitizeScannedPayload("  TICKET:EVT-7K3M-AK9P\n ")).toBe(
            "TICKET:EVT-7K3M-AK9P"
        );
        expect(sanitizeScannedPayload(null)).toBe("");
    });
});
