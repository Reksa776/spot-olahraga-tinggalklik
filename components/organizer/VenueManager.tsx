"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
    Button,
    Group,
    Modal,
    NumberInput,
    SimpleGrid,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";

import { apiFetch, ClientApiError } from "./api";
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
 * PHASE (Mantine body migration): presentation only. The `payload` shape sent to the API, the
 * create-vs-edit branch, `reset()`/`startEdit()` semantics, the `busy` gate, the verbatim
 * error surfacing of the API's own message, and the global-venue read-only rule are unchanged.
 * The delete confirmation moved from `window.confirm` to a Mantine `Modal` gating the same
 * `DELETE` (§13). `capacity` stays a string in state and is converted exactly as before, so the
 * `""` → `null` rule and `Number(...)` coercion are identical.
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
        <Stack gap="lg">
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
                            <Text size="sm" fw={600} key="name">
                                {venue.name}
                            </Text>,
                            <Text size="sm" key="city">
                                {venue.city ?? "—"}
                            </Text>,
                            <Text size="sm" key="capacity">
                                {venue.capacity?.toLocaleString("id-ID") ?? "—"}
                            </Text>,
                            <Text size="sm" key="events">
                                {venue.eventCount}
                            </Text>,
                            <StatusBadge key="owner" tone={venue.isGlobal ? "info" : "neutral"}>
                                {venue.isGlobal ? "Global" : "Milik organizer"}
                            </StatusBadge>,
                            venue.isGlobal ? (
                                <Text size="xs" c="dimmed" key="managed">
                                    Dikelola platform
                                </Text>
                            ) : (
                                <Group gap="xs" justify="flex-end" wrap="nowrap" key="actions">
                                    <Button
                                        variant="subtle"
                                        size="sm"
                                        color="brand"
                                        onClick={() => startEdit(venue)}
                                    >
                                        Ubah
                                    </Button>

                                    <Button
                                        variant="subtle"
                                        size="sm"
                                        color="red"
                                        disabled={busy}
                                        onClick={() => setPendingDelete(venue.id)}
                                    >
                                        Hapus
                                    </Button>
                                </Group>
                            ),
                        ],
                    }))}
                />
            </SectionCard>

            {error ? <ErrorBlock message={error} title="Operasi gagal" /> : null}

            <SectionCard title={editingId ? "Ubah venue" : "Tambah venue organizer"}>
                <form onSubmit={submit}>
                    <Stack gap="md">
                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <TextInput
                                label="Nama venue"
                                required
                                minLength={2}
                                size="md"
                                value={form.name}
                                onChange={(event) =>
                                    setForm({ ...form, name: event.currentTarget.value })
                                }
                            />

                            <TextInput
                                label="Kota"
                                size="md"
                                value={form.city}
                                onChange={(event) =>
                                    setForm({ ...form, city: event.currentTarget.value })
                                }
                            />
                        </SimpleGrid>

                        <TextInput
                            label="Alamat"
                            size="md"
                            value={form.address}
                            onChange={(event) =>
                                setForm({ ...form, address: event.currentTarget.value })
                            }
                        />

                        <NumberInput
                            label="Kapasitas"
                            size="md"
                            min={0}
                            value={form.capacity}
                            // Kept as the raw string so the "" → null rule in the payload is
                            // byte-for-byte the previous behaviour.
                            onChange={(value) =>
                                setForm({ ...form, capacity: value === "" ? "" : String(value) })
                            }
                        />

                        <Group>
                            <PrimaryAction loading={busy}>
                                {busy
                                    ? "Menyimpan…"
                                    : editingId
                                      ? "Simpan perubahan"
                                      : "Tambah venue"}
                            </PrimaryAction>

                            {editingId ? (
                                <Button variant="default" size="md" onClick={reset}>
                                    Batal
                                </Button>
                            ) : null}
                        </Group>
                    </Stack>
                </form>
            </SectionCard>

            <Modal
                opened={pendingDelete !== null}
                onClose={() => setPendingDelete(null)}
                title="Hapus venue ini?"
                centered
            >
                <Text size="sm">
                    Venue yang masih dipakai event akan ditolak oleh server, beserta jumlah
                    event yang memakainya.
                </Text>

                <Group justify="flex-end" mt="lg">
                    <Button variant="default" size="md" onClick={() => setPendingDelete(null)}>
                        Batal
                    </Button>

                    <Button
                        color="red"
                        size="md"
                        loading={busy}
                        onClick={() => pendingDelete && remove(pendingDelete)}
                    >
                        Hapus
                    </Button>
                </Group>
            </Modal>
        </Stack>
    );
}
