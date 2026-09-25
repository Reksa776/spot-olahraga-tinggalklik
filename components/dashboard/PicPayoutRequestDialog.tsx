"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/dashboard/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/dashboard/ui/dialog";
import { Field, Input, Textarea } from "@/components/dashboard/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/dashboard/ui/select";
import type { SettleableOrganizer } from "@/lib/pic/payout";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * ==========================================
 * PIC PAYOUT REQUEST DIALOG (PHASE 21)
 * ==========================================
 *
 * The ONE control that lets a PIC initiate their own payout: pick the tenant, read the
 * settleable amount, confirm. It is deliberately a dialog on the existing dashboard
 * `Dialog` primitive — no `window.prompt/confirm/alert` anywhere, matching every other
 * dashboard mutation.
 *
 * ── WHAT THE COMPONENT DECIDES, AND WHAT IT DOES NOT ─────────────────────────────
 * It decides NOTHING about money. The amount is not an input: it is the server's own
 * `settleableNet` for the chosen tenant, rendered read-only. The body it posts is
 * `{ organizerId, notes? }` and nothing else — no amount, no status, no bank, no
 * `picProfileId`. The service derives the claim from the PIC's ledger and lands it as
 * `REQUESTED`; the operator reviews it. A server refusal is surfaced verbatim.
 *
 * The organizer list contains only tenants where the PIC has a POSITIVE settleable
 * amount, so the PIC can never pick a tenant they did not earn in.
 */

export function PicPayoutRequestDialog({
    organizers,
}: {
    organizers: SettleableOrganizer[];
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [organizerId, setOrganizerId] = useState("");
    const [notes, setNotes] = useState("");

    const hasOptions = organizers.length > 0;
    const selected =
        organizers.find((organizer) => organizer.organizerId === organizerId) ?? null;

    function onSubmit() {
        setError(null);

        if (!organizerId) {
            setError("Pilih penyelenggara terlebih dahulu.");
            return;
        }

        setBusy(true);

        void (async () => {
            try {
                const response = await fetch("/api/pic/payouts", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        organizerId,
                        ...(notes.trim() ? { notes: notes.trim() } : {}),
                    }),
                });

                const payload = await response.json().catch(() => null);

                if (!response.ok) {
                    setError(payload?.message ?? "Gagal mengajukan pencairan.");
                    return;
                }

                setOpen(false);
                setOrganizerId("");
                setNotes("");
                startTransition(() => router.refresh());
            } catch {
                setError("Tidak dapat menghubungi server.");
            } finally {
                setBusy(false);
            }
        })();
    }

    return (
        <>
            <Button
                type="button"
                size="sm"
                disabled={!hasOptions}
                onClick={() => {
                    setError(null);
                    setOpen(true);
                }}
            >
                Ajukan Pencairan
            </Button>

            <Dialog
                open={open}
                onOpenChange={(next) => {
                    if (!next && !busy) {
                        setOpen(false);
                    }
                }}
            >
                <DialogContent
                    onInteractOutside={(event) => {
                        if (busy) {
                            event.preventDefault();
                        }
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Ajukan pencairan fee</DialogTitle>
                        <DialogDescription>
                            Pilih penyelenggara tujuan. Jumlah yang diajukan dihitung
                            server dari fee yang belum dicairkan pada penyelenggara itu —
                            nominal tidak dapat diketik. Penyelenggara akan meninjau
                            permintaan ini sebelum transfer manual dilakukan.
                        </DialogDescription>
                    </DialogHeader>

                    <Field label="Penyelenggara" htmlFor="pic-payout-organizer" required>
                        <Select
                            value={organizerId}
                            onValueChange={(value) => setOrganizerId(value)}
                        >
                            <SelectTrigger id="pic-payout-organizer">
                                <SelectValue placeholder="Pilih penyelenggara" />
                            </SelectTrigger>
                            <SelectContent>
                                {organizers.map((organizer) => (
                                    <SelectItem
                                        key={organizer.organizerId}
                                        value={organizer.organizerId}
                                    >
                                        {organizer.organizerName} ·{" "}
                                        {formatIdr(Number(organizer.settleableNet))}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>

                    <Field
                        label="Jumlah diajukan"
                        htmlFor="pic-payout-amount"
                        hint="Dihitung server dari fee yang dapat dicairkan."
                    >
                        <Input
                            id="pic-payout-amount"
                            value={
                                selected
                                    ? formatIdr(Number(selected.settleableNet))
                                    : "—"
                            }
                            readOnly
                            disabled
                        />
                    </Field>

                    <Field
                        label="Catatan (opsional)"
                        htmlFor="pic-payout-notes"
                        hint="Misalnya informasi rekening atau catatan untuk penyelenggara."
                    >
                        <Textarea
                            id="pic-payout-notes"
                            rows={3}
                            value={notes}
                            maxLength={2000}
                            placeholder="Catatan untuk penyelenggara (opsional)"
                            disabled={busy}
                            onChange={(event) => setNotes(event.target.value)}
                        />
                    </Field>

                    {error ? (
                        <p className="text-sm font-medium text-destructive">{error}</p>
                    ) : null}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={busy}
                            onClick={() => setOpen(false)}
                        >
                            Batal
                        </Button>
                        <Button
                            type="button"
                            disabled={busy || pending || !organizerId}
                            onClick={onSubmit}
                        >
                            {busy ? "Mengajukan…" : "Ajukan Pencairan"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
