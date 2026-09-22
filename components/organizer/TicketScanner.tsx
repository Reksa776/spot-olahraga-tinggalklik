"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { apiFetch, ClientApiError } from "./api";
import { Button } from "@/components/dashboard/ui/button";
import {
    DataRow,
    ErrorBlock,
    InfoNote,
    StatusBadge,
} from "@/components/dashboard/primitives";
import { Field, Input } from "@/components/dashboard/ui/input";
import type { CheckInListItem, GateState } from "./CheckInPanel";

/**
 * ==========================================
 * GATE SCANNER — CONTINUOUS CAMERA INPUT, EXISTING CHECK-IN ENGINE
 * ==========================================
 *
 * A second INPUT DEVICE for the existing gate system: the camera continuously watches
 * for the wallet QR payload (`TICKET:<ticketCode>`) and, the moment one is detected,
 * posts it automatically to the SAME `POST /api/organizer/events/:id/check-in` route the
 * manual panel uses. No part of the check-in logic is duplicated here — the server still
 * resolves, authorizes, races and records the admission; this component only turns light
 * into a code.
 *
 * ── THE CONCERT-GATE WORKFLOW ─────────────────────────────────────────────────────
 *
 * There is NO per-ticket submit button. The staff member presses Start ONCE, and from
 * then on the loop below runs continuously:
 *
 *      camera → detect QR → auto POST → show result → keep scanning → next QR → …
 *
 * The camera is NOT stopped after a success, a rejection or an already-checked-in
 * result. A short client-side cooldown suppresses the SAME payload while it lingers in
 * frame; a different customer's QR is picked up immediately. The client cooldown is UX
 * protection ONLY — the server's CAS transition, the UNIQUE `CheckIn.ticketId` and the
 * check-in transaction remain authoritative.
 *
 * ── THE CAMERA PIPELINE, AND WHY EACH GUARD EXISTS ────────────────────────────────
 * A real Android gate failed silently here, so the pipeline now separates every way it
 * can fail instead of collapsing them into one message:
 *
 *   capability  — `readCameraEnvironment()` reads `isSecureContext`, `mediaDevices`,
 *                 `getUserMedia` and `BarcodeDetector` at RUNTIME (TypeScript types prove
 *                 nothing about a phone). Each missing piece has its own diagnostic.
 *   acquisition — `getUserMedia({video:{facingMode:{ideal:"environment"}}, audio:false})`
 *                 and a safe fallback to `{video:true}`; `describeCameraError` maps each
 *                 `DOMException` name (NotAllowedError, NotFoundError, NotReadableError,
 *                 OverconstrainedError, SecurityError, AbortError) to an actionable message.
 *   video       — the stream is attached, `video.play()` is awaited and its rejection is
 *                 handled, then the loop waits until the element reports real pixels
 *                 (`isVideoReady`: readyState ≥ HAVE_CURRENT_DATA and non-zero dimensions).
 *                 `detect()` is never called against a zero-size video.
 *   detection   — the loop reschedules itself every frame, pauses on a hidden tab, and an
 *                 in-flight guard (`detectingRef`) prevents overlapping `detect()` calls.
 *   detector    — `BarcodeDetector` is constructed with `{formats:["qr_code"]}` and falls
 *                 back to the no-argument constructor; failure is surfaced, never fatal.
 *
 * ── NO NEW DEPENDENCY ─────────────────────────────────────────────────────────────
 * Decoding uses the browser-native `BarcodeDetector` API. On a browser without it the
 * camera area says so and the MANUAL field below is the full fallback — including hardware
 * keyboard-wedge scanners. No QR library is installed.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────────
 * The decoded payload is never persisted (no `localStorage`/`sessionStorage`), never
 * logged, and is sent nowhere except the existing authorized check-in route. The
 * suppression map holds a payload only in component memory for a couple of seconds, and
 * the diagnostics panel never shows the payload, a ticket code, a token or a cookie.
 */

/** Strip whitespace-newline noise and cap length. Pure, browser-independent. */
export function sanitizeScannedPayload(payload: unknown): string {
    if (typeof payload !== "string") {
        return "";
    }

    return payload.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128);
}

/**
 * How long the SAME payload is ignored after it was last processed.
 *
 * The camera keeps seeing a QR for several frames while it is held up, so without this
 * guard one ticket would fire dozens of requests. It is deliberately short: once it
 * elapses, the same QR may be detected again and the SERVER correctly rejects it as
 * already checked in (which is exactly what the gate should show).
 */
export const SAME_QR_COOLDOWN_MS = 1500;

/** How long a result stays on screen before the scanner returns to its active state. */
export const RESULT_VISIBLE_MS = 3000;

/** How long detection backs off after a network-level failure, so an outage is not spammed. */
export const NETWORK_BACKOFF_MS = 2500;

