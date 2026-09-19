"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/dashboard/ui/button";

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
 * The prompts are `window.prompt` — internal operator decisions, not buyer-facing forms, and
 * one less modal to keep accessible. The server still validates length and presence, so an
 * empty prompt is refused by the API rather than reaching the database.
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

export function RefundDecisionActions({
    refundId,
    status,
}: {
    refundId: number;
    status: RefundStatus;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<
        "approve" | "reject" | "execute" | "settle" | "fail" | null
    >(null);
    const [error, setError] = useState<string | null>(null);

    async function call(
        action: "approve" | "reject" | "execute" | "settle" | "fail",
        body?: Record<string, unknown>
    ) {
        setBusy(action);
        setError(null);

        try {
            const response = await fetch(
                `/api/ticketing/refunds/${refundId}/${action}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body ?? {}),
                }
            );

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

    function onReject() {
        const reason = window.prompt(
            "Alasan penolakan refund (wajib, minimal 3 karakter):"
        );

        if (reason === null) {
            return;
        }

        if (reason.trim().length < 3) {
            setError("Alasan penolakan minimal 3 karakter.");
            return;
        }

        void call("reject", { reason: reason.trim() });
    }

    function onSettle() {
        const transferRef = window.prompt(
            "Nomor referensi transfer bank (wajib, minimal 3 karakter):"
        );

        if (transferRef === null) {
            return;
        }

        if (transferRef.trim().length < 3) {
            setError("Nomor referensi transfer minimal 3 karakter.");
            return;
        }

        const note = window.prompt(
            "Catatan bukti transfer (opsional — bank pengirim, tanggal, nama penerima):"
        );

        // A cancelled/blank note is simply omitted; the reference is the required evidence.
        const trimmedNote = note?.trim() ?? "";

        void call("settle", {
            transferRef: transferRef.trim(),
            ...(trimmedNote.length >= 3 ? { note: trimmedNote } : {}),
        });
    }

    function onFail() {
        const reason = window.prompt(
            "Alasan kegagalan transfer (wajib, minimal 3 karakter):"
        );

        if (reason === null) {
            return;
        }

        if (reason.trim().length < 3) {
            setError("Alasan kegagalan minimal 3 karakter.");
            return;
        }

        void call("fail", { reason: reason.trim() });
    }

    if (status !== "PENDING" && status !== "APPROVED" && status !== "PROCESSING") {
        return <span className="text-xs text-muted-foreground">—</span>;
    }

    const disabled = busy !== null || pending;

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
                            onClick={onReject}
                        >
                            {busy === "reject" ? "Menolak…" : "Tolak"}
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
                            onClick={onSettle}
                        >
                            {busy === "settle" ? "Menyimpan…" : "Catat transfer"}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={disabled}
                            onClick={onFail}
                        >
                            {busy === "fail" ? "Menggagalkan…" : "Gagalkan"}
                        </Button>
                    </>
                ) : null}
            </div>

            {error ? (
                <span className="max-w-56 text-right text-xs text-destructive">
                    {error}
                </span>
            ) : null}
        </div>
    );
}
