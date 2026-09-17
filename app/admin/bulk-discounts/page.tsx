"use client";

import { FormEvent, useEffect, useState } from "react";
import { FiShoppingCart } from "react-icons/fi";

import {
    Alert,
    Box,
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
    PageHeader,
    SectionCard,
    StatusBadge,
} from "@/components/dashboard/primitives";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: `readJson` and its two error strings, `formatRupiah`, `toDateTimeLocal`,
 * `formatDate`, both loaders (`/api/admin/bulk-discounts` and the `/api/admin/products` picker, the
 * latter still swallowing its own failure), `openCreate`/`openEdit`/`closeModal`, `updateForm`, every
 * validation branch in `handleSubmit` and its messages, the create-vs-edit URL/method branch, the
 * payload (including the `new Date(...).toISOString()` conversions and `variantId`/`maxDiscount`
 * null fallbacks), the success copy, the 700ms `closeModal` timer, `toggleActive` (which still has no
 * error surface, as before) and the client-side `filtered` search across name and product name.
 *
 * Presentation changes: the `useDialog` confirmation became a Mantine `Modal`, the live-status
 * button became a `Switch`, and the page now composes the shared `PageHeader`/`SectionCard`/
 * `DataTable` vocabulary. The product `<select>` pairs became `Select` with `allowDeselect={false}`;
 * clearing `variantId` when the product changes is kept in the same `onChange`.
 */

type BulkDiscount = {
    id: number;
    name: string;
    productId: number;
    variantId: number | null;
    minQuantity: number;
    type: string;
    value: string | number;
    maxDiscount: string | number | null;
    startAt: string;
    endAt: string;
    isActive: boolean;
    product?: { id: number; name: string } | null;
    variant?: { id: number; name: string } | null;
};

type Product = {
    id: number;
    name: string;
    variants: { id: number; name: string; price: string | number }[];
};

type FormState = {
    name: string;
    productId: string;
    variantId: string;
    minQuantity: string;
    type: string;
    value: string;
    maxDiscount: string;
    startAt: string;
    endAt: string;
    isActive: boolean;
};

const emptyForm: FormState = {
    name: "",
    productId: "",
    variantId: "",
    minQuantity: "2",
    type: "PERCENTAGE",
    value: "",
    maxDiscount: "",
    startAt: "",
    endAt: "",
    isActive: true,
};

function formatRupiah(v: string | number) {
    return `Rp ${Number(v).toLocaleString("id-ID")}`;
}

