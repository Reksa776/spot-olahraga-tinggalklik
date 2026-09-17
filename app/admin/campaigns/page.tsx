"use client";

import { FormEvent, useEffect, useState } from "react";
import { FiTarget } from "react-icons/fi";

import {
    Alert,
    Badge,
    Button,
    Group,
    Modal,
    NumberInput,
    Select,
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
    PageHeader,
    SectionCard,
    StatusBadge,
} from "@/components/dashboard/primitives";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: `readJsonResponse` and both messages, `formatDate`, `toDateTimeLocal`,
 * `typeLabel`, `loadCampaigns`, `openEditModal`'s mapping (including the `Number(...)` string
 * conversions and the `discountType || "PERCENTAGE"` fallback), `closeModal`'s `saving` guard, every
 * validation branch, and — importantly — the **conditional** payload: `discountType`/`discountValue`
 * are only attached when `form.discountValue` is truthy, and `maxDiscount` only when
 * `form.maxDiscount` is truthy. Sending them unconditionally would change what the API receives, so
 * the `if` blocks are kept verbatim. The slug is still lower-cased and whitespace-hyphenated at
 * submit, and the `disabled` slug field on edit is kept because the API treats slug as immutable.
 */

type Campaign = {
    id: number;
    name: string;
    slug: string;
    description: string | null;
    bannerUrl: string | null;
    code: string | null;
    type: string;
    startAt: string;
    endAt: string;
    discountType: string | null;
    discountValue: string | number | null;
    maxDiscount: string | number | null;
    priority: number;
    isActive: boolean;
    createdAt: string;
};

type FormState = {
    name: string;
    slug: string;
    description: string;
    type: string;
    startAt: string;
    endAt: string;
    discountType: string;
    discountValue: string;
    maxDiscount: string;
    isActive: boolean;
};

const emptyForm: FormState = {
    name: "",
    slug: "",
    description: "",
    type: "GENERAL",
    startAt: "",
    endAt: "",
    discountType: "PERCENTAGE",
    discountValue: "",
    maxDiscount: "",
    isActive: true,
};

function formatDate(value: string) {
    return new Date(value).toLocaleString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function toDateTimeLocal(value: string | null) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60 * 1000).toISOString().slice(0, 16);
}

function typeLabel(type: string) {
    switch (type) {
        case "GENERAL":
            return "Umum";
        case "FLASH_SALE":
            return "Flash Sale";
        case "CATEGORY_DISCOUNT":
            return "Diskon Kategori";
        case "PRODUCT_DISCOUNT":
            return "Diskon Produk";
        default:
            return type;
    }
}

