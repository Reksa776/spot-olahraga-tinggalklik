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

import { apiFetch, ClientApiError } from "@/components/organizer/api";
import {
    DataTable,
    EmptyBlock,
    ErrorBlock,
    PrimaryAction,
    SectionCard,
} from "@/components/dashboard/primitives";

/**
 * Platform-global venue manager (decision D-64).
 *
 * Talks to `/api/admin/venues`, which requires the platform-scope
 * `venue.manage.global` permission. This component never sends an `organizerId` — the
 * global route does not read one, so ownership cannot be influenced from here.
 *
 * PHASE (Mantine body migration): presentation only. The two payloads, the create-vs-edit
 * branch, `reset()`, the `busy` gate and the verbatim error messages are unchanged; the delete
 * confirmation is a Mantine `Modal` gating the same `DELETE` (§13), and the empty state that the
 * old table drew as one full-width `<td>` is now the shared `EmptyBlock`.
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
        <Stack gap="lg">
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
                            <Group gap="xs" justify="flex-end" wrap="nowrap" key="actions">
                                <Button
                                    variant="subtle"
                                    size="sm"
                                    color="brand"
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
                                    variant="subtle"
                                    size="sm"
                                    color="red"
                                    disabled={busy}
                                    onClick={() => setPendingDelete(venue.id)}
                                >
                                    Hapus
                                </Button>
                            </Group>,
                        ],
                    }))}
                />
            </SectionCard>

            {error ? <ErrorBlock message={error} title="Operasi gagal" /> : null}

            <SectionCard title={editingId ? "Ubah venue global" : "Tambah venue global"}>
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
                            onChange={(value) =>
                                setForm({ ...form, capacity: value === "" ? "" : String(value) })
                            }
                        />

                        <Group>
                            <PrimaryAction loading={busy}>
                                {busy ? "Menyimpan…" : editingId ? "Simpan" : "Tambah"}
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
                title="Hapus venue global ini?"
                centered
            >
                <Text size="sm">
                    Venue yang masih dipakai event akan ditolak oleh server.
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
