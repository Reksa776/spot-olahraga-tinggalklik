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
import { Badge } from "@/components/dashboard/ui/badge";
import { WhatsAppTechnicalDetails } from "@/components/dashboard/WhatsAppTechnicalDetails";
import type {
    TechnicalGatewayLock,
    TechnicalLockHolder,
} from "@/components/dashboard/WhatsAppTechnicalDetails";
import {
    getWhatsAppStatusCopy,
    type WhatsAppUserMessageLevel,
} from "@/lib/whatsapp/gateway/status-copy";

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
    lock?: TechnicalGatewayLock | null;
    lockHolder?: TechnicalLockHolder | null;
    userMessage?: string;
    userMessageLevel?: string;
    userMessageDetail?: string;
    smtp?: { configured: boolean; secure: boolean; from: string | null };
};

function normalizeLevel(
    value: string | undefined
): WhatsAppUserMessageLevel {
    return value === "success" ||
        value === "info" ||
        value === "warning" ||
        value === "error"
        ? value
        : "warning";
}

export function WhatsAppSettingsPanel() {
    const [state, setState] = useState<State>({});
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [staleConfirmOpen, setStaleConfirmOpen] = useState(false);
    const [connectFailed, setConnectFailed] = useState(false);
    const [pairingRequested, setPairingRequested] = useState(false);
    const [actionConflict, setActionConflict] = useState<{
        stale: boolean;
    } | null>(null);

    async function refresh() {
        try {
            const response = await fetch("/api/admin/settings/whatsapp", {
                cache: "no-store",
            });
            const body = await response.json();

            if (!response.ok || !body.success) {
                throw new Error(body.message || "Status gagal dimuat.");
            }

            const data = body.data as State;
            setState(data);

            if (
                data.connected ||
                (data.state !== "CONFLICT" && !data.lock?.held)
            ) {
                setActionConflict(null);
            }
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
                if (response.status === 409) {
                    setActionConflict({
                        stale: Boolean(body.details?.lock?.stale),
                    });
                    setConnectFailed(true);
                    await refresh();
                    return;
                }

                throw new Error(
                    body.message || "Pairing gagal dimulai."
                );
            }

            setActionConflict(null);
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

    async function disconnect(options: {
        forceReleaseStale?: boolean;
        deleteSession: boolean;
        reason?: string;
    }) {
        setBusy(true);
        setError("");

        try {
            const response = await fetch(
                "/api/admin/settings/whatsapp/disconnect",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        deleteSession: options.deleteSession,
                        ...(options.forceReleaseStale
                            ? { forceReleaseStale: true }
                            : {}),
                        ...(options.reason ? { reason: options.reason } : {}),
                    }),
                }
            );
            const body = await response.json();

            if (!response.ok || !body.success) {
                if (response.status === 409) {
                    setActionConflict({
                        stale: Boolean(body.details?.lock?.stale),
                    });
                    setConfirmOpen(false);
                    setStaleConfirmOpen(false);
                    await refresh();
                    return;
                }

                throw new Error(
                    body.message || "Gagal memutuskan koneksi WhatsApp."
                );
            }

            setConfirmOpen(false);
            setStaleConfirmOpen(false);
            setActionConflict(null);
            setConnectFailed(false);
            setPairingRequested(false);
            setState((current) => ({
                ...current,
                state: "MANUAL_DISCONNECT",
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

    const manualDisconnect =
        state.manualDisconnect === true ||
        state.state === "MANUAL_DISCONNECT";
    const gatewayLock: TechnicalGatewayLock | null =
        state.lock ??
        (state.lockHolder
            ? {
                  held: true,
                  holder: state.lockHolder,
                  stale: false,
                  heartbeatAgeMs: null,
              }
            : null);
    const lockStale = Boolean(gatewayLock?.stale);
    const rawState = state.state ?? "UNAVAILABLE";
    const effectiveState = manualDisconnect
        ? "MANUAL_DISCONNECT"
        : actionConflict
          ? "CONFLICT"
          : rawState;
    const effectiveStale = actionConflict?.stale ?? lockStale;
    const fallbackCopy = getWhatsAppStatusCopy({
        state: effectiveState,
        manualDisconnect,
        stale: effectiveStale,
    });
    const useApiCopy =
        !actionConflict && !manualDisconnect && Boolean(state.userMessage);
    const userMessage = useApiCopy
        ? (state.userMessage as string)
        : fallbackCopy.userMessage;
    const userMessageLevel = useApiCopy
        ? normalizeLevel(state.userMessageLevel)
        : fallbackCopy.userMessageLevel;
    const userMessageDetail = useApiCopy
        ? (state.userMessageDetail ?? "")
        : fallbackCopy.userMessageDetail;
    const isConnecting =
        effectiveState === "STARTING" ||
        effectiveState === "PAIRING_REQUIRED";
    const showTechnicalDetails =
        effectiveState === "CONFLICT" || effectiveState === "ERROR";
    const showRepair =
        effectiveState === "CONFLICT" && effectiveStale;
    const showRetry =
        effectiveState === "CONFLICT" && !effectiveStale;
    const showConnect = !state.connected && !state.qr && !showRepair;
    const connectDisabled = busy || isConnecting;
    const connectLabel =
        busy || isConnecting
            ? "Menyambungkan…"
            : effectiveState === "ERROR"
              ? "Hubungkan WhatsApp"
              : showRetry || connectFailed || pairingRequested
                ? "Coba lagi"
                : "Hubungkan WhatsApp";
    const badgeVariant = manualDisconnect
        ? "muted"
        : userMessageLevel === "success"
          ? "success"
          : userMessageLevel === "info"
            ? "info"
            : userMessageLevel === "warning"
              ? "warning"
              : "danger";
    const badgeLabel = manualDisconnect
        ? "Manual"
        : userMessageLevel === "success"
          ? "Terhubung"
          : userMessageLevel === "info"
            ? "Memproses"
            : userMessageLevel === "warning"
              ? "Belum terhubung"
              : "Perlu perhatian";
    const statusDotClass =
        userMessageLevel === "success"
            ? "bg-emerald-500"
            : userMessageLevel === "info"
              ? "bg-sky-500"
              : userMessageLevel === "warning"
                ? "bg-amber-500"
                : "bg-destructive";

    return (
        <div className="space-y-6">
            <section className="space-y-4">
                <div className="rounded-card border border-border bg-card p-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="flex min-w-0 items-start gap-3">
                            <span className="mt-1 flex size-5 shrink-0 items-center justify-center">
                                {isConnecting ? (
                                    <span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
                                ) : (
                                    <span
                                        className={`size-3 rounded-full ${statusDotClass}`}
                                    />
                                )}
                            </span>

                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 className="text-lg font-semibold">
                                        {userMessage}
                                    </h2>
                                    <Badge variant={badgeVariant}>
                                        {badgeLabel}
                                    </Badge>
                                </div>
                                <p className="mt-1 text-sm text-muted-foreground">
                                    {userMessageDetail}
                                </p>
                            </div>
                        </div>

                        {state.connected ? (
                            <button
                                type="button"
                                onClick={() => setConfirmOpen(true)}
                                disabled={busy}
                                className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-50"
                            >
                                Putuskan WhatsApp
                            </button>
                        ) : null}
                    </div>

                    {showTechnicalDetails ? (
                        <div className="mt-4">
                            <WhatsAppTechnicalDetails
                                state={effectiveState}
                                lock={gatewayLock}
                                lastErrorCode={state.lastErrorCode}
                            />
                        </div>
                    ) : null}

                    {showRepair || showConnect ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                            {showRepair ? (
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => setStaleConfirmOpen(true)}
                                    className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-50"
                                >
                                    Perbaiki koneksi
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    disabled={connectDisabled}
                                    onClick={() => void connect()}
                                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                                >
                                    {connectLabel}
                                </button>
                            )}
                        </div>
                    ) : null}

                    {state.qr ? (
                        <div className="mt-5 space-y-2">
                            <p className="text-sm">
                                Scan QR dengan WhatsApp nomor yang mau dipakai.
                                Buka WhatsApp → Perangkat tertaut. Jangan
                                bagikan QR ini ke siapa pun.
                            </p>
                            <div className="inline-block rounded bg-white p-3">
                                <QRCodeSVG value={state.qr} size={240} />
                            </div>
                            <p className="text-sm font-medium">
                                QR berlaku ±60 detik, segera scan.
                            </p>
                        </div>
                    ) : null}

                    {error ? (
                        <p
                            role="alert"
                            className="mt-4 text-sm text-destructive"
                        >
                            {error}
                        </p>
                    ) : null}
                </div>
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
                            Semua session WhatsApp akan dihapus dari server.
                            Pesan otomatis (reminder, bukti pembelian, blast)
                            akan berhenti sampai Anda scan QR lagi. Lanjutkan?
                        </DialogDescription>
                    </DialogHeader>

                    {error ? (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    ) : null}

                    <DialogFooter>
                        <button
                            type="button"
                            autoFocus
                            onClick={() => setConfirmOpen(false)}
                            disabled={busy}
                            className="rounded-md border border-border px-4 py-2 disabled:opacity-50"
                        >
                            Batal
                        </button>
                        <button
                            type="button"
                            onClick={() =>
                                void disconnect({
                                    deleteSession: true,
                                    reason: "user_disconnect",
                                })
                            }
                            disabled={busy}
                            className="rounded-md bg-destructive px-4 py-2 text-destructive-foreground disabled:opacity-50"
                        >
                            {busy ? "Memutuskan…" : "Ya, putuskan"}
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
                        <DialogTitle>Perbaiki koneksi?</DialogTitle>
                        <DialogDescription>
                            Lock yang tersangkut akan dilepas. Session WhatsApp
                            yang ada tetap disimpan, jadi Anda tidak perlu scan
                            QR baru kecuali session sudah tidak berlaku.
                        </DialogDescription>
                    </DialogHeader>

                    <DialogFooter>
                        <button
                            type="button"
                            autoFocus
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
                                    reason: "force_release_stale",
                                })
                            }
                            disabled={busy}
                            className="rounded-md bg-destructive px-4 py-2 text-destructive-foreground disabled:opacity-50"
                        >
                            {busy ? "Memperbaiki…" : "Perbaiki koneksi"}
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
