"use client";

import { FormEvent, useEffect, useState } from "react";
import { FiImage } from "react-icons/fi";

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

import ProductImageUpload from "@/components/admin/ProductImageUpload";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: `readJsonResponse` and both of its error strings, `formatDate`,
 * `toDateTimeLocal`, `placementLabel`, `loadPromotions`, `openCreateModal`/`openEditModal`/
 * `closeModal` (including the `saving` guard and the full form reset), `updateForm`, the single
 * validation branch and its message, the payload shape (`priority: Number(...) || 0`, `|| null`
 * fallbacks, ISO dates only when truthy), the create-vs-edit URL/method branch, the success copy,
 * the `loadPromotions()` refresh, the 700ms `closeModal` timer, `handleDelete`'s endpoint and
 * confirmation wording, and the client-side `filtered` search.
 *
 * Presentation changes: `PageHeader`, `SectionCard` + `DataTable`, `StatusBadge`, Mantine inputs,
 * and the previously shared-`useDialog` confirmation is now a dashboard-owned Mantine `Modal` —
 * with the same title ("Hapus Promosi"), the same message and the same confirm label.
 */

type Promotion = {
    id: number;
    title: string;
    description: string | null;
    imageUrl: string | null;
    link: string | null;
    placement: string;
    priority: number;
    isActive: boolean;
    startAt: string | null;
    endAt: string | null;
    createdAt: string;
};

type FormState = {
    title: string;
    description: string;
    imageUrl: string;
    link: string;
    placement: string;
    priority: string;
    isActive: boolean;
    startAt: string;
    endAt: string;
};

const emptyForm: FormState = {
    title: "", description: "", imageUrl: "", link: "",
    placement: "HOMEPAGE", priority: "0", isActive: true, startAt: "", endAt: "",
};

function formatDate(value: string | null) {
    if (!value) return "-";
    return new Date(value).toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

function toDateTimeLocal(value: string | null) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60 * 1000).toISOString().slice(0, 16);
}

function placementLabel(p: string) {
    switch (p) {
        case "HOMEPAGE": return "Halaman Utama";
        case "CAMPAIGN": return "Kampanye";
        case "CATEGORY": return "Kategori";
        case "PRODUCT": return "Produk";
        default: return p;
    }
}

