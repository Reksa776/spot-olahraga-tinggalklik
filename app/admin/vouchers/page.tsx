"use client";

import { FormEvent, useEffect, useState } from "react";
import {
    Alert,
    Box,
    Button,
    Divider,
    Group,
    Modal,
    NumberInput,
    Progress,
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
    StatCard,
    StatGrid,
} from "@/components/dashboard/primitives";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: `readJsonResponse` and both of its error strings, `formatRupiah`,
 * `formatDate`, `toDateTimeLocal`, `loadVouchers(pageNum)` and its `page`/`limit` params, the
 * `openCreateModal`/`openEditModal`/`closeModal` resets, `updateForm`, every validation branch in
 * `handleSubmit` (including the "quota < usedCount" rule that quotes the used count), the
 * create-vs-edit URL/method branch, the payload shape (`code` upper-cased, `|| null` fallbacks,
 * `maxDiscount` only for PERCENTAGE), the success copy, the `loadVouchers(page)` refresh, the 700ms
 * `closeModal` timer, `handleDelete`'s used-count guard, `toggleActive`, the client-side
 * `filteredVouchers` search, `activeCount` and `totalUsed` derivations and the pagination handler.
 *
 * Presentation changes: `PageHeader`, three `StatCard`s, `SectionCard` + `DataTable`, a Mantine
 * `Progress` for the quota bar, a `Switch` for the active toggle and a Mantine `Modal` for the form.
 * The two confirmations the shared `useDialog` helper used to raise are now two Mantine `Modal`s —
 * one informational (voucher already used) and one destructive (confirm delete) — which is what the
 * brief asks dashboard confirmations to use.
 */

type VoucherType = "PERCENTAGE" | "FIXED";

type Voucher = {
    id: number;
    code: string;
    description: string | null;
    type: VoucherType;
    value: string | number;
    maxDiscount: string | number | null;
    minPurchase: string | number | null;
    quota: number | null;
    usedCount: number;
    isActive: boolean;
    startDate: string | null;
    endDate: string | null;
    createdAt: string;
    updatedAt: string;
};

type FormState = {
    code: string;
    description: string;
    type: VoucherType;
    value: string;
    maxDiscount: string;
    minPurchase: string;
    quota: string;
    isActive: boolean;
    startDate: string;
    endDate: string;
};

const emptyForm: FormState = {
    code: "",
    description: "",
    type: "PERCENTAGE",
    value: "",
    maxDiscount: "",
    minPurchase: "",
    quota: "",
    isActive: true,
    startDate: "",
    endDate: "",
};

function formatRupiah(value: string | number | null | undefined) {
    if (value === null || value === undefined || value === "") {
        return "-";
    }

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return "-";
    }

    return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
    }).format(number);
}

function formatDate(value: string | null) {
    if (!value) return "-";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "-";
    }

    return new Intl.DateTimeFormat("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    }).format(date);
}

function toDateTimeLocal(value: string | null) {
    if (!value) return "";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    const offset = date.getTimezoneOffset();

    const localDate = new Date(date.getTime() - offset * 60 * 1000);

    return localDate.toISOString().slice(0, 16);
}

async function readJsonResponse(response: Response) {
    const text = await response.text();

    if (!text) {
        throw new Error(
            `Server tidak mengembalikan response. Status: ${response.status}`
        );
    }

    try {
        return JSON.parse(text);
    } catch {
        console.error("NON JSON API RESPONSE:", text);

        throw new Error(
            `Server mengembalikan response bukan JSON. Status: ${response.status}`
        );
    }
}

