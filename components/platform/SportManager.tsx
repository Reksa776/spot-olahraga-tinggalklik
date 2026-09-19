"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { apiFetch, ClientApiError } from "@/components/organizer/api";
import {
    DataTable,
    ErrorBlock,
    PrimaryAction,
    SectionCard,
    StatusBadge,
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
 * Sport master-data manager (requirement brief §15).
 *
 * Talks to `/api/admin/sports`, which requires the platform-scope `sport.manage`
 * permission. Deactivation is offered prominently next to delete because retiring a
 * sport that historical events used is only possible by deactivating it — deleting is
 * refused while any event references it, and the API says so.
 *
 * PHASE (shadcn migration): presentation only. The `run()` wrapper, both `apiFetch`
 * payloads, the `busy` gate, `router.refresh()`, the client-side validation attributes
 * (`required`, `minLength={2}`) and the exact error messages are unchanged. The delete
 * confirmation is the shadcn `Dialog`, still gating the identical `DELETE` call behind the same
 * Yes/No decision.
 */

type Sport = {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    sortOrder: number;
    eventCount: number;
};

export default function SportManager({ sports }: { sports: Sport[] }) {
    const router = useRouter();

    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [form, setForm] = useState({ name: "", slug: "" });
    const [pendingDelete, setPendingDelete] = useState<Sport | null>(null);

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

    async function create(event: React.FormEvent) {
        event.preventDefault();

        await run(() =>
            apiFetch("/api/admin/sports", {
                method: "POST",
                body: JSON.stringify({
                    name: form.name,
                    ...(form.slug ? { slug: form.slug } : {}),
                }),
            })
        );

        setForm({ name: "", slug: "" });
    }

    async function confirmDelete() {
        const sport = pendingDelete;
        setPendingDelete(null);

        if (!sport) return;

        await run(() => apiFetch(`/api/admin/sports/${sport.id}`, { method: "DELETE" }));
    }

    return (
        <div className="flex flex-col gap-6">
            <SectionCard
                title="Cabang olahraga"
                description={`${sports.length} cabang terdaftar`}
            >
                <DataTable
                    minWidth={720}
                    columns={[
                        { header: "Cabang olahraga" },
                        { header: "Slug" },
                        { header: "Urutan", align: "right" },
                        { header: "Dipakai event", align: "right" },
                        { header: "Status" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={sports.map((sport) => ({
                        key: sport.id,
                        cells: [
                            <span className="text-sm font-semibold" key="name">
                                {sport.name}
                            </span>,
                            <span className="font-mono text-xs" key="slug">
                                {sport.slug}
                            </span>,
                            <span className="text-sm tabular-nums" key="order">
                                {sport.sortOrder}
                            </span>,
                            <span className="text-sm tabular-nums" key="events">
                                {sport.eventCount}
                            </span>,
                            <StatusBadge
                                key="status"
                                tone={sport.isActive ? "success" : "neutral"}
                            >
                                {sport.isActive ? "Aktif" : "Nonaktif"}
                            </StatusBadge>,
                            <div
                                className="flex flex-nowrap justify-end gap-1"
                                key="actions"
                            >
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                        run(() =>
                                            apiFetch(`/api/admin/sports/${sport.id}`, {
                                                method: "PATCH",
                                                body: JSON.stringify({
                                                    isActive: !sport.isActive,
                                                }),
                                            })
                                        )
                                    }
                                >
                                    {sport.isActive ? "Nonaktifkan" : "Aktifkan"}
                                </Button>

                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => setPendingDelete(sport)}
                                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                >
                                    Hapus
                                </Button>
                            </div>,
                        ],
                    }))}
                />
            </SectionCard>

            {error ? <ErrorBlock message={error} title="Operasi gagal" /> : null}

            <SectionCard title="Tambah cabang olahraga">
                <form onSubmit={create} className="flex flex-col gap-5">
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                        <Field label="Nama" required htmlFor="sport-name">
                            <Input
                                id="sport-name"
                                required
                                minLength={2}
                                value={form.name}
                                onChange={(event) =>
                                    setForm({ ...form, name: event.currentTarget.value })
                                }
                            />
                        </Field>

                        <Field label="Slug (opsional)" htmlFor="sport-slug">
                            <Input
                                id="sport-slug"
                                className="font-mono"
                                value={form.slug}
                                onChange={(event) =>
                                    setForm({ ...form, slug: event.currentTarget.value })
                                }
                                placeholder="dibuat otomatis dari nama"
                            />
                        </Field>
                    </div>

                    <div>
                        <PrimaryAction loading={busy}>
                            {busy ? "Menyimpan…" : "Tambah"}
                        </PrimaryAction>
                    </div>
                </form>
            </SectionCard>

            <Dialog
                open={pendingDelete !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingDelete(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Hapus cabang olahraga?</DialogTitle>
                        <DialogDescription>
                            Hapus cabang olahraga &quot;{pendingDelete?.name}&quot;? Cabang
                            yang masih dipakai event akan ditolak oleh server.
                        </DialogDescription>
                    </DialogHeader>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPendingDelete(null)}>
                            Batal
                        </Button>

                        <Button
                            variant="destructive"
                            disabled={busy}
                            onClick={confirmDelete}
                        >
                            Hapus
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
