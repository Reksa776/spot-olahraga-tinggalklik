"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { apiFetch, ClientApiError } from "@/components/organizer/api";
import {
    DataTable,
    EmptyBlock,
    ErrorBlock,
    PrimaryAction,
    SectionCard,
    StatusBadge,
    type Tone,
} from "@/components/dashboard/primitives";
import { Button } from "@/components/dashboard/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/dashboard/ui/dialog";
import { Field, Input } from "@/components/dashboard/ui/input";

/**
 * PIC management (platform scope).
 *
 * Talks to `/api/admin/pic`, which requires the platform-scope `pic.manage` permission. That is a
 * PLATFORM permission, not an organizer one: an organizer OWNER or MANAGER cannot approve a PIC,
 * because approval is the platform deciding that an outside referrer may sell on its behalf.
 *
 * ── WHAT THIS SURFACE DELIBERATELY DOES NOT DO ────────────────────────────────────
 * It does not create accounts. A PIC is a User with a `PICProfile` — the model's own definition —
 * so the create form links an EXISTING account by e-mail and the service refuses an address that
 * has no account. It also does not edit the fee rate: `defaultFeeRateBp` is set at creation and the
 * per-event override lives on the assignment surface, because a rate is a commercial decision that
 * an operator should make in one named place rather than in whichever form happens to be open.
 *
 * ── STATUS ────────────────────────────────────────────────────────────────────────
 * The three transitions the API accepts are ACTIVE, SUSPENDED and REJECTED. `PENDING` is the
 * creation state and is not settable here. Suspending asks for a reason, because the profile stores
 * one and a suspension without a recorded reason is what an appeal cannot be answered from.
 */

type PicStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "REJECTED";

export type PicRow = {
    id: string;
    picCode: string;
    displayName: string;
    status: PicStatus;
    defaultFeeRateBp: number;
    canSellAllEvents: boolean;
    approvedAt: string | null;
    suspendedAt: string | null;
    suspendReason: string | null;
    createdAt: string;
    account: { name: string | null; email: string | null; phone: string | null };
    counts: { assignments: number; attributions: number; orders: number };
    ledgerTotal: string;
};

const STATUS_TONE: Record<PicStatus, Tone> = {
    PENDING: "pending",
    ACTIVE: "success",
    SUSPENDED: "warn",
    REJECTED: "error",
};

const STATUS_LABEL: Record<PicStatus, string> = {
    PENDING: "Menunggu",
    ACTIVE: "Aktif",
    SUSPENDED: "Ditangguhkan",
    REJECTED: "Ditolak",
};

