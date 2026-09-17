"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";

import {
    Box,
    Button,
    Group,
    Modal,
    Select,
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
    StatGrid,
    StatCard,
    StatusBadge,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Refund approvals move money, so this is presentation-only in the strictest sense. Preserved
 * exactly: `loadRefunds(page, searchQuery?, status?)` and its `undefined`-vs-value argument
 * convention for search/status, the `/api/admin/refunds` params, `setRefunds`/`setSummary`/
 * `setPagination`, `handleRefundAction`'s action-specific confirm copy, the `providerRef` prompt
 * (optional — and, as before, *cancelling it still proceeds*), the `reason` prompt (required —
 * cancelling or leaving it empty aborts and clears the busy id), the `PATCH
 * /api/admin/orders/{orderId}/refund` body, `toast.success(result.message)`, the
 * `loadRefunds(pagination.page)` refresh, `setProcessingAction` gating the row buttons, and
 * `formatRupiah`/`formatDate`/`getStatusLabel`.
 *
 * The shared `useDialog` confirm/prompt pair became three Mantine `Modal`s (confirm, provider
 * reference, rejection reason), one per step of the same flow and in the same order. `getStatusClass`
 * was a four-colour Tailwind map; it is now the shared semantic tones.
 */

type Refund = {
    id: number;
    orderId: number;
    orderNumber: string;
    customer: {
        id: string;
        name: string;
        email: string;
    };
    orderTotal: number;
    refundAmount: number;
    reason: string | null;
    status: string;
    paymentMethod: string;
    orderStatus: string;
    requestedBy: string;
    processedBy: string | null;
    providerRef: string | null;
    requestedAt: string;
    processedAt: string;
};

type Summary = {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    total: number;
};

type Pagination = {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
};

type Action = "approve" | "complete" | "reject";

type Target = { refundId: number; orderId: number; action: Action };

function formatRupiah(value: number) {
    return `Rp ${Number(value || 0).toLocaleString("id-ID")}`;
}

function formatDate(value: string) {
    return new Date(value).toLocaleString("id-ID", {
        dateStyle: "medium",
        timeStyle: "short",
    });
}

function getStatusLabel(status: string) {
    const labels: Record<string, string> = {
        PENDING: "Menunggu",
        PROCESSING: "Diproses",
        COMPLETED: "Selesai",
        FAILED: "Gagal",
    };
    return labels[status] || status;
}

function getStatusTone(status: string): Tone {
    switch (status) {
        case "PENDING":
            return "warn";
        case "PROCESSING":
            return "info";
        case "COMPLETED":
            return "success";
        case "FAILED":
            return "error";
        default:
            return "neutral";
    }
}

export default function AdminRefundsPage() {
    const [refunds, setRefunds] = useState<Refund[]>([]);
    const [summary, setSummary] = useState<Summary>({
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        total: 0,
    });
    const [pagination, setPagination] = useState<Pagination>({
        page: 1,
        limit: 10,
        totalCount: 0,
        totalPages: 0,
    });
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [processingAction, setProcessingAction] = useState<number | null>(null);

    const [confirmTarget, setConfirmTarget] = useState<Target | null>(null);
    const [refTarget, setRefTarget] = useState<Target | null>(null);
    const [refInput, setRefInput] = useState("");
    const [reasonTarget, setReasonTarget] = useState<Target | null>(null);
    const [reasonInput, setReasonInput] = useState("");

    async function loadRefunds(page: number = 1, searchQuery?: string, status?: string) {
        try {
            setLoading(true);

            const params = new URLSearchParams();
            params.set("page", String(page));
            params.set("limit", "10");

            const q = searchQuery !== undefined ? searchQuery : search;
            if (q) params.set("search", q);

            const s = status !== undefined ? status : statusFilter;
            if (s) params.set("status", s);

            const response = await fetch(`/api/admin/refunds?${params.toString()}`);
            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal mengambil data refund.");
            }

            setRefunds(result.data.refunds);
            setSummary(result.data.summary);
            setPagination(result.data.pagination);
        } catch (error) {
            console.error("LOAD REFUNDS ERROR:", error);
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil data refund."
            );
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadRefunds(1);
    }, []);

    function beginAction(refundId: number, orderId: number, action: Action) {
        setProcessingAction(refundId);
        setConfirmTarget({ refundId, orderId, action });
    }

    function cancelConfirm() {
        setConfirmTarget(null);
        setProcessingAction(null);
    }

    /** Runs after the confirm step and, for `complete`/`reject`, after its own prompt step. */
    async function submitAction(
        target: Target,
        extra: { providerRef?: string; reason?: string }
    ) {
        try {
            const response = await fetch(
                `/api/admin/orders/${target.orderId}/refund`,
                {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        action: target.action,
                        providerRef: extra.providerRef,
                        reason: extra.reason,
                    }),
                }
            );

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal memproses refund.");
            }

            toast.success(result.message);
            loadRefunds(pagination.page);
        } catch (error) {
            console.error("REFUND ACTION ERROR:", error);
            toast.error(
                error instanceof Error ? error.message : "Gagal memproses refund."
            );
        } finally {
            setProcessingAction(null);
        }
    }

    function afterConfirm() {
        const target = confirmTarget;
        setConfirmTarget(null);

        if (!target) return;

        if (target.action === "complete") {
            setRefInput("");
            setRefTarget(target);
            return;
        }

        if (target.action === "reject") {
            setReasonInput("");
            setReasonTarget(target);
            return;
        }

        submitAction(target, {});
    }

    /** The provider-reference prompt is optional: closing it still completes the refund. */
    function afterProviderRef(value?: string) {
        const target = refTarget;
        setRefTarget(null);

        if (!target) return;

        submitAction(target, { providerRef: value || undefined });
    }

    function abortReason() {
        setReasonTarget(null);
        setProcessingAction(null);
    }

    function afterReason() {
        const target = reasonTarget;

        if (!target) {
            setProcessingAction(null);
            return;
        }

        if (!reasonInput) {
            abortReason();
            return;
        }

        setReasonTarget(null);
        submitAction(target, { reason: reasonInput });
    }

    const confirmTitle = (action: Action) =>
        action === "complete"
            ? "Selesaikan Refund"
            : action === "approve"
              ? "Setujui Refund"
              : "Tolak Refund";

    const confirmMessage = (action: Action) =>
        action === "complete"
            ? "Tandai refund sebagai selesai?"
            : action === "approve"
              ? "Setujui refund ini?"
              : "Tolak refund ini?";

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="Dashboard Refund"
                description="Kelola permintaan refund dari pelanggan"
            />

            {/* SUMMARY CARDS */}

            <StatGrid>
                <StatCard label="Menunggu" value={summary.pending} tone="warn" />
                <StatCard label="Diproses" value={summary.processing} tone="info" />
                <StatCard label="Selesai" value={summary.completed} tone="success" />
                <StatCard label="Gagal" value={summary.failed} tone="error" />
            </StatGrid>

            {/* SEARCH + FILTER */}

            <Group gap="md" align="flex-end" wrap="wrap">
                <TextInput
                    size="md"
                    radius="md"
                    flex={1}
                    miw={{ base: "100%", sm: 260 }}
                    placeholder="Cari nomor pesanan atau nama pelanggan..."
                    aria-label="Cari refund"
                    value={search}
                    onChange={(e) => setSearch(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            loadRefunds(1, search);
                        }
                    }}
                />

                <Select
                    size="md"
                    radius="md"
                    allowDeselect={false}
                    aria-label="Filter status refund"
                    value={statusFilter}
                    onChange={(value) => {
                        const next = value ?? "";
                        setStatusFilter(next);
                        loadRefunds(1, undefined, next);
                    }}
                    data={[
                        { value: "", label: "Semua Status" },
                        { value: "PENDING", label: "Menunggu" },
                        { value: "PROCESSING", label: "Diproses" },
                        { value: "COMPLETED", label: "Selesai" },
                        { value: "FAILED", label: "Gagal" },
                    ]}
                    w={{ base: "100%", sm: 180 }}
                />

                <Button
                    size="md"
                    radius="md"
                    onClick={() => loadRefunds(1, search)}
                >
                    Cari
                </Button>
            </Group>

            {/* TABLE */}

            <SectionCard title="Daftar Refund" description={`${pagination.totalCount} refund`}>
                <DataTable
                    minWidth={1100}
                    loading={loading}
                    loadingRows={5}
                    empty={
                        <EmptyBlock
                            title="Tidak ada data refund ditemukan"
                            description="Belum ada permintaan refund yang cocok dengan filter saat ini."
                        />
                    }
                    columns={[
                        { header: "Pesanan" },
                        { header: "Pelanggan" },
                        { header: "Jumlah Refund", align: "right" },
                        { header: "Status", align: "center" },
                        { header: "Alasan" },
                        { header: "Diajukan" },
                        { header: "Aksi", align: "center" },
                    ]}
                    rows={refunds.map((refund) => ({
                        key: String(refund.id),
                        cells: [
                            <TextLink
                                href={`/admin/orders/${refund.orderId}`}
                                key="order"
                            >
                                {refund.orderNumber}
                            </TextLink>,

                            <Stack gap={0} key="customer">
                                <Text size="sm" fw={500}>
                                    {refund.customer.name}
                                </Text>

                                <Text size="xs" c="dimmed">
                                    {refund.customer.email}
                                </Text>
                            </Stack>,

                            <Box key="amount">
                                <Text size="sm" fw={600}>
                                    {formatRupiah(refund.refundAmount)}
                                </Text>

                                <Text size="xs" c="dimmed">
                                    dari {formatRupiah(refund.orderTotal)}
                                </Text>
                            </Box>,

                            <Box key="status">
                                <StatusBadge tone={getStatusTone(refund.status)}>
                                    {getStatusLabel(refund.status)}
                                </StatusBadge>
                            </Box>,

                            <Text size="sm" c="dimmed" lineClamp={1} maw={200} key="reason">
                                {refund.reason || "-"}
                            </Text>,

                            <Text size="sm" c="dimmed" key="requested">
                                {formatDate(refund.requestedAt)}
                            </Text>,

                            <Group justify="center" gap="xs" wrap="nowrap" key="actions">
                                {refund.status === "PENDING" && (
                                    <>
                                        <Button
                                            color="green"
                                            size="sm"
                                            radius="md"
                                            disabled={processingAction === refund.id}
                                            onClick={() =>
                                                beginAction(
                                                    refund.id,
                                                    refund.orderId,
                                                    "approve"
                                                )
                                            }
                                        >
                                            Setujui
                                        </Button>

                                        <Button
                                            color="red"
                                            size="sm"
                                            radius="md"
                                            disabled={processingAction === refund.id}
                                            onClick={() =>
                                                beginAction(
                                                    refund.id,
                                                    refund.orderId,
                                                    "reject"
                                                )
                                            }
                                        >
                                            Tolak
                                        </Button>
                                    </>
                                )}

                                {refund.status === "PROCESSING" && (
                                    <Button
                                        color="green"
                                        size="sm"
                                        radius="md"
                                        disabled={processingAction === refund.id}
                                        onClick={() =>
                                            beginAction(
                                                refund.id,
                                                refund.orderId,
                                                "complete"
                                            )
                                        }
                                    >
                                        Selesai
                                    </Button>
                                )}

                                {refund.status === "COMPLETED" && (
                                    <Text size="xs" c="dimmed">
                                        Selesai
                                    </Text>
                                )}

                                {refund.status === "FAILED" && (
                                    <Text size="xs" c="dimmed">
                                        Ditolak
                                    </Text>
                                )}
                            </Group>,
                        ],
                    }))}
                    footer={
                        pagination.totalPages > 1 ? (
                            <Group justify="space-between" align="center" wrap="wrap">
                                <Text size="sm" c="dimmed">
                                    Menampilkan{" "}
                                    {(pagination.page - 1) * pagination.limit + 1} -{" "}
                                    {Math.min(
                                        pagination.page * pagination.limit,
                                        pagination.totalCount
                                    )}{" "}
                                    dari {pagination.totalCount} refund
                                </Text>

                                <Group gap="sm">
                                    <Button
                                        variant="default"
                                        size="md"
                                        radius="md"
                                        disabled={pagination.page <= 1}
                                        onClick={() =>
                                            loadRefunds(pagination.page - 1)
                                        }
                                    >
                                        ← Sebelumnya
                                    </Button>

                                    <Text size="sm" fw={500}>
                                        {pagination.page} / {pagination.totalPages}
                                    </Text>

                                    <Button
                                        variant="default"
                                        size="md"
                                        radius="md"
                                        disabled={
                                            pagination.page >= pagination.totalPages
                                        }
                                        onClick={() =>
                                            loadRefunds(pagination.page + 1)
                                        }
                                    >
                                        Selanjutnya →
                                    </Button>
                                </Group>
                            </Group>
                        ) : undefined
                    }
                />
            </SectionCard>

            {/* CONFIRM */}

            <Modal
                opened={confirmTarget !== null}
                onClose={cancelConfirm}
                title={confirmTarget ? confirmTitle(confirmTarget.action) : ""}
                centered
            >
                <Text size="sm">
                    {confirmTarget ? confirmMessage(confirmTarget.action) : ""}
                </Text>

                <Group justify="flex-end" mt="lg">
                    <Button
                        variant="default"
                        size="md"
                        radius="md"
                        onClick={cancelConfirm}
                    >
                        Batal
                    </Button>

                    <Button
                        color={confirmTarget?.action === "reject" ? "red" : "brand"}
                        size="md"
                        radius="md"
                        onClick={afterConfirm}
                    >
                        {confirmTarget?.action === "reject" ? "Tolak" : "Ya"}
                    </Button>
                </Group>
            </Modal>

            {/* PROVIDER REFERENCE */}

            <Modal
                opened={refTarget !== null}
                onClose={() => afterProviderRef(undefined)}
                title="Provider Reference"
                centered
            >
                <TextInput
                    label="Provider reference ID (opsional)"
                    size="md"
                    radius="md"
                    value={refInput}
                    onChange={(e) => setRefInput(e.currentTarget.value)}
                    placeholder="Ref ID"
                />

                <Group justify="flex-end" mt="lg">
                    <Button
                        variant="default"
                        size="md"
                        radius="md"
                        onClick={() => afterProviderRef(undefined)}
                    >
                        Batal
                    </Button>

                    <Button
                        size="md"
                        radius="md"
                        onClick={() => afterProviderRef(refInput)}
                    >
                        Selesaikan
                    </Button>
                </Group>
            </Modal>

            {/* REJECTION REASON */}

            <Modal
                opened={reasonTarget !== null}
                onClose={abortReason}
                title="Alasan Penolakan"
                centered
            >
                <Textarea
                    label="Alasan penolakan"
                    size="md"
                    radius="md"
                    required
                    value={reasonInput}
                    onChange={(e) => setReasonInput(e.currentTarget.value)}
                    placeholder="Masukkan alasan..."
                    rows={3}
                    autosize
                    minRows={3}
                />

                <Group justify="flex-end" mt="lg">
                    <Button
                        variant="default"
                        size="md"
                        radius="md"
                        onClick={abortReason}
                    >
                        Batal
                    </Button>

                    <Button
                        color="red"
                        size="md"
                        radius="md"
                        disabled={!reasonInput}
                        onClick={afterReason}
                    >
                        Tolak Refund
                    </Button>
                </Group>
            </Modal>
        </Stack>
    );
}
