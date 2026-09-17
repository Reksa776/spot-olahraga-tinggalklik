"use client";

import { useEffect, useState, useCallback } from "react";
import toast from "react-hot-toast";
import { FiClock } from "react-icons/fi";

import {
    Divider,
    Group,
    Pagination,
    Paper,
    Select,
    Skeleton,
    Stack,
    Text,
} from "@mantine/core";

import {
    EmptyBlock,
    PageHeader,
    SectionCard,
    StatusBadge,
    type Tone,
} from "@/components/dashboard/primitives";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: `load` and its query-string contract (`page`, `limit=20`, `action` only when
 * set), the `data.data?.items ?? []` / `pagination` fallbacks, the two `toast.error` branches, the
 * `useEffect(() => { load(page, actionFilter); }, [page, load])` trigger, the filter-select handler's
 * `setPage(1)` + reselect, `fmtDate` (the same `id-ID` short-month date), and both label maps —
 * `ACTION_LABELS` (every action key and its Indonesian label) and `ACTION_COLORS` — which now map to
 * semantic `StatusBadge` tones instead of tint classes, with the same fallbacks for an unknown
 * action.
 */

type AuditLogItem = {
    id: number;
    adminId: string;
    action: string;
    entityType: string;
    entityId: number | null;
    description: string;
    metadata: any;
    createdAt: string;
};

const ACTION_LABELS: Record<string, string> = {
    AFFILIATE_APPROVED: "Affiliate Disetujui",
    AFFILIATE_REJECTED: "Affiliate Ditolak",
    AFFILIATE_SUSPENDED: "Affiliate Suspended",
    AFFILIATE_RATE_UPDATED: "Rate Diubah",
    COMMISSION_APPROVED: "Komisi Disetujui",
    COMMISSION_CANCELLED: "Komisi Dibatalkan",
    COMMISSION_PAID: "Komisi Dibayarkan",
    PAYOUT_APPROVED: "Payout Disetujui",
    PAYOUT_REJECTED: "Payout Ditolak",
    PAYOUT_PAID: "Payout Dibayarkan",
    ORDER_CANCELLED: "Order Dibatalkan",
    ORDER_REFUNDED: "Order Refund",
    AFFILIATE_COMMISSION_AUTO_CANCELLED: "Komisi Auto-Cancel",
};

const ACTION_TONES: Record<string, Tone> = {
    AFFILIATE_APPROVED: "success",
    AFFILIATE_REJECTED: "error",
    AFFILIATE_SUSPENDED: "neutral",
    AFFILIATE_RATE_UPDATED: "info",
    COMMISSION_APPROVED: "success",
    COMMISSION_CANCELLED: "error",
    COMMISSION_PAID: "info",
    PAYOUT_APPROVED: "success",
    PAYOUT_REJECTED: "error",
    PAYOUT_PAID: "info",
    ORDER_CANCELLED: "error",
    ORDER_REFUNDED: "warn",
    AFFILIATE_COMMISSION_AUTO_CANCELLED: "pending",
};

function fmtDate(s: string) {
    return new Date(s).toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export default function AdminAuditLogPage() {
    const [items, setItems] = useState<AuditLogItem[]>([]);
    const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [actionFilter, setActionFilter] = useState("");

    const load = useCallback(async (p: number, action: string) => {
        try {
            setLoading(true);
            const params = new URLSearchParams();
            params.set("page", String(p));
            params.set("limit", "20");
            if (action) params.set("action", action);

            const res = await fetch(`/api/admin/audit-log?${params.toString()}`, { cache: "no-store" });
            const data = await res.json();
            if (!res.ok) { toast.error(data.message); return; }
            setItems(data.data?.items ?? []);
            setPagination(data.data?.pagination ?? { page: 1, limit: 20, total: 0, totalPages: 0 });
        } catch { toast.error("Gagal memuat data."); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { load(page, actionFilter); }, [page, load]);

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Affiliate"
                title="Riwayat Aktivitas"
                description="Audit trail untuk semua aksi admin pada affiliate system."
            />

            <SectionCard
                title="Aktivitas"
                description={`Menampilkan ${items.length} dari ${pagination.total} aktivitas`}
                actions={
                    <Select
                        size="md"
                        radius="md"
                        allowDeselect={false}
                        value={actionFilter === "" ? "ALL" : actionFilter}
                        onChange={(value) => {
                            setActionFilter(value === "ALL" ? "" : (value ?? ""));
                            setPage(1);
                        }}
                        aria-label="Filter aksi"
                        data={[
                            { value: "ALL", label: "Semua Aksi" },
                            ...Object.entries(ACTION_LABELS).map(([key, label]) => ({
                                value: key,
                                label,
                            })),
                        ]}
                        w={{ base: 180, sm: 220 }}
                    />
                }
            >
                <Stack gap={0}>
                    {loading ? (
                        Array.from({ length: 5 }).map((_, i) => (
                            <Paper key={i} withBorder={false} p="md" radius="md">
                                <Skeleton height={16} radius="sm" />
                            </Paper>
                        ))
                    ) : items.length === 0 ? (
                        <EmptyBlock title="Belum ada aktivitas." />
                    ) : (
                        items.map((item, index) => (
                            <Stack gap={0} key={item.id}>
                                {index > 0 ? <Divider /> : null}

                                <Group
                                    justify="space-between"
                                    align="flex-start"
                                    gap="md"
                                    wrap="nowrap"
                                    py="sm"
                                >
                                    <Stack gap={6} style={{ minWidth: 0, flex: 1 }}>
                                        <Text size="sm">{item.description}</Text>

                                        <Group gap="sm" wrap="wrap">
                                            <StatusBadge
                                                tone={ACTION_TONES[item.action] ?? "neutral"}
                                                size="sm"
                                            >
                                                {ACTION_LABELS[item.action] || item.action}
                                            </StatusBadge>

                                            <Text size="xs" c="dimmed">
                                                Admin: {item.adminId}
                                            </Text>

                                            {item.entityId ? (
                                                <Text size="xs" c="dimmed">
                                                    {item.entityType} #{item.entityId}
                                                </Text>
                                            ) : null}
                                        </Group>
                                    </Stack>

                                    <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                                        <FiClock size={12} />

                                        <Text size="xs" c="dimmed">
                                            {fmtDate(item.createdAt)}
                                        </Text>
                                    </Group>
                                </Group>
                            </Stack>
                        ))
                    )}
                </Stack>

                {pagination.totalPages > 1 ? (
                    <Group justify="space-between" align="center" mt="md" wrap="wrap">
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
                ) : null}
            </SectionCard>
        </Stack>
    );
}
