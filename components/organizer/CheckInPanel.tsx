"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";

import { apiFetch, ClientApiError } from "./api";
import { Button } from "@/components/dashboard/ui/button";
import { DataRow, ErrorBlock, InfoNote, StatusBadge } from "@/components/dashboard/primitives";
import { Field, Input } from "@/components/dashboard/ui/input";

/**
 * ==========================================
 * PHASE 13 — GATE CHECK-IN PANEL
 * ==========================================
 *
 * The organizer/door-staff surface for admitting tickets at one event. It is deliberately
 * a MANUAL CODE form, not a camera scanner:
 *
 *   • no QR-decoding dependency exists in the tree, and the brief forbids adding one for
 *     convenience (Part L). The wallet QR already encodes `TICKET:<ticketCode>`, so a
 *     hardware scanner in keyboard-wedge mode types the code straight into this field —
 *     the same affordance with zero new dependencies.
 *   • the server's contract (`POST …/check-in`) resolves and authorizes everything; this
 *     component sends only the code and an optional gate label. It never sends an event,
 *     a tenant, a ticket id or a status.
 *
 * ── WHAT IS SHOWN, AND WHEN ─────────────────────────────────────────────────────
 *
 * The panel is rendered only for an actor who holds `checkin.scan` on this event AND when
 * the event's gate is open — the page makes both decisions from the server with the SAME
 * canonical predicate the API uses, so a door staff member never sees a form the API would
 * refuse. The admissions list additionally requires `checkin.log.read`; when that is absent
 * the scanner still works and the list is simply not rendered.
 *
 * PHASE 15 adds two honest pieces of context, both supplied by the server (never computed
 * from the browser's clock):
 *
 *   * the check-in WINDOW state — `OPEN` before `endAt`, `GRACE` between `endAt` and
 *     `endAt + 30m`, `CLOSED` after it (P14-D06). A gate during the grace window is a real,
 *     expected state, so it is labelled rather than left to look like a normal scan.
 *   * `requiresCheckIn === false` — the event is declared gate-free (P14-D13). The panel is
 *     shown with an explicit "optional" marker and keeps working: the flag is a statement
 *     about the product, NOT a switch that locks staff out, and it is not a security
 *     decision in either direction.
 *
 * ── DUPLICATE SUBMIT ────────────────────────────────────────────────────────────
 *
 * `busy` disables the button and short-circuits `submit()`, and the input is cleared only
 * after a SUCCESS, so a double Enter cannot fire two requests. The server is the real
 * guarantee (one conditional update + a UNIQUE `CheckIn.ticketId`); this is only the
 * affordance that stops the second request being sent at all.
 *
 * ── HONEST STATES ───────────────────────────────────────────────────────────────
 *
 * A refusal is rendered from the server's own `message` and machine `code`, and an
 * `ALREADY_CHECKED_IN` shows WHEN and BY WHOM the ticket was first admitted (the server
 * puts that in `details`) — a duplicate scan at the door is a routine event, not an error
 * the staff member should have to guess about. Nothing is fabricated client-side.
 */

export type CheckInListItem = {
    id: string;
    ticketCode: string;
    attendeeName: string | null;
    ticketTypeName: string;
    checkedInAt: string;
    checkedInBy: string | null;
    gateLabel: string | null;
};

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

/** Where the event is inside its check-in window, computed server-side (P14-D06). */
export type GateState = "OPEN" | "GRACE" | "CLOSED";

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

/** A detail value the server returned, narrowed to something printable. */
function detailText(
    details: Record<string, unknown> | undefined,
    key: string
): string | null {
    const value = details?.[key];

    return typeof value === "string" && value.length > 0 ? value : null;
}

export default function CheckInPanel({
    eventId,
    canReadLog,
    initialItems,
    initialTotal,
    gateState,
    requiresCheckIn,
}: Props) {
    const [code, setCode] = useState("");
    const [gateLabel, setGateLabel] = useState("");
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    const [items, setItems] = useState<CheckInListItem[]>(initialItems);
    const [total, setTotal] = useState(initialTotal);
    const [listError, setListError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const endpoint = `/api/organizer/events/${eventId}/check-in`;

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

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const value = code.trim();

        if (!value || busy) {
            return;
        }

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
                    code: value,
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

            // Cleared only on success: a refused code stays put so the operator can see
            // exactly what was rejected while reading the message.
            setCode("");
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
            setBusy(false);
            inputRef.current?.focus();
        }
    }

    const duplicate = outcome?.kind === "error" && outcome.code === "TICKET_ALREADY_CHECKED_IN";
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

            <form onSubmit={submit} className="flex flex-col gap-3">
                <Field
                    label="Kode tiket"
                    htmlFor="checkin-code"
                    hint="Ketik kode tiket, atau arahkan pemindai QR ke kolom ini (mode keyboard)."
                >
                    <Input
                        id="checkin-code"
                        ref={inputRef}
                        value={code}
                        onChange={(event) => setCode(event.currentTarget.value)}
                        placeholder="EVT-XXXX-XXXX"
                        className="h-12 font-mono text-base tracking-wider"
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        /* PHASE 16: a phone keyboard gets a "go" key instead of a newline on
                         * the field that ends in a submit. The keyboard-wedge path is
                         * unaffected — a wedge sends Enter, which the form already handles. */
                        enterKeyHint="go"
                        /* The gate's whole workflow is "scan, then scan again": focusing on
                         * mount is the difference between one keystroke and two per ticket. */
                        autoFocus
                        disabled={busy}
                    />
                </Field>

                <Field
                    label="Label gerbang (opsional)"
                    htmlFor="checkin-gate"
                    hint="Misalnya “Pintu Utama” — membantu saat ada beberapa lokasi scan."
                >
                    <Input
                        id="checkin-gate"
                        value={gateLabel}
                        onChange={(event) => setGateLabel(event.currentTarget.value)}
                        maxLength={60}
                        autoComplete="off"
                        disabled={busy}
                    />
                </Field>

                <div>
                    <Button type="submit" size="lg" disabled={busy || code.trim() === ""}>
                        {busy ? "Memproses…" : "Check-in"}
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
