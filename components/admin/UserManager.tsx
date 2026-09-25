"use client";

import { useState } from "react";
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
 * ==========================================
 * USER MANAGEMENT V1 (PHASE 33 — ADMIN ONLY)
 * ==========================================
 *
 * The client half of `/dashboard/users`: the list table, the create form and the
 * enable/disable confirm. It talks only to `/api/admin/users*`, both of which re-enforce
 * `user.manage` server-side — this component is convenience, never authority.
 *
 * ── WHAT THE CREATE FORM OFFERS ────────────────────────────────────────────────
 * Exactly the two fixed role choices (brief §M): MANAGER and PIC. There is no ADMIN
 * option and no free-form role field — the select's options ARE the contract, and the
 * server's Zod enum would refuse anything else anyway. Choosing PIC reveals only the
 * profile fields the schema needs (display name, optional code, optional default rate);
 * no bank data is collected here, because settlement collects it when money actually
 * moves and this surface must not become a second place that stores it.
 *
 * ── WHAT THE LIST SHOWS ─────────────────────────────────────────────────────────
 * Name, email, role, status and the PIC profile identity when one exists, so "PIC
 * Account" (the User row, with login status) is visibly distinct from "PIC Profile"
 * (the business row, with its PENDING/ACTIVE/SUSPENDED state). Assignment counts are
 * deliberately absent — event assignment is a separate flow, not an attribute managed
 * here (brief §U: do not confuse assignment with account).
 */

type PicProfileStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "REJECTED";

export type ManagedUserRow = {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    platformRole: "MANAGER" | "PIC";
    disabled: boolean;
    disabledAt: string | null;
    createdAt: string;
    picProfile: {
        id: string;
        picCode: string;
        displayName: string;
        status: PicProfileStatus;
    } | null;
};

const PIC_STATUS_TONE: Record<PicProfileStatus, Tone> = {
    PENDING: "pending",
    ACTIVE: "success",
    SUSPENDED: "warn",
    REJECTED: "error",
};

const PIC_STATUS_LABEL: Record<PicProfileStatus, string> = {
    PENDING: "Menunggu",
    ACTIVE: "Aktif",
    SUSPENDED: "Ditangguhkan",
    REJECTED: "Ditolak",
};

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

