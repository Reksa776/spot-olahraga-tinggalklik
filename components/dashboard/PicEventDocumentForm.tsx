"use client";

import { useState } from "react";

export function PicEventDocumentForm({ eventId, eventTitle }: { eventId: string; eventTitle: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(formData: FormData) {
    setBusy(true); setMessage("");
    formData.set("channels", "email,whatsapp");
    try {
      const response = await fetch(`/api/pic/events/${encodeURIComponent(eventId)}/documents`, { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.message || "Pengiriman gagal.");
      setMessage(`Dokumen diproses. ${body.data.enqueued} pesan masuk antrean dari ${body.data.eligibleOrders} pesanan yang memenuhi syarat.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Pengiriman gagal."); }
    finally { setBusy(false); }
  }
  return <form action={submit} className="space-y-4 rounded-xl border p-5">
    <label className="block text-sm font-medium">Judul dokumen<input name="title" required maxLength={160} className="mt-1 block w-full rounded-md border bg-background px-3 py-2" /></label>
    <label className="block text-sm font-medium">File PDF (maksimal 10 MB)<input name="file" type="file" required accept="application/pdf,.pdf" className="mt-1 block w-full" /></label>
    <p className="text-sm text-muted-foreground">Akan diantrikan ke email dan WhatsApp pembeli dengan tiket terbit pada acara {eventTitle}. Tautan unduhan privat berlaku 90 hari.</p>
    <button disabled={busy} className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{busy ? "Memproses…" : "Kirim dokumen"}</button>
    {message ? <p role="status" className="text-sm">{message}</p> : null}
  </form>;
}
