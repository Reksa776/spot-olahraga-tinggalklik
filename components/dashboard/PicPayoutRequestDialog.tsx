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
import { StatusBadge } from "@/components/dashboard/primitives";
import type { SettleableOrganizer } from "@/lib/pic/payout";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * ==========================================
 * PIC PAYOUT REQUEST DIALOG (PHASE 21 + PAYOUT BANK CONSOLIDATION)
 * ==========================================
 *
 * The ONE control that lets a PIC initiate their own payout: pick the tenant, read the
 * settleable amount, CONFIRM THE BANK DESTINATION, and submit. It is deliberately a dialog on
 * the existing dashboard `Dialog` primitive — no `window.prompt/confirm/alert` anywhere,
 * matching every other dashboard mutation.
 *
 * ── WHAT THE COMPONENT DECIDES, AND WHAT IT DOES NOT ─────────────────────────────
 * It decides NOTHING about money. The amount is not an input: it is the server's own
 * `settleableNet` for the chosen tenant, rendered read-only. The body it posts is
 * `{ organizerId, notes?, bank? }` and nothing else — no amount, no status, no
 * `picProfileId`. The service derives the claim from the PIC's ledger and lands it as
 * `REQUESTED`; the operator reviews it. A server refusal is surfaced verbatim.
 *
 * The organizer list contains only tenants where the PIC has a POSITIVE settleable
 * amount, so the PIC can never pick a tenant they did not earn in.
 *
 * ── WHY THE BANK FIELDS LIVE HERE ────────────────────────────────────────────────
 * A payout cannot be snapshotted without a complete destination, and until this dialog
 * existed there was NO way for a PIC to supply one — bank data could only be written by an
 * ADMIN API call at profile creation, so in practice every PIC hit `BANK_DETAILS_MISSING`
 * and could never be paid. Requiring a separate "settings" trip to fix that is what the
 * owner rejected; consolidating it into the request keeps ONE surface and ONE submit.
 *
 * The three fields are pre-filled from the PIC's own profile when it has them, so CASE A
 * ("already complete → review and maybe edit") and CASE B ("incomplete → fill it in here")
 * are the same control. They are submitted only as a COMPLETE block: a half-filled
 * destination is never sent, because the money engine refuses one anyway and storing half a
 * bank account would be worse than storing none.
 *
 * ── THE RAW ACCOUNT NUMBER IS VISIBLE, AND ONLY HERE ─────────────────────────────
 * This is the single PIC-owner surface where the account number is rendered in full, and it
 * has to be: a masked value cannot be corrected, and the PIC must be able to verify exactly
 * which account their money goes to. Everywhere else it stays masked (`maskAccountNumber`):
 * the payout history below this dialog, the operator settlement views and the admin PIC
 * detail page. The value arrives from the own-scope `getMyPicProfile` read, which is
 * identity-gated to the session owner — so this is the same party who can change it, not a
 * disclosure to anyone else. It is never logged, never sent in a URL and never audited
 * verbatim.
 *
 * ── WHAT IT DELIBERATELY DOES NOT EXPLAIN AWAY ───────────────────────────────────
 * An edit here does NOT rewrite a payout that is already `REQUESTED`/`APPROVED`: the
 * `Settlement` row holds its own immutable snapshot and the operator pays THAT account. The
 * dialog says so, because the alternative is a PIC believing they redirected a payout that
 * is already in the operator's queue.
 */

/** The PIC's own stored destination, as returned by the owner-scope profile read. */
export type PicPayoutBankProfile = {
    bankName: string | null;
    bankAccountName: string | null;
    bankAccountNumber: string | null;
    /** True only when all three are present — the same all-or-nothing rule the engine enforces. */
    bankDetailsComplete: boolean;
};

/** The status copy the PIC reads after a successful submit. */
const REQUESTED_LABEL = "Menunggu Persetujuan";

