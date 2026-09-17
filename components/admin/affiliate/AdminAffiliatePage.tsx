"use client";

import { useEffect, useState, useCallback } from "react";
import toast from "react-hot-toast";

import {
    Alert,
    Button,
    Group,
    Image,
    Modal,
    Pagination,
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
    type Tone,
} from "@/components/dashboard/primitives";

/* ==========================================
 * TYPES
 * ========================================== */

type AffiliateUser = {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
};

type AffiliateKyc = {
    bankName: string | null;
    bankAccountName: string | null;
    bankAccountNumber: string | null; // masked
    ktpImageUrl: string | null;
    socialMediaPlatform: string | null;
    socialMediaUsername: string | null;
    socialMediaUrl: string | null;
};

type Application = {
    id: number;
    userId: string;
    status: string;
    affiliateCode: string | null;
    rejectionReason: string | null;
    approvedAt: string | null;
    createdAt: string;
    updatedAt: string;
    user: AffiliateUser | null;
    kyc: AffiliateKyc | null;
};

type Pagination = {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
};

/* ==========================================
 * HELPERS
 * ========================================== */

function statusLabel(status: string) {
    switch (status) {
        case "PENDING":
            return "Menunggu Review";
        case "APPROVED":
            return "Disetujui";
        case "REJECTED":
            return "Ditolak";
        default:
            return status;
    }
}

const STATUS_TONE: Record<string, Tone> = {
    PENDING: "warn",
    APPROVED: "success",
    REJECTED: "error",
};

function formatDate(value: string) {
    return new Date(value).toLocaleDateString(
        "id-ID",
        {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        }
    );
}

/* ==========================================
 * MAIN COMPONENT
 * ==========================================
 *
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: `statusLabel` and `formatDate` (same `id-ID` formatting), `loadApplications`
 * and its query-string contract (`page`, `limit=20`, `status` only when not "ALL", `search` only
 * when non-empty), the two `toast.error` branches (`data.message ?? "Gagal mengambil data."` on a
 * non-OK response, "Terjadi kesalahan." plus `console.error` on a throw), the response fallbacks,
 * the `useEffect(() => { loadApplications(page, statusFilter, search); }, [page, loadApplications])`
 * trigger, both filter handlers (page reset + re-fetch), the APPROVE `PATCH` body (`{ action:
 * "APPROVE" }`), the REJECT `PATCH` body (`{ action: "REJECT", rejectionReason: rejectReason.trim() }`)
 * with its "Alasan penolakan wajib diisi." guard and its success-only
 * `setRejectReason("")`, the success toasts, the post-mutation refresh, the `processing` gate and
 * the "Memproses..." labels.
 *
 * The approve confirmation was the shared `useDialog` promise; it is now a dashboard-owned Mantine
 * `Modal` whose title ("Setujui Pengajuan") and message are byte-for-byte the same.
 */

