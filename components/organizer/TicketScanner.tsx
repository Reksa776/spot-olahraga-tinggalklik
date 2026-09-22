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
 * frame (see `createScanThrottle`); a different customer's QR is picked up immediately.
 * The client cooldown is UX protection ONLY — the server's CAS transition, the UNIQUE
 * `CheckIn.ticketId` and the check-in transaction remain authoritative.
 *
 * ── NO NEW DEPENDENCY ─────────────────────────────────────────────────────────────
 * Decoding uses the browser-native `BarcodeDetector` API (Chromium / Android WebView).
 * On a browser without it (Firefox, Safari) the camera area explains itself and the
 * MANUAL field below is the full fallback — including hardware keyboard-wedge scanners,
 * which type the same code straight into the field. No QR library is installed.
 *
 * ── LIFECYCLE ─────────────────────────────────────────────────────────────────────
 * The detection loop is driven by `requestAnimationFrame`. Stop, unmount and a hidden
 * tab all pause it safely, and every path releases the `MediaStream` tracks — no camera
 * is left running and no frame is left scheduled.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────────
 * The decoded payload is never persisted (no `localStorage`/`sessionStorage`), never
 * logged, and is sent nowhere except the existing authorized check-in route. The
 * suppression map holds a payload only in component memory for a couple of seconds.
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

/** The UX bucket a server/client failure falls into. Pure, so it can be unit-tested. */
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

    const reason =
        typeof details?.reason === "string" ? details.reason : null;

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
    | "unsupported"
    | "denied"
    | "error";

/** The parts of the native detector this component actually calls. */
type DetectorInstance = {
    detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
};

type BarcodeDetectorCtor = new (options?: {
    formats?: string[];
}) => DetectorInstance;

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
    const [sessionCount, setSessionCount] = useState(0);
    const [items, setItems] = useState<CheckInListItem[]>(initialItems);
    const [total, setTotal] = useState(initialTotal);
    const [listError, setListError] = useState<string | null>(null);

    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const detectorRef = useRef<DetectorInstance | null>(null);
    const frameRef = useRef(0);
    const runningRef = useRef(false);
    const hiddenRef = useRef(false);
    const mountedRef = useRef(true);
    const busyRef = useRef(false);
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

    function releaseCamera() {
        runningRef.current = false;

        if (frameRef.current) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = 0;
        }

        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
    }

    /**
     * One detection pass. It NEVER throws and never stops the loop: a rejected frame (the
     * camera briefly busy) or a hidden tab simply means the next frame retries.
     */
    async function tick() {
        if (
            !mountedRef.current ||
            !runningRef.current ||
            hiddenRef.current ||
            !videoRef.current ||
            !detectorRef.current
        ) {
            return;
        }

        // While backing off after a network failure, keep the camera but skip requests.
        if (Date.now() < backoffUntilRef.current) {
            return;
        }

        let raw: string | undefined;

        try {
            const barcodes = await detectorRef.current.detect(videoRef.current);
            raw = barcodes[0]?.rawValue;
        } catch {
            return;
        }

        if (!raw || busyRef.current) {
            return;
        }

        const payload = sanitizeScannedPayload(raw);

        if (!payload) {
            return;
        }

        // Suppress the same QR while it lingers in frame; a different payload is processed
        // immediately even if one request is still in flight.
        if (!throttleRef.current.shouldProcess(payload, Date.now())) {
            return;
        }

        void checkInRef.current(payload);
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

        setState("starting");
        setOutcome(null);
        throttleRef.current.reset();
        backoffUntilRef.current = 0;

        const DetectorCtor = (window as { BarcodeDetector?: BarcodeDetectorCtor })
            .BarcodeDetector;

        if (!DetectorCtor) {
            setState("unsupported");
            return;
        }

        let stream: MediaStream;

        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment" },
            });
        } catch {
            if (mountedRef.current) {
                setState("denied");
            }
            return;
        }

        if (!mountedRef.current) {
            stream.getTracks().forEach((track) => track.stop());
            return;
        }

        try {
            detectorRef.current = new DetectorCtor({ formats: ["qr_code"] });
        } catch {
            detectorRef.current = new DetectorCtor();
        }

        streamRef.current = stream;

        if (videoRef.current) {
            videoRef.current.srcObject = stream;
            await videoRef.current.play().catch(() => undefined);
        }

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

    const isStarting = state === "starting";
    const isActive = state === "active";

    const feedback =
        outcome?.kind === "error"
            ? scanFeedbackFor(outcome.code, outcome.details)
            : null;

    const firstCheckedInAt =
        feedback === "ALREADY_CHECKED_IN"
            ? detailText(outcome?.kind === "error" ? outcome.details : undefined, "firstCheckedInAt")
            : null;
    const firstCheckedInBy =
        feedback === "ALREADY_CHECKED_IN"
            ? detailText(outcome?.kind === "error" ? outcome.details : undefined, "firstCheckedInBy")
            : null;

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
                                🟢 Scanner aktif
                            </span>
                            <span className="text-sm">
                                Silakan scan tiket berikutnya — tidak perlu menekan apa pun.
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

                {state === "unsupported" ? (
                    <InfoNote tone="warn">
                        <div className="flex flex-col gap-1">
                            <span className="text-sm font-semibold">
                                Kamera QR tidak didukung browser ini.
                            </span>
                            <span className="text-xs">
                                Gunakan kolom kode di bawah, atau pemindai QR mode
                                keyboard-wedge, untuk check-in manual.
                            </span>
                        </div>
                    </InfoNote>
                ) : null}

                {state === "denied" ? (
                    <ErrorBlock
                        title="Izin kamera ditolak"
                        message={
                            <p className="text-sm">
                                Aktifkan akses kamera untuk browser ini, atau gunakan
                                kolom kode di bawah untuk check-in manual.
                            </p>
                        }
                    />
                ) : null}

                {state === "error" ? (
                    <ErrorBlock
                        title="Kamera tidak bisa diakses"
                        message={
                            <p className="text-sm">
                                Cobalah lagi, atau gunakan kolom kode di bawah untuk
                                check-in manual.
                            </p>
                        }
                    />
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
                            {isStarting ? "Menyalakan…" : "Mulai Pemindai"}
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