function toDateTimeLocal(v: string | null) {
    if (!v) return "";
    const d = new Date(v);
    if (isNaN(d.getTime())) return "";
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

function formatDate(v: string) {
    return new Date(v).toLocaleString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

async function readJson(r: Response) {
    const t = await r.text();
    if (!t) throw new Error(`Server error ${r.status}`);
    try {
        return JSON.parse(t);
    } catch {
        throw new Error(`Invalid JSON ${r.status}`);
    }
}

export default function AdminBulkDiscountsPage() {
    const [items, setItems] = useState<BulkDiscount[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<BulkDiscount | null>(null);
    const [form, setForm] = useState<FormState>(emptyForm);
    const [search, setSearch] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [deleteTarget, setDeleteTarget] = useState<BulkDiscount | null>(null);

    const selectedProduct = products.find((p) => String(p.id) === form.productId);

    async function load() {
        try {
            setLoading(true);
            const r = await fetch("/api/admin/bulk-discounts", { cache: "no-store" });
            const res = await readJson(r);
            if (!r.ok || !res.success) throw new Error(res.message);
            setItems(res.data?.items ?? []);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Gagal memuat.");
        } finally {
            setLoading(false);
        }
    }

    async function loadProducts() {
        try {
            const r = await fetch("/api/admin/products", { cache: "no-store" });
            const res = await readJson(r);
            if (r.ok && res.success) setProducts(res.data?.items ?? []);
        } catch {
            /* ignore */
        }
    }

    useEffect(() => {
        load();
        loadProducts();
    }, []);

    function openCreate() {
        setEditing(null);
        setForm({ ...emptyForm });
        setError("");
        setSuccess("");
        setModalOpen(true);
    }

    function openEdit(item: BulkDiscount) {
        setEditing(item);
        setForm({
            name: item.name,
            productId: String(item.productId),
            variantId: item.variantId ? String(item.variantId) : "",
            minQuantity: String(item.minQuantity),
            type: item.type,
            value: String(Number(item.value)),
            maxDiscount:
                item.maxDiscount != null ? String(Number(item.maxDiscount)) : "",
            startAt: toDateTimeLocal(item.startAt),
            endAt: toDateTimeLocal(item.endAt),
            isActive: item.isActive,
        });
        setError("");
        setSuccess("");
        setModalOpen(true);
    }

    function closeModal() {
        if (saving) return;
        setModalOpen(false);
        setEditing(null);
        setForm({ ...emptyForm });
        setError("");
        setSuccess("");
    }

    function updateForm<K extends keyof FormState>(k: K, v: FormState[K]) {
        setForm((c) => ({ ...c, [k]: v }));
    }

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError("");
        setSuccess("");

        if (!form.name.trim()) {
            setError("Nama wajib diisi.");
            return;
        }
        if (!form.productId) {
            setError("Produk wajib dipilih.");
            return;
        }
        const mq = Number(form.minQuantity);
        if (!mq || mq < 2) {
            setError("Minimal quantity adalah 2.");
            return;
        }
        const val = Number(form.value);
        if (!val || val <= 0) {
            setError("Nilai diskon harus > 0.");
            return;
        }
        if (!form.startAt || !form.endAt) {
            setError("Tanggal wajib diisi.");
            return;
        }
        if (new Date(form.endAt) <= new Date(form.startAt)) {
            setError("Tanggal selesai harus setelah mulai.");
            return;
        }

        try {
            setSaving(true);
            const payload = {
                name: form.name.trim(),
                productId: Number(form.productId),
                variantId: form.variantId ? Number(form.variantId) : null,
                minQuantity: mq,
                type: form.type,
                value: val,
                maxDiscount: form.maxDiscount ? Number(form.maxDiscount) : null,
                startAt: new Date(form.startAt).toISOString(),
                endAt: new Date(form.endAt).toISOString(),
                isActive: form.isActive,
            };
            const url = editing
                ? `/api/admin/bulk-discounts/${editing.id}`
                : "/api/admin/bulk-discounts";
            const method = editing ? "PATCH" : "POST";
            const r = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const res = await readJson(r);
            if (!r.ok || !res.success) throw new Error(res.message);
            setSuccess(editing ? "Berhasil diubah." : "Berhasil dibuat.");
            await load();
            window.setTimeout(closeModal, 700);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Terjadi kesalahan.");
        } finally {
            setSaving(false);
        }
    }

    async function confirmDelete() {
        const item = deleteTarget;
        setDeleteTarget(null);
        if (!item) return;

        try {
            setDeletingId(item.id);
            const r = await fetch(`/api/admin/bulk-discounts/${item.id}`, {
                method: "DELETE",
            });
            const res = await readJson(r);
            if (!r.ok || !res.success) throw new Error(res.message);
            setSuccess("Berhasil dihapus.");
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Gagal menghapus.");
        } finally {
            setDeletingId(null);
        }
    }

    async function toggleActive(item: BulkDiscount) {
        try {
            await fetch(`/api/admin/bulk-discounts/${item.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ isActive: !item.isActive }),
            });
            await load();
        } catch {
            /* ignore */
        }
    }

    const filtered = items.filter(
        (d) =>
            !search.trim() ||
            d.name.toLowerCase().includes(search.toLowerCase()) ||
            (d.product?.name ?? "").toLowerCase().includes(search.toLowerCase())
    );

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="Beli Banyak Lebih Hemat"
                description="Konfigurasi diskon berdasarkan jumlah pembelian."
                actions={
                    <Button
                        size="md"
                        radius="md"
                        leftSection={<FiShoppingCart size={16} />}
                        onClick={openCreate}
                    >
                        Tambah
                    </Button>
                }
            />

            {error && (
                <Alert color="red" variant="light" radius="md" title="Terjadi kesalahan">
                    {error}
                </Alert>
            )}

            {success && (
                <Alert color="green" variant="light" radius="md" title="Berhasil">
                    {success}
                </Alert>
            )}

            <SectionCard
                title="Daftar Bulk Discount"
                description={`${filtered.length} item`}
                actions={
                    <TextInput
                        size="md"
                        radius="md"
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        placeholder="Cari..."
                        aria-label="Cari bulk discount"
                        w={{ base: 180, sm: 260 }}
                    />
                }
            >
                <DataTable
                    minWidth={900}
                    loading={loading}
                    empty={
                        <EmptyBlock
                            icon={<FiShoppingCart size={22} />}
                            title="Belum ada bulk discount"
                            description="Buat aturan diskon yang aktif saat pelanggan membeli dalam jumlah banyak."
                            action={
                                <Button size="md" radius="md" onClick={openCreate}>
                                    Tambah sekarang
                                </Button>
                            }
                        />
                    }
                    columns={[
                        { header: "Nama" },
                        { header: "Produk" },
                        { header: "Min Qty" },
                        { header: "Diskon" },
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

                            <Stack gap={0} key="product">
                                <Text size="sm">
                                    {d.product?.name ?? `#${d.productId}`}
                                </Text>

                                {d.variant && (
                                    <Text size="xs" c="dimmed">
                                        {d.variant.name}
                                    </Text>
                                )}
                            </Stack>,

                            <StatusBadge key="min" tone="warn">
                                {d.minQuantity}+ item
                            </StatusBadge>,

                            <Text size="sm" fw={500} key="discount">
                                {d.type === "PERCENTAGE"
                                    ? `${Number(d.value)}%`
                                    : formatRupiah(d.value)}
                            </Text>,

                            <Stack gap={2} key="period">
                                <Text size="xs">{formatDate(d.startAt)}</Text>

                                <Text size="xs" c="dimmed">
                                    s/d {formatDate(d.endAt)}
                                </Text>
                            </Stack>,

                            <Switch
                                key="status"
                                size="md"
                                color="green"
                                checked={d.isActive}
                                onChange={() => toggleActive(d)}
                                label={d.isActive ? "Aktif" : "Nonaktif"}
                            />,

                            <Group justify="flex-end" gap="xs" wrap="nowrap" key="actions">
                                <Button
                                    variant="subtle"
                                    size="sm"
                                    radius="md"
                                    onClick={() => openEdit(d)}
                                >
                                    Edit
                                </Button>

                                <Button
                                    variant="subtle"
                                    color="red"
                                    size="sm"
                                    radius="md"
                                    loading={deletingId === d.id}
                                    disabled={deletingId === d.id}
                                    onClick={() => setDeleteTarget(d)}
                                >
                                    Hapus
                                </Button>
                            </Group>,
                        ],
                    }))}
                />
            </SectionCard>

            {/* FORM MODAL */}

            <Modal
                opened={modalOpen}
                onClose={closeModal}
                size="lg"
                title={editing ? "Edit bulk discount" : "Buat baru"}
                centered
            >
                <form onSubmit={handleSubmit}>
                    <Stack gap="md">
                        {error && (
                            <Alert color="red" variant="light" radius="md">
                                {error}
                            </Alert>
                        )}

                        <TextInput
                            label="Nama"
                            size="md"
                            radius="md"
                            value={form.name}
                            onChange={(e) => updateForm("name", e.currentTarget.value)}
                        />

                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <Select
                                label="Produk"
                                size="md"
                                radius="md"
                                allowDeselect={false}
                                searchable
                                value={form.productId}
                                onChange={(value) => {
                                    updateForm("productId", value ?? "");
                                    updateForm("variantId", "");
                                }}
                                placeholder="Pilih produk"
                                data={products.map((p) => ({
                                    value: String(p.id),
                                    label: p.name,
                                }))}
                            />

                            <Select
                                label="Variant (opsional)"
                                size="md"
                                radius="md"
                                allowDeselect={false}
                                value={form.variantId}
                                onChange={(value) => updateForm("variantId", value ?? "")}
                                disabled={!selectedProduct}
                                data={[
                                    { value: "", label: "Semua variant" },
                                    ...(selectedProduct?.variants ?? []).map((v) => ({
                                        value: String(v.id),
                                        label: v.name,
                                    })),
                                ]}
                            />
                        </SimpleGrid>

                        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
                            <NumberInput
                                label="Min Quantity"
                                size="md"
                                radius="md"
                                min={2}
                                value={form.minQuantity === "" ? "" : Number(form.minQuantity)}
                                onChange={(value) =>
                                    updateForm(
                                        "minQuantity",
                                        value === "" ? "" : String(value)
                                    )
                                }
                            />

                            <Select
                                label="Tipe"
                                size="md"
                                radius="md"
                                allowDeselect={false}
                                value={form.type}
                                onChange={(value) => updateForm("type", value ?? "PERCENTAGE")}
                                data={[
                                    { value: "PERCENTAGE", label: "%" },
                                    { value: "FIXED", label: "Rp" },
                                ]}
                            />

                            <NumberInput
                                label="Nilai"
                                size="md"
                                radius="md"
                                min={1}
                                value={form.value === "" ? "" : Number(form.value)}
                                onChange={(value) =>
                                    updateForm("value", value === "" ? "" : String(value))
                                }
                            />
                        </SimpleGrid>

                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <NumberInput
                                label="Maks Diskon (Rp)"
                                size="md"
                                radius="md"
                                min={0}
                                value={form.maxDiscount === "" ? "" : Number(form.maxDiscount)}
                                onChange={(value) =>
                                    updateForm(
                                        "maxDiscount",
                                        value === "" ? "" : String(value)
                                    )
                                }
                                placeholder="Opsional"
                            />

                            <Box />
                        </SimpleGrid>

                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <TextInput
                                label="Mulai"
                                size="md"
                                radius="md"
                                type="datetime-local"
                                value={form.startAt}
                                onChange={(e) => updateForm("startAt", e.currentTarget.value)}
                            />

                            <TextInput
                                label="Selesai"
                                size="md"
                                radius="md"
                                type="datetime-local"
                                value={form.endAt}
                                onChange={(e) => updateForm("endAt", e.currentTarget.value)}
                            />
                        </SimpleGrid>

                        <Switch
                            size="md"
                            color="green"
                            checked={form.isActive}
                            onChange={(e) => updateForm("isActive", e.currentTarget.checked)}
                            label={form.isActive ? "Aktif" : "Nonaktif"}
                        />
                    </Stack>

                    <Group justify="flex-end" gap="sm" mt="xl">
                        <Button
                            type="button"
                            variant="default"
                            size="md"
                            radius="md"
                            disabled={saving}
                            onClick={closeModal}
                        >
                            Batal
                        </Button>

                        <Button
                            type="submit"
                            size="md"
                            radius="md"
                            disabled={saving}
                            loading={saving}
                        >
                            {saving ? "Menyimpan..." : editing ? "Simpan" : "Buat"}
                        </Button>
                    </Group>
                </form>
            </Modal>

            {/* DELETE CONFIRMATION */}

            <Modal
                opened={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                title="Hapus"
                centered
            >
                <Text size="sm">Hapus &quot;{deleteTarget?.name}&quot;?</Text>

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
