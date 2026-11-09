"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/dashboard/ui/dialog";
import { Checkbox } from "@/components/dashboard/ui/select";

type LockHolder = {
    pid: number | null;
    host: string | null;
    startedAt: string | null;
    ownerId: string | null;
    source: string;
};

type State = {
    state?: string;
    connected?: boolean;
    ready?: boolean;
    sessionPresent?: boolean;
    sessionExists?: boolean;
    manualDisconnect?: boolean;
    lastErrorCode?: string | null;
    qr?: string | null;
    expiresAt?: string | null;
    lockHolder?: LockHolder | null;
    smtp?: { configured: boolean; secure: boolean; from: string | null };
};

export function WhatsAppSettingsPanel() {
    const [state, setState] = useState<State>({});
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [deleteSession, setDeleteSession] = useState(false);

    async function refresh() {
        try {
            const response = await fetch("/api/admin/settings/whatsapp", {
                cache: "no-store",
            });
            const body = await response.json();

            if (!response.ok || !body.success) {
                throw new Error(body.message || "Status gagal dimuat.");
            }

            setState(body.data);
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : "Status gagal dimuat."
            );
        }
    }

    useEffect(() => {
        void refresh();
        const id = setInterval(() => void refresh(), 3000);

        return () => clearInterval(id);
    }, []);

    async function pair() {
        setBusy(true);
        setError("");

        try {
            const response = await fetch(
                "/api/admin/settings/whatsapp/pairing",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                }
            );
            const body = await response.json();

            if (!response.ok || !body.success) {
                throw new Error(
                    body.message || "Pairing gagal dimulai."
                );
            }

            await refresh();
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : "Pairing gagal dimulai."
            );
        } finally {
            setBusy(false);
        }
    }

    async function disconnect() {
        setBusy(true);
        setError("");

        try {
            const response = await fetch(
                "/api/admin/settings/whatsapp/disconnect",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ deleteSession }),
                }
            );
            const body = await response.json();

            if (!response.ok || !body.success) {
                throw new Error(
                    body.message || "Gagal memutuskan koneksi WhatsApp."
                );
            }

            setConfirmOpen(false);
            setDeleteSession(false);
            setState((current) => ({
                ...current,
                state: "DISCONNECTED",
                connected: false,
                ready: false,
                qr: null,
                expiresAt: null,
                manualDisconnect: true,
            }));
            await refresh();
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : "Gagal memutuskan koneksi WhatsApp."
            );
        } finally {
            setBusy(false);
        }
    }

    const disconnected = Boolean(state.manualDisconnect);
    const reconnect =
        disconnected ||
        state.state === "DISCONNECTED" ||
        state.state === "LOGGED_OUT";
    const pairDisabled =
        busy ||
        state.state === "UNAVAILABLE" ||
        state.state === "STARTING";
    const lock = state.lockHolder;

    return (
        <div className="space-y-6">
            <section className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-lg font-semibold">WhatsApp Baileys</h2>
                    <p>
                        Status:{" "}
                        <strong>
                            {disconnected
                                ? "DISCONNECTED (manual)"
                                : (state.state ?? "Memeriksa…")}
                        </strong>
                        {state.connected ? " · Terhubung" : ""}
                    </p>
                    {state.connected ? (
                        <button
                            type="button"
                            onClick={() => setConfirmOpen(true)}
                            disabled={busy}
                            className="rounded-md bg-destructive px-4 py-2 text-destructive-foreground disabled:opacity-50"
                        >
                            Putuskan koneksi
                        </button>
                    ) : null}
                </div>

                {!state.connected ? (
                    <button
                        type="button"
                        disabled={pairDisabled}
                        onClick={() => void pair()}
                        className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
                    >
                        {busy || state.state === "STARTING"
                            ? "Menyambungkan…"
                            : reconnect
                              ? "Hubungkan ulang"
                              : "Hubungkan WhatsApp"}
                    </button>
                ) : null}

                {disconnected ? (
                    <p className="text-sm text-muted-foreground">
                        WhatsApp diputuskan manual. Pesan otomatis berhenti
                        sampai Anda menghubungkan ulang dan scan QR.
                    </p>
                ) : null}

                {state.state === "STARTING" ? (
                    <p className="text-sm text-muted-foreground">
                        WhatsApp sedang menyelesaikan koneksi perangkat tertaut.
                        Halaman akan memperbarui status otomatis.
                    </p>
                ) : null}

                {state.state === "UNAVAILABLE" ? (
                    <p className="text-sm text-muted-foreground">
                        Gateway WhatsApp belum berjalan atau konfigurasinya belum
                        lengkap.
                    </p>
                ) : null}

                {state.state === "CONFLICT" ? (
                    <p className="text-sm text-destructive">
                        Gateway WhatsApp lain masih memegang koneksi. Hentikan
                        proses gateway lama lalu muat ulang halaman.
                    </p>
                ) : null}

                {lock ? (
                    <p className="text-sm text-muted-foreground">
                        Lock dipegang{" "}
                        {lock.pid !== null ? `pid ${lock.pid}` : "proses lain"}
                        {lock.host ? ` di ${lock.host}` : ""}
                        {lock.startedAt
                            ? ` sejak ${new Date(
                                  lock.startedAt
                              ).toLocaleString("id-ID")}`
                            : ""}
                        .
                    </p>
                ) : null}

                {state.qr ? (
                    <div className="space-y-2">
                        <p>
                            Pindai QR ini dari WhatsApp → Perangkat tertaut. QR
                            hanya tampil sebentar dan jangan bagikan ke siapa
                            pun.
                        </p>
                        <div className="inline-block rounded bg-white p-3">
                            <QRCodeSVG value={state.qr} size={240} />
                        </div>
                        <p className="text-sm">
                            QR kedaluwarsa:{" "}
                            {state.expiresAt
                                ? new Date(state.expiresAt).toLocaleTimeString(
                                      "id-ID"
                                  )
                                : "—"}
                        </p>
                    </div>
                ) : null}

                {error ? (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                ) : null}
            </section>

            <Dialog
                open={confirmOpen}
                onOpenChange={(open) => {
                    if (!busy) setConfirmOpen(open);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Putuskan WhatsApp?</DialogTitle>
                        <DialogDescription>
                            Pesan otomatis akan berhenti sampai Anda scan QR
                            ulang.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex items-start gap-3">
                        <Checkbox
                            id="delete-whatsapp-session"
                            checked={deleteSession}
                            onCheckedChange={(value) =>
                                setDeleteSession(value === true)
                            }
                        />
                        <label
                            htmlFor="delete-whatsapp-session"
                            className="cursor-pointer text-sm"
                        >
                            Hapus session (perlu scan QR baru)
                        </label>
                    </div>

                    {error ? (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    ) : null}

                    <DialogFooter>
                        <button
                            type="button"
                            onClick={() => setConfirmOpen(false)}
                            disabled={busy}
                            className="rounded-md border border-border px-4 py-2 disabled:opacity-50"
                        >
                            Batal
                        </button>
                        <button
                            type="button"
                            onClick={() => void disconnect()}
                            disabled={busy}
                            className="rounded-md bg-destructive px-4 py-2 text-destructive-foreground disabled:opacity-50"
                        >
                            {busy ? "Memutuskan…" : "Putuskan koneksi"}
                        </button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <section className="space-y-2 border-t pt-5">
                <h2 className="text-lg font-semibold">Email SMTP</h2>
                <p>
                    Status konfigurasi:{" "}
                    <strong>
                        {state.smtp?.configured ? "Siap" : "Belum lengkap"}
                    </strong>
                </p>
                <p className="text-sm text-muted-foreground">
                    Isi SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS,
                    dan EMAIL_FROM di environment server, lalu restart worker.
                    Nilai rahasia tidak ditampilkan di dashboard.
                </p>
                {state.smtp?.from ? (
                    <p className="text-sm">Pengirim: {state.smtp.from}</p>
                ) : null}
            </section>
        </div>
    );
}
