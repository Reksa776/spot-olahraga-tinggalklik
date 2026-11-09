"use client";

import { useState } from "react";

/**
 * Upload one PDF + a message to the PIC blast endpoint.
 *
 * The form deliberately reports the ENQUEUE result, not "sent": the worker sends at its own
 * single-socket pace and may defer to the daily cap, so claiming delivery here would be false.
 */
export function PicEventBlastForm({
    eventId,
    eventTitle,
}: {
    eventId: string;
    eventTitle: string;
}) {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    async function submit(formData: FormData) {
        setBusy(true);
        setMessage("");

        try {
            const response = await fetch(
                `/api/pic/events/${encodeURIComponent(eventId)}/blast`,
                { method: "POST", body: formData }
            );
            const body = await response.json();

            if (!response.ok || !body.success) {
                throw new Error(body.message || "Blast gagal.");
            }

            setMessage(
                `Blast masuk antrean: ${body.data.enqueued} pesan baru, ` +
                    `${body.data.existing} sudah pernah diantrekan, ` +
                    `${body.data.failed} gagal. ` +
                    `${body.data.withoutPhone} peserta dilewati karena nomor tidak valid.`
            );
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "Blast gagal.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <form action={submit} className="space-y-4 rounded-xl border p-5">
            <label className="block text-sm font-medium">
                Judul dokumen
                <input
                    name="title"
                    required
                    maxLength={160}
                    className="mt-1 block w-full rounded-md border bg-background px-3 py-2"
                />
            </label>

            <label className="block text-sm font-medium">
                Pesan untuk peserta
                <textarea
                    name="message"
                    required
                    rows={4}
                    maxLength={1_000}
                    className="mt-1 block w-full rounded-md border bg-background px-3 py-2"
                />
            </label>

            <label className="block text-sm font-medium">
                File PDF (maksimal 10 MB)
                <input
                    name="file"
                    type="file"
                    required
                    accept="application/pdf,.pdf"
                    className="mt-1 block w-full"
                />
            </label>

            <p className="text-sm text-muted-foreground">
                Dikirim ke pembeli pesanan lunas dengan tiket terbit pada acara{" "}
                {eventTitle} melalui WhatsApp, sebagai lampiran PDF. Pesan diantrikan, lalu
                worker mengirim satu per satu sesuai jeda antrean
                (WHATSAPP_SEND_DELAY_MS) dan batas harian WhatsApp.
            </p>

            <button
                disabled={busy}
                className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
            >
                {busy ? "Mengantrekan…" : "Kirim blast"}
            </button>

            {message ? (
                <p role="status" className="text-sm">
                    {message}
                </p>
            ) : null}
        </form>
    );
}
