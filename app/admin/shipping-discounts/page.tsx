"use client";

import { FormEvent, useEffect, useState } from "react";
import { FiTruck } from "react-icons/fi";
import {
    Button,
    Group,
    Modal,
    NumberInput,
    Select,
    SimpleGrid,
    Stack,
    Switch,
    Text,
    TextInput,
} from "@mantine/core";

import {
    DataTable,
    EmptyBlock,
    ErrorBlock,
    InfoNote,
    PageHeader,
    PrimaryAction,
    SectionCard,
    StatusBadge,
} from "@/components/dashboard/primitives";

/**
 * ==========================================
 * SHIPPING DISCOUNTS
 * ==========================================
 *
 * PHASE (Mantine body migration): presentation only. Validation order and its exact messages, the
 * payload (including `code.trim() || null`, `minPurchase`/`maxDiscount` → `null` when empty, ISO
 * dates), the create-vs-edit branch, the 700ms success delay before closing, `toggleActive` and the
 * search filter (name OR code) are unchanged. The form modal is a Mantine `Modal` on the same
 * `modalOpen` state, and the code field still uppercases on input via `toUpperCase()`.
 *
 * The delete confirmation was a `useDialog().confirm(...)` call. That primitive is mounted in the
 * ROOT layout and is shared with retail pages, so it is not converted (outside Mantine scope — see
 * the phase report); this dashboard-owned confirmation is a Mantine `Modal` instead.
 */

type ShippingDiscount = {
    id: number; name: string; code: string | null; type: string; value: string | number;
    maxDiscount: string | number | null; minPurchase: string | number | null;
    startAt: string; endAt: string; isActive: boolean;
};

type FormState = {
    name: string; code: string; type: string; value: string; maxDiscount: string;
    minPurchase: string; startAt: string; endAt: string; isActive: boolean;
};

const emptyForm: FormState = { name: "", code: "", type: "PERCENTAGE", value: "", maxDiscount: "", minPurchase: "", startAt: "", endAt: "", isActive: true };

