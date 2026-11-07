"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

type State = { state?: string; connected?: boolean; ready?: boolean; sessionPresent?: boolean; lastErrorCode?: string | null; qr?: string | null; expiresAt?: string | null; smtp?: { configured: boolean; secure: boolean; from: string | null } };

export function WhatsAppSettingsPanel() {
  const [state, setState] = useState<State>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    try { const r = await fetch("/api/admin/settings/whatsapp", { cache: "no-store" }); const b = await r.json(); if (!r.ok || !b.success) throw new Error(b.message || "Status gagal dimuat."); setState(b.data); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Status gagal dimuat."); }
  }
  useEffect(() => { const id = setInterval(() => void refresh(), 3000); return () => clearInterval(id); }, []);
  async function pair() {
    setBusy(true); setError("");
    try { const r = await fetch("/api/admin/settings/whatsapp/pairing", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); const b = await r.json(); if (!r.ok || !b.success) throw new Error(b.message || "Pairing gagal dimulai."); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Pairing gagal dimulai."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-6">
    <section className="space-y-3"><h2 className="text-lg font-semibold">WhatsApp Baileys</h2><p>Status: <strong>{state.state ?? "Memeriksa…"}</strong>{state.connected ? " · Terhubung" : ""}</p>
      {!state.connected ? <button disabled={busy || state.state === "UNAVAILABLE"} onClick={() => void pair()} className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{busy ? "Memulai…" : "Hubungkan WhatsApp"}</button> : null}
      {state.state === "UNAVAILABLE" ? <p className="text-sm text-muted-foreground">Gateway WhatsApp belum berjalan atau konfigurasinya belum lengkap.</p> : null}
      {state.state === "CONFLICT" ? <p className="text-sm text-destructive">Gateway WhatsApp lain masih memegang koneksi. Hentikan proses gateway lama lalu muat ulang halaman.</p> : null}
      {state.qr ? <div className="space-y-2"><p>Pindai QR ini dari WhatsApp → Perangkat tertaut. QR hanya tampil sebentar dan jangan bagikan ke siapa pun.</p><div className="inline-block rounded bg-white p-3"><QRCodeSVG value={state.qr} size={240} /></div><p className="text-sm">QR kedaluwarsa: {state.expiresAt ? new Date(state.expiresAt).toLocaleTimeString("id-ID") : "—"}</p></div> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </section>
    <section className="space-y-2 border-t pt-5"><h2 className="text-lg font-semibold">Email SMTP</h2><p>Status konfigurasi: <strong>{state.smtp?.configured ? "Siap" : "Belum lengkap"}</strong></p><p className="text-sm text-muted-foreground">Isi SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, dan EMAIL_FROM di environment server, lalu restart worker. Nilai rahasia tidak ditampilkan di dashboard.</p>{state.smtp?.from ? <p className="text-sm">Pengirim: {state.smtp.from}</p> : null}</section>
  </div>;
}
