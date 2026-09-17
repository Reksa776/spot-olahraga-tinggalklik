"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import {
    FiArrowLeft,
    FiDownload,
    FiFileText,
} from "react-icons/fi";

import { Box, Button, Group, Loader, Select, SimpleGrid, Stack, Text } from "@mantine/core";

import {
    DataTable,
    ErrorBlock,
    LoadingBlock,
    PageHeader,
    SectionCard,
    StatCard,
    StatGrid,
} from "@/components/dashboard/primitives";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Financial reporting, so the numbers are untouched. Preserved exactly: `formatNumber`,
 * `formatRupiah` (both keep the `Number.isFinite` guard and the `?? 0` fallback so a missing value
 * still renders as 0 rather than NaN), `formatDate`, `loadReport` and its `/api/admin/reports?period=`
 * call, the `useEffect` on `period`, `downloadExcel` including the `URL.createObjectURL` →
 * anchor → `revokeObjectURL` sequence and the exact filename `laporan-penjualan-{period}.xlsx`, and
 * every field read off the payload (`periodOrderCount`, `paidOrderCount`, `orderStatus?.CANCELLED`,
 * `paidSubtotal`, `paidShipping`, `revenue`, `dailySales`, `topProducts`, `paymentMethod`,
 * `orderStatus`).
 *
 * The four local helper components (`SummaryCard`, `BreakdownCard`, `ReportList`, `LoadingState`)
 * are gone; the same data now renders through the shared `StatCard`/`SectionCard`/`DataTable`/
 * `LoadingBlock` vocabulary. `ReportList`'s `Object.entries` iteration is preserved verbatim so
 * whatever keys the API returns are still shown.
 */

type ReportData = {
    period: string;
    periodStart: string;
    periodEnd: string;

    summary: {
        totalProducts: number;
        totalCustomers: number;
        totalOrders: number;
        periodOrderCount: number;
        paidOrderCount: number;
        revenue: number;
        paidSubtotal: number;
        paidShipping: number;
    };

    dailySales: {
        date: string;
        revenue: number;
        orders: number;
    }[];

    topProducts: {
        productId: number;
        productName: string;
        quantity: number;
        revenue: number;
    }[];

    paymentMethod: Record<string, number>;

    orderStatus: Record<string, number>;
};

function formatNumber(value: number | string | null | undefined) {
    const amount = Number(value ?? 0);

    return new Intl.NumberFormat("id-ID").format(Number.isFinite(amount) ? amount : 0);
}

function formatRupiah(value: number | string | null | undefined) {
    const amount = Number(value ?? 0);

    return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
    }).format(Number.isFinite(amount) ? amount : 0);
}