/** How long to wait for the video element to report usable dimensions. */
export const VIDEO_READY_TIMEOUT_MS = 8000;

/** Consecutive `detect()` failures before the UI warns that detection is misbehaving. */
export const DETECT_FAILURE_THRESHOLD = 8;

export type ScanThrottle = {
    /** Claim `payload` for processing at `now`; false when it is still in its cooldown. */
    shouldProcess: (payload: string, now: number) => boolean;
    /** Forget every payload (used when the scanner is (re)started). */
    reset: () => void;
};

/**
 * A `payload → lastProcessedAt` suppression map.
 *
 * Pure and browser-independent, so the duplicate-frame behaviour can be unit-tested
 * without a camera. It intentionally does NOT replace server-side idempotency.
 */
export function createScanThrottle(
    cooldownMs: number = SAME_QR_COOLDOWN_MS
): ScanThrottle {
    const seen = new Map<string, number>();

    return {
        shouldProcess(payload: string, now: number): boolean {
            if (!payload) {
                return false;
            }

            const last = seen.get(payload);

            if (last !== undefined && now - last < cooldownMs) {
                return false;
            }

            seen.set(payload, now);

            // Bound memory: drop entries whose cooldown has already elapsed.
            if (seen.size > 256) {
                for (const [key, at] of seen) {
                    if (now - at >= cooldownMs) {
                        seen.delete(key);
                    }
                }
            }

            return true;
        },
        reset(): void {
            seen.clear();
        },
    };
}

/* ── CAMERA ENVIRONMENT + FAILURE DIAGNOSTICS (pure, testable) ──────────────────── */

export type CameraEnvironment = {
    secureContext: boolean;
    mediaDevices: boolean;
    getUserMedia: boolean;
    barcodeDetector: boolean;
};

type EnvironmentScope = {
    isSecureContext?: boolean;
    BarcodeDetector?: unknown;
    navigator?: { mediaDevices?: { getUserMedia?: unknown } | null } | null;
};

/**
 * Read the runtime camera capabilities.
 *
 * Pass a fake scope in tests; the default reads the real `window`/`navigator`. A
 * non-secure context, a missing `mediaDevices` or a missing `getUserMedia` are distinct
 * failures with distinct copy — never the generic "camera unavailable".
 */
export function readCameraEnvironment(
    scope?: EnvironmentScope
): CameraEnvironment {
    if (scope) {
        return {
            secureContext: scope.isSecureContext === true,
            mediaDevices: scope.navigator?.mediaDevices != null,
            getUserMedia:
                typeof scope.navigator?.mediaDevices?.getUserMedia === "function",
            barcodeDetector: typeof scope.BarcodeDetector === "function",
        };
    }

    if (typeof window === "undefined") {
        return {
            secureContext: false,
            mediaDevices: false,
            getUserMedia: false,
            barcodeDetector: false,
        };
    }

    return {
        secureContext: window.isSecureContext === true,
        mediaDevices:
            typeof navigator !== "undefined" && navigator.mediaDevices != null,
        getUserMedia:
            typeof navigator !== "undefined" &&
            typeof navigator.mediaDevices?.getUserMedia === "function",
        barcodeDetector:
            typeof (window as { BarcodeDetector?: unknown }).BarcodeDetector ===
            "function",
    };
}

export type CameraFailureKind =
    | "INSECURE_CONTEXT"
    | "NO_MEDIA_DEVICES"
    | "NO_GET_USER_MEDIA"
    | "PERMISSION_DENIED"
    | "SECURITY"
    | "NO_CAMERA"
    | "CAMERA_BUSY"
    | "CAMERA_CONSTRAINT"
    | "CAMERA_UNAVAILABLE"
    | "VIDEO_FAILED"
    | "NO_DETECTOR"
    | "UNKNOWN";

export type CameraFailure = {
    kind: CameraFailureKind;
    title: string;
    message: string;
};

/** The failure implied purely by the environment, before any camera is requested. */
export function environmentFailure(env: CameraEnvironment): CameraFailure | null {
    if (!env.secureContext) {
        return {
            kind: "INSECURE_CONTEXT",
            title: "Koneksi tidak aman",
            message:
                "Kamera hanya dapat digunakan melalui HTTPS. Buka halaman ini melalui https:// atau localhost.",
        };
    }

    if (!env.mediaDevices) {
        return {
            kind: "NO_MEDIA_DEVICES",
            title: "Kamera tidak tersedia",
            message:
                "Browser ini tidak menyediakan akses kamera (navigator.mediaDevices).",
        };
    }

    if (!env.getUserMedia) {
        return {
            kind: "NO_GET_USER_MEDIA",
            title: "Kamera tidak tersedia",
            message:
                "Browser ini tidak mendukung pengambilan kamera (getUserMedia).",
        };
    }

    return null;
}

