"use client";

import { FormEvent, useEffect, useState } from "react";
import { FiEye, FiMail } from "react-icons/fi";

import {
    Alert,
    Badge,
    Box,
    Button,
    Group,
    Loader,
    Modal,
    ScrollArea,
    Select,
    SimpleGrid,
    Stack,
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
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: `readJson`, `TYPE_LABELS`/`TYPE_OPTIONS`, `formatDate`, `statusLabel`,
 * `load`, `openEdit` (including the `new Date(...).toISOString().slice(0, 16)` schedule
 * normalisation), `closeModal`'s `saving` guard, both submit validation branches, the payload
 * (`|| null` fallbacks and the conditional `scheduledAt`), the create-vs-edit URL/method branch,
 * `handleSend`'s `POST /api/admin/broadcasts/{id}/send` and its `res.message` success, and
 * `previewAudience`'s `GET /api/admin/broadcasts/{id}/audience` with its silent `catch` that
 * clears the preview.
 *
 * `statusColor` (six Tailwind text colours) is now the shared semantic tone table, and the three
 * `useDialog` confirmations became Mantine `Modal`s: delete, send, and the audience preview.
 * The audience preview keeps its `audienceCount > 50` "Menampilkan 50 dari …" note.
 */

type Broadcast = {
    id: number;
    name: string;
    type: string;
    channel: string;
    subject: string | null;
    message: string;
    imageUrl: string | null;
    link: string | null;
    status: string;
    scheduledAt: string | null;
    sentAt: string | null;
    audienceCount: number;
    sentCount: number;
    failedCount: number;
    createdAt: string;
};

const TYPE_LABELS: Record<string, string> = {
    BEST_SELLER: "Produk Terlaris",
    NEW_PRODUCT: "Produk Baru",
    BUY_AGAIN: "Beli Lagi",
    INACTIVE_BUYER: "Pembeli Tidak Aktif",
    PRICE_DROP: "Harga Turun",
    CART_REMINDER: "Keranjang",
    CHECKOUT_REMINDER: "Reminder Checkout",
    THANK_YOU: "Terima Kasih",
};

const TYPE_OPTIONS = Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }));

type FormState = {
    name: string;
    type: string;
    channel: string;
    subject: string;
    message: string;
    imageUrl: string;
    link: string;
    scheduledAt: string;
};

const emptyForm: FormState = {
    name: "",
    type: "BEST_SELLER",
    channel: "whatsapp",
    subject: "",
    message: "",
    imageUrl: "",
    link: "",
    scheduledAt: "",
};

