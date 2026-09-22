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
 * GATE SCANNER — CAMERA INPUT, EXISTING CHECK-IN ENGINE
 * ==========================================
 *
 * A second INPUT DEVICE for the existing gate system: the camera reads the wallet QR
 * payload (`TICKET:<ticketCode>`) and posts it to the SAME
 * `POST /api/organizer/events/:id/check-in` route the manual panel uses. No part of the
 * check-in logic is duplicated here — the server still resolves, authorizes, races and
 * records the admission; this component only turns light into a code.
 *
 * ── NO NEW DEPENDENCY ─────────────────────────────────────────────────────────────
 * Decoding uses the browser-native `BarcodeDetector` API (Chromium / Android
 * WebView). The navigation-pin tests forbidding a scanner npm dependency stay green
 * precisely because nothing is installed: on a browser without `BarcodeDetector`
 * (Firefox, Safari) the camera area explains itself and the MANUAL field below is the
 * full fallback — including hardware keyboard-wedge scanners, which type the same code
 * straight into the field, exactly as the existing panel documents.
 *
 * ── REUSE, NOT PARALLEL SYSTEM ────────────────────────────────────────────────────
 *   • payload   — the wallet QR payload is left untouched (`TICKET:…` and bare codes
 *                 both go through, and the server's `normalizeCode` accepts both)
 *   • contract  — `POST` / `GET …/check-in` are the same two routes the manual panel calls
 *   • window    — `gateState` and `requiresCheckIn` are the SERVER-supplied values from
 *                 `isEventCheckInOpen`, never computed from the browser clock
 *
 * The only client-side transform is `sanitizeScannedPayload`: control characters are
 * stripped and the string is length-capped. It is defense-in-depth for decoding noise —
 * the server re-validates the code with `isTicketCode` before anything happens.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────────
 * The decoded payload is held in component state for the duration of the request and
 * is never persisted, logged or stored — no `qrToken`, `qrTokenHash`, attendee email
 * or phone ever reaches this screen. Only the server's own response (ticket code,
 * attendee name, type, time) is rendered.
 */

/** Strip whitespace-newline noise and cap length. Pure, browser-independent. */
export function sanitizeScannedPayload(payload: unknown): string {
    if (typeof payload !== "string") {
        return "";
    }

    return payload.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128);
}

/** The one method recorded is unchanged; the scanner is an input device, not a new method. */

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

type ScannerState = "idle" | "starting" | "active" | "unsupported" | "denied" | "error";

