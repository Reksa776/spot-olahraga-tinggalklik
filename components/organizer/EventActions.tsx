"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { apiFetch, ClientApiError, preconditionsFrom } from "./api";
import { Button } from "@/components/dashboard/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/dashboard/ui/dialog";
import { Field, Textarea } from "@/components/dashboard/ui/input";
import { ErrorBlock } from "@/components/dashboard/primitives";

/**
 * ==========================================
 * EVENT LIFECYCLE ACTIONS
 * ==========================================
 *
 * Publish / unpublish / cancel / complete / archive / delete, each a dedicated endpoint
 * rather than a status field on the edit form, so the design §10.3 preconditions cannot be
 * bypassed — the API re-checks them on every call regardless of what the UI shows.
 *
 * ── WHICH ACTIONS ARE SHOWN (phase 12 §15: no inapplicable buttons) ──────────────
 * Every button below is gated on the CURRENT status, so an organizer is never offered a
 * transition the server will refuse:
 *
 *   DRAFT      → publish, delete (delete is additionally draft-only server-side)
 *   PUBLISHED  → unpublish, cancel, complete, archive
 *   ONGOING    → cancel, complete, archive
 *   COMPLETED  → archive
 *   CANCELLED  → archive
 *   ARCHIVED   → none (terminal)
 *
 * PHASE 15 — `Selesaikan event` is the MANUAL half of `PUBLISHED|ONGOING → COMPLETED`
 * (P14-D05). The automatic half is the scheduler. Two honest constraints are surfaced
 * rather than hidden: the button is DISABLED (with an explanation) when the event has no
 * `endAt`, because an `endAt`-less event can never be completed (P14-D22); and the server's
 * `NOT_ENDED` refusal is rendered verbatim if the event has not passed its end yet — the
 * browser cannot be trusted to know the clock, so it is the server's answer that counts.
 *
 * PHASE 20B — `Publikasikan` now carries the same treatment (D-P19-05 = A). An event
 * without an `endAt` cannot be published, because it could never complete and its gate
 * would never close. The button is disabled with an explanation AND the server refuses it
 * independently (`publishEvent`'s `preconditions`), so the rule survives a client that
 * ignores the disabled state — the same defence-in-depth the header describes below.
 *
 * The one precondition that is not known client-side is "an open refund blocks archive".
 * Rather than hide a button for a reason the browser cannot compute, the button is shown
 * and the server's refusal is rendered verbatim via `preconditionsFrom` — the same
 * treatment publish already gets.
 *
 * ── WHAT EACH MUTATION MEANS (and what it does NOT do) ───────────────────────────
 * `Batalkan publikasi` (unpublish, D-14) only hides listings and preserves the read-only
 * page; it does not cancel orders or void tickets.
 *
 * `Batalkan event` (cancel) stops sales and expires unpaid orders. It deliberately does
 * NOT refund money and does NOT void issued tickets — the design's refund automation is
 * post-MVP — and both the confirmation copy and the success path say so.
 *
 * `Arsipkan` (archive) is the soft delete: the event disappears from every public surface
 * and nothing is deleted. Orders, tickets, payments and refunds are untouched.
 *
 * PHASE (shadcn migration): presentation only. The mutations, the `busy` action key, the
 * `router.refresh()` / `router.push("/dashboard/events")` behaviour, `preconditionsFrom`
 * and the verbatim message rendering are unchanged. The destructive confirmations use the
 * same shadcn `Dialog` that gated the draft delete before phase 12.
 */

type Props = {
    eventId: string;
    status: string;
    /** The event's scheduled end, for the completion affordance. `null` disables it. */
    endAt?: string | null;
};

type Action =
    | "publish"
    | "unpublish"
    | "cancel"
    | "complete"
    | "archive"
    | "delete";

/** The in-flight affordance every dashboard async button shares. */
function Spinner() {
    return (
        <span
            aria-hidden
            className="size-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current"
        />
    );
}

const CANCELLABLE = new Set(["PUBLISHED", "ONGOING"]);

/** Statuses from which a manual completion is a legal request (P14-D05). */
const COMPLETABLE = new Set(["PUBLISHED", "ONGOING"]);

