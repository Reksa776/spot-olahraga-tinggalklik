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
import { formatIdr } from "@/lib/ticketing/ui/format";
import {
    getManualTransferDefinition,
    isManualTransferInputValid,
    type ManualTransferDialogKind,
} from "./manual-transfer-dialog";
import { useManualTransferDialog } from "./use-manual-transfer-dialog";

/**
 * ==========================================
 * SETTLEMENT ACTIONS (PICO payout / settlement V1)
 * ==========================================
 *
 * The only mutating controls on the settlement detail page, and deliberately the smallest
 * set that can drive the lifecycle: each control posts to the authorized API route and
 * refreshes the server component so the page shows committed truth. It does NOT decide
 * eligibility, roles, amounts or the separation of duties — the service does all of that;
 * this component carries the click and surfaces the server's answer verbatim.
 *
 * ── THE MANUAL BANK-TRANSFER RAIL (D-P17-04 = B) ──────────────────────────────────
 * There is no outbound provider payout, so an operator makes the bank transfer and then
 * records it. Two of the three money-relevant steps are now ONE operator action:
 *
 *   DRAFT            → Ajukan persetujuan  (`settlement.prepare`)          / Batalkan
 *   PENDING_APPROVAL → Setujui             (`settlement.approve`, SoD)     / Batalkan
 *   REQUESTED        → Tolak               (`settlement.approve`, SoD, reason required)
 *                    → Approve & Bayar     ← approve → proof → paid, one dialog
 *   APPROVED         → Upload Bukti & Bayar ← proof → paid, one dialog
 *                    → Gagalkan             (releases the claim lines, with a reason)
 *
 * There is deliberately NO "tandai dibayar tanpa bukti" shortcut: a settlement may only
 * reach PAID with recorded evidence, and the combined dialog still requires the transfer
 * reference the `paid` schema has always required.
 *
 * ── WHY "APPROVE & BAYAR" IS ONE ACTION AND NOT ONE ENDPOINT ─────────────────────
 * The operator's job here is a single real-world act — "make the transfer, then record
 * it". Making them hunt for three buttons to describe one act is what this change removes.
 * What it does NOT do is collapse the BACKEND: the dialog performs exactly the three
 * existing transitions, in order, over the three existing authorized endpoints:
 *
 *      POST …/approve  →  POST …/proof (multipart)  →  POST …/paid
 *
 * Every step is still authorized and state-checked server-side by the same service the
 * separate buttons called, so `preparer ≠ approver ≠ payer` (separation of duties), the
 * tenant guard and the `APPROVED`-only proof rule all still apply — and each step is still
 * a separate, audited transition. Nothing is bypassed; only the clicking is.
 *
 * ── PARTIAL FAILURE IS SAID OUT LOUD ─────────────────────────────────────────────
 * If the approval succeeds and the upload or the payment then fails, the dialog shows the
 * server's message and the page REFRESHES to the settlement's real status — which is
 * `APPROVED`, not `PAID`. There is no optimistic success, no fake "paid" state, and no
 * cleanup that pretends the first step did not happen: an approved payout that could not be
 * completed is exactly the state the operator must see, because the next visit offers
 * "Upload Bukti & Bayar" and the transfer can be finished without re-approving.
 *
 * ── WHY `Gagalkan` SURVIVES ON AN APPROVED PAYOUT ────────────────────────────────
 * It is not a payment step, and it is the ONLY edge that releases the claimed fee lines of
 * an approved payout (the cancel edge is DRAFT/PENDING only). Removing it would permanently
 * strand a PIC's claimed fees on a settlement whose bank transfer was rejected — the PIC
 * could never re-request that money. It stays, as an outline control beside the primary
 * action, so the failure path is still reachable.
 *
 * ── WHY THE TWO EDGES THAT ASK ASK IN A DIALOG (Phase 20B) ────────────────────────
 * The rejection and the failure reason used to be `window.prompt` calls. They now open the
 * dashboard's own shadcn `Dialog` — the same surface every other dashboard mutation uses.
 * The required field, the 3-character minimum, the trimmed body, the endpoints, the
 * in-flight label and the cancellation semantics are unchanged. `Ajukan persetujuan`,
 * `Setujui`, `Batalkan` and `Tolak` need no input and fire straight from their button.
 *
 * The validation and the body of the reason-only dialogs live in `./manual-transfer-dialog`
 * (pure, tested without a DOM) and the request lives in the hook; this file decides WHICH
 * dialog an action opens and renders the copy.
 */