async function readJsonResponse(response: Response) {
    const text = await response.text();
    if (!text) throw new Error(`Server error. Status: ${response.status}`);
    try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON. Status: ${response.status}`); }
}

export default function AdminPromotionsPage() {
    const [promotions, setPromotions] = useState<Promotion[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingItem, setEditingItem] = useState<Promotion | null>(null);
    const [form, setForm] = useState<FormState>(emptyForm);
    const [search, setSearch] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [deleteTarget, setDeleteTarget] = useState<Promotion | null>(null);

    async function loadPromotions() {
        try {
            setLoading(true);
            const response = await fetch("/api/admin/promotions", { cache: "no-store" });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success) throw new Error(result.message || "Gagal mengambil data.");
            setPromotions(result.data?.items ?? (Array.isArray(result.data) ? result.data : []));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal mengambil data.");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => { loadPromotions(); }, []);

    function openCreateModal() { setEditingItem(null); setForm({ ...emptyForm }); setError(""); setSuccess(""); setModalOpen(true); }
    function openEditModal(item: Promotion) {
        setEditingItem(item);
        setForm({
            title: item.title, description: item.description || "", imageUrl: item.imageUrl || "",
            link: item.link || "", placement: item.placement, priority: String(item.priority),
            isActive: item.isActive, startAt: toDateTimeLocal(item.startAt), endAt: toDateTimeLocal(item.endAt),
        });
        setError(""); setSuccess(""); setModalOpen(true);
    }
    function closeModal() { if (saving) return; setModalOpen(false); setEditingItem(null); setForm({ ...emptyForm }); setError(""); setSuccess(""); }
    function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) { setForm((c) => ({ ...c, [key]: value })); }

    async function handleSubmit(e: FormEvent) {
        e.preventDefault(); setError(""); setSuccess("");
        if (!form.title.trim()) { setError("Judul wajib diisi."); return; }

        try {
            setSaving(true);
            const payload: any = {
                title: form.title.trim(), description: form.description.trim() || null,
                imageUrl: form.imageUrl.trim() || null, link: form.link.trim() || null,
                placement: form.placement, priority: Number(form.priority) || 0,
                isActive: form.isActive,
            };
            if (form.startAt) payload.startAt = new Date(form.startAt).toISOString();
            if (form.endAt) payload.endAt = new Date(form.endAt).toISOString();

            const url = editingItem ? `/api/admin/promotions/${editingItem.id}` : "/api/admin/promotions";
            const method = editingItem ? "PATCH" : "POST";
            const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success) throw new Error(result.message || "Gagal menyimpan.");

            setSuccess(editingItem ? "Promosi berhasil diubah." : "Promosi berhasil dibuat.");
            await loadPromotions(); window.setTimeout(closeModal, 700);
        } catch (err) { setError(err instanceof Error ? err.message : "Terjadi kesalahan."); } finally { setSaving(false); }
    }

    async function handleDelete(item: Promotion) {
        try {
            setDeletingId(item.id); setError(""); setSuccess("");
            const response = await fetch(`/api/admin/promotions/${item.id}`, { method: "DELETE" });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success) throw new Error(result.message || "Gagal menghapus.");
            setSuccess("Promosi berhasil dihapus."); await loadPromotions();
        } catch (err) { setError(err instanceof Error ? err.message : "Gagal menghapus."); } finally { setDeletingId(null); }
    }

    async function confirmDelete() {
        const item = deleteTarget;
        setDeleteTarget(null);
        if (!item) return;
        await handleDelete(item);
    }

    const filtered = promotions.filter((p) => !search.trim() || p.title.toLowerCase().includes(search.toLowerCase()));

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="Promosi"
                description="Kelola banner dan promosi di berbagai placement toko."
                actions={
                    <Button
                        size="md"
                        radius="md"
                        leftSection={<FiImage size={16} />}
                        onClick={openCreateModal}
                    >
                        Tambah Promosi
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
                title="Daftar Promosi"
                description={`${filtered.length} promosi`}
                actions={
                    <TextInput
                        size="md"
                        radius="md"
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        placeholder="Cari promosi..."
                        aria-label="Cari promosi"
                        w={{ base: 180, sm: 260 }}
                    />
                }
            >
                <DataTable
                    minWidth={900}
                    loading={loading}
                    empty={
                        <EmptyBlock
                            icon={<FiImage size={22} />}
                            title="Belum ada promosi"
                            description="Buat promosi untuk menampilkan banner di toko."
                            action={
                                <Button size="md" radius="md" onClick={openCreateModal}>
                                    Tambah promosi
                                </Button>
                            }
                        />
                    }
                    columns={[
                        { header: "Judul" },
                        { header: "Placement" },
                        { header: "Prioritas" },
                        { header: "Periode" },
                        { header: "Status" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={filtered.map((p) => ({
                        key: String(p.id),
                        cells: [
                            <Stack gap={0} key="title">
                                <Text size="sm" fw={600}>
                                    {p.title}
                                </Text>

                                {p.description ? (
                                    <Text size="xs" c="dimmed" lineClamp={1} maw={250}>
                                        {p.description}
                                    </Text>
                                ) : null}
                            </Stack>,

                            <Badge variant="default" size="sm" radius="sm" key="placement">
                                {placementLabel(p.placement)}
                            </Badge>,

                            <Text size="sm" key="priority">
                                {p.priority}
                            </Text>,

                            <Stack gap={2} key="period">
                                <Text size="xs">{formatDate(p.startAt)}</Text>

                                <Text size="xs" c="dimmed">
                                    s/d {formatDate(p.endAt)}
                                </Text>
                            </Stack>,

                            <StatusBadge key="status" tone={p.isActive ? "success" : "neutral"}>
                                {p.isActive ? "Aktif" : "Nonaktif"}
                            </StatusBadge>,

                            <Group justify="flex-end" gap="xs" wrap="nowrap" key="actions">
                                <Button
                                    variant="subtle"
                                    size="sm"
                                    radius="md"
                                    onClick={() => openEditModal(p)}
                                >
                                    Edit
                                </Button>

                                <Button
                                    variant="subtle"
                                    color="red"
                                    size="sm"
                                    radius="md"
                                    loading={deletingId === p.id}
                                    disabled={deletingId === p.id}
                                    onClick={() => setDeleteTarget(p)}
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
                title={editingItem ? "Edit promosi" : "Buat promosi baru"}
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
                            label="Judul"
                            size="md"
                            radius="md"
                            value={form.title}
                            onChange={(e) => updateForm("title", e.currentTarget.value)}
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

                        <ProductImageUpload
                            value={form.imageUrl}
                            onChange={(url) => updateForm("imageUrl", url)}
                        />

                        <TextInput
                            label="Link"
                            size="md"
                            radius="md"
                            type="url"
                            placeholder="https://..."
                            value={form.link}
                            onChange={(e) => updateForm("link", e.currentTarget.value)}
                        />

                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <Select
                                label="Placement"
                                size="md"
                                radius="md"
                                allowDeselect={false}
                                value={form.placement}
                                onChange={(value) =>
                                    updateForm("placement", value ?? "HOMEPAGE")
                                }
                                data={[
                                    { value: "HOMEPAGE", label: "Halaman Utama" },
                                    { value: "CAMPAIGN", label: "Kampanye" },
                                    { value: "CATEGORY", label: "Kategori" },
                                    { value: "PRODUCT", label: "Produk" },
                                ]}
                            />

                            <NumberInput
                                label="Prioritas"
                                size="md"
                                radius="md"
                                min={0}
                                value={form.priority === "" ? "" : Number(form.priority)}
                                onChange={(value) =>
                                    updateForm(
                                        "priority",
                                        value === "" ? "" : String(value)
                                    )
                                }
                            />
                        </SimpleGrid>

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
                            {saving ? "Menyimpan..." : editingItem ? "Simpan" : "Buat Promosi"}
                        </Button>
                    </Group>
                </form>
            </Modal>

            {/* DELETE CONFIRMATION */}

            <Modal
                opened={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                title="Hapus Promosi"
                centered
            >
                <Text size="sm">Hapus promosi &quot;{deleteTarget?.title}&quot;?</Text>

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