function errorName(error: unknown): string {
    if (typeof error === "object" && error !== null && "name" in error) {
        const name = (error as { name?: unknown }).name;
        return typeof name === "string" ? name : "";
    }

    return "";
}

/**
 * Map a `DOMException` raised by `getUserMedia`/`play()` to an actionable message.
 *
 * Each name is handled separately, because "camera denied", "no camera", "camera busy"
 * and "over-constrained" demand different staff actions. Raw error text is never shown.
 */
export function describeCameraError(error: unknown): CameraFailure {
    switch (errorName(error)) {
        case "NotAllowedError":
            return {
                kind: "PERMISSION_DENIED",
                title: "Akses kamera ditolak",
                message:
                    "Periksa izin kamera Chrome untuk situs ini, lalu coba lagi.",
            };
        case "SecurityError":
            return {
                kind: "SECURITY",
                title: "Browser memblokir kamera",
                message:
                    "Browser tidak mengizinkan akses kamera pada halaman ini.",
            };
        case "NotFoundError":
        case "DevicesNotFoundError":
            return {
                kind: "NO_CAMERA",
                title: "Kamera tidak ditemukan",
                message: "Tidak ada kamera yang terdeteksi di perangkat ini.",
            };
        case "NotReadableError":
        case "TrackStartError":
            return {
                kind: "CAMERA_BUSY",
                title: "Kamera sedang digunakan",
                message:
                    "Kamera sedang dipakai aplikasi lain. Tutup aplikasi itu lalu coba lagi.",
            };
        case "OverconstrainedError":
        case "ConstraintNotSatisfiedError":
            return {
                kind: "CAMERA_CONSTRAINT",
                title: "Kamera belakang tidak tersedia",
                message:
                    "Kamera belakang tidak dapat digunakan. Coba lagi untuk memakai kamera default.",
            };
        case "AbortError":
            return {
                kind: "CAMERA_UNAVAILABLE",
                title: "Kamera gagal dimulai",
                message: "Kamera tidak dapat diakses. Coba lagi.",
            };
        default:
            return {
                kind: "UNKNOWN",
                title: "Kamera gagal digunakan",
                message:
                    "Terjadi kesalahan saat mengakses kamera. Coba lagi.",
            };
    }
}

const NO_DETECTOR_FAILURE: CameraFailure = {
    kind: "NO_DETECTOR",
    title: "QR scanner kamera tidak didukung browser ini",
    message:
        "Browser ini tidak menyediakan BarcodeDetector. Gunakan kolom kode manual di bawah.",
};

const VIDEO_FAILURE: CameraFailure = {
    kind: "VIDEO_FAILED",
    title: "Preview kamera gagal dimulai",
    message:
        "Kamera ditemukan tetapi gambar tidak muncul. Coba lagi, atau gunakan kolom kode manual.",
};

/**
 * Has the video element reported usable dimensions?
 *
 * `detect()` against a 0×0 video throws or finds nothing, so the loop refuses to run
 * until this is true. Pure, so it is unit-tested without a DOM.
 */
export function isVideoReady(video: {
    readyState: number;
    videoWidth: number;
    videoHeight: number;
}): boolean {
    return (
        video.readyState >= 2 /* HTMLMediaElement.HAVE_CURRENT_DATA */ &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
    );
}

/* ── CHECK-IN RESULT CLASSIFICATION (pure, testable) ────────────────────────────── */

/** The UX bucket a server/client failure falls into. */
export type ScanFeedback =
    | "SUCCESS"
    | "ALREADY_CHECKED_IN"
    | "GATE_CLOSED"
    | "REFUND_PENDING"
    | "NETWORK"
    | "INVALID";

/**
 * Classify a failed check-in into one of the gate's result states.
 *
 * It reads the server's own machine `code`/`details.reason` — it never decides validity
 * itself, and it invents no new server codes.
 */
export function scanFeedbackFor(
    code: string,
    details?: Record<string, unknown>
): ScanFeedback {
    if (
        code === "NETWORK_ERROR" ||
        code === "DATABASE_UNAVAILABLE" ||
        code === "SERVICE_UNAVAILABLE" ||
        code === "REQUEST_TIMEOUT"
    ) {
        return "NETWORK";
    }

    if (code === "TICKET_ALREADY_CHECKED_IN") {
        return "ALREADY_CHECKED_IN";
    }

    const reason = typeof details?.reason === "string" ? details.reason : null;

    if (reason === "EVENT_NOT_OPEN") {
        return "GATE_CLOSED";
    }

    if (reason === "REFUND_PENDING") {
        return "REFUND_PENDING";
    }

    return "INVALID";
}

