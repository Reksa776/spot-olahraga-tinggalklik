"use client";

import { FormEvent, useEffect, useState } from "react";
import { FiPercent } from "react-icons/fi";
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
} from "@/components/dashboard/primitives";

/**
 * ==========================================
 * PRODUCT DISCOUNTS
 * ==========================================
 *
 * PHASE (Mantine body migration): presentation only. The validation sequence and its exact
 * messages, the payload construction (`Number` coercions, ISO dates, `null` for empty optionals),
 * the create-vs-edit URL branch, the `window.setTimeout(closeModal, 700)` success delay, the
 * `toggleActive` PATCH, `readJson`, and the search filter (which matches the PRODUCT NAME) are
 * unchanged. The form modal is a Mantine `Modal` driven by the same `modalOpen` state, so
 * `closeModal()` still refuses to close while saving and still resets the form.
 *
 * NOTE on confirmations: this page previously used the shared `useDialog().confirm(...)`. That
 * primitive is mounted in the ROOT layout and is also used by retail pages, so it is deliberately
 * NOT converted here (it is outside the Mantine scope — see the phase report). Dashboard-owned
 * dialogs use Mantine `Modal` instead.
 */

type Discount = {
    id: number; productId: number; variantId: number | null;
    type: string; value: string | number; maxDiscount: string | number | null;
    startAt: string; endAt: string; isActive: boolean;
    product?: { id: number; name: string } | null;
    variant?: { id: number; name: string } | null;
};

type Product = { id: number; name: string; variants: { id: number; name: string; price: string | number }[] };

type FormState = {
    productId: string; variantId: string; type: string; value: string;
    maxDiscount: string; startAt: string; endAt: string; isActive: boolean;
};

const emptyForm: FormState = { productId: "", variantId: "", type: "PERCENTAGE", value: "", maxDiscount: "", startAt: "", endAt: "", isActive: true };