export default function AdminVouchersPage() {
    const [vouchers, setVouchers] = useState<Voucher[]>([]);

    const [loading, setLoading] = useState(true);

    const [saving, setSaving] = useState(false);

    const [deletingId, setDeletingId] = useState<number | null>(null);

    const [modalOpen, setModalOpen] = useState(false);

    const [editingVoucher, setEditingVoucher] = useState<Voucher | null>(null);

    const [form, setForm] = useState<FormState>(emptyForm);

    const [search, setSearch] = useState("");

    const [page, setPage] = useState(1);
    const [pagination, setPagination] = useState({
        page: 1,
        limit: 50,
        total: 0,
        totalPages: 0,
    });

    const [error, setError] = useState("");

    const [success, setSuccess] = useState("");

    const [deleteTarget, setDeleteTarget] = useState<Voucher | null>(null);

    const [blockedTarget, setBlockedTarget] = useState<Voucher | null>(null);

    async function loadVouchers(pageNum: number = 1) {
        try {
            setLoading(true);
            setError("");

            const params = new URLSearchParams();
            params.set("page", String(pageNum));
            params.set("limit", "50");

            const response = await fetch(`/api/admin/vouchers?${params.toString()}`, {
                method: "GET",
                cache: "no-store",
            });

            const result = await readJsonResponse(response);

            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal mengambil data voucher.");
            }

            const items =
                result.data?.items ?? (Array.isArray(result.data) ? result.data : []);
            const pag = result.data?.pagination;

            setVouchers(items);
            if (pag) setPagination(pag);
        } catch (err) {
            console.error("LOAD VOUCHERS ERROR:", err);

            setError(
                err instanceof Error ? err.message : "Gagal mengambil data voucher."
            );
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadVouchers(1);
    }, []);

    function openCreateModal() {
        setEditingVoucher(null);
        setForm({
            ...emptyForm,
        });
        setError("");
        setSuccess("");
        setModalOpen(true);
    }

    function openEditModal(voucher: Voucher) {
        setEditingVoucher(voucher);

        setForm({
            code: voucher.code,
            description: voucher.description || "",
            type: voucher.type,
            value: String(voucher.value ?? ""),
            maxDiscount:
                voucher.maxDiscount !== null ? String(voucher.maxDiscount) : "",
            minPurchase:
                voucher.minPurchase !== null ? String(voucher.minPurchase) : "",
            quota: voucher.quota !== null ? String(voucher.quota) : "",
            isActive: voucher.isActive,
            startDate: toDateTimeLocal(voucher.startDate),
            endDate: toDateTimeLocal(voucher.endDate),
        });

        setError("");
        setSuccess("");
        setModalOpen(true);
    }

    function closeModal() {
        if (saving) return;

        setModalOpen(false);
        setEditingVoucher(null);
        setForm({
            ...emptyForm,
        });
        setError("");
        setSuccess("");
    }

    function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
        setForm((current) => ({
            ...current,
            [key]: value,
        }));
    }

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        setError("");
        setSuccess("");

        if (!form.code.trim()) {
            setError("Kode voucher wajib diisi.");
            return;
        }

        const numericValue = Number(form.value);

        if (!Number.isFinite(numericValue) || numericValue <= 0) {
            setError("Nilai voucher harus lebih dari 0.");
            return;
        }

        if (form.type === "PERCENTAGE" && numericValue > 100) {
            setError("Persentase voucher tidak boleh lebih dari 100%.");
            return;
        }

        if (form.type === "PERCENTAGE" && form.maxDiscount) {
            const maxDiscount = Number(form.maxDiscount);

            if (!Number.isFinite(maxDiscount) || maxDiscount <= 0) {
                setError("Maksimal diskon harus lebih dari 0.");
                return;
            }
        }

        if (form.minPurchase) {
            const minPurchase = Number(form.minPurchase);

            if (!Number.isFinite(minPurchase) || minPurchase < 0) {
                setError("Minimum pembelian tidak valid.");
                return;
            }
        }

        if (form.quota) {
            const quota = Number(form.quota);

            if (!Number.isInteger(quota) || quota < 0) {
                setError("Quota harus berupa angka bulat.");
                return;
            }

            if (editingVoucher && quota < editingVoucher.usedCount) {
                setError(
                    `Quota tidak boleh lebih kecil dari ${editingVoucher.usedCount}, karena voucher sudah digunakan sebanyak itu.`
                );
                return;
            }
        }

        if (
            form.startDate &&
            form.endDate &&
            new Date(form.endDate) < new Date(form.startDate)
        ) {
            setError("Tanggal berakhir tidak boleh sebelum tanggal mulai.");
            return;
        }

        try {
            setSaving(true);

            const payload = {
                code: form.code.trim().toUpperCase(),

                description: form.description.trim() || null,

                type: form.type,

                value: numericValue,

                maxDiscount:
                    form.type === "PERCENTAGE" && form.maxDiscount
                        ? Number(form.maxDiscount)
                        : null,

                minPurchase: form.minPurchase ? Number(form.minPurchase) : null,

                quota: form.quota ? Number(form.quota) : null,

                isActive: form.isActive,

                startDate: form.startDate || null,

                endDate: form.endDate || null,
            };

            const url = editingVoucher
                ? `/api/admin/vouchers/${editingVoucher.id}`
                : "/api/admin/vouchers";

            const method = editingVoucher ? "PATCH" : "POST";

            const response = await fetch(url, {
                method,
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
            });

            const result = await readJsonResponse(response);

            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal menyimpan voucher.");
            }

            setSuccess(
                editingVoucher
                    ? "Voucher berhasil diubah."
                    : "Voucher berhasil dibuat."
            );

            await loadVouchers(page);

            window.setTimeout(() => {
                closeModal();
            }, 700);
        } catch (err) {
            console.error("SAVE VOUCHER ERROR:", err);

            setError(err instanceof Error ? err.message : "Terjadi kesalahan.");
        } finally {
            setSaving(false);
        }
    }

    function handleDelete(voucher: Voucher) {
        if (voucher.usedCount > 0) {
            setBlockedTarget(voucher);
            return;
        }

        setDeleteTarget(voucher);
    }

    async function confirmDelete() {
        const voucher = deleteTarget;

        setDeleteTarget(null);

        if (!voucher) return;

        try {
            setDeletingId(voucher.id);

            setError("");
            setSuccess("");

            const response = await fetch(`/api/admin/vouchers/${voucher.id}`, {
                method: "DELETE",
            });

            const result = await readJsonResponse(response);

            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal menghapus voucher.");
            }

            setSuccess("Voucher berhasil dihapus.");

            await loadVouchers(page);
        } catch (err) {
            console.error("DELETE VOUCHER ERROR:", err);

            setError(err instanceof Error ? err.message : "Gagal menghapus voucher.");
        } finally {
            setDeletingId(null);
        }
    }

    async function toggleActive(voucher: Voucher) {
        try {
            setError("");
            setSuccess("");

            const response = await fetch(`/api/admin/vouchers/${voucher.id}`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    isActive: !voucher.isActive,
                }),
            });

            const result = await readJsonResponse(response);

            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal mengubah status voucher.");
            }

            await loadVouchers(page);
        } catch (err) {
            console.error("TOGGLE VOUCHER ERROR:", err);

            setError(
                err instanceof Error ? err.message : "Gagal mengubah status voucher."
            );
        }
    }

    const filteredVouchers = vouchers.filter((voucher) => {
        const keyword = search.toLowerCase().trim();

        if (!keyword) {
            return true;
        }

        return (
            voucher.code.toLowerCase().includes(keyword) ||
            (voucher.description || "").toLowerCase().includes(keyword)
        );
    });

    const activeCount = vouchers.filter((voucher) => voucher.isActive).length;

    const totalUsed = vouchers.reduce((total, voucher) => total + voucher.usedCount, 0);

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="Voucher"
                description="Kelola promo, diskon, dan penggunaan voucher toko."
                actions={
                    <Button
                        size="md"
                        radius="md"
                        leftSection={<span style={{ fontSize: 18, lineHeight: 1 }}>+</span>}
                        onClick={openCreateModal}
                    >
                        Tambah Voucher
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

            <StatGrid>
                <StatCard label="Total Voucher" value={vouchers.length} hint="voucher" />
                <StatCard
                    label="Voucher Aktif"
                    value={activeCount}
                    hint="sedang berjalan"
                    tone="success"
                />
                <StatCard
                    label="Total Pemakaian"
                    value={totalUsed}
                    hint="kali digunakan"
                    tone="info"
                />
            </StatGrid>

            <SectionCard
                title="Daftar Voucher"
                description={`${filteredVouchers.length} dari ${vouchers.length} voucher`}
                actions={
                    <TextInput
                        size="md"
                        radius="md"
                        value={search}
                        onChange={(event) => setSearch(event.currentTarget.value)}
                        placeholder="Cari voucher..."
                        aria-label="Cari voucher"
                        w={{ base: 180, sm: 260 }}
                    />
                }
            >
                <DataTable
                    minWidth={1050}
                    loading={loading}
                    loadingRows={6}
                    empty={
                        <EmptyBlock
                            title="Belum ada voucher"
                            description="Buat voucher pertama untuk memberikan promo kepada pelanggan."
                            action={
                                <Button size="md" radius="md" onClick={openCreateModal}>
                                    Tambah voucher
                                </Button>
                            }
                        />
                    }
                    columns={[
                        { header: "Voucher" },
                        { header: "Diskon" },
                        { header: "Minimum" },
                        { header: "Pemakaian" },
                        { header: "Periode" },
                        { header: "Status" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={filteredVouchers.map((voucher) => {
                        const quotaProgress =
                            voucher.quota !== null && voucher.quota > 0
                                ? Math.min(100, (voucher.usedCount / voucher.quota) * 100)
                                : 0;

                        return {
                            key: String(voucher.id),
                            cells: [
                                <Stack gap={0} key="voucher">
                                    <Group gap="xs">
                                        <Text size="sm" fw={700} ff="monospace">
                                            {voucher.code}
                                        </Text>

                                        {voucher.usedCount > 0 && (
                                            <Text size="xs" c="dimmed">
                                                {voucher.usedCount}x
                                            </Text>
                                        )}
                                    </Group>

                                    {voucher.description && (
                                        <Text size="xs" c="dimmed" lineClamp={1} maw={230}>
                                            {voucher.description}
                                        </Text>
                                    )}
                                </Stack>,

                                <Box key="discount">
                                    <Text size="sm" fw={600}>
                                        {voucher.type === "PERCENTAGE"
                                            ? `${Number(voucher.value)}%`
                                            : formatRupiah(voucher.value)}
                                    </Text>

                                    {voucher.type === "PERCENTAGE" &&
                                        voucher.maxDiscount !== null && (
                                            <Text size="xs" c="dimmed">
                                                Maks. {formatRupiah(voucher.maxDiscount)}
                                            </Text>
                                        )}
                                </Box>,

                                voucher.minPurchase !== null ? (
                                    <Text size="sm" key="minimum">
                                        {formatRupiah(voucher.minPurchase)}
                                    </Text>
                                ) : (
                                    <Text size="sm" c="dimmed" key="minimum">
                                        Tanpa minimum
                                    </Text>
                                ),

                                <Box w={112} key="usage">
                                    <Group justify="space-between" gap="xs">
                                        <Text size="xs" fw={600}>
                                            {voucher.usedCount}
                                        </Text>

                                        {voucher.quota !== null && (
                                            <Text size="xs" c="dimmed">
                                                / {voucher.quota}
                                            </Text>
                                        )}
                                    </Group>

                                    {voucher.quota !== null && (
                                        <Progress
                                            value={quotaProgress}
                                            size="xs"
                                            radius="xl"
                                            mt={6}
                                            color={
                                                quotaProgress >= 90
                                                    ? "red"
                                                    : quotaProgress >= 70
                                                      ? "yellow"
                                                      : "ink"
                                            }
                                        />
                                    )}
                                </Box>,

                                <Stack gap={2} key="period">
                                    <Text size="xs">{formatDate(voucher.startDate)}</Text>

                                    <Text size="xs" c="dimmed">
                                        sampai {formatDate(voucher.endDate)}
                                    </Text>
                                </Stack>,

                                <Switch
                                    key="status"
                                    size="md"
                                    color="green"
                                    checked={voucher.isActive}
                                    onChange={() => toggleActive(voucher)}
                                    label={voucher.isActive ? "Aktif" : "Nonaktif"}
                                />,

                                <Group justify="flex-end" gap="xs" wrap="nowrap" key="actions">
                                    <Button
                                        variant="subtle"
                                        size="sm"
                                        radius="md"
                                        onClick={() => openEditModal(voucher)}
                                    >
                                        Edit
                                    </Button>

                                    <Button
                                        variant="subtle"
                                        color="red"
                                        size="sm"
                                        radius="md"
                                        loading={deletingId === voucher.id}
                                        disabled={deletingId === voucher.id}
                                        onClick={() => handleDelete(voucher)}
                                    >
                                        Hapus
                                    </Button>
                                </Group>,
                            ],
                        };
                    })}
                    footer={
                        pagination.totalPages > 1 ? (
                            <Group justify="space-between" align="center">
                                <Text size="sm" c="dimmed">
                                    Halaman {pagination.page} dari {pagination.totalPages} (
                                    {pagination.total} voucher)
                                </Text>

                                <Group gap="sm">
                                    <Button
                                        variant="default"
                                        size="md"
                                        radius="md"
                                        disabled={page <= 1}
                                        onClick={() => {
                                            const p = page - 1;
                                            setPage(p);
                                            loadVouchers(p);
                                        }}
                                    >
                                        Sebelumnya
                                    </Button>

                                    <Button
                                        variant="default"
                                        size="md"
                                        radius="md"
                                        disabled={page >= pagination.totalPages}
                                        onClick={() => {
                                            const p = page + 1;
                                            setPage(p);
                                            loadVouchers(p);
                                        }}
                                    >
                                        Selanjutnya
                                    </Button>
                                </Group>
                            </Group>
                        ) : undefined
                    }
                />
            </SectionCard>

            {/* =====================================================
                FORM MODAL
            ===================================================== */}

            <Modal
                opened={modalOpen}
                onClose={closeModal}
                size="lg"
                title={editingVoucher ? "Edit voucher" : "Buat voucher baru"}
                centered
            >
                <form onSubmit={handleSubmit}>
                    <Stack gap="lg">
                        {error && (
                            <Alert color="red" variant="light" radius="md">
                                {error}
                            </Alert>
                        )}

                        {success && (
                            <Alert color="green" variant="light" radius="md">
                                {success}
                            </Alert>
                        )}

                        {/* BASIC */}

                        <Stack gap="md">
                            <Box>
                                <Text size="sm" fw={600}>
                                    Informasi voucher
                                </Text>

                                <Text size="xs" c="dimmed" mt={2}>
                                    Tentukan kode dan informasi dasar promo.
                                </Text>
                            </Box>

                            <TextInput
                                label="Kode voucher"
                                size="md"
                                radius="md"
                                ff="monospace"
                                styles={{ input: { fontWeight: 600, textTransform: "uppercase" } }}
                                value={form.code}
                                disabled={!!editingVoucher}
                                onChange={(event) =>
                                    updateForm(
                                        "code",
                                        event.currentTarget.value
                                            .toUpperCase()
                                            .replace(/\s/g, "")
                                    )
                                }
                                placeholder="Contoh: HEMAT20"
                                description={
                                    editingVoucher
                                        ? "Kode tidak dapat diubah setelah voucher dibuat."
                                        : undefined
                                }
                            />

                            <Textarea
                                label="Deskripsi"
                                size="md"
                                radius="md"
                                value={form.description}
                                onChange={(event) =>
                                    updateForm("description", event.currentTarget.value)
                                }
                                placeholder="Contoh: Diskon spesial pelanggan baru"
                                rows={2}
                                autosize
                                minRows={2}
                                maxRows={4}
                            />
                        </Stack>

                        <Divider />

                        {/* DISCOUNT */}

                        <Stack gap="md">
                            <Box>
                                <Text size="sm" fw={600}>
                                    Aturan diskon
                                </Text>

                                <Text size="xs" c="dimmed" mt={2}>
                                    Atur jenis dan nominal potongan.
                                </Text>
                            </Box>

                            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                                <Select
                                    label="Tipe"
                                    size="md"
                                    radius="md"
                                    allowDeselect={false}
                                    value={form.type}
                                    onChange={(value) =>
                                        updateForm("type", (value ?? "PERCENTAGE") as VoucherType)
                                    }
                                    data={[
                                        { value: "PERCENTAGE", label: "Persentase (%)" },
                                        { value: "FIXED", label: "Nominal tetap (Rp)" },
                                    ]}
                                />

                                <NumberInput
                                    label="Nilai diskon"
                                    size="md"
                                    radius="md"
                                    min={0}
                                    rightSection={form.type === "PERCENTAGE" ? "%" : "IDR"}
                                    rightSectionWidth={52}
                                    value={form.value === "" ? "" : Number(form.value)}
                                    onChange={(value) =>
                                        updateForm("value", value === "" ? "" : String(value))
                                    }
                                    placeholder={form.type === "PERCENTAGE" ? "20" : "50000"}
                                />
                            </SimpleGrid>

                            {form.type === "PERCENTAGE" && (
                                <NumberInput
                                    label="Maksimal diskon (opsional)"
                                    size="md"
                                    radius="md"
                                    min={0}
                                    rightSection="IDR"
                                    rightSectionWidth={52}
                                    value={form.maxDiscount === "" ? "" : Number(form.maxDiscount)}
                                    onChange={(value) =>
                                        updateForm(
                                            "maxDiscount",
                                            value === "" ? "" : String(value)
                                        )
                                    }
                                    placeholder="50000"
                                />
                            )}
                        </Stack>

                        <Divider />

                        {/* CONDITIONS */}

                        <Stack gap="md">
                            <Box>
                                <Text size="sm" fw={600}>
                                    Syarat penggunaan
                                </Text>

                                <Text size="xs" c="dimmed" mt={2}>
                                    Tentukan minimum transaksi dan batas penggunaan.
                                </Text>
                            </Box>

                            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                                <NumberInput
                                    label="Minimum pembelian (opsional)"
                                    size="md"
                                    radius="md"
                                    min={0}
                                    rightSection="IDR"
                                    rightSectionWidth={52}
                                    value={form.minPurchase === "" ? "" : Number(form.minPurchase)}
                                    onChange={(value) =>
                                        updateForm(
                                            "minPurchase",
                                            value === "" ? "" : String(value)
                                        )
                                    }
                                    placeholder="100000"
                                />

                                <NumberInput
                                    label="Quota (opsional)"
                                    size="md"
                                    radius="md"
                                    min={0}
                                    allowDecimal={false}
                                    value={form.quota === "" ? "" : Number(form.quota)}
                                    onChange={(value) =>
                                        updateForm("quota", value === "" ? "" : String(value))
                                    }
                                    placeholder="100"
                                    description="Kosongkan jika tidak ada batas penggunaan."
                                />
                            </SimpleGrid>
                        </Stack>

                        <Divider />

                        {/* PERIOD */}

                        <Stack gap="md">
                            <Box>
                                <Text size="sm" fw={600}>
                                    Periode voucher
                                </Text>

                                <Text size="xs" c="dimmed" mt={2}>
                                    Kosongkan tanggal jika voucher tidak memiliki batas waktu.
                                </Text>
                            </Box>

                            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                                <TextInput
                                    label="Mulai"
                                    size="md"
                                    radius="md"
                                    type="datetime-local"
                                    value={form.startDate}
                                    onChange={(event) =>
                                        updateForm("startDate", event.currentTarget.value)
                                    }
                                />

                                <TextInput
                                    label="Berakhir"
                                    size="md"
                                    radius="md"
                                    type="datetime-local"
                                    value={form.endDate}
                                    onChange={(event) =>
                                        updateForm("endDate", event.currentTarget.value)
                                    }
                                />
                            </SimpleGrid>
                        </Stack>

                        <Divider />

                        {/* STATUS */}

                        <Group justify="space-between" align="flex-start" wrap="nowrap">
                            <Box>
                                <Text size="sm" fw={600}>
                                    Status voucher
                                </Text>

                                <Text size="xs" c="dimmed" mt={2}>
                                    Customer hanya dapat menggunakan voucher yang aktif.
                                </Text>
                            </Box>

                            <Switch
                                size="md"
                                color="green"
                                checked={form.isActive}
                                onChange={(event) =>
                                    updateForm("isActive", event.currentTarget.checked)
                                }
                                aria-label="Status voucher"
                            />
                        </Group>
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
                                : editingVoucher
                                  ? "Simpan perubahan"
                                  : "Buat voucher"}
                        </Button>
                    </Group>
                </form>
            </Modal>

            {/* USED-COUNT GUARD */}

            <Modal
                opened={blockedTarget !== null}
                onClose={() => setBlockedTarget(null)}
                title="Tidak Bisa Dihapus"
                centered
            >
                <Text size="sm">
                    Voucher ini sudah pernah digunakan. Nonaktifkan voucher saja.
                </Text>

                <Group justify="flex-end" mt="lg">
                    <Button
                        variant="default"
                        size="md"
                        radius="md"
                        onClick={() => setBlockedTarget(null)}
                    >
                        Mengerti
                    </Button>
                </Group>
            </Modal>

            {/* DELETE CONFIRMATION */}

            <Modal
                opened={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                title="Hapus Voucher"
                centered
            >
                <Text size="sm">
                    Hapus voucher &quot;{deleteTarget?.code}&quot;?
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
