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
 * Platform-global venue manager (decision D-64).
 *
 * Talks to `/api/admin/venues`, which requires the platform-scope
 * `venue.manage.global` permission. This component never sends an `organizerId` — the
 * global route does not read one, so ownership cannot be influenced from here.
 *
 * PHASE (shadcn migration): presentation only. The two payloads, the create-vs-edit branch,
 * `reset()`, the `busy` gate and the verbatim error messages are unchanged; the delete
 * confirmation is the shadcn `Dialog` gating the same `DELETE`, and the empty state that the old
 * table drew as one full-width `<td>` is the shared `EmptyBlock`.
 */

type Venue = {
    id: string;
    name: string;
    city: string | null;
    address: string | null;
    capacity: number | null;
    eventCount: number;
};

export default function GlobalVenueManager({ venues }: { venues: Venue[] }) {
    const router = useRouter();

    const [editingId, setEditingId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingDelete, setPendingDelete] = useState<string | null>(null);
    const [form, setForm] = useState({ name: "", city: "", address: "", capacity: "" });

    function reset() {
        setForm({ name: "", city: "", address: "", capacity: "" });
        setEditingId(null);
        setError(null);
    }

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);

        const payload = {
            name: form.name,
            city: form.city || null,
            address: form.address || null,
            capacity: form.capacity === "" ? null : Number(form.capacity),
        };

        try {
            if (editingId) {
                await apiFetch(`/api/admin/venues/${editingId}`, {
                    method: "PATCH",
                    body: JSON.stringify(payload),
                });
            } else {
                await apiFetch("/api/admin/venues", {
                    method: "POST",
                    body: JSON.stringify(payload),
                });
            }

            reset();
            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError ? caught.message : "Terjadi kesalahan."
            );
        } finally {
            setBusy(false);
        }
    }

    async function remove(venueId: string) {
        setPendingDelete(null);
        setBusy(true);
        setError(null);

        try {
            await apiFetch(`/api/admin/venues/${venueId}`, { method: "DELETE" });
            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError ? caught.message : "Gagal menghapus."
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col gap-6">
            <SectionCard
                title="Daftar venue global"
                description={`${venues.length} venue kanonik`}
            >
                <DataTable
                    minWidth={780}
                    empty={
                        <EmptyBlock
                            title="Belum ada venue global"
                            description="Venue kanonik ditambahkan di sini agar bisa dipakai semua organizer."
                        />
                    }
                    columns={[
                        { header: "Venue" },
                        { header: "Kota" },
                        { header: "Kapasitas", align: "right" },
                        { header: "Dipakai event", align: "right" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={venues.map((venue) => ({
                        key: venue.id,
                        cells: [
                            <span className="text-sm font-semibold" key="name">
                                {venue.name}
                            </span>,
                            <span className="text-sm text-muted-foreground" key="city">
                                {venue.city ?? "—"}
                            </span>,
                            <span className="text-sm tabular-nums" key="capacity">
                                {venue.capacity?.toLocaleString("id-ID") ?? "—"}
                            </span>,
                            <span className="text-sm tabular-nums" key="events">
                                {venue.eventCount}
                            </span>,
                            <div
                                className="flex flex-nowrap justify-end gap-1"
                                key="actions"
                            >
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        setEditingId(venue.id);
                                        setForm({
                                            name: venue.name,
                                            city: venue.city ?? "",
                                            address: venue.address ?? "",
                                            capacity:
                                                venue.capacity === null
                                                    ? ""
                                                    : String(venue.capacity),
                                        });
                                    }}
                                >
                                    Ubah
                                </Button>

                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => setPendingDelete(venue.id)}
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

            <SectionCard title={editingId ? "Ubah venue global" : "Tambah venue global"}>
                <form onSubmit={submit} className="flex flex-col gap-5">
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                        <Field label="Nama venue" required htmlFor="global-venue-name">
                            <Input
                                id="global-venue-name"
                                required
                                minLength={2}
                                value={form.name}
                                onChange={(event) =>
                                    setForm({ ...form, name: event.currentTarget.value })
                                }
                            />
                        </Field>

                        <Field label="Kota" htmlFor="global-venue-city">
                            <Input
                                id="global-venue-city"
                                value={form.city}
                                onChange={(event) =>
                                    setForm({ ...form, city: event.currentTarget.value })
                                }
                            />
                        </Field>
                    </div>

                    <Field label="Alamat" htmlFor="global-venue-address">
                        <Input
                            id="global-venue-address"
                            value={form.address}
                            onChange={(event) =>
                                setForm({ ...form, address: event.currentTarget.value })
                            }
                        />
                    </Field>

                    <Field label="Kapasitas" htmlFor="global-venue-capacity">
                        <Input
                            id="global-venue-capacity"
                            type="number"
                            min={0}
                            value={form.capacity}
                            onChange={(event) =>
                                setForm({ ...form, capacity: event.currentTarget.value })
                            }
                        />
                    </Field>

                    <div className="flex flex-wrap items-center gap-2">
                        <PrimaryAction loading={busy}>
                            {busy ? "Menyimpan…" : editingId ? "Simpan" : "Tambah"}
                        </PrimaryAction>

                        {editingId ? (
                            <Button type="button" variant="outline" onClick={reset}>
                                Batal
                            </Button>
                        ) : null}
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
                        <DialogTitle>Hapus venue global ini?</DialogTitle>
                        <DialogDescription>
                            Venue yang masih dipakai event akan ditolak oleh server.
                        </DialogDescription>
                    </DialogHeader>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPendingDelete(null)}>
                            Batal
                        </Button>

                        <Button
                            variant="destructive"
                            disabled={busy}
                            onClick={() => pendingDelete && remove(pendingDelete)}
                        >
                            Hapus
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
