"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { apiFetch, ClientApiError } from "@/components/organizer/api";
import {
    DataTable,
    EmptyBlock,
    ErrorBlock,
    PrimaryAction,
    SectionCard,
    StatusBadge,
    type Tone,
} from "@/components/dashboard/primitives";
import { Button } from "@/components/dashboard/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/dashboard/ui/dialog";
import { Field, Input } from "@/components/dashboard/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/dashboard/ui/select";

/**
 * Assign PICs to this organizer's events.
 *
 * Talks to `/api/organizer/pic`, which runs `requireOrganizerAccess` against the organizer that
 * OWNS the named event. The organizer id in the page URL is never treated as authority: it only
 * selects which tenant to list, and the server re-authorizes it.
 *
 * ── WHAT THE SERVER DECIDES, NOT THIS FORM ────────────────────────────────────────
 * Only ACTIVE PICs are offered, because the API refuses to attach a pending or suspended profile
 * to a sale. Only this organizer's events are offered, because the service scopes the list. Both
 * would still be enforced if this dropdown were tampered with.
 *
 * ── REVOKE IS SOFT ────────────────────────────────────────────────────────────────
 * Revoking sets `isActive: false` rather than deleting the row, because attributions and fee
 * ledger entries may already reference the pairing. Re-assigning the same PIC to the same event
 * therefore REACTIVATES that row — the schema makes `(picProfileId, eventId)` unique, so a second
 * row for the same pairing is not representable.
 */

type Assignment = {
    id: string;
    picProfileId: string;
    picName: string;
    picCode: string;
    picStatus: string;
    eventId: string;
    eventTitle: string;
    eventStatus: string;
    feeRateBp: number | null;
    feeTypeOverride: string | null;
    assignedAt: string;
    revokedAt: string | null;
    isActive: boolean;
};

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

const FEE_TYPE_LABEL: Record<string, string> = {
    PERCENTAGE: "Persentase",
    FIXED: "Nominal tetap",
    HYBRID: "Kombinasi",
};

/** Radix Select cannot hold an empty string as a value, so "inherit" is an explicit sentinel. */
const INHERIT = "inherit";