export default function AdminAffiliatePage() {
    const [applications, setApplications] =
        useState<Application[]>([]);
    const [pagination, setPagination] =
        useState<Pagination>({
            page: 1,
            limit: 20,
            total: 0,
            totalPages: 0,
        });
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] =
        useState("ALL");
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);

    // Review modal
    const [reviewing, setReviewing] =
        useState<Application | null>(null);
    const [rejectReason, setRejectReason] =
        useState("");
    const [processing, setProcessing] =
        useState(false);

    // Approve confirmation
    const [approveTarget, setApproveTarget] =
        useState<Application | null>(null);

    const loadApplications = useCallback(
        async (
            pageNum: number,
            statusVal: string,
            searchVal: string
        ) => {
            try {
                setLoading(true);
                const params = new URLSearchParams();
                params.set("page", String(pageNum));
                params.set("limit", "20");
                if (statusVal !== "ALL")
                    params.set("status", statusVal);
                if (searchVal.trim())
                    params.set(
                        "search",
                        searchVal.trim()
                    );

                const response = await fetch(
                    `/api/admin/affiliate/applications?${params.toString()}`,
                    { cache: "no-store" }
                );
                const data =
                    await response.json();

                if (!response.ok) {
                    toast.error(
                        data.message ??
                            "Gagal mengambil data."
                    );
                    return;
                }

                setApplications(
                    data.data?.items ?? []
                );
                setPagination(
                    data.data?.pagination ?? {
                        page: 1,
                        limit: 20,
                        total: 0,
                        totalPages: 0,
                    }
                );
            } catch (error) {
                console.error(error);
                toast.error(
                    "Terjadi kesalahan."
                );
            } finally {
                setLoading(false);
            }
        },
        []
    );

    useEffect(() => {
        loadApplications(page, statusFilter, search);
    }, [page, loadApplications]);

    function handleStatusFilter(value: string) {
        setStatusFilter(value);
        setPage(1);
        loadApplications(1, value, search);
    }

    function handleSearch(e: React.FormEvent) {
        e.preventDefault();
        setPage(1);
        loadApplications(1, statusFilter, search);
    }

    /* ==========================================
     * APPROVE
     * ==========================================
     *
     * The confirmation is a `Modal` now rather than the shared promise-based dialog, so the
     * "open" half lives in the modal branch below (`setApproveTarget`) and this function is the
     * `runApprove` half that previously ran after the promise resolved. The mutation itself —
     * endpoint, method, body, success toast, refresh and error copy — is unchanged.
     */

    async function runApprove(application: Application) {
        try {
            setProcessing(true);

            const res = await fetch(
                `/api/admin/affiliate/applications/${application.id}`,
                {
                    method: "PATCH",
                    headers: {
                        "Content-Type":
                            "application/json",
                    },
                    body: JSON.stringify({
                        action: "APPROVE",
                    }),
                }
            );

            const data = await res.json();

            if (!res.ok || !data.success) {
                throw new Error(
                    data.message ??
                        "Gagal menyetujui."
                );
            }

            toast.success(
                "Pengajuan berhasil disetujui."
            );
            setReviewing(null);
            loadApplications(
                page,
                statusFilter,
                search
            );
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : "Gagal menyetujui."
            );
        } finally {
            setProcessing(false);
        }
    }

    /* ==========================================
     * REJECT
     * ========================================== */

    async function handleReject(
        application: Application
    ) {
        if (!rejectReason.trim()) {
            toast.error(
                "Alasan penolakan wajib diisi."
            );
            return;
        }

        try {
            setProcessing(true);

            const res = await fetch(
                `/api/admin/affiliate/applications/${application.id}`,
                {
                    method: "PATCH",
                    headers: {
                        "Content-Type":
                            "application/json",
                    },
                    body: JSON.stringify({
                        action: "REJECT",
                        rejectionReason:
                            rejectReason.trim(),
                    }),
                }
            );

            const data = await res.json();

            if (!res.ok || !data.success) {
                throw new Error(
                    data.message ??
                        "Gagal menolak."
                );
            }

            toast.success(
                "Pengajuan berhasil ditolak."
            );
            setReviewing(null);
            setRejectReason("");
            loadApplications(
                page,
                statusFilter,
                search
            );
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : "Gagal menolak."
            );
        } finally {
            setProcessing(false);
        }
    }

    /* ==========================================
     * RENDER
     * ========================================== */

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Affiliate"
                title="Pengajuan Affiliator"
                description="Review dan kelola pengajuan Affiliator dari customer."
            />

            <SectionCard
                title="Semua Pengajuan"
                description={`Menampilkan ${applications.length} dari ${pagination.total} pengajuan`}
            >
                <Stack gap="md">
                    <Group gap="sm" align="flex-end" wrap="wrap">
                        <form onSubmit={handleSearch}>
                            <TextInput
                                size="md"
                                radius="md"
                                value={search}
                                onChange={(e) =>
                                    setSearch(e.currentTarget.value)
                                }
                                placeholder="Cari nama, email..."
                                aria-label="Cari pengajuan"
                                w={{ base: 200, sm: 260 }}
                            />
                        </form>

                        <Select
                            size="md"
                            radius="md"
                            allowDeselect={false}
                            value={statusFilter}
                            onChange={(value) =>
                                handleStatusFilter(value ?? "ALL")
                            }
                            aria-label="Filter status"
                            data={[
                                { value: "ALL", label: "Semua status" },
                                { value: "PENDING", label: "Menunggu Review" },
                                { value: "APPROVED", label: "Disetujui" },
                                { value: "REJECTED", label: "Ditolak" },
                            ]}
                        />
                    </Group>

                    <DataTable
                        minWidth={900}
                        loading={loading}
                        empty={
                            <EmptyBlock
                                title="Belum ada pengajuan"
                                description="Pengajuan Affiliator dari customer akan muncul di sini."
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
                            { header: "Customer" },
                            { header: "Bank" },
                            { header: "Rekening" },
                            { header: "Status" },
                            { header: "Tanggal" },
                            { header: "Aksi", align: "right" },
                        ]}
                        rows={applications.map((app) => ({
                            key: String(app.id),
                            cells: [
                                <Stack gap={0} key="customer">
                                    <Text size="sm" fw={600}>
                                        {app.user?.name ?? "-"}
                                    </Text>

                                    <Text size="xs" c="dimmed">
                                        {app.user?.email ?? "-"}
                                    </Text>
                                </Stack>,

                                <Text key="bank" size="sm">
                                    {app.kyc?.bankName ?? "-"}
                                </Text>,

                                <Text key="account" size="sm" ff="monospace">
                                    {app.kyc?.bankAccountNumber ?? "-"}
                                </Text>,

                                <StatusBadge key="status" tone={STATUS_TONE[app.status] ?? "neutral"}>
                                    {statusLabel(app.status)}
                                </StatusBadge>,

                                <Text key="date" size="xs" c="dimmed">
                                    {formatDate(app.createdAt)}
                                </Text>,

                                <Group justify="flex-end" key="actions">
                                    <Button
                                        variant="default"
                                        size="sm"
                                        radius="md"
                                        onClick={() => {
                                            setReviewing(app);
                                            setRejectReason("");
                                        }}
                                    >
                                        Review
                                    </Button>
                                </Group>,
                            ],
                        }))}
                    />
                </Stack>
            </SectionCard>

            {/* ==========================================
             * REVIEW MODAL
             * ========================================== */}

            <Modal
                opened={reviewing !== null}
                onClose={() => setReviewing(null)}
                size="lg"
                title="Review Pengajuan"
                centered
            >
                <Stack gap="md">
                    {/* Customer Info */}
                    <Stack gap={4}>
                        <Text size="xs" c="dimmed">
                            Customer
                        </Text>

                        <Text size="sm" fw={500}>
                            {reviewing?.user?.name ?? "-"}
                        </Text>

                        <Text size="xs" c="dimmed">
                            {reviewing?.user?.email ?? "-"}
                        </Text>

                        <Text size="xs" c="dimmed">
                            {reviewing?.user?.phone ?? "-"}
                        </Text>
                    </Stack>

                    {/* KTP */}
                    {reviewing?.kyc?.ktpImageUrl ? (
                        <Stack gap={4}>
                            <Text size="xs" c="dimmed">
                                Foto KTP
                            </Text>

                            <Image
                                src={reviewing.kyc.ktpImageUrl}
                                alt="KTP"
                                h={160}
                                w="auto"
                                fit="cover"
                                radius="md"
                            />
                        </Stack>
                    ) : null}

                    {/* Bank */}
                    <SimpleGrid cols={2} spacing="md">
                        <Stack gap={4}>
                            <Text size="xs" c="dimmed">
                                Bank
                            </Text>

                            <Text size="sm" fw={500}>
                                {reviewing?.kyc?.bankName ?? "-"}
                            </Text>
                        </Stack>

                        <Stack gap={4}>
                            <Text size="xs" c="dimmed">
                                Pemilik Rekening
                            </Text>

                            <Text size="sm" fw={500}>
                                {reviewing?.kyc?.bankAccountName ?? "-"}
                            </Text>
                        </Stack>
                    </SimpleGrid>

                    <Stack gap={4}>
                        <Text size="xs" c="dimmed">
                            Nomor Rekening
                        </Text>

                        <Text size="sm" fw={500} ff="monospace">
                            {reviewing?.kyc?.bankAccountNumber ?? "-"}
                        </Text>
                    </Stack>

                    {/* Social Media */}
                    {reviewing?.kyc?.socialMediaPlatform ? (
                        <Stack gap={4}>
                            <Text size="xs" c="dimmed">
                                Sosial Media
                            </Text>

                            <Text size="sm">
                                {reviewing.kyc.socialMediaPlatform}
                                {reviewing.kyc.socialMediaUsername
                                    ? ` — ${reviewing.kyc.socialMediaUsername}`
                                    : ""}
                            </Text>

                            {reviewing.kyc.socialMediaUrl ? (
                                <Image
                                    src={reviewing.kyc.socialMediaUrl}
                                    alt="Foto Sosial Media"
                                    h={160}
                                    w="auto"
                                    fit="cover"
                                    radius="md"
                                />
                            ) : null}
                        </Stack>
                    ) : null}

                    {/* Reject reason if exists */}
                    {reviewing?.rejectionReason ? (
                        <Alert color="red" variant="light" radius="md">
                            <Text size="xs" fw={500} c="red.7">
                                Alasan Penolakan Sebelumnya:
                            </Text>

                            <Text size="sm" c="red.8" mt={4}>
                                {reviewing.rejectionReason}
                            </Text>
                        </Alert>
                    ) : null}

                    {/* REJECT REASON INPUT */}
                    {reviewing?.status === "PENDING" ? (
                        <Textarea
                            label="Alasan Penolakan (jika Reject)"
                            size="md"
                            radius="md"
                            placeholder="Masukkan alasan penolakan..."
                            minRows={3}
                            maxRows={6}
                            autosize
                            value={rejectReason}
                            onChange={(e) =>
                                setRejectReason(e.currentTarget.value)
                            }
                        />
                    ) : null}

                    {/* ACTIONS */}
                    {reviewing?.status === "PENDING" ? (
                        <Group grow gap="sm" mt="xs">
                            <Button
                                variant="default"
                                size="md"
                                radius="md"
                                color="red"
                                onClick={() => handleReject(reviewing)}
                                disabled={processing}
                            >
                                {processing ? "Memproses..." : "Tolak"}
                            </Button>

                            <Button
                                size="md"
                                radius="md"
                                color="green"
                                onClick={() => setApproveTarget(reviewing)}
                                disabled={processing}
                            >
                                {processing ? "Memproses..." : "Setujui"}
                            </Button>
                        </Group>
                    ) : null}
                </Stack>
            </Modal>

            {/* ==========================================
             * APPROVE CONFIRMATION
             * ========================================== */}

            <Modal
                opened={approveTarget !== null}
                onClose={() => setApproveTarget(null)}
                title="Setujui Pengajuan"
                centered
            >
                <Text size="sm">
                    Setujui pengajuan dari{" "}
                    {approveTarget?.user?.name ?? "user ini"}?
                </Text>

                <Group grow gap="sm" mt="lg">
                    <Button
                        variant="default"
                        size="md"
                        radius="md"
                        onClick={() => setApproveTarget(null)}
                    >
                        Batal
                    </Button>

                    <Button
                        size="md"
                        radius="md"
                        onClick={() => {
                            const target = approveTarget;
                            setApproveTarget(null);
                            if (target) runApprove(target);
                        }}
                    >
                        Setujui
                    </Button>
                </Group>
            </Modal>
        </Stack>
    );
}