export default function EventActions({ eventId, status, endAt = null }: Props) {
    const router = useRouter();

    const [busy, setBusy] = useState<Action | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [unmet, setUnmet] = useState<string[]>([]);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [confirmingArchive, setConfirmingArchive] = useState(false);
    const [confirmingCancel, setConfirmingCancel] = useState(false);
    const [confirmingComplete, setConfirmingComplete] = useState(false);
    const [cancelReason, setCancelReason] = useState("");
    const [completeNote, setCompleteNote] = useState("");

    const archived = status === "ARCHIVED";

    async function run(action: Action, call: () => Promise<unknown>) {
        setBusy(action);
        setError(null);
        setUnmet([]);

        try {
            await call();
            router.refresh();
        } catch (caught) {
            if (caught instanceof ClientApiError) {
                setError(caught.message);
                setUnmet(preconditionsFrom(caught));
            } else {
                setError("Terjadi kesalahan.");
            }
        } finally {
            setBusy(null);
        }
    }

    async function deleteDraft() {
        setConfirmingDelete(false);

        await run("delete", () =>
            apiFetch(`/api/organizer/events/${eventId}`, { method: "DELETE" })
        ).then(() => router.push("/dashboard/events"));
    }

    async function archiveEvent() {
        setConfirmingArchive(false);

        await run("archive", () =>
            apiFetch(`/api/organizer/events/${eventId}/archive`, {
                method: "POST",
            })
        );
    }

    async function cancelEvent() {
        setConfirmingCancel(false);

        const reason = cancelReason.trim();

        await run("cancel", () =>
            apiFetch(`/api/organizer/events/${eventId}/cancel`, {
                method: "POST",
                body: JSON.stringify({ reason: reason || null }),
            })
        );
    }

    async function completeEvent() {
        setConfirmingComplete(false);

        const note = completeNote.trim();

        await run("complete", () =>
            apiFetch(`/api/organizer/events/${eventId}/complete`, {
                method: "POST",
                body: JSON.stringify({ note: note || null }),
            })
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                {status === "DRAFT" ? (
                    <Button
                        disabled={busy !== null || endAt === null}
                        onClick={() =>
                            run("publish", () =>
                                apiFetch(`/api/organizer/events/${eventId}/publish`, {
                                    method: "POST",
                                })
                            )
                        }
                        title={
                            endAt === null
                                ? "Event ini tidak memiliki waktu selesai. Waktu selesai wajib diisi sebelum publikasi, karena event tanpa waktu selesai tidak dapat diselesaikan."
                                : "Menerbitkan event agar dapat dijual dan tampil di katalog."
                        }
                    >
                        {busy === "publish" ? <Spinner /> : null}
                        {busy === "publish" ? "Memproses…" : "Publikasikan"}
                    </Button>
                ) : null}

                {status === "PUBLISHED" ? (
                    <Button
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() =>
                            run("unpublish", () =>
                                apiFetch(`/api/organizer/events/${eventId}/unpublish`, {
                                    method: "POST",
                                })
                            )
                        }
                        title="Menyembunyikan event dari katalog tanpa menghapus data, membatalkan pesanan, atau membatalkan tiket."
                    >
                        {busy === "unpublish" ? <Spinner /> : null}
                        {busy === "unpublish" ? "Memproses…" : "Batalkan publikasi"}
                    </Button>
                ) : null}

                {CANCELLABLE.has(status) ? (
                    <Button
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => {
                            setError(null);
                            setUnmet([]);
                            setConfirmingCancel(true);
                        }}
                        className="text-destructive hover:bg-destructive/10"
                    >
                        {busy === "cancel" ? <Spinner /> : null}
                        {busy === "cancel" ? "Memproses…" : "Batalkan event"}
                    </Button>
                ) : null}

                {COMPLETABLE.has(status) ? (
                    <Button
                        variant="outline"
                        disabled={busy !== null || endAt === null}
                        onClick={() => {
                            setError(null);
                            setUnmet([]);
                            setConfirmingComplete(true);
                        }}
                        title={
                            endAt === null
                                ? "Event ini tidak memiliki waktu selesai, sehingga tidak dapat diselesaikan. Batalkan atau arsipkan event sebagai gantinya."
                                : "Menutup event sebagai selesai. Penjualan berhenti dan tidak ada data yang dihapus."
                        }
                    >
                        {busy === "complete" ? <Spinner /> : null}
                        {busy === "complete" ? "Memproses…" : "Selesaikan event"}
                    </Button>
                ) : null}

                {!archived ? (
                    <Button
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => {
                            setError(null);
                            setUnmet([]);
                            setConfirmingArchive(true);
                        }}
                        title="Menyembunyikan event dari semua permukaan publik tanpa menghapus data."
                    >
                        {busy === "archive" ? <Spinner /> : null}
                        {busy === "archive" ? "Memproses…" : "Arsipkan"}
                    </Button>
                ) : null}

                {COMPLETABLE.has(status) && endAt === null ? (
                    <p className="text-xs text-muted-foreground">
                        Event tanpa waktu selesai tidak dapat diselesaikan secara manual —
                        batalkan atau arsipkan sebagai gantinya.
                    </p>
                ) : null}

                {status === "DRAFT" && endAt === null ? (
                    <p className="text-xs text-muted-foreground">
                        Event tanpa waktu selesai tidak dapat dipublikasikan — isi waktu
                        selesai pada formulir event terlebih dahulu agar event dapat
                        diselesaikan nanti.
                    </p>
                ) : null}

                {status === "DRAFT" ? (
                    <Button
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => setConfirmingDelete(true)}
                        className="text-destructive hover:bg-destructive/10"
                    >
                        {busy === "delete" ? <Spinner /> : null}
                        {busy === "delete" ? "Menghapus…" : "Hapus draft"}
                    </Button>
                ) : null}

                {archived ? (
                    <p className="text-sm text-muted-foreground">
                        Event sudah diarsipkan dan tidak muncul di permukaan publik.
                    </p>
                ) : null}
            </div>

            {error ? (
                <ErrorBlock
                    title={error}
                    message={
                        unmet.length > 0 ? (
                            <div className="flex flex-col gap-1">
                                <p className="text-xs font-semibold text-foreground">
                                    Syarat yang belum terpenuhi:
                                </p>

                                <ul className="list-disc space-y-1 pl-5 text-xs">
                                    {unmet.map((item) => (
                                        <li key={item}>{item}</li>
                                    ))}
                                </ul>
                            </div>
                        ) : (
                            <p className="text-sm">
                                Periksa kembali data event sebelum mencoba lagi.
                            </p>
                        )
                    }
                />
            ) : null}

            {/* ── Delete (draft only) ─────────────────────────────────────────── */}
            <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Hapus event draft ini?</DialogTitle>
                        <DialogDescription>
                            Tindakan ini tidak dapat dibatalkan.
                        </DialogDescription>
                    </DialogHeader>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setConfirmingDelete(false)}
                        >
                            Batal
                        </Button>

                        <Button
                            variant="destructive"
                            disabled={busy === "delete"}
                            onClick={deleteDraft}
                        >
                            {busy === "delete" ? <Spinner /> : null}
                            Hapus draft
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Cancel (stops sales, expires unpaid orders) ─────────────────── */}
            <Dialog open={confirmingCancel} onOpenChange={setConfirmingCancel}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Batalkan event ini?</DialogTitle>
                        <DialogDescription>
                            Penjualan dihentikan dan pesanan yang belum dibayar
                            dibatalkan otomatis. Uang tidak dikembalikan otomatis dan
                            tiket yang sudah terbit tidak dibatalkan — gunakan alur
                            refund untuk pengembalian dana.
                        </DialogDescription>
                    </DialogHeader>

                    <Field
                        label="Alasan pembatalan (opsional)"
                        htmlFor="cancel-reason"
                        hint="Ditampilkan pada halaman publik event."
                    >
                        <Textarea
                            id="cancel-reason"
                            rows={3}
                            maxLength={500}
                            value={cancelReason}
                            onChange={(event) =>
                                setCancelReason(event.currentTarget.value)
                            }
                        />
                    </Field>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setConfirmingCancel(false)}
                        >
                            Batal
                        </Button>

                        <Button
                            variant="destructive"
                            disabled={busy === "cancel"}
                            onClick={cancelEvent}
                        >
                            {busy === "cancel" ? <Spinner /> : null}
                            Batalkan event
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Complete (manual lifecycle close, no money moves) ─────────── */}
            <Dialog open={confirmingComplete} onOpenChange={setConfirmingComplete}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Selesaikan event ini?</DialogTitle>
                        <DialogDescription>
                            Penjualan tiket dihentikan dan event ditandai selesai. Tidak
                            ada data yang dihapus: pesanan, tiket, pembayaran, dan refund
                            tetap utuh, dan refund yang sedang berjalan tetap diproses.
                            Uang tidak bergerak otomatis dan tiket tidak dibatalkan.
                        </DialogDescription>
                    </DialogHeader>

                    <Field
                        label="Catatan (opsional)"
                        htmlFor="complete-note"
                        hint="Dicatat pada jejak audit sebagai alasan event diselesaikan."
                    >
                        <Textarea
                            id="complete-note"
                            rows={3}
                            maxLength={500}
                            value={completeNote}
                            onChange={(event) =>
                                setCompleteNote(event.currentTarget.value)
                            }
                        />
                    </Field>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setConfirmingComplete(false)}
                        >
                            Batal
                        </Button>

                        <Button
                            disabled={busy === "complete"}
                            onClick={completeEvent}
                        >
                            {busy === "complete" ? <Spinner /> : null}
                            Selesaikan event
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Archive (soft delete, non-destructive) ─────────────────────── */}
            <Dialog open={confirmingArchive} onOpenChange={setConfirmingArchive}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Arsipkan event ini?</DialogTitle>
                        <DialogDescription>
                            Event disembunyikan dari semua permukaan publik. Data
                            pesanan, tiket, pembayaran, dan refund tetap utuh dan
                            tersimpan; tidak ada data yang dihapus.
                        </DialogDescription>
                    </DialogHeader>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setConfirmingArchive(false)}
                        >
                            Batal
                        </Button>

                        <Button
                            disabled={busy === "archive"}
                            onClick={archiveEvent}
                        >
                            {busy === "archive" ? <Spinner /> : null}
                            Arsipkan
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
