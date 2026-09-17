"use client";

import { useEffect, useState, useCallback } from "react";
import toast from "react-hot-toast";
import Link from "next/link";
import { FiEye, FiSearch } from "react-icons/fi";

import {
    Button,
    Group,
    Pagination,
    Select,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";

import {
    DataTable,
    EmptyBlock,
    PageHeader,
    SectionCard,
    StatusBadge,
    type Tone,
} from "@/components/dashboard/primitives";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * This is affiliate financial UI, so nothing numeric was touched. Preserved exactly:
 * `rupiah()` (including `Number(v).toLocaleString("id-ID")`), `load` and its full query-string
 * contract (`page`, `limit=20`, and the three CONDITIONAL params — `status` only when not "ALL",
 * `search` only when non-empty, `sort` only when not the default `createdAt`, `days` only when not
 * "all"), the `data.data?.items ?? []` / `pagination` fallbacks, the `toast.error` branches
 * (`data.message` on a non-OK response, "Gagal memuat data." on a throw), the
 * `useEffect(() => { load(page, statusFilter, search, sort, period); }, [page, load])` trigger, and
 * the four handlers — each of which resets to page 1 AND re-fetches with the new value, because
 * `setPage(1)` alone does not re-run the effect when the page is already 1.
 *
 * Presentation changes: `DataTable` + `StatusBadge` (same four statuses and the same raw status
 * labels), Mantine `TextInput`/`Select`, and Mantine `Pagination` in place of the two chevron
 * buttons. Every displayed value — commission rate, clicks, conversions, conversion rate, sales and
 * total commission — is formatted by the same functions as before.
 */

type AffiliateItem = {
    id: number;
    name: string;
    email: string;
    affiliateCode: string;
    commissionRate: number;
    status: string;
    clicks: number;
    orders: number;
    totalConversions: number;
    conversionRate: number;
    sales: number;
    totalCommission: number;
    pendingCommission: number;
    approvedCommission: number;
    paidCommission: number;
    approvedAt: string | null;
    createdAt: string;
};

function rupiah(v: number) {
    return `Rp ${Number(v).toLocaleString("id-ID")}`;
}

const STATUS_TONE: Record<string, Tone> = {
    APPROVED: "success",
    PENDING: "pending",
    REJECTED: "error",
    SUSPENDED: "neutral",
};

export default function AdminAffiliateManagement() {
    const [items, setItems] = useState<AffiliateItem[]>([]);
    const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState("ALL");
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const [sort, setSort] = useState("createdAt");
    const [period, setPeriod] = useState("all");

    const load = useCallback(async (p: number, status: string, q: string, s: string, per: string) => {
        try {
            setLoading(true);
            const params = new URLSearchParams();
            params.set("page", String(p));
            params.set("limit", "20");
            if (status !== "ALL") params.set("status", status);
            if (q.trim()) params.set("search", q.trim());
            if (s !== "createdAt") params.set("sort", s);
            if (per !== "all") params.set("days", per);

            const res = await fetch(`/api/admin/affiliate?${params.toString()}`, { cache: "no-store" });
            const data = await res.json();
            if (!res.ok) { toast.error(data.message); return; }
            setItems(data.data?.items ?? []);
            setPagination(data.data?.pagination ?? { page: 1, limit: 20, total: 0, totalPages: 0 });
        } catch { toast.error("Gagal memuat data."); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { load(page, statusFilter, search, sort, period); }, [page, load]);

    function handleSearch(e: React.FormEvent) {
        e.preventDefault();
        setPage(1);
        load(1, statusFilter, search, sort, period);
    }

    function handleStatus(v: string) {
        setStatusFilter(v);
        setPage(1);
        load(1, v, search, sort, period);
    }

    function handleSort(v: string) {
        setSort(v);
        setPage(1);
        load(1, statusFilter, search, v, period);
    }

    function handlePeriod(v: string) {
        setPeriod(v);
        setPage(1);
        load(1, statusFilter, search, sort, v);
    }

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Affiliate"
                title="Affiliate Management"
                description="Kelola seluruh affiliate dan performa mereka."
            />

            <SectionCard
                title="Daftar Affiliate"
                description={`Menampilkan ${items.length} dari ${pagination.total} affiliate`}
            >
                <Stack gap="md">
                    <Group gap="sm" align="flex-end" wrap="wrap">
                        <form onSubmit={handleSearch}>
                            <TextInput
                                size="md"
                                radius="md"
                                value={search}
                                onChange={(e) => setSearch(e.currentTarget.value)}
                                placeholder="Cari nama, email, kode..."
                                aria-label="Cari affiliate"
                                leftSection={<FiSearch size={14} />}
                                w={{ base: 200, sm: 240 }}
                            />
                        </form>

                        <Select
                            size="md"
                            radius="md"
                            allowDeselect={false}
                            value={statusFilter}
                            onChange={(value) => handleStatus(value ?? "ALL")}
                            aria-label="Filter status"
                            data={[
                                { value: "ALL", label: "Semua Status" },
                                { value: "APPROVED", label: "Approved" },
                                { value: "PENDING", label: "Pending" },
                                { value: "REJECTED", label: "Rejected" },
                                { value: "SUSPENDED", label: "Suspended" },
                            ]}
                        />

                        <Select
                            size="md"
                            radius="md"
                            allowDeselect={false}
                            value={sort}
                            onChange={(value) => handleSort(value ?? "createdAt")}
                            aria-label="Urutkan"
                            data={[
                                { value: "createdAt", label: "Terbaru" },
                                { value: "sales", label: "Penjualan" },
                                { value: "commission", label: "Komisi" },
                                { value: "orders", label: "Order" },
                                { value: "clicks", label: "Klik" },
                                { value: "conversion", label: "Conversion Rate" },
                            ]}
                        />

                        <Select
                            size="md"
                            radius="md"
                            allowDeselect={false}
                            value={period}
                            onChange={(value) => handlePeriod(value ?? "all")}
                            aria-label="Periode"
                            data={[
                                { value: "all", label: "Semua Waktu" },
                                { value: "7", label: "7 Hari" },
                                { value: "30", label: "30 Hari" },
                                { value: "90", label: "90 Hari" },
                            ]}
                        />
                    </Group>

                    <DataTable
                        minWidth={1100}
                        loading={loading}
                        empty={
                            <EmptyBlock
                                title="Belum ada affiliate."
                                description="Affiliate yang mendaftar akan muncul di sini."
                            />
                        }
                        footer={
                            pagination.totalPages > 1 ? (
                                <Group justify="space-between" align="center" wrap="wrap">
                                    <Text size="sm" c="dimmed">
                                        Halaman {pagination.page} dari {pagination.totalPages}
                                    </Text>

                                    <Pagination
                                        size="md"
                                        total={pagination.totalPages}
                                        value={page}
                                        onChange={setPage}
                                    />
                                </Group>
                            ) : undefined
                        }
                        columns={[
                            { header: "Affiliator" },
                            { header: "Kode" },
                            { header: "Rate" },
                            { header: "Klik" },
                            { header: "Konversi" },
                            { header: "Conv. Rate" },
                            { header: "Penjualan" },
                            { header: "Total Komisi" },
                            { header: "Status" },
                            { header: "Aksi", align: "right" },
                        ]}
                        rows={items.map((a) => ({
                            key: String(a.id),
                            cells: [
                                <Stack gap={0} key="affiliator">
                                    <Text size="sm" fw={500}>
                                        {a.name}
                                    </Text>

                                    <Text size="xs" c="dimmed">
                                        {a.email}
                                    </Text>
                                </Stack>,

                                <Text key="code" size="sm" fw={600} ff="monospace">
                                    {a.affiliateCode}
                                </Text>,

                                <Text key="rate" size="sm">
                                    {a.commissionRate}%
                                </Text>,

                                <Text key="clicks" size="sm">
                                    {a.clicks.toLocaleString("id-ID")}
                                </Text>,

                                <Text key="conversions" size="sm">
                                    {a.totalConversions ?? a.orders}
                                </Text>,

                                <Text key="convrate" size="sm">
                                    {a.conversionRate ?? 0}%
                                </Text>,

                                <Text key="sales" size="sm">
                                    {rupiah(a.sales)}
                                </Text>,

                                <Text key="commission" size="sm" fw={500} c="green.7">
                                    {rupiah(a.totalCommission)}
                                </Text>,

                                <StatusBadge key="status" tone={STATUS_TONE[a.status] ?? "neutral"}>
                                    {a.status}
                                </StatusBadge>,

                                <Group justify="flex-end" key="actions">
                                    <Button
                                        component={Link}
                                        href={`/admin/affiliate/manage/${a.id}`}
                                        variant="default"
                                        size="sm"
                                        radius="md"
                                        leftSection={<FiEye size={12} />}
                                    >
                                        Detail
                                    </Button>
                                </Group>,
                            ],
                        }))}
                    />
                </Stack>
            </SectionCard>
        </Stack>
    );
}