/** The parts of the native detector this component actually calls. */
type DetectorInstance = {
    detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
};

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
    const [items, setItems] = useState<CheckInListItem[]>(initialItems);
    const [total, setTotal] = useState(initialTotal);
    const [listError, setListError] = useState<string | null>(null);

    const videoRef = useRef<HTMLVideoElement>(null);
    const busyRef = useRef(false);
    const scannerStateRef = useRef(false);
    const pausedUntilRef = useRef(0);
    const lastPayloadRef = useRef({ payload: "", at: 0 });

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

    async function checkIn(payload: string) {
        // Throttle the SAME payload: the camera keeps watching the same QR while it is
        // waived, and the server's idempotency is the real guarantee — this guard only
        // stops the identical request being fired on every animation frame.
        const nowMs = Date.now();

        if (
            lastPayloadRef.current.payload === payload &&
            nowMs - lastPayloadRef.current.at < 1500
        ) {
            return;
        }

        lastPayloadRef.current = { payload, at: nowMs };
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

            setOutcome({
                kind: "success",
                ticketCode: data.ticket.ticketCode,
                attendeeName: data.ticket.attendeeName,
                ticketTypeName: data.ticketType.name,
                checkedInAt: data.checkedInAt,
            });

            // A successful admission briefly stops re-reading the same ticket's QR so
            // the next ticket can be presented.
            pausedUntilRef.current = Date.now() + 1500;

            await refresh();
        } catch (caught) {
            if (caught instanceof ClientApiError) {
                setOutcome({
                    kind: "error",
                    code: caught.code,
                    message: caught.message,
                    details: caught.details,
                });
            } else {
                setOutcome({
                    kind: "error",
                    code: "INTERNAL_ERROR",
                    message: "Terjadi kesalahan.",
                });
            }
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    }

    // The camera loop reads the LATEST `checkIn` (with the current gate label) through
    // a ref, so restarting the camera is never coupled to typing in a field.
    const checkInRef = useRef(checkIn);

    useEffect(() => {
        checkInRef.current = checkIn;
    });

    async function onManualSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const payload = sanitizeScannedPayload(manualCode);

        if (!payload || busyRef.current) {
            return;
        }

        setManualCode("");
        await checkIn(payload);
    }

    useEffect(() => {
        let cancelled = false;
        let stream: MediaStream | null = null;
        let detector: DetectorInstance | null = null;
        let frameId = 0;

        function stopTracks() {
            stream?.getTracks().forEach((track) => track.stop());
            stream = null;
        }

        async function tick() {
            if (
                cancelled ||
                scannerStateRef.current === false ||
                !videoRef.current ||
                !detector
            ) {
                return;
            }

            try {
                if (Date.now() >= pausedUntilRef.current) {
                    const barcodes = await detector.detect(videoRef.current);
                    const raw = barcodes[0]?.rawValue;

                    if (raw && !busyRef.current) {
                        const payload = sanitizeScannedPayload(raw);

                        if (payload) {
                            void checkInRef.current(payload);
                        }
                    }
                }
            } catch {
                // A rejected frame (e.g. the camera was briefly busy) is not a reason to
                // stop scanning; the next frame retries.
            }
        }

        async function loop() {
            if (cancelled) {
                return;
            }

            frameId = requestAnimationFrame(() => {
                void tick().finally(loop);
            });
        }

        async function start() {
            setState("starting");

            const DetectorCtor = (window as {
                BarcodeDetector?: new (
                    options?: { formats?: string[] }
                ) => DetectorInstance;
            }).BarcodeDetector;

            if (!DetectorCtor) {
                setState("unsupported");
                return;
            }

            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: "environment" },
                });
            } catch {
                if (!cancelled) {
                    setState("denied");
                }
                return;
            }

            if (cancelled) {
                stopTracks();
                return;
            }

            try {
                detector = new DetectorCtor({ formats: ["qr_code"] });
            } catch {
                detector = new DetectorCtor();
            }

            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play().catch(() => undefined);
            }

            scannerStateRef.current = true;
            setState("active");
            loop();
        }

        scannerStateRef.current = false;
        void start();

        return () => {
            cancelled = true;
            scannerStateRef.current = false;
            cancelAnimationFrame(frameId);
            stopTracks();
        };
    }, []);

    const isStarting = state === "starting";

    const duplicate =
        outcome?.kind === "error" && outcome.code === "TICKET_ALREADY_CHECKED_IN";
    const firstCheckedInAt = duplicate
        ? detailText(outcome.details, "firstCheckedInAt")
        : null;
    const firstCheckedInBy = duplicate
        ? detailText(outcome.details, "firstCheckedInBy")
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

            <div className="flex flex-col gap-2">
                <video
                    ref={videoRef}
                    autoPlay
                    muted
                    playsInline
                    className="aspect-video w-full max-w-xl overflow-hidden rounded-xl border border-ink-200 bg-ink-100 object-cover"
                    hidden={!isStarting && state !== "active"}
                />

                {isStarting ? (
                    <InfoNote tone="warn">
                        <span className="flex items-center gap-2">
                            <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-amber-500" />
                            Menyalakan kamera…
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
            </div>

            <form onSubmit={onManualSubmit} className="flex flex-col gap-3">
                <Field
                    label="Kode tiket"
                    htmlFor="scanner-code"
                    hint="Ketik kode, atau arahkan pemindai QR ke kolom ini (mode keyboard)."
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
                        disabled={busy || manualCode.trim() === ""}
                    >
                        {busy ? "Memproses…" : "Check-in manual"}
                    </Button>
                </div>
            </form>

            {outcome?.kind === "success" ? (
                <InfoNote tone="success">
                    <div className="flex flex-col gap-1">
                        <span className="text-sm font-semibold">
                            Berhasil check-in: {outcome.attendeeName ?? "Peserta"}
                        </span>
                        <span className="text-xs">
                            {outcome.ticketTypeName} · {outcome.ticketCode} ·{" "}
                            {timeLabel(outcome.checkedInAt)}
                        </span>
                    </div>
                </InfoNote>
            ) : null}

            {outcome?.kind === "error" ? (
                duplicate ? (
                    <InfoNote tone="warn">
                        <div className="flex flex-col gap-1">
                            <span className="text-sm font-semibold">
                                Tiket ini sudah check-in sebelumnya.
                            </span>
                            <span className="text-xs">
                                {firstCheckedInAt
                                    ? `Pertama masuk ${timeLabel(firstCheckedInAt)}`
                                    : "Waktu check-in pertama tidak tercatat."}
                                {firstCheckedInBy ? ` oleh ${firstCheckedInBy}.` : "."}
                            </span>
                        </div>
                    </InfoNote>
                ) : (
                    <ErrorBlock
                        title={outcome.message}
                        message={
                            <p className="text-sm">
                                Kode {detailText(outcome.details, "ticketCode") ?? "tersebut"}{" "}
                                tidak dapat diterima. Periksa kembali tiket dan event yang
                                sedang dibuka.
                            </p>
                        }
                    />
                )
            ) : null}

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