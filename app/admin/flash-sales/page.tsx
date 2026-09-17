"use client";

import { FormEvent, useEffect, useState } from "react";
import { FiZap } from "react-icons/fi";

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
} from "@/components/dashboard/primitives";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: `readJsonResponse` and both messages, `formatRupiah`, `toDateTimeLocal`,
 * `formatDate`, both loaders (the product picker still swallowing its own failure), the
 * `openEditModal` mapping (including `purchaseLimit ?? "1"`), `closeModal`'s `saving` guard, every
 * validation branch in `handleSubmit` and its messages, the create-vs-edit URL/method branch, the
 * payload (`purchaseLimit ? Number(...) : 1`, `new Date(...).toISOString()`), `handleDelete`'s
 * `DELETE` call, `toggleActive`'s `PATCH { isActive: !item.isActive }`, and the client-side
 * `filtered` search across name and product name.
 *
 * `saleStock` keeps its `disabled={!!editingItem}` rule — the API refuses to change stock after
 * creation and the form says so. The delete confirmation is a Mantine `Modal` instead of the shared
 * `useDialog` helper.
 */

type FlashSale = {
    id: number;
    name: string;
    productId: number;
    variantId: number;
    salePrice: string | number;
    saleStock: number;
    soldCount: number;
    purchaseLimit: number | null;
    startAt: string;
    endAt: string;
    isActive: boolean;
    createdAt: string;
    product?: { id: number; name: string } | null;
    variant?: { id: number; name: string } | null;
};

type Product = {
    id: number;
    name: string;
    variants: { id: number; name: string; price: string | number; stock: number }[];
};

type FormState = {
    name: string;
    productId: string;
    variantId: string;
    salePrice: string;
    saleStock: string;
    purchaseLimit: string;
    startAt: string;
    endAt: string;
    isActive: boolean;
};

const emptyForm: FormState = {
    name: "",
    productId: "",
    variantId: "",
    salePrice: "",
    saleStock: "",
    purchaseLimit: "1",
    startAt: "",
    endAt: "",
    isActive: true,
};

function formatRupiah(value: string | number) {
    return `Rp ${Number(value).toLocaleString("id-ID")}`;
}

function toDateTimeLocal(value: string | null) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const offset = date.getTimezoneOffset();
    const localDate = new Date(date.getTime() - offset * 60 * 1000);
    return localDate.toISOString().slice(0, 16);
}

function formatDate(value: string) {
    return new Date(value).toLocaleString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

async function readJsonResponse(response: Response) {
    const text = await response.text();
    if (!text)
        throw new Error(
            `Server tidak mengembalikan response. Status: ${response.status}`
        );
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(
            `Server mengembalikan response bukan JSON. Status: ${response.status}`
        );
    }
}