type Outcome =
    | {
          kind: "success";
          ticketCode: string;
          attendeeName: string | null;
          ticketTypeName: string;
          checkedInAt: string;
      }
    | {
          kind: "error";
          code: string;
          message: string;
          details?: Record<string, unknown>;
      };

type ScannerState =
    | "idle"
    | "starting"
    | "active"
    | "stopped"
    | "error";

/** The parts of the native detector this component actually calls. */
type DetectorInstance = {
    detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
};

type BarcodeDetectorCtor = new (options?: {
    formats?: string[];
}) => DetectorInstance;

type VideoSize = { width: number; height: number };

type Props = {
    eventId: string;
    /** `checkin.log.read` — the admissions list. The scanner works without it. */
    canReadLog: boolean;
    initialItems: CheckInListItem[];
    initialTotal: number;
    /** Server-derived window state. Never recomputed from the browser clock. */
    gateState: GateState;
    /** `Event.requiresCheckIn` — false means the event declares no gate (P14-D13). */
    requiresCheckIn: boolean;
};

function timeLabel(iso: string): string {
    return new Date(iso).toLocaleString("id-ID");
}

function detailText(
    details: Record<string, unknown> | undefined,
    key: string
): string | null {
    const value = details?.[key];

    return typeof value === "string" && value.length > 0 ? value : null;
}

