"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import toast from "react-hot-toast";
import Link from "next/link";
import {
    Button,
    Group,
    Pagination,
    Paper,
    Select,
    SimpleGrid,
    Skeleton,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";

import {
    DataTable,
    EmptyBlock,
    PageHeader,
    PrimaryAction,
    SectionCard,
    StatusBadge,
    type Tone,
} from "@/components/dashboard/primitives";

/**
 * ==========================================
 * ADMIN ORDERS
 * ==========================================
 *
 * The retail order list plus the bulk-tracking (resi) import tooling.
 *
 * PHASE (Mantine body migration): presentation only. Everything below that talks to the server is
 * byte-for-byte the previous behaviour — `loadOrders` (same `useCallback` dependencies and the same
 * `page`/`limit`/`search`/`status` query), the `useEffect` trigger, both download flows
 * (`tracking-template`, `tracking-error-report`, same blob → object-URL → anchor dance), the
 * `tracking-import` upload with its `FormData`, the input-reset that allows re-selecting the same
 * file, every `toast.success`/`toast.error` message, and the summary branching. Only the markup,
 * badges, table, skeleton and pagination are Mantine now.
 *
 * Status colours stay SEMANTIC and are mapped once through the shared tone vocabulary instead of
 * per-page tint classes — the brand colour is never used to mean "paid" or "cancelled".
 */

type OrderItem = {
    id: number;
    productName: string;
    variantName: string;
    quantity: number;
    price: string | number;
    subtotal: string | number;
};

type OrderUser = {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
};

type Order = {
    id: number;
    orderNumber: string;
    recipientName: string;
    phone: string;
    address: string;
    city: string | null;
    district: string | null;
    province: string | null;
    postalCode: string | null;
    subtotal: string | number;
    shippingCost: string | number;
    total: string | number;
    status: string;
    paymentMethod: string;
    paymentStatus: string;
    shippingCourier: string | null;
    shippingService: string | null;
    trackingNumber: string | null;
    createdAt: string;
    user?: OrderUser | null;
    items: OrderItem[];
};

type Pagination_ = {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
};

function rupiah(value: string | number) {
    return `Rp ${Number(value).toLocaleString("id-ID")}`;
}

function date(value: string) {
    return new Date(value).toLocaleString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function statusLabel(status: string) {
    switch (status) {
        case "PENDING": return "Pending";
        case "PAID": return "Dibayar";
        case "PROCESSING": return "Diproses";
        case "SHIPPED": return "Dikirim";
        case "COMPLETED": return "Selesai";
        case "CANCELLED": return "Dibatalkan";
        case "REFUND_PENDING": return "Refund Diproses";
        default: return status;
    }
}

/** The previous tint map, re-expressed in the shared semantic tones (no brand for status). */
function statusTone(status: string): Tone {
    switch (status) {
        case "PENDING": return "warn";
        case "PAID": return "warn";
        case "PROCESSING": return "info";
        case "SHIPPED": return "info";
        case "COMPLETED": return "success";
        case "CANCELLED": return "error";
        case "REFUND_PENDING": return "pending";
        default: return "neutral";
    }
}

function paymentTone(status: string): Tone {
    switch (status) {
        case "PAID": return "success";
        case "PENDING": return "warn";
        case "FAILED":
        case "EXPIRED": return "error";
        default: return "neutral";
    }
}

type ImportRowResult = {
    row: number;
    orderNumber: string;
    trackingNumber: string;
    courier: string;
    status: "SUCCESS" | "FAILED" | "SKIPPED";
    reason: string;
};

type ImportResult = {
    summary: {
        total: number;
        success: number;
        failed: number;
        skipped: number;
    };
    results: ImportRowResult[];
};

export default function AdminOrdersPage() {
    const [orders, setOrders] = useState<Order[]>([]);
    const [pagination, setPagination] = useState<Pagination_>({ page: 1, limit: 20, total: 0, totalPages: 0 });
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("ALL");
    const [page, setPage] = useState(1);

    // ---- Tracking Import State ----
    const [importing, setImporting] = useState(false);
    const [importResult, setImportResult] = useState<ImportResult | null>(null);
    const [showImportResult, setShowImportResult] = useState(false);
    const [downloadingTemplate, setDownloadingTemplate] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const loadOrders = useCallback(async (pageNum: number, searchVal: string, statusVal: string) => {
        try {
            setLoading(true);
            const params = new URLSearchParams();
            params.set("page", String(pageNum));
            params.set("limit", "20");
            if (searchVal.trim()) params.set("search", searchVal.trim());
            if (statusVal !== "ALL") params.set("status", statusVal);

            const response = await fetch(`/api/admin/orders?${params.toString()}`, { cache: "no-store" });
            const data = await response.json();

            if (!response.ok) {
                toast.error(data.message ?? "Gagal mengambil pesanan.");
                return;
            }

            setOrders(data.data?.items ?? []);
            setPagination(data.data?.pagination ?? { page: 1, limit: 20, total: 0, totalPages: 0 });
        } catch (error) {
            console.error(error);
            toast.error("Terjadi kesalahan.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadOrders(page, search, statusFilter);
    }, [page, loadOrders]);

    function handleSearch(e: React.FormEvent) {
        e.preventDefault();
        setPage(1);
        loadOrders(1, search, statusFilter);
    }

    function handleStatusFilter(value: string) {
        setStatusFilter(value);
        setPage(1);
        loadOrders(1, search, value);
    }

    // ---- Download Template ----
    async function handleDownloadTemplate() {
        try {
            setDownloadingTemplate(true);
            const response = await fetch("/api/admin/orders/tracking-template", {
                cache: "no-store",
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.message ?? "Gagal mengunduh template.");
            }

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "template-import-resi.xlsx";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            toast.success("Template berhasil diunduh.");
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengunduh template."
            );
        } finally {
            setDownloadingTemplate(false);
        }
    }

    // ---- Upload Excel ----
    async function handleUploadExcel(file: File) {
        try {
            setImporting(true);
            setImportResult(null);
            setShowImportResult(false);

            const formData = new FormData();
            formData.append("file", file);

            const response = await fetch("/api/admin/orders/tracking-import", {
                method: "POST",
                body: formData,
                cache: "no-store",
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.message ?? "Gagal memproses import.");
            }

            setImportResult(data.data);
            setShowImportResult(true);

            const summary = data.data.summary;
            if (summary.failed > 0 && summary.success === 0) {
                toast.error(`Import selesai. ${summary.failed} baris gagal.`);
            } else if (summary.failed > 0) {
                toast.success(`Import selesai: ${summary.success} berhasil, ${summary.failed} gagal, ${summary.skipped} dilewati.`);
            } else {
                toast.success(`Import selesai: ${summary.success} berhasil.`);
            }

            // Reload orders list
            loadOrders(page, search, statusFilter);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal memproses import."
            );
        } finally {
            setImporting(false);
        }
    }

    function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (file) {
            handleUploadExcel(file);
        }
        // Reset input so same file can be re-selected
        e.target.value = "";
    }

    // ---- Download Error Report ----
    async function handleDownloadErrorReport(errors: ImportRowResult[]) {
        try {
            const response = await fetch("/api/admin/orders/tracking-error-report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ errors }),
                cache: "no-store",
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.message ?? "Gagal mengunduh error report.");
            }

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `error-report-import-resi.xlsx`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            toast.success("Error report berhasil diunduh.");
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengunduh error report."
            );
        }
    }

    if (loading && orders.length === 0) {
        return (
            <Stack gap="md">
                <Skeleton height={32} width={160} radius="md" />
                <Skeleton height={16} width={320} />
                <Skeleton height={320} radius="md" />
            </Stack>
        );
    }

    const failedRows = importResult?.results.filter((row) => row.status === "FAILED") ?? [];

    return (
        <Stack gap="lg">
            <PageHeader
                title="Pesanan"
                description="Kelola pesanan customer dan pantau proses pengirimannya."
            />

            {/* ---- IMPORT RESI SECTION ---- */}
            <Paper withBorder radius="md" p="md">
                <Group justify="space-between" align="center" gap="md" wrap="wrap">
                    <Group gap="sm" wrap="nowrap">
                        <Text fz={22} aria-hidden>
                            📦
                        </Text>

                        <Stack gap={0}>
                            <Text size="sm" fw={600}>
                                Import Resi Bulk
                            </Text>
                            <Text size="xs" c="dimmed">
                                Download template, isi nomor resi, lalu upload kembali.
                            </Text>
                        </Stack>
                    </Group>

                    <Group gap="sm" wrap="nowrap">
                        <Button
                            variant="default"
                            size="md"
                            radius="md"
                            loading={downloadingTemplate}
                            disabled={downloadingTemplate}
                            onClick={handleDownloadTemplate}
                        >
                            Download Template
                        </Button>

                        <PrimaryAction
                            color="ink"
                            loading={importing}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            {importing ? "Memproses…" : "Import Resi Excel"}
                        </PrimaryAction>

                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".xlsx,.xls,.csv"
                            onChange={handleFileSelect}
                            style={{ display: "none" }}
                            aria-label="Berkas import resi"
                        />
                    </Group>
                </Group>
            </Paper>

            {/* ---- IMPORT RESULT PANEL ---- */}
            {showImportResult && importResult ? (
                <SectionCard
                    title="Hasil Import Resi"
                    description="Ringkasan proses import Excel"
                    actions={
                        <Button
                            variant="subtle"
                            color="gray"
                            size="sm"
                            aria-label="Tutup hasil import"
                            onClick={() => setShowImportResult(false)}
                        >
                            Tutup
                        </Button>
                    }
                >
                    <Stack gap="md">
                        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
                            <Paper bg="gray.1" p="sm" radius="md">
                                <Text size="xs" c="dimmed" tt="uppercase">
                                    Total
                                </Text>
                                <Text fz={20} fw={700}>
                                    {importResult.summary.total}
                                </Text>
                            </Paper>

                            <Paper bg="green.0" p="sm" radius="md">
                                <Text size="xs" c="green.8" tt="uppercase">
                                    Berhasil
                                </Text>
                                <Text fz={20} fw={700} c="green.8">
                                    {importResult.summary.success}
                                </Text>
                            </Paper>

                            <Paper bg="red.0" p="sm" radius="md">
                                <Text size="xs" c="red.8" tt="uppercase">
                                    Gagal
                                </Text>
                                <Text fz={20} fw={700} c="red.8">
                                    {importResult.summary.failed}
                                </Text>
                            </Paper>

                            <Paper bg="yellow.0" p="sm" radius="md">
                                <Text size="xs" c="yellow.8" tt="uppercase">
                                    Dilewati
                                </Text>
                                <Text fz={20} fw={700} c="yellow.8">
                                    {importResult.summary.skipped}
                                </Text>
                            </Paper>
                        </SimpleGrid>

                        {importResult.summary.failed > 0 ? (
                            <Group>
                                <Button
                                    variant="light"
                                    color="red"
                                    size="md"
                                    radius="md"
                                    onClick={() => handleDownloadErrorReport(failedRows)}
                                >
                                    Download Error Report
                                </Button>
                            </Group>
                        ) : null}

                        <DataTable
                            minWidth={760}
                            columns={[
                                { header: "Baris", align: "right" },
                                { header: "Nomor Pesanan" },
                                { header: "Nomor Resi" },
                                { header: "Ekspedisi" },
                                { header: "Status" },
                                { header: "Keterangan" },
                            ]}
                            rows={importResult.results.map((r, index) => ({
                                key: `${r.row}-${index}`,
                                cells: [
                                    <Text size="xs" c="dimmed" key="row">
                                        {r.row}
                                    </Text>,
                                    <Text size="xs" fw={600} key="order">
                                        {r.orderNumber}
                                    </Text>,
                                    <Text size="xs" key="tracking">
                                        {r.trackingNumber}
                                    </Text>,
                                    <Text size="xs" key="courier">
                                        {r.courier}
                                    </Text>,
                                    <StatusBadge
                                        key="status"
                                        tone={
                                            r.status === "SUCCESS"
                                                ? "success"
                                                : r.status === "SKIPPED"
                                                  ? "warn"
                                                  : "error"
                                        }
                                    >
                                        {r.status === "SUCCESS"
                                            ? "Berhasil"
                                            : r.status === "SKIPPED"
                                              ? "Dilewati"
                                              : "Gagal"}
                                    </StatusBadge>,
                                    <Text size="xs" c="dimmed" key="reason">
                                        {r.reason}
                                    </Text>,
                                ],
                            }))}
                        />
                    </Stack>
                </SectionCard>
            ) : null}

            <SectionCard
                title="Semua Pesanan"
                description={`Menampilkan ${orders.length} dari ${pagination.total} pesanan`}
                actions={
                    <Button
                        variant="subtle"
                        color="gray"
                        size="sm"
                        onClick={() => {
                            setSearch("");
                            setStatusFilter("ALL");
                            setPage(1);
                            loadOrders(1, "", "ALL");
                        }}
                    >
                        Reset filter
                    </Button>
                }
            >
                <Stack gap="md">
                    <Group gap="md" align="flex-end" wrap="wrap">
                        <form onSubmit={handleSearch} style={{ flex: 1, minWidth: 220 }}>
                            <TextInput
                                value={search}
                                onChange={(e) => setSearch(e.currentTarget.value)}
                                placeholder="Cari nomor pesanan, nama…"
                                aria-label="Cari pesanan"
                                size="md"
                            />
                        </form>

                        <Select
                            value={statusFilter}
                            onChange={(value) => handleStatusFilter(value ?? "ALL")}
                            data={[
                                { value: "ALL", label: "Semua status" },
                                { value: "PENDING", label: "Pending" },
                                { value: "PROCESSING", label: "Diproses" },
                                { value: "SHIPPED", label: "Dikirim" },
                                { value: "COMPLETED", label: "Selesai" },
                                { value: "CANCELLED", label: "Dibatalkan" },
                            ]}
                            size="md"
                            w={{ base: "100%", sm: 200 }}
                            aria-label="Filter status pesanan"
                        />
                    </Group>

                    <DataTable
                        minWidth={940}
                        loading={loading && orders.length > 0}
                        empty={
                            <EmptyBlock
                                title="Pesanan tidak ditemukan"
                                description="Coba ubah kata kunci atau filter."
                            />
                        }
                        columns={[
                            { header: "Pesanan" },
                            { header: "Customer" },
                            { header: "Total", align: "right" },
                            { header: "Status" },
                            { header: "Pembayaran" },
                            { header: "Tanggal" },
                            { header: "Aksi", align: "right" },
                        ]}
                        rows={orders.map((order) => ({
                            key: String(order.id),
                            cells: [
                                <Stack gap={2} key="order">
                                    <Text size="sm" fw={600}>
                                        {order.orderNumber}
                                    </Text>
                                    <Text size="xs" c="dimmed">
                                        {order.items.length} item
                                    </Text>
                                </Stack>,
                                <Stack gap={2} key="customer">
                                    <Text size="sm" fw={500}>
                                        {order.user?.name ?? order.recipientName}
                                    </Text>
                                    <Text size="xs" c="dimmed">
                                        {order.user?.phone ?? order.phone}
                                    </Text>
                                </Stack>,
                                <Text size="sm" fw={600} key="total" style={{ whiteSpace: "nowrap" }}>
                                    {rupiah(order.total)}
                                </Text>,
                                <StatusBadge key="status" tone={statusTone(order.status)}>
                                    {statusLabel(order.status)}
                                </StatusBadge>,
                                <Stack gap={2} key="payment">
                                    <Text size="xs" fw={500}>
                                        {order.paymentMethod}
                                    </Text>
                                    <StatusBadge
                                        size="sm"
                                        tone={paymentTone(order.paymentStatus)}
                                    >
                                        {order.paymentStatus}
                                    </StatusBadge>
                                </Stack>,
                                <Text size="xs" c="dimmed" key="created" style={{ whiteSpace: "nowrap" }}>
                                    {date(order.createdAt)}
                                </Text>,
                                <Button
                                    key="detail"
                                    component={Link}
                                    href={`/admin/orders/${order.id}`}
                                    variant="default"
                                    size="sm"
                                    radius="md"
                                >
                                    Detail
                                </Button>,
                            ],
                        }))}
                        footer={
                            pagination.totalPages > 1 ? (
                                <Group justify="space-between" align="center" gap="md" wrap="wrap">
                                    <Text size="sm" c="dimmed">
                                        Halaman {pagination.page} dari {pagination.totalPages}
                                    </Text>

                                    <Pagination
                                        total={pagination.totalPages}
                                        value={pagination.page}
                                        size="md"
                                        withEdges
                                        onChange={(nextPage) =>
                                            setPage(Math.min(pagination.totalPages, Math.max(1, nextPage)))
                                        }
                                    />
                                </Group>
                            ) : undefined
                        }
                    />
                </Stack>
            </SectionCard>
        </Stack>
    );
}
