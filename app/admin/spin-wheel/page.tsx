"use client";

import { FormEvent, useEffect, useState } from "react";
import { FiPlus, FiTarget, FiTrash2 } from "react-icons/fi";

import {
    Alert,
    Box,
    Button,
    Divider,
    Group,
    Modal,
    NumberInput,
    Paper,
    Select,
    SimpleGrid,
    Stack,
    Switch,
    Text,
    Textarea,
    TextInput,
    UnstyledButton,
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
 * Preserved exactly: `formatRupiah`, `formatDate`, `toDateTimeLocal`, `rewardTypeLabel`,
 * `readJsonResponse` and both of its error strings, `loadCampaigns` (endpoint, `result.data?.items ?? []`
 * fallback, error copy), the `emptyForm` defaults including all five seeded rewards and
 * `maxSpinsPerUser: "0"`, `openEditModal`'s mapping (`String(...)` coercions and the per-reward copy
 * via `{ ...r }`), `closeModal`'s `saving` guard, `updateForm`/`updateReward`/`addReward`/
 * `removeReward`, **every** validation branch and its exact message (including the per-reward name /
 * value / weight rules), the payload shape (`r.type === "ZONK" ? 0 : r.value`, `id` passthrough,
 * `null` optionals, ISO dates), the create-vs-edit URL/method branch, the success copy, the
 * `loadCampaigns()` refresh and the 700ms `closeModal` timer.
 *
 * `handleToggleActive` still PATCHes only `{ isActive: !item.isActive }`, and delete is still blocked
 * once a campaign has spins (`disabled={c.spinCount > 0}`).
 *
 * Presentation changes: `PageHeader`, `SectionCard` + `DataTable`, `StatusBadge`, Mantine inputs and
 * `Paper` reward rows. The shared-`useDialog` confirmation became a dashboard-owned Mantine `Modal`
 * with the same title (\"Hapus Campaign\"), message and confirm label. `FiZap` was an unused import
 * and was dropped.
 */

type Reward = {
    id?: number;
    name: string;
    type: string;
    value: number;
    maxDiscount: number | null;
    weight: number;
    totalQuantity: number | null;
    usedQuantity: number;
    isActive: boolean;
};

type Campaign = {
    id: number;
    name: string;
    slug: string;
    description: string | null;
    minimumSpend: number;
    maxSpinsPerUser: number;
    startAt: string;
    endAt: string;
    isActive: boolean;
    createdAt: string;
    spinCount: number;
    rewards: Reward[];
};

type FormState = {
    name: string;
    description: string;
    minimumSpend: string;
    maxSpinsPerUser: string;
    startAt: string;
    endAt: string;
    isActive: boolean;
    rewards: Reward[];
};

const emptyForm: FormState = {
    name: "",
    description: "",
    minimumSpend: "100000",
    maxSpinsPerUser: "0", // 0 = no cap, milestone-based unlimited
    startAt: "",
    endAt: "",
    isActive: true,
    rewards: [
        { name: "Diskon 5%", type: "PERCENTAGE", value: 5, maxDiscount: null, weight: 40, totalQuantity: null, usedQuantity: 0, isActive: true },
        { name: "Diskon 10%", type: "PERCENTAGE", value: 10, maxDiscount: null, weight: 20, totalQuantity: null, usedQuantity: 0, isActive: true },
        { name: "Diskon Rp25.000", type: "FIXED", value: 25000, maxDiscount: null, weight: 10, totalQuantity: 100, usedQuantity: 0, isActive: true },
        { name: "Gratis Ongkir", type: "FREE_SHIPPING", value: 0, maxDiscount: null, weight: 20, totalQuantity: null, usedQuantity: 0, isActive: true },
        { name: "Coba Lagi", type: "ZONK", value: 0, maxDiscount: null, weight: 10, totalQuantity: null, usedQuantity: 0, isActive: true },
    ],
};

function formatRupiah(value: number) {
    return `Rp ${value.toLocaleString("id-ID")}`;
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

function toDateTimeLocal(value: string | null) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60 * 1000).toISOString().slice(0, 16);
}

function rewardTypeLabel(type: string) {
    switch (type) {
        case "PERCENTAGE": return "Persen (%)";
        case "FIXED": return "Fixed (Rp)";
        case "FREE_SHIPPING": return "Gratis Ongkir";
        case "CASHBACK": return "Cashback";
        case "ZONK": return "Coba Lagi";
        default: return type;
    }
}

