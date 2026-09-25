"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/dashboard/ui/button";

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
 * Prompts are `window.prompt` — internal operator decisions, and the same pattern the
 * refunds dashboard uses. The server still validates presence and length.
 */

type SettlementStatus =
    | "DRAFT"
    | "PENDING_APPROVAL"
    | "APPROVED"
    | "PAID"
    | "FAILED"
    | "CANCELLED";

type Action =
    | "submit"
    | "approve"
    | "proof"
    | "paid"
    | "fail"
    | "cancel";

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

    async function postJson(
        action: Action,
        body?: Record<string, unknown>
    ) {
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

            const response = await fetch(
                `/api/organizer/settlements/${settlementId}/${path}`,
                init
            );

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

    function onMarkPaid() {
        const reference = window.prompt(
            "Nomor referensi transfer bank (wajib, minimal 3 karakter):"
        );

        if (reference === null) {
            return;
        }

        if (reference.trim().length < 3) {
            setError("Nomor referensi transfer minimal 3 karakter.");
            return;
        }

        const note = window.prompt(
            "Catatan transfer (opsional — bank pengirim, tanggal, nama penerima):"
        );

        const trimmedNote = note?.trim() ?? "";

        void postJson("paid", {
            providerReference: reference.trim(),
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

        void postJson("fail", { reason: reason.trim() });
    }

    if (status !== "DRAFT" && status !== "PENDING_APPROVAL" && status !== "APPROVED") {
        return <p className="text-xs text-muted-foreground">Tidak ada tindakan tersisa.</p>;
    }

    const disabled = busy !== null || pending;

    return (
        <div className="flex flex-col items-start gap-2">
            <div className="flex flex-wrap gap-2">
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
                            onClick={onMarkPaid}
                        >
                            {busy === "paid" ? "Menyimpan…" : "Tandai dibayar"}
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
                <span className="max-w-md text-xs text-destructive">{error}</span>
            ) : null}
        </div>
    );
}