export default function AdminFlashSalesPage() {
    const [flashSales, setFlashSales] = useState<FlashSale[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingItem, setEditingItem] = useState<FlashSale | null>(null);
    const [form, setForm] = useState<FormState>(emptyForm);
    const [search, setSearch] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [deleteTarget, setDeleteTarget] = useState<FlashSale | null>(null);

    const selectedProduct = products.find((p) => String(p.id) === form.productId);

    async function loadFlashSales() {
        try {
            setLoading(true);
            const response = await fetch("/api/admin/flash-sales", {
                cache: "no-store",
            });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success)
                throw new Error(result.message || "Gagal mengambil data flash sale.");
            setFlashSales(
                result.data?.items ?? (Array.isArray(result.data) ? result.data : [])
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal mengambil data.");
        } finally {
            setLoading(false);
        }
    }

    async function loadProducts() {
        try {
            const response = await fetch("/api/admin/products", { cache: "no-store" });
            const result = await readJsonResponse(response);
            if (response.ok && result.success) {
                setProducts(
                    result.data?.items ?? (Array.isArray(result.data) ? result.data : [])
                );
            }
        } catch {
            /* ignore */
        }
    }

    useEffect(() => {
        loadFlashSales();
        loadProducts();
    }, []);

    function openCreateModal() {
        setEditingItem(null);
        setForm({ ...emptyForm });
        setError("");
        setSuccess("");
        setModalOpen(true);
    }

    function openEditModal(item: FlashSale) {
        setEditingItem(item);
        setForm({
            name: item.name,
            productId: String(item.productId),
            variantId: String(item.variantId),
            salePrice: String(Number(item.salePrice)),
            saleStock: String(item.saleStock),
            purchaseLimit: item.purchaseLimit != null ? String(item.purchaseLimit) : "1",
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
        setEditingItem(null);
        setForm({ ...emptyForm });
        setError("");
        setSuccess("");
    }

    function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
        setForm((c) => ({ ...c, [key]: value }));
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
        if (!form.variantId) {
            setError("Variant wajib dipilih.");
            return;
        }

        const salePrice = Number(form.salePrice);
        if (!Number.isFinite(salePrice) || salePrice <= 0) {
            setError("Harga flash sale harus lebih dari 0.");
            return;
        }

        const saleStock = Number(form.saleStock);
        if (!Number.isInteger(saleStock) || saleStock <= 0) {
            setError("Stok flash sale harus lebih dari 0.");
            return;
        }

        if (!form.startAt || !form.endAt) {
            setError("Tanggal mulai dan selesai wajib diisi.");
            return;
        }
        if (new Date(form.endAt) <= new Date(form.startAt)) {
            setError("Tanggal selesai harus setelah tanggal mulai.");
            return;
        }

        try {
            setSaving(true);
            const payload = {
                name: form.name.trim(),
                productId: Number(form.productId),
                variantId: Number(form.variantId),
                salePrice,
                saleStock,
                purchaseLimit: form.purchaseLimit ? Number(form.purchaseLimit) : 1,
                startAt: new Date(form.startAt).toISOString(),
                endAt: new Date(form.endAt).toISOString(),
                isActive: form.isActive,
            };

            const url = editingItem
                ? `/api/admin/flash-sales/${editingItem.id}`
                : "/api/admin/flash-sales";
            const method = editingItem ? "PATCH" : "POST";

            const response = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success)
                throw new Error(result.message || "Gagal menyimpan flash sale.");

            setSuccess(
                editingItem
                    ? "Flash sale berhasil diubah."
                    : "Flash sale berhasil dibuat."
            );
            await loadFlashSales();
            window.setTimeout(closeModal, 700);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Terjadi kesalahan.");
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
            setError("");
            setSuccess("");
            const response = await fetch(`/api/admin/flash-sales/${item.id}`, {
                method: "DELETE",
            });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success)
                throw new Error(result.message || "Gagal menghapus flash sale.");
            setSuccess("Flash sale berhasil dihapus.");
            await loadFlashSales();
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Gagal menghapus flash sale."
            );
        } finally {
            setDeletingId(null);
        }
    }

    async function toggleActive(item: FlashSale) {
        try {
            setError("");
            setSuccess("");
            const response = await fetch(`/api/admin/flash-sales/${item.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ isActive: !item.isActive }),
            });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success)
                throw new Error(result.message || "Gagal mengubah status.");
            await loadFlashSales();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal mengubah status.");
        }
    }

    const filtered = flashSales.filter((fs) => {
        if (!search.trim()) return true;
        const kw = search.toLowerCase();
        return (
            fs.name.toLowerCase().includes(kw) ||
            (fs.product?.name ?? "").toLowerCase().includes(kw)
        );
    });

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="Flash Sale"
                description="Kelola flash sale produk dengan harga khusus dan stok terbatas."
                actions={
                    <Button
                        size="md"
                        radius="md"
                        leftSection={<FiZap size={16} />}
                        onClick={openCreateModal}
                    >
                        Tambah Flash Sale
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
                title="Daftar Flash Sale"
                description={`${filtered.length} flash sale`}
                actions={
                    <TextInput
                        size="md"
                        radius="md"
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        placeholder="Cari flash sale..."
                        aria-label="Cari flash sale"
                        w={{ base: 180, sm: 260 }}
                    />
                }
            >
                <DataTable
                    minWidth={1000}
                    loading={loading}
                    empty={
                        <EmptyBlock
                            icon={<FiZap size={22} />}
                            title="Belum ada flash sale"
                            description="Buat flash sale untuk menawarkan harga khusus dengan stok terbatas."
                            action={
                                <Button size="md" radius="md" onClick={openCreateModal}>
                                    Tambah flash sale
                                </Button>
                            }
                        />
                    }
                    columns={[
                        { header: "Nama" },
                        { header: "Produk / Variant" },
                        { header: "Harga" },
                        { header: "Stok" },
                        { header: "Periode" },
                        { header: "Status" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={filtered.map((fs) => {
                        const remaining = Math.max(0, fs.saleStock - fs.soldCount);

                        return {
                            key: String(fs.id),
                            cells: [
                                <Text size="sm" fw={600} key="name">
                                    {fs.name}
                                </Text>,

                                <Stack gap={0} key="product">
                                    <Text size="sm">
                                        {fs.product?.name ?? `#${fs.productId}`}
                                    </Text>

                                    <Text size="xs" c="dimmed">
                                        {fs.variant?.name ?? `#${fs.variantId}`}
                                    </Text>
                                </Stack>,

                                <Text size="sm" fw={600} c="brand.7" key="price">
                                    {formatRupiah(fs.salePrice)}
                                </Text>,

                                <Box key="stock">
                                    <Text
                                        size="sm"
                                        fw={600}
                                        c={
                                            remaining === 0
                                                ? "red"
                                                : remaining <= 5
                                                  ? "orange"
                                                  : undefined
                                        }
                                    >
                                        {remaining}
                                    </Text>

                                    <Text size="xs" c="dimmed">
                                        tersisa / {fs.soldCount} terjual
                                    </Text>
                                </Box>,

                                <Stack gap={2} key="period">
                                    <Text size="xs">{formatDate(fs.startAt)}</Text>

                                    <Text size="xs" c="dimmed">
                                        s/d {formatDate(fs.endAt)}
                                    </Text>
                                </Stack>,

                                <Switch
                                    key="status"
                                    size="md"
                                    color="green"
                                    checked={fs.isActive}
                                    onChange={() => toggleActive(fs)}
                                    label={fs.isActive ? "Aktif" : "Nonaktif"}
                                />,

                                <Group
                                    justify="flex-end"
                                    gap="xs"
                                    wrap="nowrap"
                                    key="actions"
                                >
                                    <Button
                                        variant="subtle"
                                        size="sm"
                                        radius="md"
                                        onClick={() => openEditModal(fs)}
                                    >
                                        Edit
                                    </Button>

                                    <Button
                                        variant="subtle"
                                        color="red"
                                        size="sm"
                                        radius="md"
                                        loading={deletingId === fs.id}
                                        disabled={deletingId === fs.id}
                                        onClick={() => setDeleteTarget(fs)}
                                    >
                                        Hapus
                                    </Button>
                                </Group>,
                            ],
                        };
                    })}
                />
            </SectionCard>

            {/* FORM MODAL */}

            <Modal
                opened={modalOpen}
                onClose={closeModal}
                size="lg"
                title={editingItem ? "Edit flash sale" : "Buat flash sale baru"}
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
                            label="Nama flash sale"
                            size="md"
                            radius="md"
                            value={form.name}
                            onChange={(e) => updateForm("name", e.currentTarget.value)}
                            placeholder="Contoh: Flash Sale Ramadhan"
                        />

                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <Select
                                label="Produk"
                                size="md"
                                radius="md"
                                searchable
                                allowDeselect={false}
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
                                label="Variant"
                                size="md"
                                radius="md"
                                allowDeselect={false}
                                value={form.variantId}
                                onChange={(value) => updateForm("variantId", value ?? "")}
                                disabled={!selectedProduct}
                                placeholder="Pilih variant"
                                data={(selectedProduct?.variants ?? []).map((v) => ({
                                    value: String(v.id),
                                    label: `${v.name} — ${formatRupiah(v.price)} (stok: ${v.stock})`,
                                }))}
                            />
                        </SimpleGrid>

                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <NumberInput
                                label="Harga flash sale (Rp)"
                                size="md"
                                radius="md"
                                min={1}
                                thousandSeparator="."
                                decimalSeparator=","
                                value={form.salePrice === "" ? "" : Number(form.salePrice)}
                                onChange={(value) =>
                                    updateForm(
                                        "salePrice",
                                        value === "" ? "" : String(value)
                                    )
                                }
                            />

                            <NumberInput
                                label="Stok flash sale"
                                size="md"
                                radius="md"
                                min={1}
                                disabled={!!editingItem}
                                description={
                                    editingItem
                                        ? "Stok tidak bisa diubah setelah dibuat"
                                        : undefined
                                }
                                value={form.saleStock === "" ? "" : Number(form.saleStock)}
                                onChange={(value) =>
                                    updateForm(
                                        "saleStock",
                                        value === "" ? "" : String(value)
                                    )
                                }
                            />
                        </SimpleGrid>

                        <NumberInput
                            label="Batas pembelian per user"
                            size="md"
                            radius="md"
                            min={1}
                            value={
                                form.purchaseLimit === "" ? "" : Number(form.purchaseLimit)
                            }
                            onChange={(value) =>
                                updateForm(
                                    "purchaseLimit",
                                    value === "" ? "" : String(value)
                                )
                            }
                        />

                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <TextInput
                                label="Tanggal mulai"
                                size="md"
                                radius="md"
                                type="datetime-local"
                                value={form.startAt}
                                onChange={(e) =>
                                    updateForm("startAt", e.currentTarget.value)
                                }
                            />

                            <TextInput
                                label="Tanggal selesai"
                                size="md"
                                radius="md"
                                type="datetime-local"
                                value={form.endAt}
                                onChange={(e) =>
                                    updateForm("endAt", e.currentTarget.value)
                                }
                            />
                        </SimpleGrid>

                        <Switch
                            size="md"
                            color="green"
                            checked={form.isActive}
                            onChange={(e) =>
                                updateForm("isActive", e.currentTarget.checked)
                            }
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
                            {saving
                                ? "Menyimpan..."
                                : editingItem
                                  ? "Simpan Perubahan"
                                  : "Buat Flash Sale"}
                        </Button>
                    </Group>
                </form>
            </Modal>

            {/* DELETE CONFIRMATION */}

            <Modal
                opened={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                title="Hapus Flash Sale"
                centered
            >
                <Text size="sm">
                    Hapus flash sale &quot;{deleteTarget?.name}&quot;?
                </Text>

                <Text size="sm" c="dimmed" mt="sm">
                    Tindakan ini tidak bisa dibatalkan.
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