function formatRupiah(v: string | number) { return `Rp ${Number(v).toLocaleString("id-ID")}`; }
function toDateTimeLocal(v: string | null) { if (!v) return ""; const d = new Date(v); if (isNaN(d.getTime())) return ""; const off = d.getTimezoneOffset(); return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16); }
function formatDate(v: string) { return new Date(v).toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
async function readJson(r: Response) { const t = await r.text(); if (!t) throw new Error(`Server error ${r.status}`); try { return JSON.parse(t); } catch { throw new Error(`Invalid JSON ${r.status}`); } }

export default function AdminDiscountsPage() {
    const [items, setItems] = useState<Discount[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<Discount | null>(null);
    const [form, setForm] = useState<FormState>(emptyForm);
    const [search, setSearch] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [pendingDelete, setPendingDelete] = useState<Discount | null>(null);

    const selectedProduct = products.find((p) => String(p.id) === form.productId);

    async function load() {
        try { setLoading(true); const r = await fetch("/api/admin/discounts", { cache: "no-store" }); const res = await readJson(r); if (!r.ok || !res.success) throw new Error(res.message); setItems(res.data?.items ?? (Array.isArray(res.data) ? res.data : [])); } catch (e) { setError(e instanceof Error ? e.message : "Gagal memuat."); } finally { setLoading(false); }
    }

    async function loadProducts() { try { const r = await fetch("/api/admin/products", { cache: "no-store" }); const res = await readJson(r); if (r.ok && res.success) setProducts(res.data?.items ?? []); } catch { /* ignore */ } }

    useEffect(() => { load(); loadProducts(); }, []);

    function openCreate() { setEditing(null); setForm({ ...emptyForm }); setError(""); setSuccess(""); setModalOpen(true); }
    function openEdit(item: Discount) { setEditing(item); setForm({ productId: String(item.productId), variantId: item.variantId ? String(item.variantId) : "", type: item.type, value: String(Number(item.value)), maxDiscount: item.maxDiscount != null ? String(Number(item.maxDiscount)) : "", startAt: toDateTimeLocal(item.startAt), endAt: toDateTimeLocal(item.endAt), isActive: item.isActive }); setError(""); setSuccess(""); setModalOpen(true); }
    function closeModal() { if (saving) return; setModalOpen(false); setEditing(null); setForm({ ...emptyForm }); setError(""); setSuccess(""); }
    function updateForm<K extends keyof FormState>(k: K, v: FormState[K]) { setForm((c) => ({ ...c, [k]: v })); }

    async function handleSubmit(e: FormEvent) {
        e.preventDefault(); setError(""); setSuccess("");
        if (!form.productId) { setError("Produk wajib dipilih."); return; }
        const val = Number(form.value); if (!val || val <= 0) { setError("Nilai harus > 0."); return; }
        if (form.type === "PERCENTAGE" && val > 100) { setError("Persentase maksimal 100%."); return; }
        if (!form.startAt || !form.endAt) { setError("Tanggal wajib diisi."); return; }
        if (new Date(form.endAt) <= new Date(form.startAt)) { setError("Tanggal selesai harus setelah mulai."); return; }
        try {
            setSaving(true);
            const payload = { productId: Number(form.productId), variantId: form.variantId ? Number(form.variantId) : null, type: form.type, value: val, maxDiscount: form.maxDiscount ? Number(form.maxDiscount) : null, startAt: new Date(form.startAt).toISOString(), endAt: new Date(form.endAt).toISOString(), isActive: form.isActive };
            const url = editing ? `/api/admin/discounts/${editing.id}` : "/api/admin/discounts";
            const r = await fetch(url, { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            const res = await readJson(r); if (!r.ok || !res.success) throw new Error(res.message);
            setSuccess(editing ? "Berhasil diubah." : "Berhasil dibuat."); await load(); window.setTimeout(closeModal, 700);
        } catch (e) { setError(e instanceof Error ? e.message : "Terjadi kesalahan."); } finally { setSaving(false); }
    }

    async function handleDelete(item: Discount) {
        setPendingDelete(null);
        try { setDeletingId(item.id); const r = await fetch(`/api/admin/discounts/${item.id}`, { method: "DELETE" }); const res = await readJson(r); if (!r.ok || !res.success) throw new Error(res.message); setSuccess("Berhasil dihapus."); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Gagal menghapus."); } finally { setDeletingId(null); }
    }

    async function toggleActive(item: Discount) {
        try { await fetch(`/api/admin/discounts/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: !item.isActive }) }); await load(); } catch { /* ignore */ }
    }

    const filtered = items.filter((d) => !search.trim() || (d.product?.name ?? "").toLowerCase().includes(search.toLowerCase()));

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="Diskon Produk"
                description="Kelola diskon per produk atau per variant."
                actions={
                    <PrimaryAction color="ink" onClick={openCreate}>
                        <FiPercent size={16} aria-hidden />
                        <Text span ml={8}>
                            Tambah Diskon
                        </Text>
                    </PrimaryAction>
                }
            />

            {error ? <ErrorBlock message={error} title="Gagal" /> : null}
            {success ? <InfoNote tone="success">{success}</InfoNote> : null}

            <SectionCard
                title="Daftar Diskon"
                description={`${filtered.length} diskon`}
                actions={
                    <TextInput
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        placeholder="Cari produk…"
                        aria-label="Cari diskon"
                        size="md"
                        w={{ base: 180, sm: 288 }}
                    />
                }
            >
                <DataTable
                    minWidth={900}
                    loading={loading}
                    empty={
                        <EmptyBlock
                            icon={<FiPercent size={22} />}
                            title="Belum ada diskon"
                            action={<PrimaryAction onClick={openCreate}>Tambah sekarang</PrimaryAction>}
                        />
                    }
                    columns={[
                        { header: "Produk" },
                        { header: "Variant" },
                        { header: "Diskon" },
                        { header: "Periode" },
                        { header: "Status" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={filtered.map((d) => ({
                        key: String(d.id),
                        cells: [
                            <Text size="sm" fw={600} key="product">
                                {d.product?.name ?? `#${d.productId}`}
                            </Text>,
                            <Text size="sm" key="variant">
                                {d.variant?.name ?? "Semua variant"}
                            </Text>,
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
                title={editing ? "Edit diskon" : "Buat diskon baru"}
                size="lg"
                centered
                closeOnClickOutside={!saving}
                closeOnEscape={!saving}
            >
                <form onSubmit={handleSubmit}>
                    <Stack gap="md">
                        {error ? <ErrorBlock message={error} title="Tidak dapat disimpan" /> : null}

                        <SimpleGrid cols={2} spacing="md">
                            <Select
                                label="Produk"
                                required
                                size="md"
                                placeholder="Pilih produk"
                                value={form.productId || null}
                                data={products.map((p) => ({ value: String(p.id), label: p.name }))}
                                onChange={(value) => {
                                    updateForm("productId", value ?? "");
                                    updateForm("variantId", "");
                                }}
                            />

                            <Select
                                label="Variant (opsional)"
                                size="md"
                                placeholder="Semua variant"
                                value={form.variantId || null}
                                disabled={!selectedProduct}
                                data={(selectedProduct?.variants ?? []).map((v) => ({
                                    value: String(v.id),
                                    label: v.name,
                                }))}
                                onChange={(value) => updateForm("variantId", value ?? "")}
                            />
                        </SimpleGrid>

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
                title="Hapus Diskon"
                centered
            >
                <Text size="sm">Hapus diskon ini?</Text>

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
