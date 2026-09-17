"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
    Alert,
    Button,
    Group,
    List,
    Modal,
    Paper,
    SimpleGrid,
    Stack,
    Switch,
    Text,
    Textarea,
    TextInput,
} from "@mantine/core";

import {
    DataTable,
    EmptyBlock,
    SectionCard,
    StatusBadge,
} from "@/components/dashboard/primitives";

import { apiFetch, ClientApiError } from "./api";

/**
 * ==========================================
 * TICKET TYPE MANAGER (Phase 5)
 * ==========================================
 *
 * The sellable tiers of one event: list, create, edit, activate/deactivate, delete —
 * plus the inventory counters, which the brief allows on this surface specifically
 * ("Internal view — **may** show quota/reserved/sold (this is the authorized surface,
 * unlike the public payload)").
 *
 * BACKEND REMAINS AUTHORITATIVE (brief §27)
 * -----------------------------------------
 * The publish-readiness checklist below is a *preview* computed from the ticket types
 * this page already loaded. It exists so an organizer understands what is missing
 * before pressing Publish, and it is deliberately advisory: the publish endpoint
 * re-evaluates every precondition server-side and its answer is what decides. Nothing
 * here weakens that guard — a stale or crafted client state cannot publish anything.
 *
 * PRICE IS A STRING, ON PURPOSE
 * -----------------------------
 * `price` is never converted with `Number()` in this component. There is no JS
 * arithmetic on money anywhere in the Phase 5 UI — the value is bound straight to the
 * input and posted as the same string it arrived as, so `1234567.89` cannot come back
 * as `1234567.8899999999`. Only the read-only display uses `Number()` for formatting.
 *
 * QUOTA FLOOR
 * -----------
 * When editing, the quota input's `min` is the committed count (`sold + reserved`) that
 * the API returned, and the hint states it. The API enforces the same floor and rejects
 * a reduction below it with `minimumQuota` in `details`, so the client hint is a
 * convenience rather than the control.
 *
 * ---------------------------------------------------------------------------
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: `toLocalInput` / `toIso`, `formatMoney` (same `Number()` read-only formatting
 * with `minimumFractionDigits: 0` / `maximumFractionDigits: 2`), `EMPTY_FORM` and all of its
 * defaults, the readiness derivation (`activeWithQuota`, `startInFuture`, both condition labels),
 * `reset` / `startEdit` (including `price: type.price` verbatim and the `?? ""` fallbacks),
 * `buildPayload` and its `Object.fromEntries(...filter(...))` undefined-stripping, `submit`
 * (endpoint for create vs edit, the `wasEditing` branch for the notice copy, `reset()` then
 * `router.refresh()`), `setActive` (bare `{ isActive }` PATCH body, `reset()` only when the edited row
 * is the toggled one) and `remove` (the DELETE endpoint, the same reset rule, and the API's verbatim
 * "cannot delete an ordered type" message).
 *
 * `price` stays a **string** in the form state and in the payload — the Mantine field is a
 * `TextInput`, never a `NumberInput`, precisely so no numeric round trip is introduced.
 *
 * The delete confirmation was `window.confirm`; it is now a Mantine `Modal` with the identical
 * wording (`Hapus jenis tiket "<name>"?`), which is what the brief requires for dashboard
 * confirmations.
 */

type TicketType = {
    id: string;
    name: string;
    description: string | null;
    price: string;
    currency: string;
    minPerOrder: number;
    maxPerOrder: number | null;
    salesStartAt: string | null;
    salesEndAt: string | null;
    isActive: boolean;
    sortOrder: number;
    salesState: string;
    isSoldOut: boolean;
    inventory: {
        quota: number;
        sold: number;
        reserved: number;
        available: number;
        committed: number;
    };
};

type Props = {
    eventId: string;
    eventStartAt: string;
    ticketTypes: TicketType[];
};

