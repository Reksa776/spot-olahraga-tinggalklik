"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { apiFetch, ClientApiError } from "./api";
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
import {
    DataTable,
    ErrorBlock,
    PrimaryAction,
    SectionCard,
    StatusBadge,
} from "@/components/dashboard/primitives";

/**
 * ==========================================
 * VENUE MANAGER (decision D-64)
 * ==========================================
 *
 * Creates and edits **private** venues for one organizer. Global venues are deliberately
 * not created here: they require the platform-scope `venue.manage.global` permission and
 * live under the admin surface, so this component never offers the option.
 *
 * Global venues are shown to the organizer because they are readable (they are shared
 * by design) but their edit controls are absent — and if a request were made anyway, the
 * API answers `FORBIDDEN` because the actor lacks the platform permission. The absence
 * of a button is convenience; the permission check is the control.
 *
 * PHASE (shadcn migration): presentation only. The `payload` shape sent to the API, the
 * create-vs-edit branch, `reset()`/`startEdit()` semantics, the `busy` gate, the verbatim
 * error surfacing of the API's own message, and the global-venue read-only rule are unchanged.
 * The delete confirmation is the shadcn `Dialog`, gating the same `DELETE`. `capacity` stays a
 * string in state and is converted exactly as before, so the `""` → `null` rule and `Number(...)`
 * coercion are identical.
 */

type Venue = {
    id: string;
    name: string;
    city: string | null;
    address: string | null;
    capacity: number | null;
    isGlobal: boolean;
    eventCount: number;
};

type Props = {
    organizerId: string;
    venues: Venue[];
};

export default function VenueManager({ organizerId, venues }: Props) {
    const router = useRouter();

    const [editingId, setEditingId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingDelete, setPendingDelete] = useState<string | null>(null);

    const [form, setForm] = useState({
        name: "",
        city: "",
        address: "",
        capacity: "",
    });

    function reset() {
        setForm({ name: "", city: "", address: "", capacity: "" });
        setEditingId(null);
        setError(null);
    }

    function startEdit(venue: Venue) {
        setEditingId(venue.id);
        setError(null);
        setForm({
            name: venue.name,
            city: venue.city ?? "",
            address: venue.address ?? "",
            capacity: venue.capacity === null ? "" : String(venue.capacity),
        });
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
                await apiFetch(`/api/organizer/venues/${editingId}`, {
                    method: "PATCH",
                    body: JSON.stringify(payload),
                });
            } else {
                // `organizerId` is the ownership TARGET. The API authorizes it; it is
                // never treated as authority.
                await apiFetch("/api/organizer/venues", {
                    method: "POST",
                    body: JSON.stringify({ ...payload, organizerId }),
                });
            }

            reset();
            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError
                    ? caught.message
                    : "Terjadi kesalahan."
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
            await apiFetch(`/api/organizer/venues/${venueId}`, { method: "DELETE" });
            router.refresh();
        } catch (caught) {
            // A venue still referenced by an event is refused with the event count, so
            // the operator knows why. That message is shown verbatim.
            setError(
                caught instanceof ClientApiError
                    ? caught.message
                    : "Gagal menghapus venue."
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col gap-6">
            <SectionCard
                title="Daftar venue"
                description={`${venues.length} venue terbaca untuk organizer ini`}
            >
                <DataTable
                    minWidth={820}
                    columns={[
                        { header: "Venue" },
                        { header: "Kota" },
                        { header: "Kapasitas", align: "right" },
                        { header: "Event", align: "right" },
                        { header: "Kepemilikan" },
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
                            <StatusBadge key="owner" tone={venue.isGlobal ? "info" : "neutral"}>
                                {venue.isGlobal ? "Global" : "Milik organizer"}
                            </StatusBadge>,
                            venue.isGlobal ? (
                                <span
                                    className="text-xs text-muted-foreground"
                                    key="managed"
                                >
                                    Dikelola platform
                                </span>
                            ) : (
                                <div
                                    className="flex flex-nowrap justify-end gap-1"
                                    key="actions"
                                >
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => startEdit(venue)}
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
                                </div>
                            ),
                        ],
                    }))}
                />
            </SectionCard>

            {error ? <ErrorBlock message={error} title="Operasi gagal" /> : null}

            <SectionCard title={editingId ? "Ubah venue" : "Tambah venue organizer"}>
                <form onSubmit={submit} className="flex flex-col gap-5">
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                        <Field label="Nama venue" required htmlFor="venue-name">
                            <Input
                                id="venue-name"
                                required
                                minLength={2}
                                value={form.name}
                                onChange={(event) =>
                                    setForm({ ...form, name: event.currentTarget.value })
                                }
                            />
                        </Field>

                        <Field label="Kota" htmlFor="venue-city">
                            <Input
                                id="venue-city"
                                value={form.city}
                                onChange={(event) =>
                                    setForm({ ...form, city: event.currentTarget.value })
                                }
                            />
                        </Field>
                    </div>

                    <Field label="Alamat" htmlFor="venue-address">
                        <Input
                            id="venue-address"
                            value={form.address}
                            onChange={(event) =>
                                setForm({ ...form, address: event.currentTarget.value })
                            }
                        />
                    </Field>

                    <Field label="Kapasitas" htmlFor="venue-capacity">
                        <Input
                            id="venue-capacity"
                            type="number"
                            min={0}
                            value={form.capacity}
                            // Kept as the raw string so the "" → null rule in the payload is
                            // byte-for-byte the previous behaviour.
                            onChange={(event) =>
                                setForm({ ...form, capacity: event.currentTarget.value })
                            }
                        />
                    </Field>

                    <div className="flex flex-wrap items-center gap-2">
                        <PrimaryAction loading={busy}>
                            {busy
                                ? "Menyimpan…"
                                : editingId
                                  ? "Simpan perubahan"
                                  : "Tambah venue"}
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
                        <DialogTitle>Hapus venue ini?</DialogTitle>
                        <DialogDescription>
                            Venue yang masih dipakai event akan ditolak oleh server, beserta
                            jumlah event yang memakainya.
                        </DialogDescription>
                    </DialogHeader>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setPendingDelete(null)}
                        >
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