export default function UserManager({ users }: { users: ManagedUserRow[] }) {
    const router = useRouter();

    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [pendingToggle, setPendingToggle] = useState<ManagedUserRow | null>(null);

    const [form, setForm] = useState({
        name: "",
        email: "",
        password: "",
        role: "MANAGER",
        picDisplayName: "",
        picCode: "",
        picRatePercent: "",
    });

    async function run(call: () => Promise<string | void>) {
        setBusy(true);
        setError(null);
        setNotice(null);

        try {
            const message = await call();
            if (message) setNotice(message);
            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError ? caught.message : "Terjadi kesalahan."
            );
        } finally {
            setBusy(false);
        }
    }

    async function create(event: React.FormEvent) {
        event.preventDefault();

        const ratePercent = form.picRatePercent.trim();
        const parsedRate = ratePercent === "" ? null : Number(ratePercent);

        if (
            form.role === "PIC" &&
            parsedRate !== null &&
            (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100)
        ) {
            setError("Tarif harus berupa angka antara 0 dan 100.");
            return;
        }

        await run(async () => {
            await apiFetch("/api/admin/users", {
                method: "POST",
                body: JSON.stringify({
                    name: form.name,
                    email: form.email,
                    password: form.password,
                    role: form.role,
                    ...(form.role === "PIC"
                        ? {
                              pic: {
                                  ...(form.picDisplayName
                                      ? { displayName: form.picDisplayName }
                                      : {}),
                                  ...(form.picCode ? { picCode: form.picCode } : {}),
                                  ...(parsedRate === null
                                      ? {}
                                      : { defaultFeeRateBp: Math.round(parsedRate * 100) }),
                              },
                          }
                        : {}),
                }),
            });

            setShowCreate(false);
            setForm({
                name: "",
                email: "",
                password: "",
                role: "MANAGER",
                picDisplayName: "",
                picCode: "",
                picRatePercent: "",
            });

            return `Akun ${form.role} dibuat. Berikan kredensial kepada pengguna secara aman — password tidak akan ditampilkan lagi.`;
        });
    }

    async function confirmToggle() {
        const user = pendingToggle;
        setPendingToggle(null);

        if (!user) return;

        await run(() =>
            apiFetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
                method: "PATCH",
                body: JSON.stringify({ disabled: !user.disabled }),
            }).then(() =>
                user.disabled
                    ? "Akun diaktifkan kembali."
                    : "Akun dinonaktifkan. Login dan akses dashboard ditolak sampai diaktifkan lagi."
            )
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <SectionCard
                title="Daftar pengguna"
                description={`${users.length} akun MANAGER/PIC dikelola`}
                actions={
                    <PrimaryAction type="button" onClick={() => setShowCreate(true)}>
                        + Tambah Pengguna
                    </PrimaryAction>
                }
            >
                <DataTable
                    minWidth={980}
                    columns={[
                        { header: "Nama" },
                        { header: "Email" },
                        { header: "Peran" },
                        { header: "Status akun" },
                        { header: "Profil PIC" },
                        { header: "Dibuat" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={users.map((user) => ({
                        key: user.id,
                        cells: [
                            <span className="text-sm font-semibold" key="name">
                                {user.name ?? "—"}
                            </span>,
                            <span className="text-sm" key="email">
                                {user.email ?? "—"}
                            </span>,
                            <StatusBadge key="role" tone="info">
                                {user.platformRole}
                            </StatusBadge>,
                            <span
                                className="flex flex-col items-start gap-1"
                                key="accountStatus"
                            >
                                <StatusBadge tone={user.disabled ? "error" : "success"}>
                                    {user.disabled ? "Nonaktif" : "Aktif"}
                                </StatusBadge>
                                {user.disabledAt ? (
                                    <span className="text-xs text-muted-foreground">
                                        sejak {DATE_FORMAT.format(new Date(user.disabledAt))}
                                    </span>
                                ) : null}
                            </span>,
                            user.picProfile ? (
                                <span className="flex flex-col items-start gap-1" key="pic">
                                    <span className="font-mono text-xs">
                                        {user.picProfile.picCode}
                                    </span>
                                    <StatusBadge
                                        size="sm"
                                        tone={PIC_STATUS_TONE[user.picProfile.status]}
                                    >
                                        {PIC_STATUS_LABEL[user.picProfile.status]}
                                    </StatusBadge>
                                </span>
                            ) : (
                                <span
                                    className="text-xs text-muted-foreground"
                                    key="pic"
                                >
                                    —
                                </span>
                            ),
                            <span className="text-xs text-muted-foreground" key="created">
                                {DATE_FORMAT.format(new Date(user.createdAt))}
                            </span>,
                            <span
                                className="flex flex-nowrap justify-end gap-1"
                                key="actions"
                            >
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => setPendingToggle(user)}
                                    className={
                                        user.disabled
                                            ? undefined
                                            : "text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    }
                                >
                                    {user.disabled ? "Aktifkan" : "Nonaktifkan"}
                                </Button>
                            </span>,
                        ],
                    }))}
                    empty={
                        <EmptyBlock
                            title="Belum ada pengguna"
                            description="Buat akun MANAGER atau PIC dengan tombol Tambah Pengguna."
                        />
                    }
                />
            </SectionCard>

            {notice ? (
                <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>
            ) : null}
            {error ? <ErrorBlock message={error} title="Operasi gagal" /> : null}

            <Dialog open={showCreate} onOpenChange={setShowCreate}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Tambah Pengguna</DialogTitle>
                        <DialogDescription>
                            Buat akun operasional baru. Pilihan peran tetap: Manager dan
                            PIC. Akun PIC dibuat beserta profil PIC-nya (status awal
                            Menunggu) dan siap ditugaskan ke event setelah diaktifkan.
                        </DialogDescription>
                    </DialogHeader>

                    <form onSubmit={create} className="flex flex-col gap-5">
                        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                            <Field label="Nama" required htmlFor="user-name">
                                <Input
                                    id="user-name"
                                    required
                                    minLength={2}
                                    value={form.name}
                                    onChange={(event) =>
                                        setForm({ ...form, name: event.currentTarget.value })
                                    }
                                />
                            </Field>

                            <Field label="Email" required htmlFor="user-email">
                                <Input
                                    id="user-email"
                                    type="email"
                                    required
                                    value={form.email}
                                    onChange={(event) =>
                                        setForm({ ...form, email: event.currentTarget.value })
                                    }
                                    placeholder="nama@email.com"
                                />
                            </Field>

                            <Field
                                label="Password"
                                required
                                htmlFor="user-password"
                                hint="Minimal 8 karakter, dengan huruf besar, huruf kecil, dan angka."
                            >
                                <Input
                                    id="user-password"
                                    type="password"
                                    required
                                    minLength={8}
                                    value={form.password}
                                    onChange={(event) =>
                                        setForm({
                                            ...form,
                                            password: event.currentTarget.value,
                                        })
                                    }
                                />
                            </Field>

                            <Field label="Peran" required htmlFor="user-role">
                                <select
                                    id="user-role"
                                    required
                                    value={form.role}
                                    onChange={(event) =>
                                        setForm({ ...form, role: event.currentTarget.value })
                                    }
                                    className="flex h-9 w-full rounded-field border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors"
                                >
                                    <option value="MANAGER">Manager</option>
                                    <option value="PIC">PIC</option>
                                </select>
                            </Field>

                            {form.role === "PIC" ? (
                                <>
                                    <Field
                                        label="Nama tampilan PIC"
                                        htmlFor="user-pic-name"
                                        hint="Kosongkan untuk memakai nama akun."
                                    >
                                        <Input
                                            id="user-pic-name"
                                            value={form.picDisplayName}
                                            onChange={(event) =>
                                                setForm({
                                                    ...form,
                                                    picDisplayName:
                                                        event.currentTarget.value,
                                                })
                                            }
                                        />
                                    </Field>

                                    <Field
                                        label="Kode PIC (opsional)"
                                        htmlFor="user-pic-code"
                                    >
                                        <Input
                                            id="user-pic-code"
                                            className="font-mono"
                                            value={form.picCode}
                                            onChange={(event) =>
                                                setForm({
                                                    ...form,
                                                    picCode: event.currentTarget.value,
                                                })
                                            }
                                            placeholder="dibuat otomatis dari nama"
                                        />
                                    </Field>

                                    <Field
                                        label="Tarif default % (opsional)"
                                        htmlFor="user-pic-rate"
                                        hint="Kosongkan untuk mengikuti default event/organizer."
                                    >
                                        <Input
                                            id="user-pic-rate"
                                            type="number"
                                            min={0}
                                            max={100}
                                            step="0.01"
                                            value={form.picRatePercent}
                                            onChange={(event) =>
                                                setForm({
                                                    ...form,
                                                    picRatePercent:
                                                        event.currentTarget.value,
                                                })
                                            }
                                        />
                                    </Field>
                                </>
                            ) : null}
                        </div>

                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setShowCreate(false)}
                            >
                                Batal
                            </Button>

                            <PrimaryAction loading={busy}>
                                {busy ? "Menyimpan…" : "Buat akun"}
                            </PrimaryAction>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            <Dialog
                open={pendingToggle !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingToggle(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {pendingToggle?.disabled
                                ? "Aktifkan akun?"
                                : "Nonaktifkan akun?"}
                        </DialogTitle>
                        <DialogDescription>
                            {pendingToggle?.disabled
                                ? `Aktifkan kembali "${pendingToggle?.name}"? Pengguna dapat login dan mengakses dashboard seperti sebelumnya.`
                                : `Nonaktifkan "${pendingToggle?.name}"? Login akan ditolak dan seluruh akses dashboard berhenti. Data dan riwayat tidak dihapus, dan akun dapat diaktifkan kembali.`}
                        </DialogDescription>
                    </DialogHeader>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setPendingToggle(null)}
                        >
                            Batal
                        </Button>

                        <Button disabled={busy} onClick={confirmToggle}>
                            {pendingToggle?.disabled ? "Aktifkan" : "Nonaktifkan"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