type SettlementStatus =
    | "DRAFT"
    | "PENDING_APPROVAL"
    | "APPROVED"
    | "PAID"
    | "FAILED"
    | "CANCELLED"
    | "REQUESTED"
    | "REJECTED";

type Action =
    | "submit"
    | "approve"
    | "reject"
    | "paid"
    | "fail"
    | "cancel"
    /** The combined approve → proof → paid run. */
    | "approvePay";

/** The actions that ask the operator something before they can proceed. */
const DIALOG_FOR: Partial<Record<Action, ManualTransferDialogKind>> = {
    fail: "settleFail",
    // PHASE 21 — refusing a PIC payout request asks for a reason the PIC will read.
    reject: "rejectPayout",
};

/** Which transition of the combined run is in flight, for the progress label. */
type PayStage = "approve" | "proof" | "paid";

const PROOF_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
const PROOF_HINT = "jpeg, png, webp, atau pdf · maksimum 5MB.";

/** Mirrors `markPaidSchema`: the reference is required and must trim to 3+ characters. */
const REFERENCE_MIN = 3;
const REFERENCE_MAX = 120;
/** Mirrors the optional-note convention the manual-transfer machine already uses. */
const NOTE_MIN = 3;
const NOTE_MAX = 2000;

/**
 * The facts the operator must be able to see before moving money, taken from the same
 * server payload the page renders. `bankAccountNumber` arrives ALREADY MASKED from
 * `buildSettlementPayload` — this dialog never receives a raw account number, and so can
 * never display one.
 */
export type SettlementPaySummary = {
    payeeName: string;
    organizerName: string | null;
    netAmount: string;
    bankName: string | null;
    bankAccountName: string | null;
    /** `••••` + last four, produced server-side. */
    bankAccountNumber: string | null;
};

function SummaryRow({
    label,
    value,
    mono,
}: {
    label: string;
    value: string;
    mono?: boolean;
}) {
    return (
        <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className={mono ? "font-mono text-sm" : "text-sm"}>{value}</span>
        </div>
    );
}

