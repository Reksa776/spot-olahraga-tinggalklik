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
    getManualTransferDefinition,
    isManualTransferInputValid,
    type ManualTransferDialogKind,
} from "./manual-transfer-dialog";
import { useManualTransferDialog } from "./use-manual-transfer-dialog";

/**
 * ==========================================
 * REFUND DECISION ACTIONS (Phase 10B, re-scoped by Phase 18B)
 * ==========================================
 *
 * The only mutating control on the refunds dashboard, and deliberately the smallest one that
 * can work: it posts to the authorized API routes and then refreshes the server component so
 * the table shows committed truth. It does NOT decide eligibility, roles or amounts — the
 * service does all of that, and this component's whole job is to carry the click and surface
 * the server's answer verbatim.
 *
 * Separation of duties is enforced server-side, so a requester who also opens the dashboard
 * gets a `FORBIDDEN` answer rather than a hidden button: hiding the button would be a lie
 * about the control, while the 403 is the control stating itself.
 *
 * ── THE MANUAL BANK-TRANSFER RAIL (Phase 18B, D-P17-04 = B) ──────────────────────
 * There is no outbound provider refund, so an operator makes the transfer and then records
 * it. That produces three distinct controls, one per lifecycle edge:
 *
 *   PENDING    → Setujui / Tolak        (`refund.approve`, a reason is required to reject)
 *   APPROVED   → Mulai proses           (`refund.execute`; claims the refund for processing
 *                                        and moves no money)
 *   PROCESSING → Catat transfer         (`refund.settle`; REQUIRES a transfer reference, and
 *                                        is the only action that can move money)
 *              → Gagalkan               (`refund.fail`; a reason is required)
 *
 * ── WHY THESE THREE ASK IN A DIALOG (Phase 20B) ───────────────────────────────────
 * `Tolak`, `Catat transfer` and `Gagalkan` used to chain `window.prompt` calls. They now
 * open the dashboard's own shadcn `Dialog` — the same confirmation surface every other
 * dashboard mutation uses, and the one its header declares to be the ONLY such surface. What
 * did not change: the same fields (a required transfer reference or reason, an optional
 * evidence note), the same 3-character minimum before the request is made, the same trimmed
 * body (`note` rides along only when it is 3+ characters), the same endpoints, the same
 * in-flight label, and the same cancellation: a cancelled dialog sends nothing, exactly as a
 * cancelled prompt did.
 *
 * The validation and the body live in `./manual-transfer-dialog` (pure, tested without a
 * DOM); the request lives in the hook; this file only decides WHICH dialog an action opens
 * and renders the copy. The server still validates length and presence, so a client that
 * ignores the rules is refused by the API rather than reaching the database.
 *
 * This component deliberately does not show a "mark as refunded" shortcut: a refund can only
 * become REFUNDED with evidence, and there is no UI path around that.
 */

type RefundStatus =
    | "PENDING"
    | "APPROVED"
    | "REJECTED"
    | "PROCESSING"
    | "REFUNDED"
    | "FAILED";

type Action = "approve" | "reject" | "execute" | "settle" | "fail";

/** The actions that ask the operator something before they can proceed. */
const DIALOG_FOR: Partial<Record<Action, ManualTransferDialogKind>> = {
    reject: "reject",
    settle: "settle",
    fail: "fail",
};

export function RefundDecisionActions({
    refundId,
    status,
}: {
    refundId: number;
    status: RefundStatus;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<Action | null>(null);
    const [error, setError] = useState<string | null>(null);

    // One URL builder for the whole component: the dialog hook posts its `start` effect to
    // `/api/ticketing/refunds/<id>/<action>`, and `call` posts the no-input actions to the
    // same place.
    const actionUrl = (action: string) => `/api/ticketing/refunds/${refundId}/${action}`;
    const dialog = useManualTransferDialog(actionUrl);

    async function call(action: Action, body?: Record<string, unknown>) {
        setBusy(action);
        setError(null);

        try {
            const response = await fetch(actionUrl(action), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body ?? {}),
            });

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                setError(payload?.message ?? "Tindakan refund gagal.");
                return;
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

        void call(action);
    }

    if (status !== "PENDING" && status !== "APPROVED" && status !== "PROCESSING") {
        return <span className="text-xs text-muted-foreground">—</span>;
    }

    const disabled = busy !== null || pending;
    const definition = dialog.state.openKind
        ? getManualTransferDefinition(dialog.state.openKind)
        : null;
    const dialogBusy = dialog.isBusy;
    const canSubmit =
        definition !== null && isManualTransferInputValid(definition, dialog.values);
    // An invalid value is only called out once the operator has typed it or pressed the
    // confirm button — an untouched, empty dialog is not scolding anyone.
    const showFieldError =
        definition !== null && dialog.state.showErrors && !canSubmit;

    return (
        <div className="flex flex-col items-end gap-1">
            <div className="flex flex-wrap justify-end gap-2">
                {status === "PENDING" ? (
                    <>
                        <Button
                            type="button"
                            size="sm"
                            disabled={disabled}
                            onClick={() => void call("approve")}
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
                            {dialog.state.openKind === "reject" && dialogBusy
                                ? "Menolak…"
                                : "Tolak"}
                        </Button>
                    </>
                ) : null}

                {status === "APPROVED" ? (
                    <Button
                        type="button"
                        size="sm"
                        disabled={disabled}
                        onClick={() => void call("execute")}
                    >
                        {busy === "execute" ? "Memproses…" : "Mulai proses"}
                    </Button>
                ) : null}

                {status === "PROCESSING" ? (
                    <>
                        <Button
                            type="button"
                            size="sm"
                            disabled={disabled}
                            onClick={() => onAction("settle")}
                        >
                            {dialog.state.openKind === "settle" && dialogBusy
                                ? "Menyimpan…"
                                : "Catat transfer"}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={disabled}
                            onClick={() => onAction("fail")}
                        >
                            {dialog.state.openKind === "fail" && dialogBusy
                                ? "Menggagalkan…"
                                : "Gagalkan"}
                        </Button>
                    </>
                ) : null}
            </div>

            {error ? (
                <span className="max-w-56 text-right text-xs text-destructive">
                    {error}
                </span>
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
                                htmlFor={`refund-reference-${refundId}`}
                                hint={definition.hints.reference}
                                required
                                error={
                                    showFieldError
                                        ? definition.errors.reference
                                        : undefined
                                }
                            >
                                <Input
                                    id={`refund-reference-${refundId}`}
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
                                htmlFor={`refund-note-${refundId}`}
                                hint={definition.hints.note}
                                error={
                                    showFieldError
                                        ? definition.errors.note
                                        : undefined
                                }
                            >
                                <Textarea
                                    id={`refund-note-${refundId}`}
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
                                htmlFor={`refund-reason-${refundId}`}
                                hint={definition.hints.reason}
                                required
                                error={
                                    showFieldError
                                        ? definition.errors.reason
                                        : undefined
                                }
                            >
                                <Textarea
                                    id={`refund-reason-${refundId}`}
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
