"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Group, Modal, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";

import { apiFetch, ClientApiError } from "@/components/organizer/api";
import {
    DataTable,
    ErrorBlock,
    PrimaryAction,
    SectionCard,
    StatusBadge,
} from "@/components/dashboard/primitives";

/**
 * Sport master-data manager (requirement brief §15).
 *
 * Talks to `/api/admin/sports`, which requires the platform-scope `sport.manage`
 * permission. Deactivation is offered prominently next to delete because retiring a
 * sport that historical events used is only possible by deactivating it — deleting is
 * refused while any event references it, and the API says so.
 *
 * PHASE (Mantine body migration): presentation only. The `run()` wrapper, both `apiFetch`
 * payloads, the `busy` gate, `router.refresh()`, the client-side validation attributes
 * (`required`, `minLength={2}`) and the exact error messages are unchanged. The one behavioural
 * refinement is that the delete confirmation is now a Mantine `Modal` instead of
 * `window.confirm`, which the brief asks for explicitly (§13); it still gates the identical
 * `DELETE` call behind the same Yes/No decision.
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
        <Stack gap="lg">
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
                            <Text size="sm" fw={600} key="name">
                                {sport.name}
                            </Text>,
                            <Text size="xs" ff="monospace" key="slug">
                                {sport.slug}
                            </Text>,
                            <Text size="sm" key="order">
                                {sport.sortOrder}
                            </Text>,
                            <Text size="sm" key="events">
                                {sport.eventCount}
                            </Text>,
                            <StatusBadge
                                key="status"
                                tone={sport.isActive ? "success" : "neutral"}
                            >
                                {sport.isActive ? "Aktif" : "Nonaktif"}
                            </StatusBadge>,
                            <Group gap="xs" justify="flex-end" wrap="nowrap" key="actions">
                                <Button
                                    variant="subtle"
                                    size="sm"
                                    color="brand"
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
                                    variant="subtle"
                                    size="sm"
                                    color="red"
                                    disabled={busy}
                                    onClick={() => setPendingDelete(sport)}
                                >
                                    Hapus
                                </Button>
                            </Group>,
                        ],
                    }))}
                />
            </SectionCard>

            {error ? <ErrorBlock message={error} title="Operasi gagal" /> : null}

            <SectionCard title="Tambah cabang olahraga">
                <form onSubmit={create}>
                    <Stack gap="md">
                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <TextInput
                                label="Nama"
                                required
                                minLength={2}
                                size="md"
                                value={form.name}
                                onChange={(event) =>
                                    setForm({ ...form, name: event.currentTarget.value })
                                }
                            />

                            <TextInput
                                label="Slug (opsional)"
                                size="md"
                                ff="monospace"
                                value={form.slug}
                                onChange={(event) =>
                                    setForm({ ...form, slug: event.currentTarget.value })
                                }
                                placeholder="dibuat otomatis dari nama"
                            />
                        </SimpleGrid>

                        <Group>
                            <PrimaryAction loading={busy}>
                                {busy ? "Menyimpan…" : "Tambah"}
                            </PrimaryAction>
                        </Group>
                    </Stack>
                </form>
            </SectionCard>

            <Modal
                opened={pendingDelete !== null}
                onClose={() => setPendingDelete(null)}
                title="Hapus cabang olahraga?"
                centered
            >
                <Text size="sm">
                    Hapus cabang olahraga &quot;{pendingDelete?.name}&quot;? Cabang yang masih
                    dipakai event akan ditolak oleh server.
                </Text>

                <Group justify="flex-end" mt="lg">
                    <Button variant="default" size="md" onClick={() => setPendingDelete(null)}>
                        Batal
                    </Button>

                    <Button color="red" size="md" loading={busy} onClick={confirmDelete}>
                        Hapus
                    </Button>
                </Group>
            </Modal>
        </Stack>
    );
}
