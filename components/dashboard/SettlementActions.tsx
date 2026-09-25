"use client";

import { useRef, useState, useTransition } from "react";
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
 * records it. The lifecycle therefore offers one control per edge:
 *
 *   DRAFT            → Ajukan persetujuan  (`settlement.prepare`)     / Batalkan
 *   PENDING_APPROVAL → Setujui             (`settlement.approve`, SoD vs preparer) / Batalkan
 *   APPROVED         → [upload bukti]      (`settlement.proof.upload`, replaces old)
 *                    → Tandai dibayar      (`settlement.approve` + proof access; REQUIRES
 *                                           a transfer reference; the ONLY money-moving edge)
 *                    → Gagalkan            (releases the claim lines, with a reason)
 *
 * There is deliberately NO "tandai dibayar tanpa bukti" shortcut: a settlement may only
 * reach PAID with recorded evidence. Approval is shown even to the person who prepared the
 * payout — they will receive a `FORBIDDEN` answer (SoD) rather than a hidden button,
 * exactly like the refunds dashboard.
 *
 * ── WHY THE TWO EDGES THAT ASK ASK IN A DIALOG (Phase 20B) ────────────────────────
 * `Tandai dibayar` (a transfer reference plus an optional note) and `Gagalkan` (a reason)
 * used to chain `window.prompt` calls. They now open the dashboard's own shadcn `Dialog` —
 * the same surface every other dashboard mutation uses. What did not change: the required
 * field, the 3-character minimum before a request is made, the trimmed body, the endpoints,
 * the in-flight label, and the cancellation (a cancelled dialog sends nothing, exactly as a
 * cancelled prompt did). `Ajukan persetujuan`, `Setujui` and `Batalkan` need no input and
 * therefore still fire straight from their button, and the proof upload is still a file
 * input, not a prompt.
 *
 * The validation and the body live in `./manual-transfer-dialog` (pure, tested without a
 * DOM); the request lives in the hook; this file only decides WHICH dialog an action opens
 * and renders the copy. The server still validates presence and length.
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
    | "proof"
    | "paid"
    | "fail"
    | "cancel";

/** The actions that ask the operator something before they can proceed. */
const DIALOG_FOR: Partial<Record<Action, ManualTransferDialogKind>> = {
    paid: "paid",
    fail: "settleFail",
    // PHASE 21 — refusing a PIC payout request asks for a reason the PIC will read.
    reject: "rejectPayout",
};