/** Basis points → a human percentage. `0` is not "0%", it is the schema's "inherit". */
function formatFeeRate(bp: number): string {
    if (bp === 0) {
        return "Ikut default";
    }

    return `${(bp / 100).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;
}

function formatRupiah(value: string): string {
    const numeric = Number(value);

    if (!Number.isFinite(numeric)) {
        return value;
    }

    return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
    }).format(numeric);
}

export default function PicManager({ pics }: { pics: PicRow[] }) {
    const router = useRouter();

    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [form, setForm] = useState({
        email: "",
        displayName: "",
        picCode: "",
        defaultFeeRateBp: "",
    });
    const [pendingSuspend, setPendingSuspend] = useState<PicRow | null>(null);
    const [suspendReason, setSuspendReason] = useState("");

    async function run(call: () => Promise<unknown>) {
        setBusy(true);
        setError(null);

        try {
            await call();
            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError ? caught.message : "Terjadi kesalahan."
            );
        } finally {
            setBusy(false);
        }
    }

    /** PATCH one status transition. `reason` is only sent for SUSPENDED. */
    async function setStatus(pic: PicRow, status: PicStatus, reason?: string) {
        await run(() =>
            apiFetch(`/api/admin/pic/${pic.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                    status,
                    ...(reason ? { reason } : {}),
                }),
            })
        );
    }

    async function create(event: React.FormEvent) {
        event.preventDefault();

        // The rate field is a percentage in the UI and basis points on the wire, so the conversion
        // happens exactly once, here. An empty field means "inherit" (0) and is omitted, letting the
        // schema default apply rather than sending a number the operator did not choose.
        const ratePercent = form.defaultFeeRateBp.trim();
        const parsedRate = ratePercent === "" ? null : Number(ratePercent);

        if (parsedRate !== null && (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100)) {
            setError("Tarif harus berupa angka antara 0 dan 100.");
            return;
        }

        await run(() =>
            apiFetch("/api/admin/pic", {
                method: "POST",
                body: JSON.stringify({
                    email: form.email,
                    displayName: form.displayName,
                    ...(form.picCode ? { picCode: form.picCode } : {}),
                    ...(parsedRate === null
                        ? {}
                        : { defaultFeeRateBp: Math.round(parsedRate * 100) }),
                }),
            })
        );

        setForm({ email: "", displayName: "", picCode: "", defaultFeeRateBp: "" });
    }

    async function confirmSuspend() {
        const pic = pendingSuspend;
        const reason = suspendReason.trim();

        setPendingSuspend(null);
        setSuspendReason("");

        if (!pic) return;

        await setStatus(pic, "SUSPENDED", reason || undefined);
    }

    return (
        <div className="flex flex-col gap-6">
            <SectionCard
                title="Daftar PIC"
                description={`${pics.length} profil PIC terdaftar`}
            >
                <DataTable
                    minWidth={900}
                    columns={[
                        { header: "PIC" },
                        { header: "Akun" },
                        { header: "Status" },
                        { header: "Tarif default", align: "right" },
                        { header: "Event", align: "right" },
                        { header: "Order", align: "right" },
                        { header: "Fee ledger", align: "right" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={pics.map((pic) => ({
                        key: pic.id,
                        cells: [
                            <div className="flex flex-col" key="pic">
                                <span className="text-sm font-semibold">
                                    {pic.displayName}
                                </span>
                                <span className="font-mono text-xs text-muted-foreground">
                                    {pic.picCode}
                                </span>
                            </div>,
                            <div className="flex flex-col" key="account">
                                <span className="text-sm">{pic.account.name ?? "—"}</span>
                                <span className="text-xs text-muted-foreground">
                                    {pic.account.email ?? "—"}
                                </span>
                            </div>,
                            <div className="flex flex-col items-start gap-1" key="status">
                                <StatusBadge tone={STATUS_TONE[pic.status]}>
                                    {STATUS_LABEL[pic.status]}
                                </StatusBadge>
                                {pic.canSellAllEvents ? (
                                    <span className="text-xs text-muted-foreground">
                                        Semua event
                                    </span>
                                ) : null}
                            </div>,
                            <span className="text-sm tabular-nums" key="rate">
                                {formatFeeRate(pic.defaultFeeRateBp)}
                            </span>,
                            <span className="text-sm tabular-nums" key="events">
                                {pic.counts.assignments}
                            </span>,
                            <span className="text-sm tabular-nums" key="orders">
                                {pic.counts.orders}
                            </span>,
                            <span className="text-sm tabular-nums" key="ledger">
                                {formatRupiah(pic.ledgerTotal)}
                            </span>,
                            <div className="flex flex-nowrap justify-end gap-1" key="actions">
                                {pic.status !== "ACTIVE" ? (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => setStatus(pic, "ACTIVE")}
                                    >
                                        Aktifkan
                                    </Button>
                                ) : (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => setPendingSuspend(pic)}
                                    >
                                        Tangguhkan
                                    </Button>
                                )}

                                {pic.status !== "REJECTED" ? (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => setStatus(pic, "REJECTED")}
                                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    >
                                        Tolak
                                    </Button>
                                ) : null}

                                <Button variant="ghost" size="sm" asChild>
                                    <Link href={`/platform/pic/${pic.id}`}>Detail</Link>
                                </Button>
                            </div>,
                        ],
                    }))}
                    empty={
                        <EmptyBlock
                            title="Belum ada PIC"
                            description="Tambahkan profil PIC dengan menautkan akun yang sudah terdaftar."
                        />
                    }
                />
            </SectionCard>

            {error ? <ErrorBlock message={error} title="Operasi gagal" /> : null}

            <SectionCard
                title="Tambah PIC"
                description="Profil PIC ditautkan ke akun yang sudah terdaftar. Akun PIC dibuat lewat halaman registrasi seperti pengguna lain, agar kredensial tetap dikelola di satu tempat."
            >
                <form onSubmit={create} className="flex flex-col gap-5">
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                        <Field label="Email akun" required htmlFor="pic-email">
                            <Input
                                id="pic-email"
                                type="email"
                                required
                                value={form.email}
                                onChange={(event) =>
                                    setForm({ ...form, email: event.currentTarget.value })
                                }
                                placeholder="nama@email.com"
                            />
                        </Field>

                        <Field label="Nama tampilan" required htmlFor="pic-name">
                            <Input
                                id="pic-name"
                                required
                                minLength={2}
                                value={form.displayName}
                                onChange={(event) =>
                                    setForm({ ...form, displayName: event.currentTarget.value })
                                }
                            />
                        </Field>

                        <Field label="Kode PIC (opsional)" htmlFor="pic-code">
                            <Input
                                id="pic-code"
                                className="font-mono"
                                value={form.picCode}
                                onChange={(event) =>
                                    setForm({ ...form, picCode: event.currentTarget.value })
                                }
                                placeholder="dibuat otomatis dari nama"
                            />
                        </Field>

                        <Field
                            label="Tarif default % (opsional)"
                            htmlFor="pic-rate"
                            hint="Kosongkan untuk mengikuti default event/organizer. Nilai di sini adalah default pribadi PIC dan masih bisa ditimpa per event."
                        >
                            <Input
                                id="pic-rate"
                                type="number"
                                min={0}
                                max={100}
                                step="0.01"
                                value={form.defaultFeeRateBp}
                                onChange={(event) =>
                                    setForm({
                                        ...form,
                                        defaultFeeRateBp: event.currentTarget.value,
                                    })
                                }
                            />
                        </Field>
                    </div>

                    <div>
                        <PrimaryAction loading={busy}>
                            {busy ? "Menyimpan…" : "Tambah PIC"}
                        </PrimaryAction>
                    </div>
                </form>
            </SectionCard>

            <Dialog
                open={pendingSuspend !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setPendingSuspend(null);
                        setSuspendReason("");
                    }
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Tangguhkan PIC?</DialogTitle>
                        <DialogDescription>
                            Tangguhkan &quot;{pendingSuspend?.displayName}&quot;? PIC yang
                            ditangguhkan tidak bisa lagi ditugaskan ke event baru, namun
                            penugasan dan fee yang sudah tercatat tetap tersimpan. Alasan
                            dicatat pada profil dan pada audit log.
                        </DialogDescription>
                    </DialogHeader>

                    <Field label="Alasan (opsional)" htmlFor="pic-suspend-reason">
                        <Input
                            id="pic-suspend-reason"
                            value={suspendReason}
                            onChange={(event) => setSuspendReason(event.currentTarget.value)}
                            maxLength={500}
                        />
                    </Field>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setPendingSuspend(null);
                                setSuspendReason("");
                            }}
                        >
                            Batal
                        </Button>

                        <Button disabled={busy} onClick={confirmSuspend}>
                            Tangguhkan
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