export default function PicAssignmentManager({
    assignments,
    events,
    pics,
}: {
    assignments: Assignment[];
    events: { id: string; title: string; status: string }[];
    pics: { id: string; displayName: string; picCode: string }[];
}) {
    const router = useRouter();

    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [form, setForm] = useState({
        picProfileId: "",
        eventId: "",
        feeRateBp: "",
        feeTypeOverride: INHERIT,
    });
    const [pendingRevoke, setPendingRevoke] = useState<Assignment | null>(null);

    async function run(call: () => Promise<unknown>) {
        setBusy(true);
        setError(null);

        try {
            await call();
            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError ? caught.message : "Terjadi kesalahan."
            );
        } finally {
            setBusy(false);
        }
    }

    async function assign(event: React.FormEvent) {
        event.preventDefault();

        if (!form.picProfileId || !form.eventId) {
            setError("Pilih PIC dan event terlebih dahulu.");
            return;
        }

        // The form collects a percentage; the API stores basis points. The conversion happens once,
        // here, and an empty field stays omitted so the server applies "inherit" rather than 0%.
        const ratePercent = form.feeRateBp.trim();
        const parsedRate = ratePercent === "" ? null : Number(ratePercent);

        if (parsedRate !== null && (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100)) {
            setError("Tarif harus berupa angka antara 0 dan 100.");
            return;
        }

        await run(() =>
            apiFetch("/api/organizer/pic", {
                method: "POST",
                body: JSON.stringify({
                    picProfileId: form.picProfileId,
                    eventId: form.eventId,
                    ...(parsedRate === null
                        ? {}
                        : { feeRateBp: Math.round(parsedRate * 100) }),
                    ...(form.feeTypeOverride === INHERIT
                        ? {}
                        : { feeTypeOverride: form.feeTypeOverride }),
                }),
            })
        );

        setForm({ picProfileId: "", eventId: "", feeRateBp: "", feeTypeOverride: INHERIT });
    }

    async function confirmRevoke() {
        const assignment = pendingRevoke;
        setPendingRevoke(null);

        if (!assignment) return;

        await run(() =>
            apiFetch(`/api/organizer/pic/${assignment.id}`, { method: "DELETE" })
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <SectionCard
                title="Penugasan PIC"
                description={`${assignments.filter((item) => item.isActive).length} penugasan aktif dari ${assignments.length} riwayat`}
            >
                <DataTable
                    minWidth={860}
                    columns={[
                        { header: "Event" },
                        { header: "PIC" },
                        { header: "Tarif event", align: "right" },
                        { header: "Ditugaskan" },
                        { header: "Status" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={assignments.map((assignment) => ({
                        key: assignment.id,
                        cells: [
                            <div className="flex flex-col" key="event">
                                <span className="text-sm font-semibold">
                                    {assignment.eventTitle}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {assignment.eventStatus}
                                </span>
                            </div>,
                            <div className="flex flex-col" key="pic">
                                <span className="text-sm">{assignment.picName}</span>
                                <span className="font-mono text-xs text-muted-foreground">
                                    {assignment.picCode}
                                </span>
                            </div>,
                            <span className="text-sm tabular-nums" key="rate">
                                {assignment.feeRateBp === null
                                    ? "Ikut default"
                                    : `${(assignment.feeRateBp / 100).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`}
                            </span>,
                            <span className="text-sm text-muted-foreground" key="assigned">
                                {DATE_FORMAT.format(new Date(assignment.assignedAt))}
                            </span>,
                            <StatusBadge
                                key="status"
                                tone={(assignment.isActive ? "success" : "neutral") as Tone}
                            >
                                {assignment.isActive ? "Aktif" : "Dicabut"}
                            </StatusBadge>,
                            <div className="flex flex-nowrap justify-end" key="actions">
                                {assignment.isActive ? (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => setPendingRevoke(assignment)}
                                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    >
                                        Cabut
                                    </Button>
                                ) : (
                                    <span className="text-xs text-muted-foreground">—</span>
                                )}
                            </div>,
                        ],
                    }))}
                    empty={
                        <EmptyBlock
                            title="Belum ada penugasan PIC"
                            description="PIC yang ditugaskan ke event di sini yang berhak mengatribusikan penjualan tiket event tersebut."
                        />
                    }
                />
            </SectionCard>

            {error ? <ErrorBlock message={error} title="Operasi gagal" /> : null}

            <SectionCard
                title="Tugaskan PIC"
                description="Hanya PIC berstatus aktif yang dapat ditugaskan. Tarif di sini menimpa tarif default PIC untuk event ini."
            >
                <form onSubmit={assign} className="flex flex-col gap-5">
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                        <Field label="Event" required>
                            <Select
                                value={form.eventId}
                                onValueChange={(value) =>
                                    setForm({ ...form, eventId: value })
                                }
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Pilih event" />
                                </SelectTrigger>
                                <SelectContent>
                                    {events.map((event) => (
                                        <SelectItem key={event.id} value={event.id}>
                                            {event.title}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>

                        <Field label="PIC" required>
                            <Select
                                value={form.picProfileId}
                                onValueChange={(value) =>
                                    setForm({ ...form, picProfileId: value })
                                }
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Pilih PIC" />
                                </SelectTrigger>
                                <SelectContent>
                                    {pics.map((pic) => (
                                        <SelectItem key={pic.id} value={pic.id}>
                                            {pic.displayName} · {pic.picCode}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>

                        <Field label="Tarif event % (opsional)" htmlFor="pic-assign-rate">
                            <Input
                                id="pic-assign-rate"
                                type="number"
                                min={0}
                                max={100}
                                step="0.01"
                                value={form.feeRateBp}
                                onChange={(event) =>
                                    setForm({ ...form, feeRateBp: event.currentTarget.value })
                                }
                                placeholder="mengikuti default"
                            />
                        </Field>

                        <Field label="Tipe fee (opsional)">
                            <Select
                                value={form.feeTypeOverride}
                                onValueChange={(value) =>
                                    setForm({ ...form, feeTypeOverride: value })
                                }
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={INHERIT}>Mengikuti default</SelectItem>
                                    {Object.entries(FEE_TYPE_LABEL).map(([value, label]) => (
                                        <SelectItem key={value} value={value}>
                                            {label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                    </div>

                    <div>
                        <PrimaryAction loading={busy}>
                            {busy ? "Menyimpan…" : "Tugaskan"}
                        </PrimaryAction>
                    </div>
                </form>
            </SectionCard>

            <Dialog
                open={pendingRevoke !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingRevoke(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Cabut penugasan?</DialogTitle>
                        <DialogDescription>
                            Cabut penugasan {pendingRevoke?.picName} pada event{" "}
                            {pendingRevoke?.eventTitle}? Riwayat atribusi dan fee yang sudah
                            tercatat tetap tersimpan, dan PIC tidak lagi mendapat atribusi baru
                            dari event ini.
                        </DialogDescription>
                    </DialogHeader>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPendingRevoke(null)}>
                            Batal
                        </Button>

                        <Button variant="destructive" disabled={busy} onClick={confirmRevoke}>
                            Cabut
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