export function SettlementActions({
    settlementId,
    status,
    proofAvailable,
}: {
    settlementId: string;
    status: SettlementStatus;
    proofAvailable: boolean;
}) {
    const router = useRouter();
    const fileInput = useRef<HTMLInputElement>(null);
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<Action | null>(null);
    const [error, setError] = useState<string | null>(null);

    // The dialog hook posts its `start` effect to the same URL `postJson` uses; the
    // `proof` action is never a dialog action, so it never takes this path.
    const actionUrl = (action: string) =>
        `/api/organizer/settlements/${settlementId}/${action}`;
    const dialog = useManualTransferDialog(actionUrl);

    async function postJson(action: Action, body?: Record<string, unknown>) {
        setBusy(action);
        setError(null);

        try {
            const path = action === "proof" ? "proof" : action;
            const headers: Record<string, string> = {};

            if (action !== "proof") {
                headers["Content-Type"] = "application/json";
            }

            const init: RequestInit = { method: "POST", headers };

            if (action !== "proof") {
                init.body = JSON.stringify(body ?? {});
            }

            const response = await fetch(actionUrl(path), init);

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                setError(payload?.message ?? "Tindakan settlement gagal.");
                return;
            }

            startTransition(() => router.refresh());
        } catch {
            setError("Tidak dapat menghubungi server.");
        } finally {
            setBusy(null);
        }
    }

    async function uploadProof(file: File) {
        const formData = new FormData();
        formData.append("file", file);

        setBusy("proof");
        setError(null);

        try {
            const response = await fetch(
                `/api/organizer/settlements/${settlementId}/proof`,
                { method: "POST", body: formData }
            );

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                setError(payload?.message ?? "Upload bukti gagal.");
                return;
            }

            if (fileInput.current) {
                fileInput.current.value = "";
            }

            startTransition(() => router.refresh());
        } catch {
            setError("Tidak dapat menghubungi server.");
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

        void postJson(action);
    }

    if (
        status !== "DRAFT" &&
        status !== "PENDING_APPROVAL" &&
        status !== "APPROVED" &&
        status !== "REQUESTED"
    ) {
        return <p className="text-xs text-muted-foreground">Tidak ada tindakan tersisa.</p>;
    }

    const disabled = busy !== null || pending;
    const definition = dialog.state.openKind
        ? getManualTransferDefinition(dialog.state.openKind)
        : null;
    const dialogBusy = dialog.isBusy;
    const canSubmit =
        definition !== null && isManualTransferInputValid(definition, dialog.values);
    const showFieldError =
        definition !== null && dialog.state.showErrors && !canSubmit;

    return (
        <div className="flex flex-col items-start gap-2">
            <div className="flex flex-wrap gap-2">
                {status === "REQUESTED" ? (
                    <>
                        <Button
                            type="button"
                            size="sm"
                            disabled={disabled}
                            onClick={() => void postJson("approve")}
                        >
                            {busy === "approve" ? "Menyetujui…" : "Setujui"}
                        </Button>
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
                    </>
                ) : null}

                {status === "DRAFT" ? (
                    <>
                        <Button
                            type="button"
                            size="sm"
                            disabled={disabled}
                            onClick={() => void postJson("submit")}
                        >
                            {busy === "submit" ? "Mengajukan…" : "Ajukan persetujuan"}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={disabled}
                            onClick={() => void postJson("cancel")}
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
                            onClick={() => void postJson("approve")}
                        >
                            {busy === "approve" ? "Menyetujui…" : "Setujui"}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={disabled}
                            onClick={() => void postJson("cancel")}
                        >
                            {busy === "cancel" ? "Membatalkan…" : "Batalkan"}
                        </Button>
                    </>
                ) : null}

                {status === "APPROVED" ? (
                    <>
                        <input
                            ref={fileInput}
                            type="file"
                            accept="image/jpeg,image/png,image/webp,application/pdf"
                            className="sr-only"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) {
                                    void uploadProof(file);
                                }
                            }}
                        />
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={disabled}
                            onClick={() => fileInput.current?.click()}
                        >
                            {busy === "proof"
                                ? "Menyimpan…"
                                : proofAvailable
                                  ? "Ganti bukti transfer"
                                  : "Upload bukti transfer"}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            disabled={disabled}
                            onClick={() => onAction("paid")}
                        >
                            {dialog.state.openKind === "paid" && dialogBusy
                                ? "Menyimpan…"
                                : "Tandai dibayar"}
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

                        {definition.fields.includes("reference") ? (
                            <Field
                                label={definition.labels.reference}
                                htmlFor={`settlement-reference-${settlementId}`}
                                hint={definition.hints.reference}
                                required
                                error={
                                    showFieldError
                                        ? definition.errors.reference
                                        : undefined
                                }
                            >
                                <Input
                                    id={`settlement-reference-${settlementId}`}
                                    value={dialog.values.reference ?? ""}
                                    placeholder={definition.placeholders.reference}
                                    maxLength={definition.maxLengths.reference}
                                    disabled={dialogBusy}
                                    onChange={(event) =>
                                        dialog.change("reference", event.target.value)
                                    }
                                />
                            </Field>
                        ) : null}

                        {definition.fields.includes("note") ? (
                            <Field
                                label={definition.labels.note}
                                htmlFor={`settlement-note-${settlementId}`}
                                hint={definition.hints.note}
                                error={
                                    showFieldError
                                        ? definition.errors.note
                                        : undefined
                                }
                            >
                                <Textarea
                                    id={`settlement-note-${settlementId}`}
                                    rows={3}
                                    value={dialog.values.note ?? ""}
                                    placeholder={definition.placeholders.note}
                                    maxLength={definition.maxLengths.note}
                                    disabled={dialogBusy}
                                    onChange={(event) =>
                                        dialog.change("note", event.target.value)
                                    }
                                />
                            </Field>
                        ) : null}

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
                                variant={definition.destructive ? "destructive" : "default"}
                                disabled={dialogBusy || !canSubmit}
                                onClick={dialog.submit}
                            >
                                {dialogBusy
                                    ? "Menyimpan…"
                                    : definition.confirmLabel}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            ) : null}
        </div>
    );
}
