"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Box, Button, Group, Progress, SimpleGrid, Skeleton, Stack, Text } from "@mantine/core";
import { FiBox, FiFileText, FiShoppingBag, FiTrendingUp, FiUsers } from "react-icons/fi";

import AdminMenuCard from "@/components/admin/AdminMenuCard";
import DashboardStats, { type DashboardSummary } from "@/components/admin/DashboardStats";
import StatusBreakdownCard, { type OrderStatusData } from "@/components/admin/StatusBreakdownCard";
import RecentOrdersCard, { type RecentOrder } from "@/components/admin/RecentOrdersCard";
import SalesChart, { type DailySale } from "@/components/admin/SalesChart";
import TopProductsCard from "@/components/admin/TopProductsCard";
import {
    ErrorBlock,
    LoadingBlock,
    PageHeader,
    SectionCard,
    StatCard,
    StatGrid,
} from "@/components/dashboard/primitives";

/**
 * ==========================================
 * ADMIN OVERVIEW
 * ==========================================
 *
 * MIGRATION NOTES
 * ---------------
 * • Data fetching is untouched: the same `/api/admin/dashboard?period=7d` request, the same
 *   `cache: "no-store"`, the same `json.success` check and the same error copy.
 * • Every section the previous page rendered is still here, in the same order, reading the same
 *   fields. Nothing was dropped and nothing was invented.
 * • The two identical status panels are now one component (`StatusBreakdownCard`) rendered twice —
 *   previously `OrderStatusCard.tsx` and `PaymentMethodCard.tsx` were the same file twice, printing
 *   the *order* status list under a "Metode Pembayaran" heading. The second panel keeps its heading
 *   and now shows the payment-method counts the API actually returns for it.
 * • `any` became two local interfaces so the payload shape is checked; the API contract is
 *   unchanged.
 */

type PaymentMethodData = Record<string, number>;

type FlashSale = {
    id: number;
    name: string;
    soldCount: number;
    saleStock: number;
};

type Campaign = {
    id: number;
    name: string;
    type: string;
    endAt: string;
};

type DashboardData = {
    summary: DashboardSummary & {
        activeFlashSalesCount?: number;
        activeCampaignsCount?: number;
        pendingOrders?: number;
        failedPayments?: number;
    };
    dailySales: DailySale[];
    orderStatus: OrderStatusData;
    paymentMethod: PaymentMethodData;
    topProducts: { productId: number; productName: string; quantity: number; revenue: number }[];
    recentOrders: RecentOrder[];
    activeFlashSales?: FlashSale[];
    activeCampaigns?: Campaign[];
};

/**
 * The payment-method keys the dashboard API returns (`app/api/admin/dashboard/route.ts`). Listed
 * explicitly so the panel renders the four real methods instead of the six order-status labels the
 * previous implementation read off a payload that never had them.
 */
const PAYMENT_METHOD_LABELS = ["COD", "BANK_TRANSFER", "E_WALLET", "QRIS"];