type FormState = {
    name: string;
    description: string;
    price: string;
    quota: string;
    minPerOrder: string;
    maxPerOrder: string;
    salesStartAt: string;
    salesEndAt: string;
    isActive: boolean;
    sortOrder: string;
};

const EMPTY_FORM: FormState = {
    name: "",
    description: "",
    price: "",
    quota: "",
    minPerOrder: "1",
    maxPerOrder: "",
    salesStartAt: "",
    salesEndAt: "",
    isActive: true,
    sortOrder: "0",
};

/** `datetime-local` value ↔ ISO, matching `EventForm`'s handling. */
function toLocalInput(iso: string | null): string {
    if (!iso) return "";

    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) return "";

    const offsetMs = date.getTimezoneOffset() * 60_000;

    return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function toIso(local: string): string | null {
    if (!local) return null;

    const date = new Date(local);

    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatMoney(price: string, currency: string): string {
    const amount = Number(price);

    if (!Number.isFinite(amount)) return `${price} ${currency}`;

    return `Rp${amount.toLocaleString("id-ID", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    })}`;
}

export default function TicketTypeManager({
    eventId,
    eventStartAt,
    ticketTypes,
}: Props) {
    const router = useRouter();

    const [editingId, setEditingId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [form, setForm] = useState<FormState>(EMPTY_FORM);
    const [deleteTarget, setDeleteTarget] = useState<TicketType | null>(null);

    const editing = ticketTypes.find((type) => type.id === editingId) ?? null;

    /**
     * Publish precondition preview — mirrors design §10.3 / Phase 4 `publishEvent`.
     *
     * Only the ticket-type condition is evaluated here; the "start time in the future"
     * condition is shown too because it is one line and is the other common blocker.
     */
    const activeWithQuota = ticketTypes.filter(
        (type) => type.isActive && type.inventory.quota > 0
    );
    const startInFuture = new Date(eventStartAt).getTime() > Date.now();

    const readiness = [
        {
            label: "Waktu mulai event sudah di masa depan",
            met: startInFuture,
        },
        {
            label: "Minimal satu jenis tiket aktif dengan kuota lebih dari 0",
            met: activeWithQuota.length > 0,
        },
    ];

    function reset() {
        setForm(EMPTY_FORM);
        setEditingId(null);
        setError(null);
    }

    function startEdit(type: TicketType) {
        setEditingId(type.id);
        setError(null);
        setNotice(null);
        setForm({
            name: type.name,
            description: type.description ?? "",
            // Kept exactly as the API sent it. No Number() round trip.
            price: type.price,
            quota: String(type.inventory.quota),
            minPerOrder: String(type.minPerOrder),
            maxPerOrder: type.maxPerOrder === null ? "" : String(type.maxPerOrder),
            salesStartAt: toLocalInput(type.salesStartAt),
            salesEndAt: toLocalInput(type.salesEndAt),
            isActive: type.isActive,
            sortOrder: String(type.sortOrder),
        });
    }

    function buildPayload(): Record<string, unknown> {
        const payload: Record<string, unknown> = {
            name: form.name,
            description: form.description || null,
            price: form.price,
            quota: form.quota,
            minPerOrder: form.minPerOrder === "" ? undefined : form.minPerOrder,
            maxPerOrder: form.maxPerOrder === "" ? null : form.maxPerOrder,
            salesStartAt: toIso(form.salesStartAt),
            salesEndAt: toIso(form.salesEndAt),
            isActive: form.isActive,
            sortOrder: form.sortOrder === "" ? undefined : form.sortOrder,
        };

        // Drop undefined so a partial PATCH does not send keys the schema would treat
        // as "no change" in a confusing way.
        return Object.fromEntries(
            Object.entries(payload).filter(([, value]) => value !== undefined)
        );
    }

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setNotice(null);

        const payload = buildPayload();

        try {
            if (editingId) {
                await apiFetch(
                    `/api/organizer/events/${eventId}/ticket-types/${editingId}`,
                    { method: "PATCH", body: JSON.stringify(payload) }
                );
            } else {
                await apiFetch(`/api/organizer/events/${eventId}/ticket-types`, {
                    method: "POST",
                    body: JSON.stringify(payload),
                });
            }

            const wasEditing = editingId !== null;

            reset();
            setNotice(
                wasEditing
                    ? "Jenis tiket diperbarui."
                    : "Jenis tiket ditambahkan. Jalankan publikasi bila syarat lain sudah terpenuhi."
            );
            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError ? caught.message : "Terjadi kesalahan."
            );
        } finally {
            setBusy(false);
        }
    }

    async function setActive(type: TicketType, isActive: boolean) {
        setBusy(true);
        setError(null);
        setNotice(null);

        try {
            await apiFetch(
                `/api/organizer/events/${eventId}/ticket-types/${type.id}`,
                { method: "PATCH", body: JSON.stringify({ isActive }) }
            );

            if (editingId === type.id) {
                reset();
            }

            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError ? caught.message : "Terjadi kesalahan."
            );
        } finally {
            setBusy(false);
        }
    }

    async function remove(type: TicketType) {
        setBusy(true);
        setError(null);
        setNotice(null);

        try {
            await apiFetch(
                `/api/organizer/events/${eventId}/ticket-types/${type.id}`,
                { method: "DELETE" }
            );

            if (editingId === type.id) {
                reset();
            }

            router.refresh();
        } catch (caught) {
            // A type that has been ordered cannot be deleted; the API explains why and
            // points at deactivation, so that message is shown verbatim.
            setError(
                caught instanceof ClientApiError
                    ? caught.message
                    : "Gagal menghapus jenis tiket."
            );
        } finally {
            setBusy(false);
        }
    }

    async function confirmDelete() {
        const type = deleteTarget;
        setDeleteTarget(null);
        if (!type) return;
        await remove(type);
    }

    return (
        <Stack gap="lg">
            {/* Publish readiness preview (brief §27). Advisory only. */}

            <Paper withBorder radius="md" p="md" bg="gray.0">
                <List size="sm" spacing={4}>
                    {readiness.map((item) => (
                        <List.Item key={item.label}>
                            <Group gap="xs" wrap="nowrap" align="flex-start">
                                <Text
                                    component="span"
                                    fw={700}
                                    c={item.met ? "green.7" : "red.7"}
                                    aria-hidden
                                >
                                    {item.met ? "✓" : "✗"}
                                </Text>

                                <Text
                                    component="span"
                                    size="sm"
                                    c={item.met ? "dimmed" : undefined}
                                >
                                    {item.label}
                                </Text>
                            </Group>
                        </List.Item>
                    ))}
                </List>

                <Text size="xs" c="dimmed" mt="xs">
                    Syarat ini diperiksa ulang oleh server saat publikasi dijalankan.
                </Text>
            </Paper>

            {/* TICKET TYPES */}

            {ticketTypes.length === 0 ? (
                <EmptyBlock
                    title="Belum ada jenis tiket"
                    description="Event hanya dapat dipublikasikan setelah ada minimal satu jenis tiket aktif dengan kuota lebih dari 0."
                />
            ) : (
                <SectionCard title="Jenis Tiket">
                    <DataTable
                        minWidth={1000}
                        columns={[
                            { header: "Jenis tiket" },
                            { header: "Harga" },
                            { header: "Kuota" },
                            { header: "Terjual" },
                            { header: "Ditahan" },
                            { header: "Tersedia" },
                            { header: "Penjualan" },
                            { header: "Status" },
                            { header: "", align: "right" },
                        ]}
                        rows={ticketTypes.map((type) => ({
                            key: type.id,
                            cells: [
                                <Stack gap={0} key="name">
                                    <Text size="sm" fw={500}>
                                        {type.name}
                                    </Text>

                                    <Text size="xs" c="dimmed">
                                        urutan {type.sortOrder} · min {type.minPerOrder}
                                        {type.maxPerOrder === null
                                            ? ""
                                            : ` · maks ${type.maxPerOrder}`}
                                    </Text>
                                </Stack>,

                                <Text key="price" size="sm" style={{ whiteSpace: "nowrap" }}>
                                    {formatMoney(type.price, type.currency)}
                                </Text>,

                                <Text key="quota" size="sm">
                                    {type.inventory.quota.toLocaleString("id-ID")}
                                </Text>,

                                <Text key="sold" size="sm">
                                    {type.inventory.sold.toLocaleString("id-ID")}
                                </Text>,

                                <Text key="reserved" size="sm">
                                    {type.inventory.reserved.toLocaleString("id-ID")}
                                </Text>,

                                <Text key="available" size="sm" fw={500}>
                                    {type.inventory.available.toLocaleString("id-ID")}
                                </Text>,

                                <Stack gap={2} key="sales">
                                    <Text size="xs">
                                        {type.salesState}
                                        {type.isSoldOut ? " · habis" : ""}
                                    </Text>

                                    <Text size="xs" c="dimmed">
                                        {type.salesStartAt
                                            ? new Date(type.salesStartAt).toLocaleString("id-ID")
                                            : "mengikuti event"}
                                        {" → "}
                                        {type.salesEndAt
                                            ? new Date(type.salesEndAt).toLocaleString("id-ID")
                                            : "mengikuti event"}
                                    </Text>
                                </Stack>,

                                <StatusBadge key="status" tone={type.isActive ? "success" : "neutral"}>
                                    {type.isActive ? "Aktif" : "Nonaktif"}
                                </StatusBadge>,

                                <Group justify="flex-end" gap="xs" wrap="nowrap" key="actions">
                                    <Button
                                        variant="subtle"
                                        size="compact-sm"
                                        radius="md"
                                        onClick={() => startEdit(type)}
                                    >
                                        Ubah
                                    </Button>

                                    <Button
                                        variant="subtle"
                                        size="compact-sm"
                                        radius="md"
                                        color="ink"
                                        disabled={busy}
                                        onClick={() => setActive(type, !type.isActive)}
                                    >
                                        {type.isActive ? "Nonaktifkan" : "Aktifkan"}
                                    </Button>

                                    <Button
                                        variant="subtle"
                                        size="compact-sm"
                                        radius="md"
                                        color="red"
                                        disabled={busy}
                                        onClick={() => setDeleteTarget(type)}
                                    >
                                        Hapus
                                    </Button>
                                </Group>,
                            ],
                        }))}
                    />
                </SectionCard>
            )}

            {error ? (
                <Alert color="red" variant="light" radius="md">
                    {error}
                </Alert>
            ) : null}

            {notice ? (
                <Alert color="blue" variant="light" radius="md">
                    {notice}
                </Alert>
            ) : null}

            {/* FORM */}

            <SectionCard
                title={editingId ? `Ubah "${editing?.name ?? ""}"` : "Tambah jenis tiket"}
            >
                <form onSubmit={submit}>
                    <Stack gap="md">
                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <TextInput
                                label="Nama"
                                size="md"
                                radius="md"
                                required
                                minLength={2}
                                value={form.name}
                                onChange={(event) =>
                                    setForm({ ...form, name: event.currentTarget.value })
                                }
                                placeholder="Tribun, VIP, Early Bird…"
                            />

                            <TextInput
                                label="Harga (IDR)"
                                description="Maksimal 2 angka desimal. Nilai dikirim apa adanya tanpa pembulatan."
                                size="md"
                                radius="md"
                                required
                                inputMode="decimal"
                                value={form.price}
                                onChange={(event) =>
                                    setForm({ ...form, price: event.currentTarget.value })
                                }
                                placeholder="150000"
                            />

                            <TextInput
                                label="Kuota"
                                description={
                                    editing && editing.inventory.committed > 0
                                        ? `Kuota tidak dapat dikurangi di bawah ${editing.inventory.committed.toLocaleString(
                                              "id-ID"
                                          )} (terjual + ditahan).`
                                        : undefined
                                }
                                size="md"
                                radius="md"
                                required
                                inputMode="numeric"
                                min={editing ? editing.inventory.committed : 0}
                                value={form.quota}
                                onChange={(event) =>
                                    setForm({ ...form, quota: event.currentTarget.value })
                                }
                            />

                            <TextInput
                                label="Urutan tampil"
                                size="md"
                                radius="md"
                                inputMode="numeric"
                                value={form.sortOrder}
                                onChange={(event) =>
                                    setForm({ ...form, sortOrder: event.currentTarget.value })
                                }
                            />

                            <TextInput
                                label="Minimal per order"
                                size="md"
                                radius="md"
                                inputMode="numeric"
                                value={form.minPerOrder}
                                onChange={(event) =>
                                    setForm({ ...form, minPerOrder: event.currentTarget.value })
                                }
                            />

                            <TextInput
                                label="Maksimal per order"
                                size="md"
                                radius="md"
                                inputMode="numeric"
                                placeholder="kosong = mengikuti batas event"
                                value={form.maxPerOrder}
                                onChange={(event) =>
                                    setForm({ ...form, maxPerOrder: event.currentTarget.value })
                                }
                            />

                            <TextInput
                                label="Mulai penjualan"
                                description="Kosong = mengikuti jadwal penjualan event."
                                size="md"
                                radius="md"
                                type="datetime-local"
                                value={form.salesStartAt}
                                onChange={(event) =>
                                    setForm({ ...form, salesStartAt: event.currentTarget.value })
                                }
                            />

                            <TextInput
                                label="Berakhir penjualan"
                                size="md"
                                radius="md"
                                type="datetime-local"
                                value={form.salesEndAt}
                                onChange={(event) =>
                                    setForm({ ...form, salesEndAt: event.currentTarget.value })
                                }
                            />
                        </SimpleGrid>

                        <Textarea
                            label="Deskripsi"
                            size="md"
                            radius="md"
                            minRows={3}
                            maxRows={8}
                            autosize
                            value={form.description}
                            onChange={(event) =>
                                setForm({ ...form, description: event.currentTarget.value })
                            }
                        />

                        <Switch
                            label="Aktif (dapat dibeli)"
                            size="md"
                            color="green"
                            checked={form.isActive}
                            onChange={(event) =>
                                setForm({ ...form, isActive: event.currentTarget.checked })
                            }
                        />

                        <Group gap="sm">
                            <Button
                                type="submit"
                                size="md"
                                radius="md"
                                disabled={busy}
                                loading={busy}
                            >
                                {busy
                                    ? "Menyimpan…"
                                    : editingId
                                      ? "Simpan perubahan"
                                      : "Tambah jenis tiket"}
                            </Button>

                            {editingId ? (
                                <Button
                                    type="button"
                                    variant="default"
                                    size="md"
                                    radius="md"
                                    onClick={reset}
                                >
                                    Batal
                                </Button>
                            ) : null}
                        </Group>
                    </Stack>
                </form>
            </SectionCard>

            {/* DELETE CONFIRMATION */}

            <Modal
                opened={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                title="Hapus Jenis Tiket"
                centered
            >
                <Text size="sm">
                    Hapus jenis tiket &quot;{deleteTarget?.name}&quot;?
                </Text>

                <Group justify="flex-end" mt="lg">
                    <Button
                        variant="default"
                        size="md"
                        radius="md"
                        onClick={() => setDeleteTarget(null)}
                    >
                        Batal
                    </Button>

                    <Button color="red" size="md" radius="md" onClick={confirmDelete}>
                        Hapus
                    </Button>
                </Group>
            </Modal>
        </Stack>
    );
}