function formatDate(date: string) {
    return new Intl.DateTimeFormat("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    }).format(new Date(date));
}

export default function AdminReportsPage() {
    const [period, setPeriod] = useState("7d");
    const [data, setData] = useState<ReportData | null>(null);

    const [loading, setLoading] = useState(true);

    const [downloading, setDownloading] = useState(false);

    async function loadReport() {
        try {
            setLoading(true);

            const response = await fetch(`/api/admin/reports?period=${period}`, {
                cache: "no-store",
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal mengambil laporan.");
            }

            setData(result.data);
        } catch (error) {
            console.error("LOAD REPORT ERROR:", error);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadReport();
    }, [period]);

    async function downloadExcel() {
        try {
            setDownloading(true);

            const response = await fetch(`/api/admin/reports/excel?period=${period}`);

            if (!response.ok) {
                const result = await response.json();

                throw new Error(result.message || "Gagal download laporan.");
            }

            const blob = await response.blob();

            const url = window.URL.createObjectURL(blob);

            const a = document.createElement("a");

            a.href = url;

            a.download = `laporan-penjualan-${period}.xlsx`;

            document.body.appendChild(a);

            a.click();

            a.remove();

            window.URL.revokeObjectURL(url);
        } catch (error) {
            console.error("DOWNLOAD REPORT ERROR:", error);

            toast.error(
                error instanceof Error ? error.message : "Gagal download laporan."
            );
        } finally {
            setDownloading(false);
        }
    }

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin Reporting"
                title="Laporan Penjualan"
                description="Rekapitulasi penjualan, pesanan, pembayaran, dan produk terlaris."
                actions={
                    <Group gap="sm" wrap="wrap">
                        <Select
                            size="md"
                            radius="md"
                            allowDeselect={false}
                            value={period}
                            onChange={(value) => setPeriod(value ?? "7d")}
                            aria-label="Periode laporan"
                            data={[
                                { value: "7d", label: "7 Hari" },
                                { value: "30d", label: "30 Hari" },
                                { value: "90d", label: "90 Hari" },
                                { value: "1y", label: "1 Tahun" },
                            ]}
                            w={140}
                        />

                        <Button
                            size="md"
                            radius="md"
                            color="ink"
                            disabled={downloading}
                            onClick={downloadExcel}
                            leftSection={
                                downloading ? (
                                    <Loader size="xs" color="white" />
                                ) : (
                                    <FiDownload size={17} />
                                )
                            }
                        >
                            {downloading ? "Menyiapkan..." : "Download Excel"}
                        </Button>
                    </Group>
                }
            />

            <Group gap="xs">
                <Button
                    component={Link}
                    href="/admin"
                    variant="subtle"
                    size="compact-md"
                    radius="md"
                    px={0}
                    leftSection={<FiArrowLeft size={15} />}
                >
                    Kembali ke Dashboard
                </Button>
            </Group>

            {loading ? (
                <LoadingBlock label="Memuat laporan…" />
            ) : !data ? (
                <ErrorBlock
                    message="Gagal mengambil laporan."
                    title="Laporan tidak tersedia"
                />
            ) : (
                <>
                    {/* PERIOD */}

                    <Box>
                        <Text size="sm" fw={500} c="dimmed">
                            Periode laporan
                        </Text>

                        <Text fw={600} mt={4}>
                            {formatDate(data.periodStart)} — {formatDate(data.periodEnd)}
                        </Text>
                    </Box>

                    {/* SUMMARY */}

                    <StatGrid>
                        <StatCard
                            label="Pesanan"
                            value={formatNumber(data.summary.periodOrderCount ?? 0)}
                            icon={<FiFileText size={18} />}
                        />

                        <StatCard
                            label="Pesanan Dibayar"
                            value={formatNumber(data.summary.paidOrderCount ?? 0)}
                            icon={<FiFileText size={18} />}
                            tone="success"
                        />

                        <StatCard
                            label="Pesanan Dibatalkan"
                            value={formatNumber(data.orderStatus?.CANCELLED ?? 0)}
                            icon={<FiFileText size={18} />}
                            tone="error"
                        />
                    </StatGrid>

                    {/* REVENUE BREAKDOWN */}

                    <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
                        <StatCard
                            label="Subtotal Produk"
                            value={formatRupiah(data.summary.paidSubtotal ?? 0)}
                        />

                        <StatCard
                            label="Ongkos Kirim"
                            value={formatRupiah(data.summary.paidShipping ?? 0)}
                        />

                        <StatCard
                            label="Total Pendapatan"
                            value={formatRupiah(data.summary.revenue ?? 0)}
                            tone="success"
                        />
                    </SimpleGrid>

                    {/* DAILY SALES */}

                    <SectionCard
                        title="Penjualan Harian"
                        description="Rekap pendapatan dan jumlah pesanan."
                    >
                        <DataTable
                            minWidth={600}
                            columns={[
                                { header: "Tanggal" },
                                { header: "Pesanan", align: "right" },
                                { header: "Pendapatan", align: "right" },
                            ]}
                            rows={data.dailySales.map((item) => ({
                                key: item.date,
                                cells: [
                                    <Text size="sm" fw={500} key="date">
                                        {formatDate(item.date)}
                                    </Text>,
                                    <Text size="sm" key="orders">
                                        {item.orders}
                                    </Text>,
                                    <Text size="sm" fw={600} key="revenue">
                                        {formatRupiah(item.revenue)}
                                    </Text>,
                                ],
                            }))}
                        />
                    </SectionCard>

                    {/* TOP PRODUCTS */}

                    <SectionCard
                        title="Produk Terlaris"
                        description="Produk dengan penjualan tertinggi pada periode ini."
                    >
                        <DataTable
                            minWidth={650}
                            columns={[
                                { header: "Produk" },
                                { header: "Terjual", align: "right" },
                                { header: "Pendapatan", align: "right" },
                            ]}
                            rows={data.topProducts.map((item) => ({
                                key: String(item.productId),
                                cells: [
                                    <Text size="sm" fw={500} key="name">
                                        {item.productName}
                                    </Text>,
                                    <Text size="sm" key="qty">
                                        {item.quantity}
                                    </Text>,
                                    <Text size="sm" fw={600} key="revenue">
                                        {formatRupiah(item.revenue)}
                                    </Text>,
                                ],
                            }))}
                        />
                    </SectionCard>

                    {/* PAYMENT + STATUS */}

                    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
                        <ReportList title="Metode Pembayaran" data={data.paymentMethod} />

                        <ReportList title="Status Pesanan" data={data.orderStatus} />
                    </SimpleGrid>
                </>
            )}
        </Stack>
    );
}

/**
 * `Object.entries` in the same order the payload provides them — the keys are whatever the report
 * API returns, so they are rendered rather than enumerated.
 */
function ReportList({ title, data }: { title: string; data: Record<string, number> }) {
    return (
        <SectionCard title={title}>
            <Stack gap="sm">
                {Object.entries(data).map(([key, value]) => (
                    <Group
                        key={key}
                        justify="space-between"
                        wrap="nowrap"
                        px="md"
                        py="sm"
                        style={{
                            background: "var(--mantine-color-gray-0)",
                            borderRadius: 8,
                        }}
                    >
                        <Text size="sm" fw={500}>
                            {key}
                        </Text>

                        <Text fw={700}>{value}</Text>
                    </Group>
                ))}
            </Stack>
        </SectionCard>
    );
}