async function readJsonResponse(response: Response) {
    const text = await response.text();
    if (!text) throw new Error(`Server error. Status: ${response.status}`);
    try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON. Status: ${response.status}`); }
}

export default function AdminSpinWheelPage() {
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
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
            const response = await fetch("/api/admin/spin-wheel/campaigns", { cache: "no-store" });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success) throw new Error(result.message || "Gagal mengambil data.");
            setCampaigns(result.data?.items ?? []);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal mengambil data.");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => { loadCampaigns(); }, []);

    function openCreateModal() {
        setEditingItem(null);
        setForm({ ...emptyForm });
        setError(""); setSuccess(""); setModalOpen(true);
    }

    function openEditModal(item: Campaign) {
        setEditingItem(item);
        setForm({
            name: item.name,
            description: item.description || "",
            minimumSpend: String(item.minimumSpend),
            maxSpinsPerUser: String(item.maxSpinsPerUser),
            startAt: toDateTimeLocal(item.startAt),
            endAt: toDateTimeLocal(item.endAt),
            isActive: item.isActive,
            rewards: item.rewards.map((r) => ({ ...r })),
        });
        setError(""); setSuccess(""); setModalOpen(true);
    }

    function closeModal() {
        if (saving) return;
        setModalOpen(false); setEditingItem(null); setForm({ ...emptyForm }); setError(""); setSuccess("");
    }

    function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
        setForm((c) => ({ ...c, [key]: value }));
    }

    function updateReward(index: number, field: keyof Reward, value: any) {
        setForm((c) => {
            const rewards = [...c.rewards];
            rewards[index] = { ...rewards[index], [field]: value };
            return { ...c, rewards };
        });
    }

    function addReward() {
        setForm((c) => ({
            ...c,
            rewards: [
                ...c.rewards,
                { name: "", type: "PERCENTAGE", value: 5, maxDiscount: null, weight: 10, totalQuantity: null, usedQuantity: 0, isActive: true },
            ],
        }));
    }

    function removeReward(index: number) {
        setForm((c) => ({
            ...c,
            rewards: c.rewards.filter((_, i) => i !== index),
        }));
    }

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(""); setSuccess("");

        if (!form.name.trim()) { setError("Nama campaign wajib diisi."); return; }
        if (!form.startAt || !form.endAt) { setError("Tanggal wajib diisi."); return; }
        if (new Date(form.endAt) <= new Date(form.startAt)) { setError("Tanggal selesai harus setelah tanggal mulai."); return; }
        if (form.rewards.length === 0) { setError("Minimal harus ada 1 reward."); return; }

        // Validate rewards
        for (const r of form.rewards) {
            if (!r.name.trim()) { setError("Nama reward wajib diisi."); return; }
            if (r.type !== "ZONK" && (!Number.isFinite(r.value) || r.value <= 0)) {
                setError(`Nilai reward "${r.name}" harus lebih dari 0.`);
                return;
            }
            if (!Number.isInteger(r.weight) || r.weight < 1) {
                setError(`Weight reward "${r.name}" harus bilangan bulat >= 1.`);
                return;
            }
        }

        try {
            setSaving(true);
            const payload = {
                name: form.name.trim(),
                description: form.description.trim() || null,
                minimumSpend: Number(form.minimumSpend),
                maxSpinsPerUser: Number(form.maxSpinsPerUser),
                startAt: new Date(form.startAt).toISOString(),
                endAt: new Date(form.endAt).toISOString(),
                isActive: form.isActive,
                rewards: form.rewards.map((r) => ({
                    id: r.id,
                    name: r.name.trim(),
                    type: r.type,
                    value: r.type === "ZONK" ? 0 : r.value,
                    maxDiscount: r.maxDiscount,
                    weight: r.weight,
                    totalQuantity: r.totalQuantity,
                    isActive: r.isActive,
                })),
            };

            const url = editingItem
                ? `/api/admin/spin-wheel/campaigns/${editingItem.id}`
                : "/api/admin/spin-wheel/campaigns";
            const method = editingItem ? "PATCH" : "POST";

            const response = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success) throw new Error(result.message || "Gagal menyimpan.");

            setSuccess(editingItem ? "Campaign berhasil diubah." : "Campaign berhasil dibuat.");
            await loadCampaigns();
            window.setTimeout(closeModal, 700);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Terjadi kesalahan.");
        } finally {
            setSaving(false);
        }
    }

    async function handleToggleActive(item: Campaign) {
        try {
            setError(""); setSuccess("");
            const response = await fetch(`/api/admin/spin-wheel/campaigns/${item.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ isActive: !item.isActive }),
            });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success) throw new Error(result.message || "Gagal mengubah status.");
            await loadCampaigns();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal mengubah status.");
        }
    }

    async function handleDelete(item: Campaign) {
        try {
            setError(""); setSuccess("");
            const response = await fetch(`/api/admin/spin-wheel/campaigns/${item.id}`, { method: "DELETE" });
            const result = await readJsonResponse(response);
            if (!response.ok || !result.success) throw new Error(result.message || "Gagal menghapus.");
            setSuccess("Campaign berhasil dihapus.");
            await loadCampaigns();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal menghapus.");
        }
    }

    async function confirmDelete() {
        const item = deleteTarget;
        setDeleteTarget(null);
        if (!item) return;
        await handleDelete(item);
    }

    const filtered = campaigns.filter((c) => !search.trim() || c.name.toLowerCase().includes(search.toLowerCase()));

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="Spin Wheel Promo"
                description="Kelola kampanye spin wheel promo untuk customer."
                actions={
                    <Button
                        size="md"
                        radius="md"
                        leftSection={<FiTarget size={16} />}
                        onClick={openCreateModal}
                    >
                        Tambah Campaign
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
                title="Daftar Campaign"
                description={`${filtered.length} campaign`}
                actions={
                    <TextInput
                        size="md"
                        radius="md"
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        placeholder="Cari campaign..."
                        aria-label="Cari campaign"
                        w={{ base: 180, sm: 260 }}
                    />
                }
            >
                <DataTable
                    minWidth={1000}
                    loading={loading}
                    empty={
                        <EmptyBlock
                            icon={<FiTarget size={22} />}
                            title="Belum ada campaign spin wheel"
                            description="Buat campaign untuk mengaktifkan spin wheel promo."
                            action={
                                <Button size="md" radius="md" onClick={openCreateModal}>
                                    Buat campaign
                                </Button>
                            }
                        />
                    }
                    columns={[
                        { header: "Nama" },
                        { header: "Min. Belanja" },
                        { header: "Rewards" },
                        { header: "Periode" },
                        { header: "Spin" },
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

                            <Text size="sm" fw={500} key="min">
                                {formatRupiah(c.minimumSpend)}
                            </Text>,

                            <Stack gap={2} key="rewards">
                                <Text size="sm">{c.rewards.length} reward</Text>

                                <Text size="xs" c="dimmed">
                                    Max {c.maxSpinsPerUser}x spin/user
                                </Text>
                            </Stack>,

                            <Stack gap={2} key="period">
                                <Text size="xs">{formatDate(c.startAt)}</Text>

                                <Text size="xs" c="dimmed">
                                    s/d {formatDate(c.endAt)}
                                </Text>
                            </Stack>,

                            <Stack gap={2} key="spin">
                                <Text size="sm" fw={500}>
                                    {c.spinCount}
                                </Text>

                                <Text size="xs" c="dimmed">
                                    total spin
                                </Text>
                            </Stack>,

                            <UnstyledButton
                                key="status"
                                onClick={() => handleToggleActive(c)}
                                aria-label={`Ubah status ${c.name}`}
                            >
                                <StatusBadge tone={c.isActive ? "success" : "neutral"}>
                                    {c.isActive ? "Aktif" : "Nonaktif"}
                                </StatusBadge>
                            </UnstyledButton>,

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
                                    disabled={c.spinCount > 0}
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
                title={editingItem ? "Edit campaign" : "Buat campaign baru"}
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
                            label="Nama Campaign"
                            size="md"
                            radius="md"
                            placeholder="Contoh: Ramadan Spin Wheel"
                            value={form.name}
                            onChange={(e) => updateForm("name", e.currentTarget.value)}
                        />

                        <Textarea
                            label="Deskripsi"
                            size="md"
                            radius="md"
                            placeholder="Deskripsi campaign (opsional)"
                            value={form.description}
                            onChange={(e) => updateForm("description", e.currentTarget.value)}
                            minRows={3}
                            maxRows={5}
                            autosize
                        />

                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <NumberInput
                                label="Minimum Belanja (Rp)"
                                description="Total subtotal order yang sudah dibayar"
                                size="md"
                                radius="md"
                                min={0}
                                step={1000}
                                value={form.minimumSpend === "" ? "" : Number(form.minimumSpend)}
                                onChange={(value) =>
                                    updateForm("minimumSpend", value === "" ? "" : String(value))
                                }
                            />

                            <NumberInput
                                label="Max Spin per User"
                                description="0 = tanpa batas (berdasarkan milestone belanja)"
                                size="md"
                                radius="md"
                                min={0}
                                value={form.maxSpinsPerUser === "" ? "" : Number(form.maxSpinsPerUser)}
                                onChange={(value) =>
                                    updateForm("maxSpinsPerUser", value === "" ? "" : String(value))
                                }
                            />
                        </SimpleGrid>

                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                            <TextInput
                                label="Tanggal Mulai"
                                size="md"
                                radius="md"
                                type="datetime-local"
                                value={form.startAt}
                                onChange={(e) => updateForm("startAt", e.currentTarget.value)}
                            />

                            <TextInput
                                label="Tanggal Selesai"
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

                        <Divider
                            label={`Rewards (${form.rewards.length})`}
                            labelPosition="left"
                        />

                        <Group justify="flex-end">
                            <Button
                                type="button"
                                variant="default"
                                size="sm"
                                radius="md"
                                leftSection={<FiPlus size={14} />}
                                onClick={addReward}
                            >
                                Tambah Reward
                            </Button>
                        </Group>

                        <Stack gap="sm">
                            {form.rewards.map((r, idx) => (
                                <Paper key={idx} withBorder radius="md" p="md">
                                    <Group justify="space-between" align="center" mb="sm">
                                        <Text size="xs" fw={600} c="dimmed">
                                            Reward #{idx + 1}
                                        </Text>

                                        <Button
                                            type="button"
                                            variant="subtle"
                                            color="red"
                                            size="compact-sm"
                                            radius="md"
                                            leftSection={<FiTrash2 size={14} />}
                                            onClick={() => removeReward(idx)}
                                        >
                                            Hapus
                                        </Button>
                                    </Group>

                                    <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
                                        <Box style={{ gridColumn: "span 2" }}>
                                            <TextInput
                                                label="Nama"
                                                size="sm"
                                                radius="md"
                                                placeholder="Diskon 5%"
                                                value={r.name}
                                                onChange={(e) =>
                                                    updateReward(idx, "name", e.currentTarget.value)
                                                }
                                            />
                                        </Box>

                                        <Select
                                            label="Tipe"
                                            size="sm"
                                            radius="md"
                                            allowDeselect={false}
                                            value={r.type}
                                            onChange={(value) =>
                                                updateReward(idx, "type", value ?? "PERCENTAGE")
                                            }
                                            data={[
                                                { value: "PERCENTAGE", label: "Persen (%)" },
                                                { value: "FIXED", label: "Fixed (Rp)" },
                                                { value: "FREE_SHIPPING", label: "Gratis Ongkir" },
                                                { value: "CASHBACK", label: "Cashback" },
                                                { value: "ZONK", label: "Coba Lagi" },
                                            ]}
                                        />

                                        <NumberInput
                                            label="Weight"
                                            size="sm"
                                            radius="md"
                                            min={1}
                                            value={r.weight}
                                            onChange={(value) =>
                                                updateReward(
                                                    idx,
                                                    "weight",
                                                    value === "" ? 0 : Number(value)
                                                )
                                            }
                                        />

                                        {r.type !== "ZONK" && r.type !== "FREE_SHIPPING" && (
                                            <>
                                                <NumberInput
                                                    label="Nilai"
                                                    size="sm"
                                                    radius="md"
                                                    min={0}
                                                    value={r.value}
                                                    onChange={(value) =>
                                                        updateReward(
                                                            idx,
                                                            "value",
                                                            value === "" ? 0 : Number(value)
                                                        )
                                                    }
                                                />

                                                <NumberInput
                                                    label="Max Diskon"
                                                    size="sm"
                                                    radius="md"
                                                    min={0}
                                                    placeholder="Tidak terbatas"
                                                    value={r.maxDiscount ?? ""}
                                                    onChange={(value) =>
                                                        updateReward(
                                                            idx,
                                                            "maxDiscount",
                                                            value === "" ? null : Number(value)
                                                        )
                                                    }
                                                />
                                            </>
                                        )}

                                        <NumberInput
                                            label="Total Qty"
                                            size="sm"
                                            radius="md"
                                            min={0}
                                            placeholder="Tidak terbatas"
                                            value={r.totalQuantity ?? ""}
                                            onChange={(value) =>
                                                updateReward(
                                                    idx,
                                                    "totalQuantity",
                                                    value === "" ? null : Number(value)
                                                )
                                            }
                                        />

                                        <Switch
                                            label={r.isActive ? "Aktif" : "Off"}
                                            size="sm"
                                            color="green"
                                            checked={r.isActive}
                                            onChange={(e) =>
                                                updateReward(
                                                    idx,
                                                    "isActive",
                                                    e.currentTarget.checked
                                                )
                                            }
                                            style={{ alignSelf: "end" }}
                                        />
                                    </SimpleGrid>
                                </Paper>
                            ))}
                        </Stack>
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
                            {saving ? "Menyimpan..." : editingItem ? "Simpan" : "Buat Campaign"}
                        </Button>
                    </Group>
                </form>
            </Modal>

            {/* DELETE CONFIRMATION */}

            <Modal
                opened={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                title="Hapus Campaign"
                centered
            >
                <Text size="sm">
                    Hapus campaign &quot;{deleteTarget?.name}&quot;?
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
