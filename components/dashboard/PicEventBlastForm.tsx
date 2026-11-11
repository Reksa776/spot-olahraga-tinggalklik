"use client";

import { useState } from "react";
import type { PicBlastHistory } from "@/lib/pic/blast";

const STATUS_LABEL: Record<PicBlastHistory["recipients"][number]["status"], string> = {
    SENT: "Terkirim ke gateway",
    QUEUED: "Menunggu antrean",
    SENDING: "Sedang dikirim",
    FAILED: "Gagal",
    SKIPPED: "Dilewati",
    AMBIGUOUS: "Perlu dicek",
    NOT_SENT: "Belum dikirim",
    NO_PHONE: "Nomor WhatsApp tidak tersedia/valid",
};

function maskPhone(phone: string) {
    return phone.length <= 6 ? "•••" : `${phone.slice(0, 4)}••••${phone.slice(-3)}`;
}

function formatDate(value: Date | string | null) {
    if (!value) return "—";
    return new Date(value).toLocaleString("id-ID", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Jakarta",
    });
}

export function PicEventBlastForm({
    eventId,
    initialHistory,
}: {
    eventId: string;
    initialHistory: PicBlastHistory;
}) {
    const [history, setHistory] = useState(initialHistory);
    const [driveUrl, setDriveUrl] = useState(initialHistory.lastDriveUrl ?? "");
    const [busy, setBusy] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [statusMessage, setStatusMessage] = useState("");
    const [errorMessage, setErrorMessage] = useState("");
    const retryableCount = history.recipients.filter((recipient) =>
        ["NOT_SENT", "FAILED", "SKIPPED"].includes(recipient.status)
    ).length;
    const sentCount = history.recipients.filter((recipient) => recipient.status === "SENT").length;
    const sendableCount = history.recipients.filter((recipient) => recipient.status !== "NO_PHONE").length;

    async function refreshHistory() {
        setRefreshing(true);
        try {
            const response = await fetch(`/api/pic/events/${encodeURIComponent(eventId)}/blast`, {
                method: "GET",
                cache: "no-store",
            });
            const body = await response.json().catch(() => null);
            if (response.ok && body?.success && body.data) {
                setHistory(body.data as PicBlastHistory);
                if (!driveUrl && body.data.lastDriveUrl) setDriveUrl(body.data.lastDriveUrl);
            }
        } catch {
            setErrorMessage("Pesan sudah diproses, tetapi riwayat belum dapat diperbarui. Muat ulang halaman untuk melihat status terbaru.");
        } finally {
            setRefreshing(false);
        }
    }

    async function send(sendOnlyUnsent: boolean) {
        if (!driveUrl.trim()) {
            setErrorMessage("Masukkan tautan Google Drive terlebih dahulu.");
            return;
        }
        const targetCount = sendOnlyUnsent ? retryableCount : sendableCount;
        const prompt = sendOnlyUnsent
            ? `Kirim tautan kepada ${targetCount} pembeli yang belum berhasil dikirim?`
            : `Kirim tautan kepada ${targetCount} pembeli yang memenuhi syarat?`;
        if (targetCount === 0 || !window.confirm(prompt)) return;

        setBusy(true);
        setStatusMessage("");
        setErrorMessage("");
        try {
            const response = await fetch(`/api/pic/events/${encodeURIComponent(eventId)}/blast`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    driveUrl: driveUrl.trim(),
                    blastId: window.crypto.randomUUID(),
                    sendOnlyUnsent,
                }),
            });
            const body = await response.json().catch(() => null);
            if (!response.ok || !body?.success) {
                throw new Error(body?.message || "Blast dokumen gagal diproses.");
            }

            const result = body.data;
            setStatusMessage(
                `${result.enqueued} pesan baru masuk antrean. ${result.existing} sudah memiliki antrean dan ${result.failed} gagal diproses.`
            );
            await refreshHistory();
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Blast dokumen gagal diproses.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-6">
            <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
                <div>
                    <label htmlFor="pic-drive-url" className="block text-sm font-semibold">
                        Tautan Google Drive
                    </label>
                    <input
                        id="pic-drive-url"
                        type="url"
                        required
                        maxLength={2_048}
                        value={driveUrl}
                        onChange={(event) => setDriveUrl(event.target.value)}
                        placeholder="https://drive.google.com/..."
                        className="mt-1.5 block min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                        Pastikan akses tautan Drive sudah dibuka untuk peserta.
                    </p>
                </div>
                <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row">
                    <button
                        type="button"
                        disabled={busy || sendableCount === 0}
                        onClick={() => void send(false)}
                        className="inline-flex min-h-10 items-center justify-center rounded-lg border border-input px-4 py-2 text-sm font-semibold disabled:opacity-50"
                    >
                        {busy ? "Memproses…" : "Kirim ke semua pembeli"}
                    </button>
                    <button
                        type="button"
                        disabled={busy || retryableCount === 0}
                        onClick={() => void send(true)}
                        className="inline-flex min-h-10 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                    >
                        {busy ? "Memproses…" : `Kirim yang belum terkirim (${retryableCount})`}
                    </button>
                </div>
                {errorMessage ? <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{errorMessage}</p> : null}
                {statusMessage ? <p role="status" className="rounded-lg bg-muted p-3 text-sm">{statusMessage}</p> : null}
            </section>

            <section className="space-y-3">
                <div>
                    <h2 className="text-base font-semibold">Riwayat penerima</h2>
                    <p className="text-sm text-muted-foreground">
                        {sentCount} terkirim ke gateway · {history.recipients.length - sentCount} belum berstatus terkirim
                        {history.hasMore ? ` · daftar menampilkan ${history.scannedOrders} dari ${history.eligibleOrders} pesanan eligible` : ""}
                    </p>
                </div>
                <button
                    type="button"
                    disabled={busy || refreshing}
                    onClick={() => void refreshHistory()}
                    className="inline-flex min-h-9 items-center rounded-lg border border-input px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                >
                    {refreshing ? "Memuat status…" : "Perbarui status"}
                </button>
                {history.recipients.length === 0 ? (
                    <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
                        Belum ada pembeli yang memenuhi syarat untuk menerima dokumen.
                    </div>
                ) : (
                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full min-w-[680px] text-left text-sm">
                            <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
                                <tr>
                                    <th className="px-4 py-3 font-medium">Pembeli</th>
                                    <th className="px-4 py-3 font-medium">Pesanan</th>
                                    <th className="px-4 py-3 font-medium">WhatsApp</th>
                                    <th className="px-4 py-3 font-medium">Status</th>
                                    <th className="px-4 py-3 font-medium">Waktu terkirim</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {history.recipients.map((recipient) => (
                                    <tr key={recipient.orderId}>
                                        <td className="px-4 py-3 font-medium">{recipient.buyerName}</td>
                                        <td className="px-4 py-3">{recipient.orderNumber}</td>
                                        <td className="px-4 py-3 font-mono text-xs">{recipient.phone ? maskPhone(recipient.phone) : "—"}</td>
                                        <td className="px-4 py-3">{STATUS_LABEL[recipient.status]}</td>
                                        <td className="px-4 py-3">{formatDate(recipient.sentAt)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                <p className="text-xs leading-relaxed text-muted-foreground">
                    “Terkirim ke gateway” berarti WhatsApp menerima pesan untuk diproses; status itu belum memastikan penerima telah membaca pesan. Pesan yang hasilnya belum pasti ditandai “Perlu dicek” dan tidak dimasukkan ke kirim ulang otomatis agar tidak terkirim ganda.
                </p>
            </section>
        </div>
    );
}