/** Copy for the two places an incomplete destination is reported (notice + server refusal). */
const BANK_INCOMPLETE_MESSAGE =
    "Data rekening belum lengkap. Lengkapi data rekening terlebih dahulu.";

export function PicPayoutRequestDialog({
    organizers,
    bank,
}: {
    organizers: SettleableOrganizer[];
    bank: PicPayoutBankProfile;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<{
        status: string;
        netAmount: string | null;
        organizerName: string | null;
    } | null>(null);
    const [organizerId, setOrganizerId] = useState("");
    const [notes, setNotes] = useState("");
    const [bankName, setBankName] = useState(bank.bankName ?? "");
    const [bankAccountName, setBankAccountName] = useState(bank.bankAccountName ?? "");
    const [bankAccountNumber, setBankAccountNumber] = useState(
        bank.bankAccountNumber ?? ""
    );

    const hasOptions = organizers.length > 0;
    const selected =
        organizers.find((organizer) => organizer.organizerId === organizerId) ?? null;

    const trimmedBank = {
        bankName: bankName.trim(),
        bankAccountName: bankAccountName.trim(),
        bankAccountNumber: bankAccountNumber.trim(),
    };

    const bankComplete = Boolean(
        trimmedBank.bankName &&
            trimmedBank.bankAccountName &&
            trimmedBank.bankAccountNumber
    );

    /* The profile's own completeness drives the pre-submit notice; the form's current state
       drives the guard, so clearing a field cannot post an incomplete destination. */
    const showIncompleteNotice = !bank.bankDetailsComplete || !bankComplete;

    /** Re-read the profile's values each time the dialog opens (a refresh may have changed them). */
    function openDialog() {
        setError(null);
        setSuccess(null);
        setBankName(bank.bankName ?? "");
        setBankAccountName(bank.bankAccountName ?? "");
        setBankAccountNumber(bank.bankAccountNumber ?? "");
        setOpen(true);
    }

    function onSubmit() {
        setError(null);

        if (!organizerId) {
            setError("Pilih penyelenggara terlebih dahulu.");
            return;
        }

        if (!bankComplete) {
            setError(BANK_INCOMPLETE_MESSAGE);
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
                        bank: trimmedBank,
                    }),
                });

                const payload = await response.json().catch(() => null);

                if (!response.ok) {
                    // The engine's own refusal is mapped to the actionable copy; everything
                    // else (claim collision, contention, tenant with nothing left) is shown
                    // exactly as the server worded it.
                    const reason = payload?.details?.reason;

                    setError(
                        reason === "BANK_DETAILS_MISSING"
                            ? BANK_INCOMPLETE_MESSAGE
                            : (payload?.message ?? "Gagal mengajukan pencairan.")
                    );
                    return;
                }

                setSuccess({
                    status: payload?.data?.status ?? "REQUESTED",
                    netAmount: payload?.data?.netAmount ?? null,
                    organizerName: payload?.data?.organizerName ?? null,
                });
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
                onClick={openDialog}
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
                            Pilih penyelenggara tujuan, lalu lengkapi data rekening. Jumlah
                            yang diajukan dihitung server dari fee yang belum dicairkan pada
                            penyelenggara itu — nominal tidak dapat diketik. Penyelenggara
                            akan meninjau permintaan ini sebelum transfer manual dilakukan.
                        </DialogDescription>
                    </DialogHeader>

                    {success ? (
                        <div className="flex flex-col gap-3">
                            <p className="text-sm font-medium text-foreground">
                                Pengajuan pencairan berhasil dibuat.
                            </p>
                            <div className="flex flex-col gap-1 rounded-field border border-input bg-card p-3">
                                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    Status
                                </span>
                                <span className="flex items-center gap-2">
                                    <StatusBadge tone="pending">
                                        {REQUESTED_LABEL}
                                    </StatusBadge>
                                    {success.netAmount ? (
                                        <span className="text-sm tabular-nums text-muted-foreground">
                                            {formatIdr(Number(success.netAmount))}
                                            {success.organizerName
                                                ? ` · ${success.organizerName}`
                                                : ""}
                                        </span>
                                    ) : null}
                                </span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Penyelenggara akan meninjau permintaan ini. Status akan
                                berubah setelah ditinjau, dan pencairan selesai hanya
                                setelah bukti transfer dicatat.
                            </p>

                            <DialogFooter>
                                <Button
                                    type="button"
                                    disabled={pending}
                                    onClick={() => setOpen(false)}
                                >
                                    Tutup
                                </Button>
                            </DialogFooter>
                        </div>
                    ) : (
                        <>
                            <Field
                                label="Penyelenggara"
                                htmlFor="pic-payout-organizer"
                                required
                            >
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
                                                {formatIdr(
                                                    Number(organizer.settleableNet)
                                                )}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>

                            <Field
                                label="Saldo yang dapat dicairkan"
                                htmlFor="pic-payout-amount"
                                hint="Dihitung server dari fee yang dapat dicairkan. Nominal tidak dapat diketik."
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

                            <div className="flex flex-col gap-4 rounded-field border border-input bg-card p-4">
                                <div className="flex flex-col gap-1">
                                    <p className="text-sm font-semibold text-foreground">
                                        Data Rekening
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        Rekening tujuan transfer. Data disimpan di profil
                                        PIC kamu dan disalin ke setiap pencairan saat
                                        diajukan.
                                    </p>
                                </div>

                                {showIncompleteNotice ? (
                                    <p className="rounded-field border border-dashed border-input bg-muted/40 p-3 text-xs font-medium text-foreground">
                                        Data rekening belum lengkap. Lengkapi data
                                        rekening untuk mengajukan pencairan.
                                    </p>
                                ) : null}

                                <Field
                                    label="Nama Bank"
                                    htmlFor="pic-payout-bank-name"
                                    required
                                >
                                    <Input
                                        id="pic-payout-bank-name"
                                        value={bankName}
                                        maxLength={64}
                                        placeholder="Contoh: BCA"
                                        disabled={busy}
                                        onChange={(event) =>
                                            setBankName(event.target.value)
                                        }
                                    />
                                </Field>

                                <Field
                                    label="Nama Pemilik Rekening"
                                    htmlFor="pic-payout-bank-account-name"
                                    required
                                >
                                    <Input
                                        id="pic-payout-bank-account-name"
                                        value={bankAccountName}
                                        maxLength={64}
                                        placeholder="Nama sesuai rekening"
                                        disabled={busy}
                                        onChange={(event) =>
                                            setBankAccountName(event.target.value)
                                        }
                                    />
                                </Field>

                                <Field
                                    label="Nomor Rekening"
                                    htmlFor="pic-payout-bank-account-number"
                                    required
                                    hint="Hanya kamu yang dapat melihat nomor ini secara lengkap. Penyelenggara melihat 4 digit terakhir."
                                >
                                    <Input
                                        id="pic-payout-bank-account-number"
                                        value={bankAccountNumber}
                                        maxLength={64}
                                        inputMode="numeric"
                                        placeholder="Nomor rekening"
                                        disabled={busy}
                                        onChange={(event) =>
                                            setBankAccountNumber(event.target.value)
                                        }
                                    />
                                </Field>

                                <p className="text-xs text-muted-foreground">
                                    Perubahan rekening tidak mengubah pengajuan yang
                                    sudah dibuat — pencairan yang sedang ditinjau tetap
                                    memakai rekening yang tersalin saat pengajuan itu
                                    dibuat.
                                </p>
                            </div>

                            <Field
                                label="Catatan (opsional)"
                                htmlFor="pic-payout-notes"
                                hint="Misalnya informasi tambahan untuk penyelenggara."
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
                                <p className="text-sm font-medium text-destructive">
                                    {error}
                                </p>
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
                                    {busy ? "Memproses..." : "Ajukan Pencairan"}
                                </Button>
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
