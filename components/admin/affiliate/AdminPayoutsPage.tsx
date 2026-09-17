"use client";

import { useEffect, useState, useCallback } from "react";
import toast from "react-hot-toast";
import { FiCheck, FiSearch, FiX } from "react-icons/fi";

import {
    Button,
    Group,
    Modal,
    Pagination,
    Select,
    Stack,
    Text,
    TextInput,
    Textarea,
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
 * HIGH-RISK AREA — payout money. Every financial value is rendered by the same functions as before:
 * `rupiah()` (`Rp` + `Number(v).toLocaleString("id-ID")`) and `fmtDate()` (`id-ID` short-month,
 * 2-digit hour/minute). No amount, total or rounding was touched.
 *
 * Preserved exactly: `load` and its query string (`page`, `limit=20`, `status` only when not "ALL",
 * `search` only when non-empty), the response fallbacks, both `toast.error` branches, the
 * `useEffect(() => { load(page, statusFilter, search); }, [page, load])` trigger, `handleSearch` /
 * `handleStatus` (page reset + re-fetch), and `handleAction` in full: the `PATCH` endpoint, the
 * `body.action` value, the CONDITIONAL `reason` (REJECT only) and `proofFilePath` (CONFIRM_PAID only,
 * and only when non-empty), `toast.success(r.message)`, the three state resets and the
 * `load(page, statusFilter, search)` refresh. The action buttons per payout status
 * (PENDING → Approve/Reject, PROCESSING → Check Status/Confirm Paid, PAID → Settle) and the
 * `statusLabel` / rejection-reason display are unchanged.
 *
 * Presentation changes: `Modal` replaces the hand-rolled overlay with identical titles, copy and
 * button labels; `statusLabel` keys now map to semantic `StatusBadge` tones.
 */

type PayoutItem = {
    id: number; affiliateId: number; affiliateName: string; affiliateEmail: string;
    affiliateCode: string; amount: number; status: string;
    bankName: string; bankAccountName: string; bankAccountNumber: string;
    requestedAt: string; processedAt: string | null; processedBy: string | null; rejectionReason: string | null;
};

function rupiah(v: number) { return `Rp ${Number(v).toLocaleString("id-ID")}`; }
function fmtDate(s: string) { return new Date(s).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }

const statusLabel: Record<string, string> = { PENDING: "Menunggu", PROCESSING: "Diproses", PAID: "Dibayar", FAILED: "Gagal", REJECTED: "Ditolak", CANCELLED: "Dibatalkan" };
const statusTone: Record<string, Tone> = {
    PENDING: "pending",
    PROCESSING: "info",
    PAID: "success",
    FAILED: "error",
    REJECTED: "error",
    CANCELLED: "neutral",
};

export default function AdminPayoutsPage() {
    const [items, setItems] = useState<PayoutItem[]>([]);
    const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState("ALL");
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);

    // Modal state
    const [modal, setModal] = useState<{ payoutId: number; action: string } | null>(null);
    const [reason, setReason] = useState("");
    const [refNumber, setRefNumber] = useState("");
    const [saving, setSaving] = useState(false);

    const load = useCallback(async (p: number, status: string, q: string) => {
        try {
            setLoading(true);
            const params = new URLSearchParams();
            params.set("page", String(p));
            params.set("limit", "20");
            if (status !== "ALL") params.set("status", status);
            if (q.trim()) params.set("search", q.trim());
            const res = await fetch(`/api/admin/affiliate/payouts?${params.toString()}`, { cache: "no-store" });
            const data = await res.json();
            if (!res.ok) { toast.error(data.message); return; }
            setItems(data.data?.items ?? []);
            setPagination(data.data?.pagination ?? { page: 1, limit: 20, total: 0, totalPages: 0 });
        } catch { toast.error("Gagal memuat data."); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { load(page, statusFilter, search); }, [page, load]);

    function handleSearch(e: React.FormEvent) { e.preventDefault(); setPage(1); load(1, statusFilter, search); }
    function handleStatus(v: string) { setStatusFilter(v); setPage(1); load(1, v, search); }

    async function handleAction() {
        if (!modal) return;
        try {
            setSaving(true);
            const body: any = { action: modal.action };
            if (modal.action === "REJECT") body.reason = reason.trim();
            if (modal.action === "CONFIRM_PAID" && refNumber.trim()) body.proofFilePath = refNumber.trim();
            const res = await fetch(`/api/admin/affiliate/payouts/${modal.payoutId}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            const r = await res.json();
            if (!res.ok) { toast.error(r.message); return; }
            toast.success(r.message);
            setModal(null); setReason(""); setRefNumber("");
            load(page, statusFilter, search);
        } catch { toast.error("Gagal memproses."); }
        finally { setSaving(false); }
    }

    function closeModal() {
        setModal(null);
        setReason("");
        setRefNumber("");
    }

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Affiliate"
                title="Payout Management"
                description="Kelola permintaan pencairan komisi affiliate."
            />

            <SectionCard
                title="Permintaan Payout"
                description={`Menampilkan ${items.length} dari ${pagination.total} payout`}
            >
                <Stack gap="md">
                    <Group gap="sm" align="flex-end" wrap="wrap">
                        <form onSubmit={handleSearch}>
                            <TextInput
                                size="md"
                                radius="md"
                                value={search}
                                onChange={(e) => setSearch(e.currentTarget.value)}
                                placeholder="Cari nama, kode, rekening..."
                                aria-label="Cari payout"
                                leftSection={<FiSearch size={14} />}
                                w={{ base: 200, sm: 260 }}
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
                                { value: "PENDING", label: "Pending" },
                                { value: "PROCESSING", label: "Processing" },
                                { value: "PAID", label: "Paid" },
                                { value: "FAILED", label: "Failed" },
                                { value: "REJECTED", label: "Rejected" },
                                { value: "CANCELLED", label: "Cancelled" },
                            ]}
                        />
                    </Group>

                    <DataTable
                        minWidth={1000}
                        loading={loading}
                        empty={
                            <EmptyBlock
                                title="Belum ada payout request."
                                description="Permintaan pencairan komisi affiliator akan muncul di sini."
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
                            { header: "Jumlah" },
                            { header: "Bank" },
                            { header: "Rekening" },
                            { header: "Status" },
                            { header: "Tanggal" },
                            { header: "Aksi", align: "right" },
                        ]}
                        rows={items.map((p) => ({
                            key: String(p.id),
                            cells: [
                                <Stack gap={0} key="affiliator">
                                    <Text size="sm" fw={500}>
                                        {p.affiliateName}
                                    </Text>

                                    <Text size="xs" c="dimmed" ff="monospace">
                                        {p.affiliateCode}
                                    </Text>
                                </Stack>,

                                <Text key="amount" size="sm" fw={600}>
                                    {rupiah(p.amount)}
                                </Text>,

                                <Text key="bank" size="sm">
                                    {p.bankName}
                                </Text>,

                                <Text key="account" size="sm" ff="monospace">
                                    {p.bankAccountNumber}
                                </Text>,

                                <Stack gap={2} key="status">
                                    <StatusBadge tone={statusTone[p.status] ?? "neutral"}>
                                        {statusLabel[p.status] || p.status}
                                    </StatusBadge>

                                    {p.rejectionReason ? (
                                        <Text size="xs" c="red.7">
                                            {p.rejectionReason}
                                        </Text>
                                    ) : null}
                                </Stack>,

                                <Text key="date" size="sm" c="dimmed">
                                    {fmtDate(p.requestedAt)}
                                </Text>,

                                <Group justify="flex-end" gap="xs" wrap="nowrap" key="actions">
                                    {p.status === "PENDING" && (
                                        <>
                                            <Button
                                                size="compact-sm"
                                                radius="md"
                                                color="green"
                                                variant="light"
                                                leftSection={<FiCheck size={10} />}
                                                onClick={() => setModal({ payoutId: p.id, action: "APPROVE" })}
                                            >
                                                Approve &amp; Process
                                            </Button>

                                            <Button
                                                size="compact-sm"
                                                radius="md"
                                                color="red"
                                                variant="light"
                                                leftSection={<FiX size={10} />}
                                                onClick={() => setModal({ payoutId: p.id, action: "REJECT" })}
                                            >
                                                Reject
                                            </Button>
                                        </>
                                    )}

                                    {p.status === "PROCESSING" && (
                                        <>
                                            <Button
                                                size="compact-sm"
                                                radius="md"
                                                color="blue"
                                                variant="light"
                                                leftSection={<FiCheck size={10} />}
                                                onClick={() => setModal({ payoutId: p.id, action: "STATUS" })}
                                            >
                                                Check Status
                                            </Button>

                                            <Button
                                                size="compact-sm"
                                                radius="md"
                                                color="green"
                                                variant="light"
                                                leftSection={<FiCheck size={10} />}
                                                onClick={() => setModal({ payoutId: p.id, action: "CONFIRM_PAID" })}
                                            >
                                                Confirm Paid
                                            </Button>
                                        </>
                                    )}

                                    {p.status === "PAID" && (
                                        <Button
                                            size="compact-sm"
                                            radius="md"
                                            color="ink"
                                            variant="light"
                                            leftSection={<FiCheck size={10} />}
                                            onClick={() => setModal({ payoutId: p.id, action: "SETTLE" })}
                                        >
                                            Settle
                                        </Button>
                                    )}
                                </Group>,
                            ],
                        }))}
                    />
                </Stack>
            </SectionCard>

            {/* Action Modal */}

            <Modal
                opened={modal !== null}
                onClose={closeModal}
                centered
                title={
                    modal?.action === "APPROVE" ? "Approve & Process Payout"
                    : modal?.action === "REJECT" ? "Reject Payout"
                    : modal?.action === "STATUS" ? "Check Provider Status"
                    : modal?.action === "CONFIRM_PAID" ? "Confirm Payment Success"
                    : "Retry Settlement"
                }
            >
                <Stack gap="md">
                    {modal?.action === "REJECT" && (
                        <Textarea
                            label="Alasan Penolakan *"
                            size="md"
                            radius="md"
                            minRows={3}
                            maxRows={6}
                            autosize
                            value={reason}
                            onChange={(e) => setReason(e.currentTarget.value)}
                            placeholder="Contoh: Data rekening tidak valid..."
                        />
                    )}

                    {modal?.action === "APPROVE" && (
                        <Text size="sm">
                            Konfirmasi approve payout ini? Dana akan dikirim ke rekening affiliator melalui payment provider.
                        </Text>
                    )}

                    {modal?.action === "CONFIRM_PAID" && (
                        <Stack gap="sm">
                            <Text size="sm">
                                Konfirmasi bahwa pembayaran sudah berhasil? Payout akan berubah ke status PAID dan komisi akan di-settle.
                            </Text>

                            <TextInput
                                label="Bukti Pembayaran (opsional)"
                                description="Path file bukti transfer (jika ada)"
                                size="md"
                                radius="md"
                                value={refNumber}
                                onChange={(e) => setRefNumber(e.currentTarget.value)}
                                placeholder="storage/uploads/affiliate/payout-proof/..."
                            />
                        </Stack>
                    )}

                    {modal?.action === "STATUS" && (
                        <Text size="sm">
                            Cek status payout ini dengan provider? Jika provider mengkonfirmasi success, payout akan otomatis menjadi PAID.
                        </Text>
                    )}

                    {modal?.action === "SETTLE" && (
                        <Text size="sm">
                            Retry commission settlement? Ini tidak mengirim uang lagi, hanya menyelesaikan pencatatan commission.
                        </Text>
                    )}

                    <Group grow gap="sm" mt="xs">
                        <Button
                            variant="default"
                            size="md"
                            radius="md"
                            onClick={closeModal}
                        >
                            Batal
                        </Button>

                        <Button
                            size="md"
                            radius="md"
                            color={
                                modal?.action === "APPROVE" || modal?.action === "CONFIRM_PAID"
                                    ? "green"
                                    : modal?.action === "STATUS"
                                      ? "blue"
                                      : modal?.action === "SETTLE"
                                        ? "ink"
                                        : "red"
                            }
                            onClick={handleAction}
                            disabled={saving || (modal?.action === "REJECT" && !reason.trim())}
                        >
                            {saving
                                ? "Memproses..."
                                : modal?.action === "APPROVE"
                                  ? "Approve & Process"
                                  : modal?.action === "STATUS"
                                    ? "Check Status"
                                    : modal?.action === "CONFIRM_PAID"
                                      ? "Confirm Paid"
                                      : modal?.action === "SETTLE"
                                        ? "Retry Settlement"
                                        : "Reject"}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
}