async function readJsonResponse(response: Response) {
    const text = await response.text();
    if (!text) throw new Error(`Server error. Status: ${response.status}`);
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Invalid JSON. Status: ${response.status}`);
    }
}

export default function AdminCampaignsPage() {
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingItem, setEditingItem] = useState<Campaign | null>(null);
    const [form, setForm] = useState<FormState>(emptyForm);
    const [search, setSearch] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [deleteTarget, setDeleteTarget] = useState<Campaign | null>(null);

    async function loadCampaigns() {
        try {
            setLoading(true);
            const response = await fetch("/api/admin/campaigns", { cache: "no-store" });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success)
                throw new Error(result.message || "Gagal mengambil data.");
            setCampaigns(
                result.data?.items ?? (Array.isArray(result.data) ? result.data : [])
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal mengambil data.");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadCampaigns();
    }, []);

    function openCreateModal() {
        setEditingItem(null);
        setForm({ ...emptyForm });
        setError("");
        setSuccess("");
        setModalOpen(true);
    }

    function openEditModal(item: Campaign) {
        setEditingItem(item);
        setForm({
            name: item.name,
            slug: item.slug,
            description: item.description || "",
            type: item.type,
            startAt: toDateTimeLocal(item.startAt),
            endAt: toDateTimeLocal(item.endAt),
            discountType: item.discountType || "PERCENTAGE",
            discountValue:
                item.discountValue != null ? String(Number(item.discountValue)) : "",
            maxDiscount:
                item.maxDiscount != null ? String(Number(item.maxDiscount)) : "",
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
        if (!form.slug.trim()) {
            setError("Slug wajib diisi.");
            return;
        }
        if (!form.startAt || !form.endAt) {
            setError("Tanggal wajib diisi.");
            return;
        }
        if (new Date(form.endAt) <= new Date(form.startAt)) {
            setError("Tanggal selesai harus setelah tanggal mulai.");
            return;
        }

        try {
            setSaving(true);
            const payload: any = {
                name: form.name.trim(),
                slug: form.slug.trim().toLowerCase().replace(/\s+/g, "-"),
                description: form.description.trim() || null,
                type: form.type,
                startAt: new Date(form.startAt).toISOString(),
                endAt: new Date(form.endAt).toISOString(),
                isActive: form.isActive,
            };
            if (form.discountValue) {
                payload.discountType = form.discountType;
                payload.discountValue = Number(form.discountValue);
            }
            if (form.maxDiscount) payload.maxDiscount = Number(form.maxDiscount);

            const url = editingItem
                ? `/api/admin/campaigns/${editingItem.id}`
                : "/api/admin/campaigns";
            const method = editingItem ? "PATCH" : "POST";
            const response = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success)
                throw new Error(result.message || "Gagal menyimpan.");

            setSuccess(
                editingItem
                    ? "Kampanye berhasil diubah."
                    : "Kampanye berhasil dibuat."
            );
            await loadCampaigns();
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
            const response = await fetch(`/api/admin/campaigns/${item.id}`, {
                method: "DELETE",
            });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success)
                throw new Error(result.message || "Gagal menghapus.");
            setSuccess("Kampanye berhasil dihapus.");
            await loadCampaigns();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal menghapus.");
        } finally {
            setDeletingId(null);
        }
    }

    const filtered = campaigns.filter(
        (c) => !search.trim() || c.name.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="Kampanye"
                description="Kelola kampanye promosi dan diskon toko."
                actions={
                    <Button
                        size="md"
                        radius="md"
                        leftSection={<FiTarget size={16} />}
                        onClick={openCreateModal}
                    >
                        Tambah Kampanye
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
                title="Daftar Kampanye"
                description={`${filtered.length} kampanye`}
                actions={
                    <TextInput
                        size="md"
                        radius="md"
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        placeholder="Cari kampanye..."
                        aria-label="Cari kampanye"
                        w={{ base: 180, sm: 260 }}
                    />
                }
            >
                <DataTable
                    minWidth={900}
                    loading={loading}
                    empty={
                        <EmptyBlock
                            icon={<FiTarget size={22} />}
                            title="Belum ada kampanye"
                            description="Buat kampanye untuk menjalankan promosi toko."
                            action={
                                <Button size="md" radius="md" onClick={openCreateModal}>
                                    Tambah kampanye
                                </Button>
                            }
                        />
                    }
                    columns={[
                        { header: "Nama" },
                        { header: "Tipe" },
                        { header: "Diskon" },
                        { header: "Periode" },
                        { header: "Status" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={filtered.map((c) => ({
                        key: String(c.id),
                        cells: [
                            <Stack gap={0} key="name">
                                <Text size="sm" fw={600}>
                                    {c.name}
                                </Text>

                                <Text size="xs" c="dimmed">
                                    /{c.slug}
                                </Text>
                            </Stack>,

                            <Badge variant="default" size="sm" radius="sm" key="type">
                                {typeLabel(c.type)}
                            </Badge>,

                            c.discountValue != null ? (
                                <Text size="sm" fw={500} key="discount">
                                    {c.discountType === "PERCENTAGE"
                                        ? `${Number(c.discountValue)}%`
                                        : `Rp ${Number(c.discountValue).toLocaleString(
                                              "id-ID"
                                          )}`}
                                </Text>
                            ) : (
                                <Text size="xs" c="dimmed" key="discount">
                                    -
                                </Text>
                            ),

                            <Stack gap={2} key="period">
                                <Text size="xs">{formatDate(c.startAt)}</Text>

                                <Text size="xs" c="dimmed">
                                    s/d {formatDate(c.endAt)}
                                </Text>
                            </Stack>,

                            <StatusBadge key="status" tone={c.isActive ? "success" : "neutral"}>
                                {c.isActive ? "Aktif" : "Nonaktif"}
                            </StatusBadge>,

                            <Group justify="flex-end" gap="xs" wrap="nowrap" key="actions">
                                <Button
                                    variant="subtle"
                                    size="sm"
                                    radius="md"
                                    onClick={() => openEditModal(c)}
                                >
                                    Edit
                                </Button>

                                <Button
                                    variant="subtle"
                                    color="red"
                                    size="sm"
                                    radius="md"
                                    loading={deletingId === c.id}
                                    disabled={deletingId === c.id}
                                    onClick={() => setDeleteTarget(c)}
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
                title={editingItem ? "Edit kampanye" : "Buat kampanye baru"}
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

                        <TextInput
                            label="Slug"
                            size="md"
                            radius="md"
                            value={form.slug}
                            onChange={(e) => updateForm("slug", e.currentTarget.value)}
                            disabled={!!editingItem}
                        />

                        <Textarea
                            label="Deskripsi"
                            size="md"
                            radius="md"
                            value={form.description}
                            onChange={(e) =>
                                updateForm("description", e.currentTarget.value)
                            }
                            minRows={3}
                            maxRows={6}
                            autosize
                        />

                        <Select
                            label="Tipe"
                            size="md"
                            radius="md"
                            allowDeselect={false}
                            value={form.type}
                            onChange={(value) => updateForm("type", value ?? "GENERAL")}
                            data={[
                                { value: "GENERAL", label: "Umum" },
                                { value: "FLASH_SALE", label: "Flash Sale" },
                                { value: "CATEGORY_DISCOUNT", label: "Diskon Kategori" },
                                { value: "PRODUCT_DISCOUNT", label: "Diskon Produk" },
                            ]}
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

                        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
                            <Select
                                label="Tipe Diskon"
                                size="md"
                                radius="md"
                                allowDeselect={false}
                                value={form.discountType}
                                onChange={(value) =>
                                    updateForm("discountType", value ?? "PERCENTAGE")
                                }
                                data={[
                                    { value: "PERCENTAGE", label: "Persen (%)" },
                                    { value: "FIXED", label: "Fixed (Rp)" },
                                ]}
                            />

                            <NumberInput
                                label="Nilai Diskon"
                                size="md"
                                radius="md"
                                min={0}
                                value={
                                    form.discountValue === ""
                                        ? ""
                                        : Number(form.discountValue)
                                }
                                onChange={(value) =>
                                    updateForm(
                                        "discountValue",
                                        value === "" ? "" : String(value)
                                    )
                                }
                            />

                            <NumberInput
                                label="Maks Diskon"
                                size="md"
                                radius="md"
                                min={0}
                                value={
                                    form.maxDiscount === "" ? "" : Number(form.maxDiscount)
                                }
                                onChange={(value) =>
                                    updateForm(
                                        "maxDiscount",
                                        value === "" ? "" : String(value)
                                    )
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
                            {saving ? "Menyimpan..." : editingItem ? "Simpan" : "Buat Kampanye"}
                        </Button>
                    </Group>
                </form>
            </Modal>

            {/* DELETE CONFIRMATION */}

            <Modal
                opened={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                title="Hapus Kampanye"
                centered
            >
                <Text size="sm">
                    Hapus kampanye &quot;{deleteTarget?.name}&quot;?
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