export default function TicketScanner({
    eventId,
    canReadLog,
    initialItems,
    initialTotal,
    gateState,
    requiresCheckIn,
}: Props) {
    const endpoint = `/api/organizer/events/${eventId}/check-in`;

    const [gateLabel, setGateLabel] = useState("");
    const [manualCode, setManualCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    const [state, setState] = useState<ScannerState>("idle");
    const [failure, setFailure] = useState<CameraFailure | null>(null);
    const [detectWarning, setDetectWarning] = useState<string | null>(null);
    const [videoSize, setVideoSize] = useState<VideoSize | null>(null);
    const [sessionCount, setSessionCount] = useState(0);
    const [items, setItems] = useState<CheckInListItem[]>(initialItems);
    const [total, setTotal] = useState(initialTotal);
    const [listError, setListError] = useState<string | null>(null);

    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const detectorRef = useRef<DetectorInstance | null>(null);
    const frameRef = useRef(0);
    const runningRef = useRef(false);
    const detectingRef = useRef(false);
    const hiddenRef = useRef(false);
    const mountedRef = useRef(true);
    const busyRef = useRef(false);
    const detectFailuresRef = useRef(0);
    const throttleRef = useRef<ScanThrottle>(createScanThrottle());
    const backoffUntilRef = useRef(0);
    const outcomeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const refresh = useCallback(async () => {
        if (!canReadLog) {
            return;
        }

        try {
            const data = await apiFetch<{
                items: CheckInListItem[];
                total: number;
            }>(`${endpoint}?limit=20`);

            setItems(data.items);
            setTotal(data.total);
            setListError(null);
        } catch {
            setListError("Gagal memuat daftar check-in terbaru.");
        }
    }, [canReadLog, endpoint]);

    /** Show a result briefly, then return the scanner to its normal active state. */
    const showOutcome = useCallback((next: Outcome) => {
        setOutcome(next);

        if (outcomeTimerRef.current) {
            clearTimeout(outcomeTimerRef.current);
        }

        outcomeTimerRef.current = setTimeout(() => {
            if (!mountedRef.current) {
                return;
            }
            setOutcome(null);
        }, RESULT_VISIBLE_MS);
    }, []);

    async function checkIn(payload: string) {
        busyRef.current = true;
        setBusy(true);
        setOutcome(null);

        try {
            const data = await apiFetch<{
                ticket: {
                    ticketCode: string;
                    attendeeName: string | null;
                };
                ticketType: { name: string };
                checkedInAt: string;
            }>(endpoint, {
                method: "POST",
                body: JSON.stringify({
                    code: payload,
                    gateLabel: gateLabel.trim() || null,
                }),
            });

            showOutcome({
                kind: "success",
                ticketCode: data.ticket.ticketCode,
                attendeeName: data.ticket.attendeeName,
                ticketTypeName: data.ticketType.name,
                checkedInAt: data.checkedInAt,
            });
            setSessionCount((count) => count + 1);

            await refresh();
        } catch (caught) {
            if (caught instanceof ClientApiError) {
                showOutcome({
                    kind: "error",
                    code: caught.code,
                    message: caught.message,
                    details: caught.details,
                });
            } else {
                // A transport failure — pause requests briefly so an outage is not spammed,
                // while the camera keeps running and the loop recovers on its own.
                backoffUntilRef.current = Date.now() + NETWORK_BACKOFF_MS;
                showOutcome({
                    kind: "error",
                    code: "NETWORK_ERROR",
                    message: "Gagal terhubung ke server.",
                });
            }
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    }

    // The camera loop reads the LATEST `checkIn` (with the current gate label) through a
    // ref, so restarting the camera is never coupled to typing in a field.
    const checkInRef = useRef(checkIn);

    useEffect(() => {
        checkInRef.current = checkIn;
    });

    /** Release every camera resource. Safe to call repeatedly (retry, stop, unmount). */
    function releaseCamera() {
        runningRef.current = false;
        detectingRef.current = false;

        if (frameRef.current) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = 0;
        }

        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
        }

        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
    }

    /** Resolve once the video element has real pixels, or reject after a timeout. */
    function waitForVideoReady(
        video: HTMLVideoElement,
        timeoutMs: number = VIDEO_READY_TIMEOUT_MS
    ): Promise<void> {
        if (isVideoReady(video)) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            let settled = false;

            const cleanup = () => {
                video.removeEventListener("loadedmetadata", finish);
                video.removeEventListener("canplay", finish);
                video.removeEventListener("playing", finish);
                clearTimeout(timer);
            };

            const finish = () => {
                if (settled || !isVideoReady(video)) {
                    return;
                }
                settled = true;
                cleanup();
                resolve();
            };

            const timer = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(new Error("VIDEO_READY_TIMEOUT"));
            }, timeoutMs);

            video.addEventListener("loadedmetadata", finish);
            video.addEventListener("canplay", finish);
            video.addEventListener("playing", finish);
        });
    }

    /** Prefer the rear camera; fall back to the default camera if that constraint fails. */
    async function acquireStream(): Promise<MediaStream> {
        const mediaDevices = navigator.mediaDevices;

        try {
            return await mediaDevices.getUserMedia({
                video: { facingMode: { ideal: "environment" } },
                audio: false,
            });
        } catch (error) {
            const name = errorName(error);

            if (
                name === "OverconstrainedError" ||
                name === "ConstraintNotSatisfiedError" ||
                name === "NotFoundError"
            ) {
                return await mediaDevices.getUserMedia({
                    video: true,
                    audio: false,
                });
            }

            throw error;
        }
    }

    /**
     * One detection pass. It NEVER throws and never stops the loop: a rejected frame, a
     * hidden tab or a not-yet-ready video simply means the next frame retries.
     */
    async function tick() {
        if (hiddenRef.current || !mountedRef.current || !runningRef.current) {
            return;
        }

        const video = videoRef.current;
        const detector = detectorRef.current;

        if (!video || !detector) {
            return;
        }

        // Never call detect() against a zero-size video, and never overlap two detect()
        // calls: the detector is async and a slow frame must not stack up.
        if (!isVideoReady(video) || detectingRef.current) {
            return;
        }

        // While backing off after a network failure, keep the camera but skip requests.
        if (Date.now() < backoffUntilRef.current) {
            return;
        }

        detectingRef.current = true;

        try {
            const barcodes = await detector.detect(video);

            if (detectFailuresRef.current !== 0) {
                detectFailuresRef.current = 0;
                setDetectWarning(null);
            }

            const raw = barcodes[0]?.rawValue;

            if (raw && !busyRef.current) {
                const payload = sanitizeScannedPayload(raw);

                // Suppress the same QR while it lingers in frame; a different payload is
                // processed immediately even if one request is still in flight.
                if (
                    payload &&
                    throttleRef.current.shouldProcess(payload, Date.now())
                ) {
                    void checkInRef.current(payload);
                }
            }
        } catch (error) {
            // A detect() failure is not fatal — surface it only once it looks persistent.
            detectFailuresRef.current += 1;

            if (detectFailuresRef.current === DETECT_FAILURE_THRESHOLD) {
                const described = describeCameraError(error);
                setDetectWarning(`Deteksi QR bermasalah: ${described.title}.`);
            }
        } finally {
            detectingRef.current = false;
        }
    }

    function loop() {
        if (!runningRef.current) {
            return;
        }

        frameRef.current = requestAnimationFrame(() => {
            void tick().finally(loop);
        });
    }

    async function startScanner() {
        if (runningRef.current || state === "starting") {
            return;
        }

        // Always start from a clean slate, so a retry can never leak a previous stream,
        // detector or pending frame.
        releaseCamera();
        detectorRef.current = null;

        setState("starting");
        setFailure(null);
        setDetectWarning(null);
        setOutcome(null);
        setVideoSize(null);
        throttleRef.current.reset();
        backoffUntilRef.current = 0;
        detectFailuresRef.current = 0;

        const environment = readCameraEnvironment();
        const environmentProblem = environmentFailure(environment);

        if (environmentProblem) {
            setFailure(environmentProblem);
            setState("error");
            return;
        }

        const DetectorCtor = (window as { BarcodeDetector?: BarcodeDetectorCtor })
            .BarcodeDetector;

        if (!DetectorCtor) {
            setFailure(NO_DETECTOR_FAILURE);
            setState("error");
            return;
        }

        let stream: MediaStream;

        try {
            stream = await acquireStream();
        } catch (error) {
            if (mountedRef.current) {
                setFailure(describeCameraError(error));
                setState("error");
            }
            return;
        }

        if (!mountedRef.current) {
            stream.getTracks().forEach((track) => track.stop());
            return;
        }

        let detector: DetectorInstance;

        try {
            detector = new DetectorCtor({ formats: ["qr_code"] });
        } catch {
            try {
                detector = new DetectorCtor();
            } catch {
                stream.getTracks().forEach((track) => track.stop());
                setFailure(NO_DETECTOR_FAILURE);
                setState("error");
                return;
            }
        }

        const video = videoRef.current;

        if (!video) {
            stream.getTracks().forEach((track) => track.stop());
            setFailure(VIDEO_FAILURE);
            setState("error");
            return;
        }

        streamRef.current = stream;
        video.srcObject = stream;

        try {
            // `play()` can reject on mobile even with `muted`/`playsInline`; surface it
            // rather than pretending the preview is running.
            await video.play();
            await waitForVideoReady(video);
        } catch {
            releaseCamera();
            setFailure(VIDEO_FAILURE);
            setState("error");
            return;
        }

        if (!mountedRef.current) {
            releaseCamera();
            return;
        }

        detectorRef.current = detector;
        setVideoSize({ width: video.videoWidth, height: video.videoHeight });
        runningRef.current = true;
        setState("active");
        loop();
    }

    function stopScanner() {
        releaseCamera();
        detectorRef.current = null;
        setState("stopped");
    }

    // Mount/unmount lifecycle: visibility handling plus a guaranteed camera release.
    useEffect(() => {
        mountedRef.current = true;

        const onVisibilityChange = () => {
            hiddenRef.current = document.visibilityState === "hidden";
        };

        document.addEventListener("visibilitychange", onVisibilityChange);
        onVisibilityChange();

        return () => {
            mountedRef.current = false;
            document.removeEventListener("visibilitychange", onVisibilityChange);
            releaseCamera();

            if (outcomeTimerRef.current) {
                clearTimeout(outcomeTimerRef.current);
            }
        };
    }, []);

    async function onManualSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const payload = sanitizeScannedPayload(manualCode);

        if (!payload || busyRef.current) {
            return;
        }

        setManualCode("");
        await checkIn(payload);
    }

    const environment = readCameraEnvironment();
    const isStarting = state === "starting";
    const isActive = state === "active";
    const canRetry = state === "error";

    const feedback =
        outcome?.kind === "error"
            ? scanFeedbackFor(outcome.code, outcome.details)
            : null;

    const firstCheckedInAt =
        feedback === "ALREADY_CHECKED_IN"
            ? detailText(
                  outcome?.kind === "error" ? outcome.details : undefined,
                  "firstCheckedInAt"
              )
            : null;
    const firstCheckedInBy =
        feedback === "ALREADY_CHECKED_IN"
            ? detailText(
                  outcome?.kind === "error" ? outcome.details : undefined,
                  "firstCheckedInBy"
              )
            : null;

    const diagnostics: Array<[string, string]> = [
        ["Secure context", environment.secureContext ? "YA" : "TIDAK"],
        ["Camera API", environment.mediaDevices ? "YA" : "TIDAK"],
        ["getUserMedia", environment.getUserMedia ? "YA" : "TIDAK"],
        ["BarcodeDetector", environment.barcodeDetector ? "YA" : "TIDAK"],
        ["Camera stream", isActive ? "AKTIF" : "—"],
        ["Video", videoSize ? `${videoSize.width} × ${videoSize.height}` : "—"],
        ["Scanner", state.toUpperCase()],
        ["Detection", detectWarning ? "BERMASALAH" : isActive ? "BERJALAN" : "—"],
    ];

    return (
        <div className="flex flex-col gap-5">
            {!requiresCheckIn ? (
                <InfoNote tone="warn">
                    <div className="flex flex-col gap-1">
                        <span className="text-sm font-semibold">
                            Event ini tidak mewajibkan check-in.
                        </span>
                        <span className="text-xs">
                            Pemindai tetap dapat dipakai bila memang perlu mencatat
                            kehadiran, tetapi kehadiran tidak menjadi syarat event ini dan
                            tidak memengaruhi penyelesaian atau refund.
                        </span>
                    </div>
                </InfoNote>
            ) : null}

            {gateState === "GRACE" ? (
                <InfoNote tone="warn">
                    <div className="flex flex-col gap-1">
                        <span className="text-sm font-semibold">
                            Masa tenggang check-in.
                        </span>
                        <span className="text-xs">
                            Event sudah melewati waktu selesai. Pintu masih terbuka selama
                            30 menit setelah waktu selesai, setelah itu tiket tidak dapat
                            lagi diterima.
                        </span>
                    </div>
                </InfoNote>
            ) : null}

            {/* ── CAMERA — the dominant surface ─────────────────────────────── */}
            <div className="flex flex-col gap-3">
                <div className="relative">
                    <video
                        ref={videoRef}
                        autoPlay
                        muted
                        playsInline
                        className="aspect-[4/3] w-full overflow-hidden rounded-xl border border-ink-200 bg-ink-900 object-cover sm:aspect-video"
                        hidden={!isStarting && !isActive}
                    />

                    {/* The QR target area — a clear, touch-sized aim frame. */}
                    {isActive ? (
                        <div
                            aria-hidden
                            className="pointer-events-none absolute inset-0 flex items-center justify-center"
                        >
                            <div className="h-3/5 w-3/5 rounded-2xl border-4 border-ink-50/80" />
                        </div>
                    ) : null}
                </div>

                {isStarting ? (
                    <InfoNote tone="warn">
                        <span className="flex items-center gap-2">
                            <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-amber-500" />
                            Menyalakan kamera…
                        </span>
                    </InfoNote>
                ) : null}

                {isActive ? (
                    <InfoNote tone="success">
                        <div className="flex flex-col gap-1">
                            <span className="text-base font-semibold">
                                🟢 Kamera aktif
                            </span>
                            <span className="text-sm">
                                Arahkan QR tiket ke kamera — tidak perlu menekan apa pun.
                            </span>
                        </div>
                    </InfoNote>
                ) : null}

                {state === "stopped" ? (
                    <InfoNote tone="warn">
                        <span className="text-sm font-semibold">
                            Scanner berhenti.
                        </span>
                    </InfoNote>
                ) : null}

                {failure ? (
                    <ErrorBlock
                        title={failure.title}
                        message={<p className="text-sm">{failure.message}</p>}
                        action={
                            canRetry ? (
                                <Button
                                    type="button"
                                    size="sm"
                                    onClick={startScanner}
                                >
                                    Coba Lagi
                                </Button>
                            ) : null
                        }
                    />
                ) : null}

                {detectWarning ? (
                    <InfoNote tone="warn">
                        <div className="flex flex-col gap-1">
                            <span className="text-sm font-semibold">
                                {detectWarning}
                            </span>
                            <span className="text-xs">
                                Pemindai tetap aktif. Bila berlanjut, gunakan kolom kode
                                manual di bawah.
                            </span>
                        </div>
                    </InfoNote>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                    {isActive ? (
                        <Button
                            type="button"
                            size="lg"
                            variant="outline"
                            onClick={stopScanner}
                        >
                            Berhenti
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            size="lg"
                            onClick={startScanner}
                            disabled={isStarting}
                        >
                            {isStarting
                                ? "Menyalakan…"
                                : canRetry
                                  ? "Coba Lagi"
                                  : "Mulai Pemindai"}
                        </Button>
                    )}

                    <StatusBadge tone="neutral" size="sm">
                        Total masuk: {sessionCount}
                    </StatusBadge>
                </div>
            </div>

            {/* ── RESULT — appears after every automatic scan, then auto-clears ─ */}
            {outcome?.kind === "success" ? (
                <InfoNote tone="success">
                    <div className="flex flex-col gap-1">
                        <span className="text-base font-semibold">
                            ✅ CHECK-IN BERHASIL
                        </span>
                        <span className="text-sm">
                            {outcome.attendeeName ?? "Peserta"}
                        </span>
                        <span className="text-xs">
                            {outcome.ticketTypeName} · {outcome.ticketCode} ·{" "}
                            {timeLabel(outcome.checkedInAt)}
                        </span>
                    </div>
                </InfoNote>
            ) : null}

            {outcome?.kind === "error" && feedback === "ALREADY_CHECKED_IN" ? (
                <InfoNote tone="warn">
                    <div className="flex flex-col gap-1">
                        <span className="text-base font-semibold">
                            ⚠️ TIKET SUDAH DIGUNAKAN
                        </span>
                        <span className="text-xs">
                            {firstCheckedInAt
                                ? `Check-in pada ${timeLabel(firstCheckedInAt)}`
                                : "Waktu check-in pertama tidak tercatat."}
                            {firstCheckedInBy ? ` oleh ${firstCheckedInBy}.` : "."}
                        </span>
                    </div>
                </InfoNote>
            ) : null}

            {outcome?.kind === "error" && feedback === "GATE_CLOSED" ? (
                <InfoNote tone="warn">
                    <div className="flex flex-col gap-1">
                        <span className="text-base font-semibold">
                            🔒 GATE SUDAH DITUTUP
                        </span>
                        <span className="text-xs">
                            Event ini tidak lagi menerima check-in.
                        </span>
                    </div>
                </InfoNote>
            ) : null}

            {outcome?.kind === "error" && feedback === "REFUND_PENDING" ? (
                <InfoNote tone="warn">
                    <div className="flex flex-col gap-1">
                        <span className="text-base font-semibold">
                            ⚠️ TIKET SEDANG PROSES REFUND
                        </span>
                        <span className="text-xs">
                            Tiket ini belum dapat check-in sampai proses refund selesai.
                        </span>
                    </div>
                </InfoNote>
            ) : null}

            {outcome?.kind === "error" && feedback === "NETWORK" ? (
                <ErrorBlock
                    title="Gagal terhubung ke server"
                    message={
                        <p className="text-sm">
                            Periksa koneksi. Pemindai tetap aktif dan akan mencoba lagi.
                        </p>
                    }
                />
            ) : null}

            {outcome?.kind === "error" && feedback === "INVALID" ? (
                <ErrorBlock
                    title="❌ TIKET TIDAK VALID"
                    message={
                        <p className="text-sm">
                            {outcome.message}
                            {detailText(outcome.details, "ticketCode")
                                ? ` (${detailText(outcome.details, "ticketCode")})`
                                : ""}
                        </p>
                    }
                />
            ) : null}

            {/* ── MANUAL FALLBACK — secondary, still functional ─────────────── */}
            <form onSubmit={onManualSubmit} className="flex flex-col gap-3">
                <Field
                    label="Kode tiket (manual)"
                    htmlFor="scanner-code"
                    hint="Cadangan bila kamera tidak tersedia. Ketik kode, atau arahkan pemindai QR ke kolom ini (mode keyboard)."
                >
                    <Input
                        id="scanner-code"
                        value={manualCode}
                        onChange={(event) =>
                            setManualCode(event.currentTarget.value)
                        }
                        placeholder="EVT-XXXX-XXXX"
                        className="h-12 font-mono text-base tracking-wider"
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        enterKeyHint="go"
                        disabled={busy}
                    />
                </Field>

                <Field
                    label="Label gerbang (opsional)"
                    htmlFor="scanner-gate"
                    hint="Misalnya “Pintu Utama” — membantu saat ada beberapa lokasi scan."
                >
                    <Input
                        id="scanner-gate"
                        value={gateLabel}
                        onChange={(event) => setGateLabel(event.currentTarget.value)}
                        maxLength={60}
                        autoComplete="off"
                        disabled={busy}
                    />
                </Field>

                <div>
                    <Button
                        type="submit"
                        size="lg"
                        variant="outline"
                        disabled={busy || manualCode.trim() === ""}
                    >
                        {busy ? "Memproses…" : "Check-in manual"}
                    </Button>
                </div>
            </form>

            {/* ── TECHNICAL DETAILS — safe diagnostics, never the payload ────── */}
            <details className="rounded-xl border border-ink-200 px-4 py-3">
                <summary className="cursor-pointer text-sm font-semibold">
                    Detail teknis
                </summary>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
                    {diagnostics.map(([label, value]) => (
                        <div key={label} className="flex flex-col">
                            <dt className="text-muted-foreground">{label}</dt>
                            <dd>{value}</dd>
                        </div>
                    ))}
                </dl>
            </details>

            {canReadLog ? (
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold">Check-in terbaru</h3>
                        <StatusBadge tone="neutral" size="sm">
                            {total} tiket
                        </StatusBadge>
                    </div>

                    {listError ? (
                        <ErrorBlock
                            title={listError}
                            message={
                                <p className="text-sm">
                                    Daftar kehadiran tidak dapat dimuat. Pemindaian tetap
                                    dapat dilakukan.
                                </p>
                            }
                            action={
                                <Button variant="outline" size="sm" onClick={refresh}>
                                    Coba lagi
                                </Button>
                            }
                        />
                    ) : items.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Belum ada tiket yang check-in di event ini.
                        </p>
                    ) : (
                        <div className="flex flex-col">
                            {items.map((item, index) => (
                                <DataRow
                                    key={item.id}
                                    divider={index > 0}
                                    title={item.attendeeName ?? item.ticketCode}
                                    meta={`${item.ticketTypeName} · ${item.ticketCode} · ${timeLabel(
                                        item.checkedInAt
                                    )}`}
                                    trailing={
                                        item.gateLabel ? (
                                            <StatusBadge tone="info" size="sm">
                                                {item.gateLabel}
                                            </StatusBadge>
                                        ) : null
                                    }
                                />
                            ))}
                        </div>
                    )}
                </div>
            ) : null}
        </div>
    );
}