function formatDate(v: string) {
    return new Date(v).toLocaleString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function statusLabel(s: string) {
    switch (s) {
        case "DRAFT":
            return "Draft";
        case "SCHEDULED":
            return "Terjadwal";
        case "SENDING":
            return "Mengirim...";
        case "COMPLETED":
            return "Selesai";
        case "FAILED":
            return "Gagal";
        default:
            return s;
    }
}

function statusTone(s: string): Tone {
    switch (s) {
        case "COMPLETED":
            return "success";
        case "SENDING":
            return "info";
        case "FAILED":
            return "error";
        case "SCHEDULED":
            return "warn";
        default:
            return "neutral";
    }
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

export default function AdminBroadcastsPage() {
    const [items, setItems] = useState<Broadcast[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<Broadcast | null>(null);
    const [form, setForm] = useState<FormState>(emptyForm);
    const [search, setSearch] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [audienceModal, setAudienceModal] = useState<{
        broadcast: any;
        audienceCount: number;
        preview: any[];
    } | null>(null);
    const [audienceLoading, setAudienceLoading] = useState(false);
    const [sendingId, setSendingId] = useState<number | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<Broadcast | null>(null);
    const [sendTarget, setSendTarget] = useState<Broadcast | null>(null);

    async function load() {
        try {
            setLoading(true);
            const r = await fetch("/api/admin/broadcasts", { cache: "no-store" });
            const res = await readJson(r);
            if (!r.ok || !res.success) throw new Error(res.message);
            setItems(res.data?.items ?? []);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Gagal memuat.");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        load();
    }, []);

    function openCreate() {
        setEditing(null);
        setForm({ ...emptyForm });
        setError("");
        setSuccess("");
        setModalOpen(true);
    }

    function openEdit(item: Broadcast) {
        setEditing(item);
        setForm({
            name: item.name,
            type: item.type,
            channel: item.channel,
            subject: item.subject || "",
            message: item.message,
            imageUrl: item.imageUrl || "",
            link: item.link || "",
            scheduledAt: item.scheduledAt
                ? new Date(item.scheduledAt).toISOString().slice(0, 16)
                : "",
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
        if (!form.message.trim()) {
            setError("Pesan wajib diisi.");
            return;
        }

        try {
            setSaving(true);
            const payload: any = {
                name: form.name.trim(),
                type: form.type,
                channel: form.channel,
                subject: form.subject.trim() || null,
                message: form.message.trim(),
                imageUrl: form.imageUrl.trim() || null,
                link: form.link.trim() || null,
            };
            if (form.scheduledAt) payload.scheduledAt = new Date(form.scheduledAt).toISOString();

            const url = editing
                ? `/api/admin/broadcasts/${editing.id}`
                : "/api/admin/broadcasts";
            const r = await fetch(url, {
                method: editing ? "PATCH" : "POST",
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
            const r = await fetch(`/api/admin/broadcasts/${item.id}`, {
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

    async function confirmSend() {
        const item = sendTarget;
        setSendTarget(null);
        if (!item) return;

        try {
            setSendingId(item.id);
            setError("");
            setSuccess("");
            const r = await fetch(`/api/admin/broadcasts/${item.id}/send`, {
                method: "POST",
            });
            const res = await readJson(r);
            if (!r.ok || !res.success) throw new Error(res.message);
            setSuccess(res.message || "Broadcast berhasil dikirim.");
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Gagal mengirim.");
        } finally {
            setSendingId(null);
        }
    }

    async function previewAudience(item: Broadcast) {
        try {
            setAudienceLoading(true);
            setAudienceModal(null);
            const r = await fetch(`/api/admin/broadcasts/${item.id}/audience`);
            const res = await readJson(r);
            if (!r.ok || !res.success) throw new Error(res.message);
            setAudienceModal(res.data);
        } catch {
            setAudienceModal(null);
        } finally {
            setAudienceLoading(false);
        }
    }

    const filtered = items.filter(
        (b) =>
            !search.trim() ||
            b.name.toLowerCase().includes(search.toLowerCase()) ||
            (TYPE_LABELS[b.type] ?? "").toLowerCase().includes(search.toLowerCase())
    );

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="Broadcast"
                description="Kirim pesan pemasaran ke pelanggan berdasarkan segmen."
                actions={
                    <Button
                        size="md"
                        radius="md"
                        leftSection={<FiMail size={16} />}
                        onClick={openCreate}
                    >
                        Buat Broadcast
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
                title="Daftar Broadcast"
                description={`${filtered.length} broadcast`}
                actions={
                    <TextInput
                        size="md"
                        radius="md"
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        placeholder="Cari..."
                        aria-label="Cari broadcast"
                        w={{ base: 180, sm: 260 }}
                    />
                }
            >
                <DataTable
                    minWidth={1000}
                    loading={loading}
                    empty={
                        <EmptyBlock
                            icon={<FiMail size={22} />}
                            title="Belum ada broadcast"
                            description="Buat broadcast untuk mengirim pesan ke satu segmen pelanggan."
                            action={
                                <Button size="md" radius="md" onClick={openCreate}>
                                    Buat sekarang
                                </Button>
                            }
                        />
                    }
                    columns={[
                        { header: "Nama" },
                        { header: "Tipe" },
                        { header: "Channel" },
                        { header: "Audience" },
                        { header: "Status" },
                        { header: "Dibuat" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={filtered.map((b) => ({
                        key: String(b.id),
                        cells: [
                            <Stack gap={0} key="name">
                                <Text size="sm" fw={600}>
                                    {b.name}
                                </Text>

                                {b.subject && (
                                    <Text size="xs" c="dimmed">
                                        {b.subject}
                                    </Text>
                                )}
                            </Stack>,

                            <Badge variant="default" size="sm" radius="sm" key="type">
                                {TYPE_LABELS[b.type] ?? b.type}
                            </Badge>,

                            <Text size="xs" tt="capitalize" key="channel">
                                {b.channel}
                            </Text>,

                            <Button
                                variant="subtle"
                                size="compact-sm"
                                key="audience"
                                onClick={() => previewAudience(b)}
                            >
                                <Group gap={6} wrap="nowrap">
                                    <FiEye size={12} />
                                    <Text size="xs" fw={500}>
                                        {b.audienceCount} orang
                                    </Text>
                                </Group>
                            </Button>,

                            <StatusBadge tone={statusTone(b.status)} key="status">
                                {statusLabel(b.status)}
                            </StatusBadge>,

                            <Text size="xs" key="created">
                                {formatDate(b.createdAt)}
                            </Text>,

                            <Group justify="flex-end" gap="xs" wrap="nowrap" key="actions">
                                {(b.status === "DRAFT" || b.status === "SCHEDULED") && (
                                    <Button
                                        variant="subtle"
                                        color="green"
                                        size="sm"
                                        radius="md"
                                        loading={sendingId === b.id}
                                        disabled={sendingId === b.id}
                                        onClick={() => setSendTarget(b)}
                                    >
                                        {sendingId === b.id ? "Mengirim..." : "Kirim"}
                                    </Button>
                                )}

                                {b.status === "FAILED" && (
                                    <Button
                                        variant="subtle"
                                        color="orange"
                                        size="sm"
                                        radius="md"
                                        loading={sendingId === b.id}
                                        disabled={sendingId === b.id}
                                        onClick={() => setSendTarget(b)}
                                    >
                                        {sendingId === b.id ? "Mengirim..." : "Kirim Ulang"}
                                    </Button>
                                )}

                                <Button
                                    variant="subtle"
                                    size="sm"
                                    radius="md"
                                    onClick={() => openEdit(b)}
                                >
                                    Edit
                                </Button>

                                <Button
                                    variant="subtle"
                                    color="red"
                                    size="sm"
                                    radius="md"
                                    loading={deletingId === b.id}
                                    disabled={deletingId === b.id}
                                    onClick={() => setDeleteTarget(b)}
                                >
                                    Hapus
                                </Button>
                            </Group>,
                        ],
                    }))}
                />
            </SectionCard>

            {/* CREATE/EDIT MODAL */}

            <Modal
                opened={modalOpen}
                onClose={closeModal}
                size="lg"
                title={editing ? "Edit broadcast" : "Buat broadcast baru"}
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
                            label="Nama Broadcast"
                            size="md"
                            radius="md"
                            value={form.name}
                            onChange={(e) => updateForm("name", e.currentTarget.value)}
                            placeholder="Contoh: Flash Sale Ramadhan"
                        />

                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <Select
                                label="Tipe"
                                size="md"
                                radius="md"
                                allowDeselect={false}
                                disabled={!!editing}
                                value={form.type}
                                onChange={(value) =>
                                    updateForm("type", value ?? "BEST_SELLER")
                                }
                                data={TYPE_OPTIONS}
                            />

                            <Select
                                label="Channel"
                                size="md"
                                radius="md"
                                allowDeselect={false}
                                value={form.channel}
                                onChange={(value) =>
                                    updateForm("channel", value ?? "whatsapp")
                                }
                                data={[
                                    { value: "whatsapp", label: "WhatsApp" },
                                    { value: "email", label: "Email" },
                                ]}
                            />
                        </SimpleGrid>

                        <TextInput
                            label="Subjek (opsional)"
                            size="md"
                            radius="md"
                            value={form.subject}
                            onChange={(e) => updateForm("subject", e.currentTarget.value)}
                        />

                        <Textarea
                            label="Pesan"
                            size="md"
                            radius="md"
                            required
                            value={form.message}
                            onChange={(e) => updateForm("message", e.currentTarget.value)}
                            rows={5}
                            autosize
                            minRows={4}
                            maxRows={10}
                            placeholder="Gunakan {name} untuk nama pelanggan, {product} untuk nama produk, dll."
                        />

                        <TextInput
                            label="URL Gambar (opsional)"
                            size="md"
                            radius="md"
                            type="url"
                            value={form.imageUrl}
                            onChange={(e) => updateForm("imageUrl", e.currentTarget.value)}
                            placeholder="https://..."
                        />

                        <TextInput
                            label="Link (opsional)"
                            size="md"
                            radius="md"
                            type="url"
                            value={form.link}
                            onChange={(e) => updateForm("link", e.currentTarget.value)}
                            placeholder="https://..."
                        />

                        <TextInput
                            label="Jadwal Kirim (opsional)"
                            size="md"
                            radius="md"
                            type="datetime-local"
                            value={form.scheduledAt}
                            onChange={(e) =>
                                updateForm("scheduledAt", e.currentTarget.value)
                            }
                            description="Kosongkan untuk menyimpan sebagai draft."
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
                            {saving ? "Menyimpan..." : editing ? "Simpan" : "Buat Broadcast"}
                        </Button>
                    </Group>
                </form>
            </Modal>

            {/* AUDIENCE PREVIEW MODAL */}

            <Modal
                opened={audienceLoading || audienceModal !== null}
                onClose={() => setAudienceModal(null)}
                size="lg"
                title={
                    audienceLoading ? (
                        "Memuat audience…"
                    ) : (
                        <Box>
                            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                                Audience Preview
                            </Text>

                            <Text fw={700} mt={4}>
                                {audienceModal?.broadcast.name}
                            </Text>

                            <Text size="sm" c="dimmed" mt={2}>
                                {audienceModal?.audienceCount} target ditemukan
                            </Text>
                        </Box>
                    )
                }
                centered
            >
                {audienceLoading ? (
                    <Group justify="center" py="xl" gap="sm">
                        <Loader size="sm" />
                        <Text size="sm" c="dimmed">
                            Memuat audience...
                        </Text>
                    </Group>
                ) : audienceModal ? (
                    <Box>
                        {audienceModal.preview.length === 0 ? (
                            <Text size="sm" c="dimmed" ta="center">
                                Tidak ada audience yang cocok.
                            </Text>
                        ) : (
                            <ScrollArea.Autosize mah={400}>
                                <Stack gap="xs">
                                    {audienceModal.preview.map((m: any, i: number) => (
                                        <Group
                                            key={i}
                                            justify="space-between"
                                            wrap="nowrap"
                                            px="md"
                                            py="sm"
                                            style={{
                                                border: "1px solid var(--mantine-color-gray-2)",
                                                borderRadius: 8,
                                            }}
                                        >
                                            <Box style={{ minWidth: 0 }}>
                                                <Text size="sm" fw={500}>
                                                    {m.name || "User #" + m.userId.slice(0, 8)}
                                                </Text>

                                                <Text size="xs" c="dimmed">
                                                    {m.phone}
                                                </Text>
                                            </Box>

                                            <Badge variant="default" size="sm" radius="xl">
                                                {m.reason}
                                            </Badge>
                                        </Group>
                                    ))}
                                </Stack>
                            </ScrollArea.Autosize>
                        )}

                        {audienceModal.audienceCount > 50 && (
                            <Text size="xs" c="dimmed" ta="center" mt="md">
                                Menampilkan 50 dari {audienceModal.audienceCount} audience
                            </Text>
                        )}
                    </Box>
                ) : null}
            </Modal>

            {/* SEND CONFIRMATION */}

            <Modal
                opened={sendTarget !== null}
                onClose={() => setSendTarget(null)}
                title="Kirim Broadcast"
                centered
            >
                <Text size="sm">
                    Kirim broadcast &quot;{sendTarget?.name}&quot; ke{" "}
                    {sendTarget?.audienceCount} orang?
                </Text>

                <Text size="sm" c="dimmed" mt="sm">
                    Tindakan ini tidak bisa dibatalkan.
                </Text>

                <Group justify="flex-end" mt="lg">
                    <Button
                        variant="default"
                        size="md"
                        radius="md"
                        onClick={() => setSendTarget(null)}
                    >
                        Batal
                    </Button>

                    <Button size="md" radius="md" onClick={confirmSend}>
                        Kirim
                    </Button>
                </Group>
            </Modal>

            {/* DELETE CONFIRMATION */}

            <Modal
                opened={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                title="Hapus Broadcast"
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