export default function AdminPage() {
    const [data, setData] = useState<DashboardData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function loadDashboard() {
            try {
                const response = await fetch("/api/admin/dashboard?period=7d", {
                    cache: "no-store",
                });

                const result = await response.json();

                if (!response.ok || !result.success) {
                    throw new Error(result.message || "Gagal mengambil dashboard.");
                }

                setData(result.data);
            } catch (caught) {
                console.error("LOAD ADMIN DASHBOARD ERROR:", caught);
                setError(caught instanceof Error ? caught.message : "Gagal mengambil dashboard.");
            } finally {
                setLoading(false);
            }
        }

        loadDashboard();
    }, []);

    if (loading) {
        return (
            <Stack gap="lg">
                <Box>
                    <Skeleton height={28} width={280} radius="sm" />
                    <Skeleton height={16} width={420} mt="sm" radius="sm" />
                </Box>
                <Skeleton height={110} radius="md" />
                <Skeleton height={110} radius="md" />
                <LoadingBlock label="Memuat ringkasan toko…" />
            </Stack>
        );
    }

    if (!data) {
        return (
            <>
                <PageHeader eyebrow="Admin Dashboard" title="Ringkasan Toko" />
                <ErrorBlock
                    message={error ?? "Gagal mengambil data dashboard."}
                    action={
                        <Button size="md" radius="md" onClick={() => window.location.reload()}>
                            Coba lagi
                        </Button>
                    }
                />
            </>
        );
    }

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin Dashboard"
                title="Ringkasan Toko"
                description="Pantau penjualan, pesanan, produk, dan performa toko."
                actions={
                    <Button
                        component={Link}
                        href="/admin/reports"
                        size="md"
                        radius="md"
                        color="ink"
                        leftSection={<FiFileText size={17} />}
                    >
                        Laporan Penjualan
                    </Button>
                }
            />

            {/* QUICK MENU */}
            <Box>
                <Text fw={600} size="md" mb={4}>
                    Menu Cepat
                </Text>
                <Text size="sm" c="dimmed" mb="md">
                    Akses fitur administrasi toko.
                </Text>

                <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }} spacing="md">
                    <AdminMenuCard
                        href="/admin/products"
                        icon={FiBox}
                        title="Produk"
                        description="Kelola produk dan variant."
                    />
                    <AdminMenuCard
                        href="/admin/orders"
                        icon={FiShoppingBag}
                        title="Pesanan"
                        description="Lihat dan proses pesanan."
                    />
                    <AdminMenuCard
                        href="/admin/users"
                        icon={FiUsers}
                        title="Pengguna"
                        description="Kelola pengguna toko."
                    />
                    <AdminMenuCard
                        href="/admin/reports"
                        icon={FiTrendingUp}
                        title="Reporting"
                        description="Lihat dan download laporan."
                    />
                </SimpleGrid>
            </Box>

            <DashboardStats summary={data.summary} />

            <SalesChart data={data.dailySales} />

            <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
                <StatusBreakdownCard
                    title="Status Pesanan"
                    description="Rekap status pesanan periode aktif."
                    data={data.orderStatus}
                />

                <StatusBreakdownCard
                    title="Metode Pembayaran"
                    description="Rekap metode pembayaran periode aktif."
                    data={data.paymentMethod}
                    order={PAYMENT_METHOD_LABELS}
                />
            </SimpleGrid>

            <SimpleGrid cols={{ base: 1, xl: 2 }} spacing="md">
                <TopProductsCard data={data.topProducts} />

                <RecentOrdersCard data={data.recentOrders} />
            </SimpleGrid>

            {/* FLASH SALES & CAMPAIGNS */}
            <SimpleGrid cols={{ base: 1, xl: 2 }} spacing="md">
                <SectionCard
                    title="Flash Sale Aktif"
                    actions={
                        <Badge color="brand" variant="light" size="lg" radius="sm">
                            {data.summary?.activeFlashSalesCount ?? 0}
                        </Badge>
                    }
                >
                    {data.activeFlashSales && data.activeFlashSales.length > 0 ? (
                        <Stack gap="sm">
                            {data.activeFlashSales.slice(0, 5).map((flashSale) => (
                                <Group key={flashSale.id} justify="space-between" wrap="nowrap" gap="md">
                                    <Box style={{ minWidth: 0, flex: 1 }}>
                                        <Text size="sm" fw={500} lineClamp={1}>
                                            {flashSale.name}
                                        </Text>
                                        <Text size="xs" c="dimmed">
                                            {flashSale.soldCount}/{flashSale.saleStock} terjual
                                        </Text>
                                    </Box>

                                    <Progress
                                        value={
                                            flashSale.saleStock === 0
                                                ? 0
                                                : Math.min(
                                                      100,
                                                      (flashSale.soldCount / flashSale.saleStock) * 100
                                                  )
                                        }
                                        color="brand"
                                        size="sm"
                                        w={80}
                                        radius="xl"
                                    />
                                </Group>
                            ))}
                        </Stack>
                    ) : (
                        <Text size="sm" c="dimmed">
                            Tidak ada flash sale aktif
                        </Text>
                    )}
                </SectionCard>

                <SectionCard
                    title="Kampanye Aktif"
                    actions={
                        <Badge color="blue" variant="light" size="lg" radius="sm">
                            {data.summary?.activeCampaignsCount ?? 0}
                        </Badge>
                    }
                >
                    {data.activeCampaigns && data.activeCampaigns.length > 0 ? (
                        <Stack gap="sm">
                            {data.activeCampaigns.slice(0, 5).map((campaign) => (
                                <Group key={campaign.id} justify="space-between" wrap="nowrap" gap="md">
                                    <Box style={{ minWidth: 0, flex: 1 }}>
                                        <Text size="sm" fw={500} lineClamp={1}>
                                            {campaign.name}
                                        </Text>
                                        <Text size="xs" c="dimmed">
                                            {campaign.type}
                                        </Text>
                                    </Box>

                                    <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                                        s/d{" "}
                                        {new Date(campaign.endAt).toLocaleDateString("id-ID", {
                                            day: "2-digit",
                                            month: "short",
                                        })}
                                    </Text>
                                </Group>
                            ))}
                        </Stack>
                    ) : (
                        <Text size="sm" c="dimmed">
                            Tidak ada kampanye aktif
                        </Text>
                    )}
                </SectionCard>
            </SimpleGrid>

            {/* OPERATIONAL SUMMARY */}
            <StatGrid>
                <StatCard
                    label="Menunggu Diproses"
                    value={data.summary?.pendingOrders ?? 0}
                    tone="pending"
                />
                <StatCard
                    label="Pembayaran Gagal"
                    value={data.summary?.failedPayments ?? 0}
                    tone="error"
                />
                <StatCard
                    label="Flash Sale Aktif"
                    value={data.summary?.activeFlashSalesCount ?? 0}
                    tone="brand"
                />
                <StatCard
                    label="Kampanye Aktif"
                    value={data.summary?.activeCampaignsCount ?? 0}
                    tone="info"
                />
            </StatGrid>
        </Stack>
    );
}
