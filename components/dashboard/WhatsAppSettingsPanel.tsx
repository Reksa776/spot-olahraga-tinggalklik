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
    processName: string | null;
    alive: boolean;
    ownerId: string | null;
    source: string;
};

type GatewayLock = {
    held: boolean;
    holder: LockHolder | null;
    stale: boolean;
    heartbeatAgeMs: number | null;
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
    lock?: GatewayLock | null;
    lockHolder?: LockHolder | null;
    smtp?: { configured: boolean; secure: boolean; from: string | null };
};

type LockConflict = {
    message: string;
    holder: LockHolder | null;
    stale: boolean;
    heartbeatAgeMs: number | null;
};

function formatAge(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms)) {
        return "tidak diketahui";
    }

    const seconds = Math.max(0, Math.floor(ms / 1000));

    if (seconds < 60) {
        return `${seconds} detik`;
    }

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) {
        return `${minutes} menit`;
    }

    const hours = Math.floor(minutes / 60);

    return `${hours} jam ${minutes % 60} menit`;
}

function holderDescription(holder: LockHolder | null): string {
    const who =
        holder?.pid !== null && holder?.pid !== undefined
            ? `proses pid ${holder.pid}`
            : "proses lain";
    const process = holder?.processName
        ? ` (${holder.processName})`
        : "";
    const host = holder?.host ? ` di ${holder.host}` : "";
    const started = holder?.startedAt
        ? `, sejak ${new Date(holder.startedAt).toLocaleString("id-ID")}`
        : "";

    return `${who}${process}${host}${started}`;
}