function formatRupiah(v: string | number) { return `Rp ${Number(v).toLocaleString("id-ID")}`; }
function toDateTimeLocal(v: string | null) { if (!v) return ""; const d = new Date(v); if (isNaN(d.getTime())) return ""; const off = d.getTimezoneOffset(); return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16); }
function formatDate(v: string) { return new Date(v).toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric" }); }
async function readJson(r: Response) { const t = await r.text(); if (!t) throw new Error(`Server error ${r.status}`); try { return JSON.parse(t); } catch { throw new Error(`Invalid JSON ${r.status}`); } }

export default function AdminShippingDiscountsPage() {
    const [items, setItems] = useState<ShippingDiscount[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<ShippingDiscount | null>(null);
    const [form, setForm] = useState<FormState>(emptyForm);
    const [search, setSearch] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [pendingDelete, setPendingDelete] = useState<ShippingDiscount | null>(null);

    async function load() { try { setLoading(true); const r = await fetch("/api/admin/shipping-discounts", { cache: "no-store" }); const res = await readJson(r); if (!r.ok || !res.success) throw new Error(res.message); setItems(res.data?.items ?? []); } catch (e) { setError(e instanceof Error ? e.message : "Gagal memuat."); } finally { setLoading(false); } }
    useEffect(() => { load(); }, []);

    function openCreate() { setEditing(null); setForm({ ...emptyForm }); setError(""); setSuccess(""); setModalOpen(true); }
    function openEdit(item: ShippingDiscount) { setEditing(item); setForm({ name: item.name, code: item.code || "", type: item.type, value: String(Number(item.value)), maxDiscount: item.maxDiscount != null ? String(Number(item.maxDiscount)) : "", minPurchase: item.minPurchase != null ? String(Number(item.minPurchase)) : "", startAt: toDateTimeLocal(item.startAt), endAt: toDateTimeLocal(item.endAt), isActive: item.isActive }); setError(""); setSuccess(""); setModalOpen(true); }
    function closeModal() { if (saving) return; setModalOpen(false); setEditing(null); setForm({ ...emptyForm }); setError(""); setSuccess(""); }
    function updateForm<K extends keyof FormState>(k: K, v: FormState[K]) { setForm((c) => ({ ...c, [k]: v })); }

    async function handleSubmit(e: FormEvent) {
        e.preventDefault(); setError(""); setSuccess("");
        if (!form.name.trim()) { setError("Nama wajib diisi."); return; }
        const val = Number(form.value); if (!val || val <= 0) { setError("Nilai harus > 0."); return; }
        if (!form.startAt || !form.endAt) { setError("Tanggal wajib diisi."); return; }
        if (new Date(form.endAt) <= new Date(form.startAt)) { setError("Tanggal selesai harus setelah mulai."); return; }
        try {
            setSaving(true);
            const payload = { name: form.name.trim(), code: form.code.trim() || null, type: form.type, value: val, maxDiscount: form.maxDiscount ? Number(form.maxDiscount) : null, minPurchase: form.minPurchase ? Number(form.minPurchase) : null, startAt: new Date(form.startAt).toISOString(), endAt: new Date(form.endAt).toISOString(), isActive: form.isActive };
            const url = editing ? `/api/admin/shipping-discounts/${editing.id}` : "/api/admin/shipping-discounts";
            const r = await fetch(url, { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            const res = await readJson(r); if (!r.ok || !res.success) throw new Error(res.message);
            setSuccess(editing ? "Berhasil diubah." : "Berhasil dibuat."); await load(); window.setTimeout(closeModal, 700);
        } catch (e) { setError(e instanceof Error ? e.message : "Terjadi kesalahan."); } finally { setSaving(false); }
    }

    async function handleDelete(item: ShippingDiscount) {
        setPendingDelete(null);
        try { setDeletingId(item.id); const r = await fetch(`/api/admin/shipping-discounts/${item.id}`, { method: "DELETE" }); const res = await readJson(r); if (!r.ok || !res.success) throw new Error(res.message); setSuccess("Berhasil dihapus."); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Gagal menghapus."); } finally { setDeletingId(null); }
    }

    async function toggleActive(item: ShippingDiscount) {
        try { await fetch(`/api/admin/shipping-discounts/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: !item.isActive }) }); await load(); } catch { /* ignore */ }
    }

    const filtered = items.filter((d) => !search.trim() || d.name.toLowerCase().includes(search.toLowerCase()) || (d.code ?? "").toLowerCase().includes(search.toLowerCase()));

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="Diskon Ongkir"
                description="Konfigurasi diskon biaya pengiriman."
                actions={
                    <PrimaryAction color="ink" onClick={openCreate}>
                        <FiTruck size={16} aria-hidden />
                        <Text span ml={8}>
                            Tambah
                        </Text>
                    </PrimaryAction>
                }
            />

            {error ? <ErrorBlock message={error} title="Gagal" /> : null}
            {success ? <InfoNote tone="success">{success}</InfoNote> : null}

            <SectionCard
                title="Daftar Diskon Ongkir"
                description={`${filtered.length} item`}
                actions={
                    <TextInput
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        placeholder="Cari…"
                        aria-label="Cari diskon ongkir"
                        size="md"
                        w={{ base: 180, sm: 288 }}
                    />
                }
            >
                <DataTable
                    minWidth={860}
                    loading={loading}
                    empty={
                        <EmptyBlock
                            icon={<FiTruck size={22} />}
                            title="Belum ada diskon ongkir"
                            action={<PrimaryAction onClick={openCreate}>Tambah sekarang</PrimaryAction>}
                        />
                    }
                    columns={[
                        { header: "Nama" },
                        { header: "Kode" },
                        { header: "Diskon" },
                        { header: "Min Belanja" },
                        { header: "Periode" },
                        { header: "Status" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={filtered.map((d) => ({
                        key: String(d.id),
                        cells: [
                            <Text size="sm" fw={600} key="name">
                                {d.name}
                            </Text>,
                            d.code ? (
                                <StatusBadge key="code" tone="info">
                                    {d.code}
                                </StatusBadge>
                            ) : (
                                <Text size="xs" c="dimmed" key="code">
                                    Auto
                                </Text>
                            ),
                            <Stack gap={2} key="value">
                                <Text size="sm" fw={500}>
                                    {d.type === "PERCENTAGE" ? `${Number(d.value)}%` : formatRupiah(d.value)}
                                </Text>
                                {d.maxDiscount ? (
                                    <Text size="xs" c="dimmed">
                                        Maks {formatRupiah(d.maxDiscount)}
                                    </Text>
                                ) : null}
                            </Stack>,
                            d.minPurchase ? (
                                <Text size="sm" key="min">
                                    {formatRupiah(d.minPurchase)}
                                </Text>
                            ) : (
                                <Text size="xs" c="dimmed" key="min">
                                    -
                                </Text>
                            ),
                            <Stack gap={2} key="period">
                                <Text size="xs">{formatDate(d.startAt)}</Text>
                                <Text size="xs" c="dimmed">
                                    s/d {formatDate(d.endAt)}
                                </Text>
                            </Stack>,
                            <Button
                                key="status"
                                variant="subtle"
                                size="sm"
                                color={d.isActive ? "green" : "gray"}
                                onClick={() => toggleActive(d)}
                                leftSection={
                                    <span
                                        style={{
                                            display: "inline-block",
                                            width: 8,
                                            height: 8,
                                            borderRadius: 999,
                                            background: d.isActive
                                                ? "var(--mantine-color-green-5)"
                                                : "var(--mantine-color-gray-4)",
                                        }}
                                        aria-hidden
                                    />
                                }
                            >
                                {d.isActive ? "Aktif" : "Nonaktif"}
                            </Button>,
                            <Group gap="xs" justify="flex-end" wrap="nowrap" key="actions">
                                <Button variant="subtle" size="sm" color="gray" onClick={() => openEdit(d)}>
                                    Edit
                                </Button>
                                <Button
                                    variant="subtle"
                                    size="sm"
                                    color="red"
                                    loading={deletingId === d.id}
                                    disabled={deletingId === d.id}
                                    onClick={() => setPendingDelete(d)}
                                >
                                    Hapus
                                </Button>
                            </Group>,
                        ],
                    }))}
                />
            </SectionCard>

            <Modal
                opened={modalOpen}
                onClose={closeModal}
                title={editing ? "Edit diskon ongkir" : "Buat diskon ongkir"}
                size="lg"
                centered
                closeOnClickOutside={!saving}
                closeOnEscape={!saving}
            >
                <form onSubmit={handleSubmit}>
                    <Stack gap="md">
                        {error ? <ErrorBlock message={error} title="Tidak dapat disimpan" /> : null}

                        <TextInput
                            label="Nama"
                            required
                            size="md"
                            value={form.name}
                            onChange={(e) => updateForm("name", e.currentTarget.value)}
                        />

                        <TextInput
                            label="Kode (opsional)"
                            size="md"
                            value={form.code}
                            placeholder="ONGKIR50 — kosongkan untuk auto-apply"
                            onChange={(e) => updateForm("code", e.currentTarget.value.toUpperCase())}
                        />

                        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
                            <Select
                                label="Tipe"
                                size="md"
                                value={form.type}
                                data={[
                                    { value: "PERCENTAGE", label: "%" },
                                    { value: "FIXED", label: "Rp" },
                                ]}
                                onChange={(value) => updateForm("type", value ?? "PERCENTAGE")}
                            />

                            <NumberInput
                                label="Nilai"
                                size="md"
                                min={1}
                                value={form.value === "" ? "" : Number(form.value)}
                                onChange={(value) => updateForm("value", value === "" ? "" : String(value))}
                            />

                            <NumberInput
                                label="Maks Diskon"
                                size="md"
                                min={0}
                                placeholder="Opsional"
                                value={form.maxDiscount === "" ? "" : Number(form.maxDiscount)}
                                onChange={(value) =>
                                    updateForm("maxDiscount", value === "" ? "" : String(value))
                                }
                            />
                        </SimpleGrid>

                        <NumberInput
                            label="Minimal Belanja (Rp)"
                            size="md"
                            min={0}
                            placeholder="0 = tanpa minimal"
                            value={form.minPurchase === "" ? "" : Number(form.minPurchase)}
                            onChange={(value) =>
                                updateForm("minPurchase", value === "" ? "" : String(value))
                            }
                        />

                        <SimpleGrid cols={2} spacing="md">
                            <TextInput
                                label="Mulai"
                                size="md"
                                type="datetime-local"
                                value={form.startAt}
                                onChange={(e) => updateForm("startAt", e.currentTarget.value)}
                            />

                            <TextInput
                                label="Selesai"
                                size="md"
                                type="datetime-local"
                                value={form.endAt}
                                onChange={(e) => updateForm("endAt", e.currentTarget.value)}
                            />
                        </SimpleGrid>

                        <Switch
                            label={form.isActive ? "Aktif" : "Nonaktif"}
                            size="md"
                            checked={form.isActive}
                            onChange={(e) => updateForm("isActive", e.currentTarget.checked)}
                        />

                        <Group justify="flex-end">
                            <Button variant="default" size="md" onClick={closeModal} disabled={saving}>
                                Batal
                            </Button>

                            <Button type="submit" size="md" color="ink" loading={saving}>
                                {saving ? "Menyimpan…" : editing ? "Simpan" : "Buat"}
                            </Button>
                        </Group>
                    </Stack>
                </form>
            </Modal>

            <Modal
                opened={pendingDelete !== null}
                onClose={() => setPendingDelete(null)}
                title="Hapus diskon ongkir"
                centered
            >
                <Text size="sm">Hapus &quot;{pendingDelete?.name}&quot;?</Text>

                <Group justify="flex-end" mt="lg">
                    <Button variant="default" size="md" onClick={() => setPendingDelete(null)}>
                        Batal
                    </Button>

                    <Button
                        color="red"
                        size="md"
                        loading={deletingId !== null}
                        onClick={() => pendingDelete && handleDelete(pendingDelete)}
                    >
                        Hapus
                    </Button>
                </Group>
            </Modal>
        </Stack>
    );
}
