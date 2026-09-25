"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/dashboard/ui/button";

/**
 * ==========================================
 * REFUND TRANSFER-EVIDENCE (FILE) — STAFF CONTROL
 * ==========================================
 *
 * The operator-facing half of the refund-evidence rail. It reuses the routes that already
 * exist and adds no second storage or delivery mechanism:
 *
 *   * ATTACH — a file input POSTs multipart to
 *     `/api/organizer/refunds/[refundId]/evidence`, whose service re-checks the refund's OWN
 *     tenant, `REFUND_EXECUTE`, separation of duties (a requester never attaches the evidence
 *     for their own request), magic-sniffs the bytes and pins the key with a CAS. Nothing is
 *     settled here; `settleRefund` remains the only path to `REFUNDED`.
 *   * VIEW — a plain anchor to
 *     `/api/organizer/refunds/[refundId]/evidence/[fileName]`, the same authenticated route,
 *     so the bytes are delivered by that handler and never by this component.
 *
 * ── WHAT IT DECIDES, AND WHAT IT DOES NOT ─────────────────────────────────────────
 * It decides only WHICH control to show (attach while the refund is still open, view
 * whenever a file is attached). It does not decide a status, an amount, a role or a legal
 * transition: the API answers all of that, and the server's message is surfaced verbatim.
 * There is no "mark as refunded" affordance, because a refund can only reach `REFUNDED`
 * through `settleRefund` with recorded evidence.
 *
 * The parent supplies `evidenceUrl`, which the SERVER built from the refund row
 * (`refundStaffEvidenceUrl`), so this component never assembles a storage path from a key.
 * A second click while an upload is in flight starts nothing (the `busy` guard), and the
 * dialog-free surface keeps the "no native browser dialog" contract this board already
 * holds.
 */

/** Statuses in which an operator may still attach or replace the transfer evidence. */
const ATTACHABLE = new Set(["PENDING", "APPROVED", "PROCESSING"]);

export function RefundEvidenceActions({
    refundId,
    status,
    evidenceUrl,
}: {
    refundId: number;
    status: string;
    /** Server-built staff href for the attached file, or `null` when there is none. */
    evidenceUrl: string | null;
}) {
    const router = useRouter();
    const fileInput = useRef<HTMLInputElement>(null);
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canAttach = ATTACHABLE.has(status);

    async function upload(file: File) {
        // A second click (or a second `change`) while the request is in flight starts nothing.
        if (busy) {
            return;
        }

        const formData = new FormData();
        formData.append("file", file);

        setBusy(true);
        setError(null);

        try {
            const response = await fetch(
                `/api/organizer/refunds/${refundId}/evidence`,
                { method: "POST", body: formData }
            );

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                // The server's answer, verbatim — this component never invents a message.
                setError(payload?.message ?? "Upload bukti transfer gagal.");
                return;
            }

            if (fileInput.current) {
                fileInput.current.value = "";
            }

            startTransition(() => router.refresh());
        } catch {
            setError("Tidak dapat menghubungi server.");
        } finally {
            setBusy(false);
        }
    }

    // A settled/failed refund with no attached file has nothing to show; an attached file is
    // always viewable, at every status.
    if (!canAttach && !evidenceUrl) {
        return null;
    }

    return (
        <div className="mt-1 flex flex-col items-start gap-1">
            {evidenceUrl ? (
                <a
                    href={evidenceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-semibold text-primary hover:underline"
                >
                    Lihat bukti
                </a>
            ) : null}

            {canAttach ? (
                <>
                    <input
                        ref={fileInput}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,application/pdf"
                        className="sr-only"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                                void upload(file);
                            }
                        }}
                    />
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy || pending}
                        onClick={() => fileInput.current?.click()}
                    >
                        {busy
                            ? "Mengunggah…"
                            : evidenceUrl
                              ? "Ganti bukti"
                              : "Unggah bukti"}
                    </Button>
                </>
            ) : null}

            {error ? (
                <span className="max-w-56 text-xs text-destructive">
                    {error}
                </span>
            ) : null}
        </div>
    );
}