export function SettlementActions({
    settlementId,
    status,
    proofAvailable,
    summary,
}: {
    settlementId: string;
    status: SettlementStatus;
    proofAvailable: boolean;
    summary: SettlementPaySummary;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<Action | null>(null);
    const [error, setError] = useState<string | null>(null);

    // The combined Approve & Bayar / Upload Bukti & Bayar dialog.
    const [payOpen, setPayOpen] = useState(false);
    const [payStage, setPayStage] = useState<PayStage | null>(null);
    const [payFile, setPayFile] = useState<File | null>(null);
    const [payReference, setPayReference] = useState("");
    const [payNote, setPayNote] = useState("");
    const [payError, setPayError] = useState<string | null>(null);
    const [payAttempted, setPayAttempted] = useState(false);

    // The dialog hook posts its `start` effect to the same URL `postAction` uses.
    const actionUrl = (action: string) =>
        `/api/organizer/settlements/${settlementId}/${action}`;
    const dialog = useManualTransferDialog(actionUrl);

    /** A `REQUESTED` payout still needs the approval step; an `APPROVED` one does not. */
    const needsApproval = status === "REQUESTED";
    const payBusy = busy === "approvePay";
    const disabled = busy !== null || pending;

    const referenceValue = payReference.trim();
    const noteValue = payNote.trim();
    const payValid = payFile !== null && referenceValue.length >= REFERENCE_MIN;

    /**
     * One existing settlement transition over JSON. Returns the outcome instead of writing
     * to component state, so BOTH the simple buttons and the combined dialog can report the
     * server's answer in their own place.
     */
    async function postAction(
        action: string,
        body?: Record<string, unknown>
    ): Promise<{ ok: boolean; message: string | null }> {
        try {
            const response = await fetch(actionUrl(action), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body ?? {}),
            });

            const payload = await response.json().catch(() => null);

            return response.ok
                ? { ok: true, message: null }
                : {
                      ok: false,
                      message: payload?.message ?? "Tindakan settlement gagal.",
                  };
        } catch {
            return { ok: false, message: "Tidak dapat menghubungi server." };
        }
    }

    /**
     * The EXISTING proof upload — multipart to the same route, with the same server-side
     * magic-byte sniffing, size cap and `APPROVED`-only rule. No storage engine is added.
     */
    async function postProof(
        file: File
    ): Promise<{ ok: boolean; message: string | null }> {
        try {
            const formData = new FormData();
            formData.append("file", file);

            const response = await fetch(
                `/api/organizer/settlements/${settlementId}/proof`,
                { method: "POST", body: formData }
            );

            const payload = await response.json().catch(() => null);

            return response.ok
                ? { ok: true, message: null }
                : { ok: false, message: payload?.message ?? "Upload bukti gagal." };
        } catch {
            return { ok: false, message: "Tidak dapat menghubungi server." };
        }
    }

    function openPayDialog() {
        setPayOpen(true);
        setPayStage(null);
        setPayFile(null);
        setPayReference("");
        setPayNote("");
        setPayError(null);
        setPayAttempted(false);
    }

    /**
     * ONE operator action, THREE existing transitions, every one of them still authorized
     * and state-checked by the server:
     *
     *   approve → attach proof → mark paid
     *
     * `paid` is reached ONLY if the proof upload actually succeeded, so a settlement can
     * never be marked paid without recorded evidence. A refusal at any step stops the run
     * and is reported verbatim; the page then refreshes to the real status.
     */
    async function approveUploadAndPay() {
        setPayAttempted(true);
        setPayError(null);

        if (!payFile) {
            setPayError("Bukti transaksi wajib diunggah.");
            return;
        }

        if (referenceValue.length < REFERENCE_MIN) {
            setPayError(
                `Nomor referensi transfer minimal ${REFERENCE_MIN} karakter.`
            );
            return;
        }

        setBusy("approvePay");

        try {
            if (needsApproval) {
                setPayStage("approve");

                const approved = await postAction("approve");

                if (!approved.ok) {
                    setPayError(approved.message);
                    return;
                }
            }

            setPayStage("proof");

            const uploaded = await postProof(payFile);

            if (!uploaded.ok) {
                setPayError(uploaded.message);
                return;
            }

            setPayStage("paid");

            const paid = await postAction("paid", {
                providerReference: referenceValue,
                ...(noteValue.length >= NOTE_MIN ? { note: noteValue } : {}),
            });

            if (!paid.ok) {
                setPayError(paid.message);
                return;
            }

            setPayOpen(false);
        } finally {
            setBusy(null);
            setPayStage(null);
            // ALWAYS re-read committed truth. A half-finished run (approved, upload refused)
            // must show APPROVED — never the PAID the operator was hoping for.
            startTransition(() => router.refresh());
        }
    }

    /** An action with no input: post it, report a refusal, otherwise refresh. */
    async function runSimple(action: Action) {
        setBusy(action);
        setError(null);

        try {
            const result = await postAction(action);

            if (!result.ok) {
                setError(result.message);
                return;
            }

            startTransition(() => router.refresh());
        } finally {
            setBusy(null);
        }
    }

    function onAction(action: Action) {
        const kind = DIALOG_FOR[action];

        if (kind) {
            dialog.open(kind);
            return;
        }

        void runSimple(action);
    }

    if (
        status !== "DRAFT" &&
        status !== "PENDING_APPROVAL" &&
        status !== "APPROVED" &&
        status !== "REQUESTED"
    ) {
        return <p className="text-xs text-muted-foreground">Tidak ada tindakan tersisa.</p>;
    }

    const definition = dialog.state.openKind
        ? getManualTransferDefinition(dialog.state.openKind)
        : null;
    const dialogBusy = dialog.isBusy;
    const canSubmit =
        definition !== null && isManualTransferInputValid(definition, dialog.values);
    const showFieldError =
        definition !== null && dialog.state.showErrors && !canSubmit;

    const payStageLabel =
        payStage === "approve"
            ? "Menyetujui…"
            : payStage === "proof"
              ? "Mengunggah bukti…"
              : payStage === "paid"
                ? "Mencatat pembayaran…"
                : "Upload & Bayar";

    return (
        <div className="flex flex-col items-start gap-2">
            <div className="flex flex-wrap gap-2">
                {status === "REQUESTED" ? (
                    <>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={disabled}
                            onClick={() => onAction("reject")}
                        >
                            {dialog.state.openKind === "rejectPayout" && dialogBusy
                                ? "Menolak…"
                                : "Tolak"}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            disabled={disabled}
                            onClick={openPayDialog}
                        >
                            {payBusy ? "Memproses…" : "Approve & Bayar"}
                        </Button>
                    </>
                ) : null}

                {status === "DRAFT" ? (
                    <>
                        <Button
                            type="button"
                            size="sm"
                            disabled={disabled}
                            onClick={() => onAction("submit")}
                        >
                            {busy === "submit" ? "Mengajukan…" : "Ajukan persetujuan"}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={disabled}
                            onClick={() => onAction("cancel")}
                        >
                            {busy === "cancel" ? "Membatalkan…" : "Batalkan"}
                        </Button>
                    </>
                ) : null}

                {status === "PENDING_APPROVAL" ? (
                    <>
                        <Button
                            type="button"
                            size="sm"
                            disabled={disabled}
                            onClick={() => onAction("approve")}
                        >
                            {busy === "approve" ? "Menyetujui…" : "Setujui"}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={disabled}
                            onClick={() => onAction("cancel")}
                        >
                            {busy === "cancel" ? "Membatalkan…" : "Batalkan"}
                        </Button>
                    </>
                ) : null}

                {status === "APPROVED" ? (
                    <>
                        <Button
                            type="button"
                            size="sm"
                            disabled={disabled}
                            onClick={openPayDialog}
                        >
                            {payBusy ? "Memproses…" : "Upload Bukti & Bayar"}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={disabled}
                            onClick={() => onAction("fail")}
                        >
                            {dialog.state.openKind === "settleFail" && dialogBusy
                                ? "Menggagalkan…"
                                : "Gagalkan"}
                        </Button>
                    </>
                ) : null}
            </div>

            {error ? (
                <span className="max-w-md text-xs text-destructive">{error}</span>
            ) : null}

            {/* ── The combined approve → upload → pay dialog ─────────────────────── */}
            <Dialog
                open={payOpen}
                onOpenChange={(next) => {
                    if (!next && !payBusy) {
                        setPayOpen(false);
                    }
                }}
            >
                <DialogContent
                    onInteractOutside={(event) => {
                        if (payBusy) {
                            event.preventDefault();
                        }
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>
                            {needsApproval ? "Approve Pencairan" : "Upload Bukti & Bayar"}
                        </DialogTitle>
                        <DialogDescription>
                            {needsApproval
                                ? "Pencairan disetujui, bukti transfer diunggah, lalu pembayaran dicatat — satu alur. Status menjadi PAID hanya setelah bukti tersimpan dan referensi transfer tercatat."
                                : "Unggah bukti transfer lalu catat pembayarannya. Status menjadi PAID hanya setelah bukti tersimpan dan referensi transfer tercatat."}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col gap-2 rounded-field border border-input bg-card p-4">
                        <SummaryRow label="PIC" value={summary.payeeName} />
                        <SummaryRow
                            label="Penyelenggara"
                            value={summary.organizerName ?? "—"}
                        />
                        <SummaryRow
                            label="Nominal"
                            value={formatIdr(Number(summary.netAmount))}
                        />
                        <SummaryRow label="Bank" value={summary.bankName ?? "—"} />
                        {summary.bankAccountName ? (
                            <SummaryRow
                                label="Atas nama"
                                value={summary.bankAccountName}
                            />
                        ) : null}
                        <SummaryRow
                            label="Rekening"
                            value={summary.bankAccountNumber ?? "—"}
                            mono
                        />
                        <p className="text-xs text-muted-foreground">
                            Nomor rekening ditampilkan tersamarkan. Pastikan tujuan
                            transfer sesuai sebelum melanjutkan.
                        </p>
                    </div>

                    <Field
                        label="Bukti transaksi"
                        htmlFor={`settlement-proof-${settlementId}`}
                        hint={
                            proofAvailable
                                ? `${PROOF_HINT} Bukti sebelumnya akan diganti.`
                                : PROOF_HINT
                        }
                        required
                        error={
                            payAttempted && !payFile
                                ? "Bukti transaksi wajib diunggah."
                                : undefined
                        }
                    >
                        <input
                            id={`settlement-proof-${settlementId}`}
                            type="file"
                            accept={PROOF_ACCEPT}
                            disabled={payBusy}
                            onChange={(event) => {
                                setPayFile(event.target.files?.[0] ?? null);
                                setPayError(null);
                            }}
                            className="flex w-full min-w-0 rounded-field border border-input bg-card px-3 py-2 text-sm file:mr-3 file:rounded-field file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm file:font-medium disabled:cursor-not-allowed disabled:opacity-60"
                        />
                    </Field>

                    <Field
                        label="Nomor referensi transfer bank"
                        htmlFor={`settlement-paid-reference-${settlementId}`}
                        hint={`Wajib, minimal ${REFERENCE_MIN} karakter.`}
                        required
                        error={
                            payAttempted && referenceValue.length < REFERENCE_MIN
                                ? `Nomor referensi transfer minimal ${REFERENCE_MIN} karakter.`
                                : undefined
                        }
                    >
                        <Input
                            id={`settlement-paid-reference-${settlementId}`}
                            value={payReference}
                            maxLength={REFERENCE_MAX}
                            placeholder="Contoh: TRX-20260925-00456"
                            disabled={payBusy}
                            onChange={(event) => {
                                setPayReference(event.target.value);
                                setPayError(null);
                            }}
                        />
                    </Field>

                    <Field
                        label="Catatan transfer (opsional)"
                        htmlFor={`settlement-paid-note-${settlementId}`}
                        hint="Opsional — bank pengirim, tanggal, nama penerima."
                    >
                        <Textarea
                            id={`settlement-paid-note-${settlementId}`}
                            rows={3}
                            value={payNote}
                            maxLength={NOTE_MAX}
                            placeholder="Contoh: Mandiri 9876543210, 25 Sep 2026, PIC Dita"
                            disabled={payBusy}
                            onChange={(event) => {
                                setPayNote(event.target.value);
                                setPayError(null);
                            }}
                        />
                    </Field>

                    {payError ? (
                        <p className="text-sm font-medium text-destructive">{payError}</p>
                    ) : null}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={payBusy}
                            onClick={() => setPayOpen(false)}
                        >
                            Batal
                        </Button>
                        <Button
                            type="button"
                            disabled={!payValid || payBusy}
                            onClick={() => void approveUploadAndPay()}
                        >
                            {payBusy ? payStageLabel : "Upload & Bayar"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── The reason-only dialogs (reject / fail), machine-driven ────────── */}
            {definition ? (
                <Dialog
                    open
                    onOpenChange={(next) => {
                        if (!next && !dialogBusy) {
                            dialog.close();
                        }
                    }}
                >
                    <DialogContent
                        onInteractOutside={(event) => {
                            if (dialogBusy) {
                                event.preventDefault();
                            }
                        }}
                    >
                        <DialogHeader>
                            <DialogTitle>{definition.title}</DialogTitle>
                            <DialogDescription>
                                {definition.description}
                            </DialogDescription>
                        </DialogHeader>

                        {definition.fields.includes("reason") ? (
                            <Field
                                label={definition.labels.reason}
                                htmlFor={`settlement-reason-${settlementId}`}
                                hint={definition.hints.reason}
                                required
                                error={
                                    showFieldError
                                        ? definition.errors.reason
                                        : undefined
                                }
                            >
                                <Textarea
                                    id={`settlement-reason-${settlementId}`}
                                    rows={3}
                                    value={dialog.values.reason ?? ""}
                                    placeholder={definition.placeholders.reason}
                                    maxLength={definition.maxLengths.reason}
                                    disabled={dialogBusy}
                                    onChange={(event) =>
                                        dialog.change("reason", event.target.value)
                                    }
                                />
                            </Field>
                        ) : null}

                        {dialog.state.error ? (
                            <p className="text-sm font-medium text-destructive">
                                {dialog.state.error}
                            </p>
                        ) : null}

                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                disabled={dialogBusy}
                                onClick={dialog.close}
                            >
                                Batal
                            </Button>
                            <Button
                                type="button"
                                variant={
                                    definition.destructive ? "destructive" : "default"
                                }
                                disabled={dialogBusy || !canSubmit}
                                onClick={dialog.submit}
                            >
                                {dialogBusy ? "Menyimpan…" : definition.confirmLabel}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            ) : null}
        </div>
    );
}
