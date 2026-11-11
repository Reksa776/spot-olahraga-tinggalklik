"use client";

import { useRef, useState } from "react";

/** Send a Google Drive share link to checked-in attendees through the notification queue. */
export function PicEventBlastForm({
    eventId,
    recipientCount,
}: {
    eventId: string;
    recipientCount: number;
}) {
    const [busy, setBusy] = useState(false);
    const [statusMessage, setStatusMessage] = useState("");
    const [errorMessage, setErrorMessage] = useState("");
    const [hasCompletedBlast, setHasCompletedBlast] = useState(false);
    const pendingBlastId = useRef<string | null>(null);

    async function submit(formData: FormData) {
        if (
            hasCompletedBlast &&
            !window.confirm(
                `Kirim ulang tautan dokumen ini kepada ${recipientCount} pembeli dengan tiket aktif?`
            )
        ) {
            return;
        }

        pendingBlastId.current ??= window.crypto.randomUUID();
        setBusy(true);
        setStatusMessage("");
        setErrorMessage("");

        try {
            const response = await fetch(
                `/api/pic/events/${encodeURIComponent(eventId)}/blast`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        driveUrl: String(formData.get("driveUrl") ?? ""),
                        blastId: pendingBlastId.current,
                    }),
                }
            );
            const body = await response.json().catch(() => null);

            if (!response.ok || !body?.success) {
                throw new Error(body?.message || "Blast dokumen gagal diproses.");
            }

            const result = body.data;
            pendingBlastId.current = null;
            setHasCompletedBlast(true);
            setStatusMessage(
                `${result.enqueued} pesan masuk antrean untuk pembeli tiket yang memenuhi syarat. ` +
                    `${result.existing} sudah ada di antrean, ${result.failed} gagal, ` +
                    `${result.withoutPhone} dilewati karena nomor WhatsApp tidak valid.`
            );
        } catch (error) {
            setErrorMessage(
                error instanceof Error ? error.message : "Blast dokumen gagal diproses."
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <form action={submit} className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
            <div>
                <label htmlFor="pic-drive-url" className="block text-sm font-semibold">
                    Tautan Google Drive
                </label>
                <input
                    id="pic-drive-url"
                    name="driveUrl"
                    type="url"
                    required
                    maxLength={2_048}
                    placeholder="https://drive.google.com/..."
                    className="mt-1.5 block min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    Atur akses Drive agar peserta yang memiliki tautan dapat membuka dokumen.
                </p>
            </div>

            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                    Tautan dikirim melalui WhatsApp ke {recipientCount} pembeli dengan nomor valid dan tiket aktif.
                </p>
                <button
                    type="submit"
                    disabled={busy || recipientCount === 0}
                    className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {busy
                        ? "Mengantrekan pesan…"
                        : hasCompletedBlast
                          ? "Kirim ulang ke peserta"
                          : "Kirim ke peserta"}
                </button>
            </div>

            {errorMessage ? (
                <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    {errorMessage}
                </p>
            ) : null}
            {statusMessage ? (
                <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
                    {statusMessage}
                </p>
            ) : null}
        </form>
    );
}