export function WhatsAppSettingsPanel() {
    const [state, setState] = useState<State>({});
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [staleConfirmOpen, setStaleConfirmOpen] = useState(false);
    const [deleteSession, setDeleteSession] = useState(false);
    const [lockConflict, setLockConflict] = useState<LockConflict | null>(
        null
    );
    const [connectFailed, setConnectFailed] = useState(false);
    const [pairingRequested, setPairingRequested] = useState(false);

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

    async function connect() {
        setBusy(true);
        setError("");
        setConnectFailed(false);

        try {
            const response = await fetch(
                "/api/admin/settings/whatsapp/connect",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                }
            );
            const body = await response.json();

            if (!response.ok || !body.success) {
                const details = body.details ?? {};
                const holder: LockHolder | null =
                    details.lock?.holder ?? details.lockHolder ?? null;

                if (
                    response.status === 409 &&
                    (holder !== null || details.lock)
                ) {
                    setLockConflict({
                        message:
                            body.message ||
                            "Gateway masih memegang lock.",
                        holder,
                        stale: Boolean(details.lock?.stale),
                        heartbeatAgeMs:
                            details.lock?.heartbeatAgeMs ?? null,
                    });
                    setConnectFailed(true);
                    return;
                }

                throw new Error(
                    body.message || "Pairing gagal dimulai."
                );
            }

            setConnectFailed(false);
            setPairingRequested(true);
            await refresh();
        } catch (cause) {
            setConnectFailed(true);
            setError(
                cause instanceof Error
                    ? cause.message
                    : "Pairing gagal dimulai."
            );
        } finally {
            setBusy(false);
        }
    }

    async function disconnect(
        options: { forceReleaseStale?: boolean; deleteSession?: boolean } = {}
    ) {
        setBusy(true);
        setError("");

        const shouldDeleteSession =
            options.deleteSession ?? deleteSession;

        try {
            const response = await fetch(
                "/api/admin/settings/whatsapp/disconnect",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        deleteSession: shouldDeleteSession,
                        ...(options.forceReleaseStale
                            ? { forceReleaseStale: true }
                            : {}),
                    }),
                }
            );
            const body = await response.json();

            if (!response.ok || !body.success) {
                const details = body.details ?? {};
                const holder: LockHolder | null =
                    details.lock?.holder ?? details.lockHolder ?? null;

                if (
                    response.status === 409 &&
                    (holder !== null || details.lock)
                ) {
                    setLockConflict({
                        message:
                            body.message ||
                            "Gateway masih memegang lock.",
                        holder,
                        stale: Boolean(details.lock?.stale),
                        heartbeatAgeMs:
                            details.lock?.heartbeatAgeMs ?? null,
                    });
                    setConfirmOpen(false);
                    setStaleConfirmOpen(false);
                    return;
                }

                throw new Error(
                    body.message || "Gagal memutuskan koneksi WhatsApp."
                );
            }

            setConfirmOpen(false);
            setStaleConfirmOpen(false);
            setDeleteSession(false);
            setConnectFailed(false);
            setPairingRequested(false);
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

    const disconnected =
        state.manualDisconnect === true ||
        state.state === "MANUAL_DISCONNECT";
    const reconnect =
        disconnected ||
        state.state === "DISCONNECTED" ||
        state.state === "LOGGED_OUT";
    const connectDisabled =
        busy ||
        state.state === "UNAVAILABLE" ||
        state.state === "STARTING";
    const connectLabel =
        busy || state.state === "STARTING"
            ? "Menyambungkan…"
            : disconnected
              ? "Hubungkan ulang"
              : connectFailed ||
                  pairingRequested ||
                  state.state === "ERROR" ||
                  state.state === "CONFLICT"
                ? "Coba lagi"
                : reconnect
                  ? "Hubungkan ulang"
                  : "Hubungkan WhatsApp";
    const gatewayLock: GatewayLock | null =
        state.lock ??
        (state.lockHolder
            ? {
                  held: true,
                  holder: state.lockHolder,
                  stale: false,
                  heartbeatAgeMs: null,
              }
            : null);
    const lockHeld = Boolean(gatewayLock?.held);
    const lockStale = Boolean(gatewayLock?.stale);
    const lockHolder = gatewayLock?.holder ?? null;

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

                <section className="space-y-2 rounded-md border border-border p-3">
                    <h3 className="font-semibold">Gateway lock</h3>

                    {!lockHeld ? (
                        <p className="text-sm text-muted-foreground">
                            Tidak ada lock.
                        </p>
                    ) : lockStale ? (
                        <div className="space-y-2">
                            <p className="inline-flex rounded bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900">
                                LOCK STALE
                            </p>
                            <p className="text-sm text-muted-foreground">
                                Dipegang {holderDescription(lockHolder)}.
                                Heartbeat {formatAge(
                                    gatewayLock?.heartbeatAgeMs ?? null
                                )}{" "}
                                lalu; proses tidak terbukti hidup.
                            </p>
                            <button
                                type="button"
                                onClick={() => setStaleConfirmOpen(true)}
                                disabled={busy}
                                className="rounded-md bg-destructive px-3 py-2 text-sm text-destructive-foreground disabled:opacity-50"
                            >
                                Lepas lock stale
                            </button>
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            Dipegang {holderDescription(lockHolder)}. Heartbeat{" "}
                            {formatAge(gatewayLock?.heartbeatAgeMs ?? null)}{" "}
                            lalu.
                            {lockHolder && !lockHolder.alive
                                ? " Status proses tidak dapat dipastikan; lock dianggap hidup."
                                : ""}
                        </p>
                    )}
                </section>

                {!state.connected && !state.qr ? (
                    <button
                        type="button"
                        disabled={connectDisabled}
                        onClick={() => void connect()}
                        className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
                    >
                        {connectLabel}
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

                {state.qr ? (
                    <div className="space-y-2">
                        <p>
                            Scan QR dengan WhatsApp nomor yang mau dipakai.
                            Buka WhatsApp → Perangkat tertaut. QR hanya tampil
                            sebentar dan jangan bagikan ke siapa pun.
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

            <Dialog
                open={staleConfirmOpen}
                onOpenChange={(open) => {
                    if (!busy) setStaleConfirmOpen(open);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Lepas lock stale?</DialogTitle>
                        <DialogDescription>
                            Hanya lanjutkan jika Anda yakin proses pemegang lock
                            sudah mati. Lock yang masih hidup tidak akan
                            dilepas.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-1 text-sm">
                        <p>Pemegang lock:</p>
                        <p className="font-medium">
                            {holderDescription(lockHolder)}
                        </p>
                        <p className="text-muted-foreground">
                            Heartbeat terakhir:{" "}
                            {formatAge(gatewayLock?.heartbeatAgeMs ?? null)}{" "}
                            lalu.
                        </p>
                    </div>

                    <DialogFooter>
                        <button
                            type="button"
                            onClick={() => setStaleConfirmOpen(false)}
                            disabled={busy}
                            className="rounded-md border border-border px-4 py-2 disabled:opacity-50"
                        >
                            Batal
                        </button>
                        <button
                            type="button"
                            onClick={() =>
                                void disconnect({
                                    forceReleaseStale: true,
                                    deleteSession: false,
                                })
                            }
                            disabled={busy}
                            className="rounded-md bg-destructive px-4 py-2 text-destructive-foreground disabled:opacity-50"
                        >
                            {busy ? "Melepas…" : "Lepas lock stale"}
                        </button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog
                open={lockConflict !== null}
                onOpenChange={(open) => {
                    if (!open) setLockConflict(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Gateway masih memegang lock</DialogTitle>
                        <DialogDescription>
                            {lockConflict?.message ??
                                "Lock dipegang proses lain."}
                        </DialogDescription>
                    </DialogHeader>

                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-muted-foreground">PID</dt>
                        <dd>{lockConflict?.holder?.pid ?? "tidak diketahui"}</dd>
                        <dt className="text-muted-foreground">Host</dt>
                        <dd>
                            {lockConflict?.holder?.host ?? "tidak diketahui"}
                        </dd>
                        <dt className="text-muted-foreground">Proses</dt>
                        <dd>
                            {lockConflict?.holder?.processName ??
                                "tidak terbaca"}
                        </dd>
                        <dt className="text-muted-foreground">Heartbeat</dt>
                        <dd>
                            {formatAge(lockConflict?.heartbeatAgeMs ?? null)}{" "}
                            lalu
                        </dd>
                        <dt className="text-muted-foreground">Stale</dt>
                        <dd>{lockConflict?.stale ? "ya" : "tidak"}</dd>
                    </dl>

                    <p className="text-sm">
                        Hentikan proses di host tersebut:
                    </p>
                    <code className="rounded bg-muted px-2 py-1 text-sm">
                        pm2 stop{" "}
                        {lockConflict?.holder?.processName ??
                            "<nama-proses-gateway>"}
                    </code>

                    {lockConflict?.stale ? (
                        <p className="text-sm text-amber-700">
                            Lock ini terdeteksi stale. Tutup dialog ini lalu
                            gunakan tombol &quot;Lepas lock stale&quot; di blok
                            Gateway lock.
                        </p>
                    ) : null}

                    <DialogFooter>
                        <button
                            type="button"
                            onClick={() => setLockConflict(null)}
                            className="rounded-md border border-border px-4 py-2"
                        >
                            Tutup
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
