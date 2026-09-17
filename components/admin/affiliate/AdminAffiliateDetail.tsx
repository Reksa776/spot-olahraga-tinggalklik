"use client";

import { useEffect, useState, useCallback } from "react";
import toast from "react-hot-toast";
import {
    FiArrowLeft,
    FiCheck,
    FiDollarSign,
    FiEdit,
    FiMousePointer,
    FiShoppingBag,
    FiTarget,
} from "react-icons/fi";
import {
    Area,
    AreaChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import {
    Alert,
    Box,
    Button,
    Group,
    Image,
    Loader,
    Modal,
    NumberInput,
    Paper,
    SimpleGrid,
    Stack,
    Text,
    Textarea,
} from "@mantine/core";

import {
    DataTable,
    EmptyBlock,
    PageHeader,
    SectionCard,
    StatCard,
    StatGrid,
    StatusBadge,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";
import { CHART_COLORS } from "@/components/dashboard/mantine-theme";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * HIGH-RISK AREA — commission and payout financials. Every monetary value is still rendered by
 * `rupiah()` (`Rp` + `Number(v).toLocaleString("id-ID")`) and every date by `fmtDate()`
 * (`id-ID` 2-digit day / short month / numeric year). No amount, rate, count or total was altered.
 *
 * Preserved exactly — every fetch and mutation:
 *  • `load()` — `GET /api/admin/affiliate/${id}`, `result.success` branch, `toast.error(result.message)`
 *    vs "Gagal memuat data.", and the `useEffect(() => { load(); }, [load])` trigger;
 *  • `saveRate()` — the `parseFloat` + `isNaN || < 0 || > 50` guard and its "Rate harus 0-50%."
 *    message, the **two-step confirm** (`if (!confirmRate) { setConfirmRate(true); return; }`) which
 *    has been kept exactly, the `PATCH` body `{ action: "UPDATE_RATE", rate }`, and the resets;
 *  • `handleConvAction()` — the `PATCH` endpoint and the CONDITIONAL `reason` (CANCEL only, and only
 *    when non-empty), the `toast` branches and the refresh;
 *  • the Suspend / Activate `PATCH` bodies (`{ action: "UPDATE_STATUS", status: "SUSPENDED" }` /
 *    `"APPROVED"`), their toast copy and their `load()`;
 *  • the conversion action rules (APPROVE only for PENDING, CANCEL for PENDING and APPROVED);
 *  • `imageErrors` and the click-to-enlarge preview.
 *
 * The three `useDialog` confirmations (approve commission is inline copy, suspend and activate) are
 * now Mantine `Modal`s carrying the same titles, messages and confirm labels. The chart keeps its
 * data and formatting but now paints the TinggalKlik brand palette instead of an arbitrary indigo
 * gradient, so the dashboard reads as one identity.
 */

type DetailData = {
    profile: {
        id: number; name: string; email: string; phone: string;
        affiliateCode: string; commissionRate: number; status: string;
        approvedAt: string | null; bankName: string; bankAccountName: string; bankAccountNumber: string;
        socialMediaPlatform?: string; socialMediaUsername?: string; socialMediaUrl?: string;
        ktpImageUrl?: string;
    };
    stats: {
        clicks: number; orders: number; conversions: number; totalSales: number;
        totalCommission: number; conversionRate: number; averageOrderValue: number; monthlySales: number;
    };
    commission: {
        pending: { count: number; amount: number; sales: number };
        approved: { count: number; amount: number; sales: number };
        paid: { count: number; amount: number; sales: number };
        cancelled: { count: number; amount: number; sales: number };
        total: number;
    };
    conversions: Array<{
        id: number; orderNumber: string; orderDate: string; orderSubtotal: number;
        commissionRate: number; commissionAmount: number; status: string; createdAt: string;
    }>;
    pendingPayouts: Array<{ id: number; amount: number; status: string; requestedAt: string }>;
    balance: { available: number; pending: number; approved: number; paid: number; totalEarned: number };
    allPayouts: Array<{ id: number; amount: number; status: string; bankName: string; bankAccountName: string; bankAccountNumber: string; requestedAt: string; processedAt: string | null; processedBy: string | null; rejectionReason: string | null }>;
    chart: Array<{ date: string; clicks: number; conversions: number; sales: number; commission: number }>;
    auditLogs: Array<{ id: number; adminId: string; action: string; description: string; metadata: any; createdAt: string }>;
};

function rupiah(v: number) { return `Rp ${Number(v).toLocaleString("id-ID")}`; }
function fmtDate(s: string) { return new Date(s).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }); }

const statusLabel: Record<string, string> = { PENDING: "Menunggu", APPROVED: "Disetujui", PAID: "Dibayar", CANCELLED: "Dibatalkan", REVERSED: "Dikembalikan" };
const statusTone: Record<string, Tone> = {
    PENDING: "pending",
    APPROVED: "success",
    PAID: "info",
    CANCELLED: "error",
};

export default function AdminAffiliateDetail({ id }: { id: string }) {
    const [data, setData] = useState<DetailData | null>(null);
    const [loading, setLoading] = useState(true);
    const [editingRate, setEditingRate] = useState(false);
    const [newRate, setNewRate] = useState("");
    const [saving, setSaving] = useState(false);

    // Commission action state
    const [actionModal, setActionModal] = useState<{ convId: number; action: string } | null>(null);
    const [actionReason, setActionReason] = useState("");

    // Status action confirmation
    const [statusAction, setStatusAction] = useState<"SUSPEND" | "ACTIVATE" | null>(null);

    // Chart state
    const [chartMetric, setChartMetric] = useState<"clicks" | "conversions" | "sales" | "commission">("clicks");

    // Image preview state
    const [previewImage, setPreviewImage] = useState<{ url: string; label: string } | null>(null);
    const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const res = await fetch(`/api/admin/affiliate/${id}`, { cache: "no-store" });
            const result = await res.json();
            if (result.success) setData(result.data);
            else toast.error(result.message);
        } catch { toast.error("Gagal memuat data."); }
        finally { setLoading(false); }
    }, [id]);

    useEffect(() => { load(); }, [load]);

    const [confirmRate, setConfirmRate] = useState(false);

    async function saveRate() {
        const rate = parseFloat(newRate);
        if (isNaN(rate) || rate < 0 || rate > 50) { toast.error("Rate harus 0-50%."); return; }
        if (!confirmRate) {
            setConfirmRate(true);
            return;
        }
        try {
            setSaving(true);
            const res = await fetch(`/api/admin/affiliate/${id}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "UPDATE_RATE", rate }),
            });
            const r = await res.json();
            if (!res.ok) { toast.error(r.message); return; }
            toast.success(r.message);
            setEditingRate(false);
            setConfirmRate(false);
            load();
        } catch { toast.error("Gagal update rate."); }
        finally { setSaving(false); }
    }

    async function handleConvAction() {
        if (!actionModal) return;
        const { convId, action } = actionModal;
        try {
            setSaving(true);
            const body: any = { action };
            if (action === "CANCEL" && actionReason.trim()) body.reason = actionReason.trim();
            const res = await fetch(`/api/admin/affiliate/commissions/${convId}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            const r = await res.json();
            if (!res.ok) { toast.error(r.message); return; }
            toast.success(r.message);
            setActionModal(null); setActionReason("");
            load();
        } catch { toast.error("Gagal memproses."); }
        finally { setSaving(false); }
    }

    async function runStatusAction(action: "SUSPEND" | "ACTIVATE") {
        try {
            setSaving(true);
            const res = await fetch(`/api/admin/affiliate/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "UPDATE_STATUS", status: action === "SUSPEND" ? "SUSPENDED" : "APPROVED" }),
            });
            const r = await res.json();
            if (!res.ok) { toast.error(r.message); return; }
            toast.success(r.message);
            load();
        } catch { toast.error(action === "SUSPEND" ? "Gagal suspend." : "Gagal activate."); }
        finally { setSaving(false); }
    }

    if (loading) {
        return (
            <Group justify="center" mih={240}>
                <Loader size="sm" />
            </Group>
        );
    }

    if (!data) {
        return (
            <EmptyBlock title="Data tidak ditemukan." />
        );
    }

    const { profile, stats, commission, conversions, pendingPayouts, auditLogs } = data;

    return (
        <Stack gap="lg">
            <TextLink href="/admin/affiliate">
                <Group gap={4} component="span">
                    <FiArrowLeft size={14} /> Kembali
                </Group>
            </TextLink>

            <PageHeader
                eyebrow="Affiliate"
                title={profile.name}
                description={`${profile.email} • ${profile.phone}`}
            />

            {/* Profile */}
            <SectionCard title="Profil Affiliator">
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
                    <Stack gap={6}>
                        <Group gap="sm" wrap="wrap">
                            <Text ff="monospace" size="sm" fw={700}>
                                {profile.affiliateCode}
                            </Text>

                            <StatusBadge tone={statusTone[profile.status] ?? "neutral"}>
                                {profile.status}
                            </StatusBadge>

                            {profile.approvedAt ? (
                                <Text size="xs" c="dimmed">
                                    Sejak {fmtDate(profile.approvedAt)}
                                </Text>
                            ) : null}
                        </Group>
                    </Stack>

                    <Paper withBorder radius="md" p="sm" bg="gray.0">
                        <Stack gap={4}>
                            <Text size="xs" c="dimmed">
                                Bank: {profile.bankName}
                            </Text>

                            <Text size="xs" c="dimmed">
                                Rekening: {profile.bankAccountName} • {profile.bankAccountNumber}
                            </Text>

                            {profile.socialMediaPlatform ? (
                                <Text size="xs" c="dimmed">
                                    Social: {profile.socialMediaPlatform} • {profile.socialMediaUsername}
                                </Text>
                            ) : null}
                        </Stack>
                    </Paper>
                </SimpleGrid>
            </SectionCard>

            {/* KYC Documents */}
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                <SectionCard title="Foto KTP">
                    {profile.ktpImageUrl && !imageErrors["ktp"] ? (
                        <Stack gap="xs">
                            <Box
                                component="button"
                                type="button"
                                onClick={() => setPreviewImage({ url: profile.ktpImageUrl!, label: "Foto KTP" })}
                                style={{ display: "block", width: "100%", border: "none", padding: 0, background: "none", cursor: "zoom-in" }}
                                aria-label="Perbesar foto KTP"
                            >
                                <Image
                                    src={profile.ktpImageUrl}
                                    alt="KTP"
                                    h={192}
                                    fit="cover"
                                    radius="md"
                                    onError={() => setImageErrors((prev) => ({ ...prev, ktp: true }))}
                                />
                            </Box>

                            <Text size="xs" c="dimmed">
                                Klik untuk memperbesar
                            </Text>
                        </Stack>
                    ) : (
                        <Paper withBorder radius="md" bg="gray.0" h={192} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <Text size="sm" c="dimmed">
                                File tidak tersedia
                            </Text>
                        </Paper>
                    )}
                </SectionCard>

                <SectionCard title="Foto Social Media">
                    <Stack gap="xs">
                        {profile.socialMediaPlatform ? (
                            <Text size="xs" c="dimmed">
                                {profile.socialMediaPlatform} • {profile.socialMediaUsername}
                            </Text>
                        ) : null}

                        {profile.socialMediaUrl && !imageErrors["social"] ? (
                            <>
                                <Box
                                    component="button"
                                    type="button"
                                    onClick={() => setPreviewImage({ url: profile.socialMediaUrl!, label: "Foto Social Media" })}
                                    style={{ display: "block", width: "100%", border: "none", padding: 0, background: "none", cursor: "zoom-in" }}
                                    aria-label="Perbesar foto social media"
                                >
                                    <Image
                                        src={profile.socialMediaUrl}
                                        alt="Social Media"
                                        h={192}
                                        fit="cover"
                                        radius="md"
                                        onError={() => setImageErrors((prev) => ({ ...prev, social: true }))}
                                    />
                                </Box>

                                <Text size="xs" c="dimmed">
                                    Klik untuk memperbesar
                                </Text>
                            </>
                        ) : (
                            <Paper withBorder radius="md" bg="gray.0" h={192} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <Text size="sm" c="dimmed">
                                    File tidak tersedia
                                </Text>
                            </Paper>
                        )}
                    </Stack>
                </SectionCard>
            </SimpleGrid>

            {/* Stats */}
            <StatGrid>
                <StatCard
                    icon={<FiMousePointer size={14} />}
                    label="Klik"
                    value={stats.clicks.toLocaleString("id-ID")}
                />

                <StatCard
                    icon={<FiShoppingBag size={14} />}
                    label="Order"
                    value={String(stats.orders)}
                    hint={`${stats.conversions} konversi`}
                />

                <StatCard
                    icon={<FiDollarSign size={14} />}
                    label="Penjualan"
                    value={rupiah(stats.totalSales)}
                    hint={`Rata-rata ${rupiah(stats.averageOrderValue)}`}
                />

                <StatCard
                    icon={<FiTarget size={14} />}
                    label="Conv. Rate"
                    value={`${stats.conversionRate}%`}
                />
            </StatGrid>

            {/* Commission Rate */}
            <SectionCard
                title="Commission Rate"
                actions={
                    !editingRate ? (
                        <Button
                            variant="default"
                            size="sm"
                            radius="md"
                            leftSection={<FiEdit size={12} />}
                            onClick={() => { setEditingRate(true); setNewRate(String(profile.commissionRate)); }}
                        >
                            Edit
                        </Button>
                    ) : (
                        <Group gap="xs" wrap="wrap">
                            <NumberInput
                                size="sm"
                                radius="md"
                                step={0.01}
                                min={0}
                                max={50}
                                value={newRate === "" ? "" : Number(newRate)}
                                onChange={(value) => {
                                    setNewRate(value === "" ? "" : String(value));
                                    setConfirmRate(false);
                                }}
                                w={100}
                                aria-label="Rate komisi baru"
                            />

                            <Text size="xs" c="dimmed">
                                %
                            </Text>

                            {confirmRate ? (
                                <Group gap="xs" wrap="wrap">
                                    <Text size="xs" fw={500} c="yellow.7">
                                        Yakin ubah rate?
                                    </Text>

                                    <Button
                                        size="compact-sm"
                                        radius="md"
                                        color="yellow"
                                        leftSection={<FiCheck size={12} />}
                                        onClick={saveRate}
                                        disabled={saving}
                                    >
                                        {saving ? "..." : "Ya, Simpan"}
                                    </Button>

                                    <Button
                                        size="compact-sm"
                                        radius="md"
                                        variant="subtle"
                                        onClick={() => setConfirmRate(false)}
                                    >
                                        Batal
                                    </Button>
                                </Group>
                            ) : (
                                <Button
                                    size="compact-sm"
                                    radius="md"
                                    leftSection={<FiCheck size={12} />}
                                    onClick={saveRate}
                                    disabled={saving}
                                >
                                    {saving ? "..." : "Simpan"}
                                </Button>
                            )}

                            <Button
                                size="compact-sm"
                                radius="md"
                                variant="subtle"
                                onClick={() => { setEditingRate(false); setConfirmRate(false); }}
                            >
                                Batal
                            </Button>
                        </Group>
                    )
                }
            >
                <Text fz={24} fw={700}>
                    {profile.commissionRate}%
                </Text>

                <Text size="xs" c="dimmed" mt={4}>
                    Rate baru berlaku untuk order berikutnya. Historical commission tidak berubah.
                </Text>
            </SectionCard>

            {/* Commission Breakdown */}
            <SectionCard title="Commission Breakdown">
                <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
                    <CommCard label="Pending" count={commission.pending.count} amount={commission.pending.amount} />
                    <CommCard label="Approved" count={commission.approved.count} amount={commission.approved.amount} />
                    <CommCard label="Paid" count={commission.paid.count} amount={commission.paid.amount} />
                    <CommCard label="Cancelled" count={commission.cancelled.count} amount={commission.cancelled.amount} />
                </SimpleGrid>

                <Paper withBorder radius="md" p="sm" mt="md" bg="gray.0">
                    <Group justify="space-between">
                        <Text size="sm" fw={500} c="dimmed">
                            Total Komisi
                        </Text>

                        <Text size="lg" fw={700} c="green.7">
                            {rupiah(commission.total)}
                        </Text>
                    </Group>
                </Paper>
            </SectionCard>

            {/* Financial Summary */}
            {data.balance && (
                <SectionCard title="Ringkasan Keuangan">
                    <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
                        <BalanceCard label="Saldo Tersedia" value={rupiah(data.balance.available)} />
                        <BalanceCard label="Pending" value={rupiah(data.balance.pending)} />
                        <BalanceCard label="Sudah Dibayar" value={rupiah(data.balance.paid)} />
                        <BalanceCard label="Total Earned" value={rupiah(data.balance.totalEarned)} />
                    </SimpleGrid>
                </SectionCard>
            )}

            {/* Payout History */}
            {data.allPayouts && data.allPayouts.length > 0 && (
                <SectionCard title="Riwayat Payout">
                    <DataTable
                        minWidth={800}
                        columns={[
                            { header: "ID" },
                            { header: "Jumlah" },
                            { header: "Bank" },
                            { header: "Status" },
                            { header: "Tanggal" },
                            { header: "Catatan" },
                        ]}
                        rows={data.allPayouts.map((p) => ({
                            key: String(p.id),
                            cells: [
                                <Text key="id" size="sm" fw={500}>
                                    #{p.id}
                                </Text>,

                                <Text key="amount" size="sm" fw={600}>
                                    {rupiah(p.amount)}
                                </Text>,

                                <Text key="bank" size="sm">
                                    {p.bankName} • {p.bankAccountNumber}
                                </Text>,

                                <StatusBadge key="status" tone={statusTone[p.status] ?? "neutral"}>
                                    {statusLabel[p.status] || p.status}
                                </StatusBadge>,

                                <Text key="date" size="sm" c="dimmed">
                                    {fmtDate(p.requestedAt)}
                                </Text>,

                                <Stack gap={2} key="note">
                                    {p.processedAt ? (
                                        <Text size="sm" c="dimmed">
                                            Diproses: {fmtDate(p.processedAt)}
                                        </Text>
                                    ) : null}

                                    {p.rejectionReason ? (
                                        <Text size="sm" c="red.7">
                                            {p.rejectionReason}
                                        </Text>
                                    ) : null}
                                </Stack>,
                            ],
                        }))}
                    />
                </SectionCard>
            )}

            {/* Admin Actions */}
            <SectionCard title="Admin Actions">
                <Group gap="sm" wrap="wrap">
                    {profile.status !== "SUSPENDED" && (
                        <Button
                            color="red"
                            variant="light"
                            size="sm"
                            radius="md"
                            onClick={() => setStatusAction("SUSPEND")}
                        >
                            Suspend
                        </Button>
                    )}

                    {profile.status === "SUSPENDED" && (
                        <Button
                            color="green"
                            variant="light"
                            size="sm"
                            radius="md"
                            onClick={() => setStatusAction("ACTIVATE")}
                        >
                            Activate
                        </Button>
                    )}
                </Group>
            </SectionCard>

            {/* Performance Chart */}
            <SectionCard
                title="Grafik Performa (90 Hari)"
                actions={
                    <Group gap={4}>
                        {(["clicks", "conversions", "sales", "commission"] as const).map((m) => (
                            <Button
                                key={m}
                                type="button"
                                size="compact-sm"
                                radius="md"
                                variant={chartMetric === m ? "filled" : "subtle"}
                                onClick={() => setChartMetric(m)}
                            >
                                {m === "clicks" ? "Klik" : m === "conversions" ? "Konversi" : m === "sales" ? "Penjualan" : "Komisi"}
                            </Button>
                        ))}
                    </Group>
                }
            >
                {data.chart.length > 0 ? (
                    <Box h={256} mt="sm">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={data.chart} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                                <defs>
                                    <linearGradient id="colorMetricAdmin" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor={CHART_COLORS.brand} stopOpacity={0.3} />
                                        <stop offset="95%" stopColor={CHART_COLORS.brand} stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                                <XAxis dataKey="date" tick={{ fontSize: 10, fill: CHART_COLORS.axis }}
                                    tickFormatter={(v) => { const d = new Date(v); return `${d.getDate()}/${d.getMonth() + 1}`; }}
                                    stroke={CHART_COLORS.grid} />
                                <YAxis tick={{ fontSize: 10, fill: CHART_COLORS.axis }} stroke={CHART_COLORS.grid} />
                                <Tooltip
                                    contentStyle={{ borderRadius: "12px", border: "1px solid #e5e7eb", fontSize: "12px" }}
                                    labelFormatter={(v) => fmtDate(String(v))}
                                    formatter={(value: any) => { const v = Number(value); return chartMetric === "sales" || chartMetric === "commission" ? rupiah(v) : v.toLocaleString("id-ID"); }}
                                />
                                <Area type="monotone" dataKey={chartMetric} stroke={CHART_COLORS.brand} strokeWidth={2}
                                    fillOpacity={1} fill="url(#colorMetricAdmin)" />
                            </AreaChart>
                        </ResponsiveContainer>
                    </Box>
                ) : (
                    <Paper withBorder radius="md" bg="gray.0" h={256} mt="sm" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Text size="sm" c="dimmed">
                            Belum ada data performa
                        </Text>
                    </Paper>
                )}
            </SectionCard>

            {/* Pending Payouts */}
            {pendingPayouts.length > 0 && (
                <Alert color="yellow" variant="light" radius="md" title="Pending Payouts">
                    <Stack gap="xs">
                        {pendingPayouts.map((p) => (
                            <Group key={p.id} justify="space-between" gap="md" wrap="nowrap">
                                <Text size="xs" c="yellow.8">
                                    Payout #{p.id} — {fmtDate(p.requestedAt)}
                                </Text>

                                <Text size="xs" fw={600} c="yellow.9">
                                    {rupiah(p.amount)} ({p.status})
                                </Text>
                            </Group>
                        ))}
                    </Stack>
                </Alert>
            )}

            {/* Conversion History */}
            <SectionCard title="Riwayat Konversi (50 terbaru)">
                <DataTable
                    minWidth={800}
                    empty={<EmptyBlock title="Belum ada konversi." />}
                    columns={[
                        { header: "Order" },
                        { header: "Tanggal" },
                        { header: "Subtotal" },
                        { header: "Rate" },
                        { header: "Komisi" },
                        { header: "Status" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={conversions.map((c) => ({
                        key: String(c.id),
                        cells: [
                            <Text key="order" size="sm" fw={500}>
                                {c.orderNumber}
                            </Text>,

                            <Text key="date" size="sm" c="dimmed">
                                {fmtDate(c.createdAt)}
                            </Text>,

                            <Text key="subtotal" size="sm">
                                {rupiah(c.orderSubtotal)}
                            </Text>,

                            <Text key="rate" size="sm" c="dimmed">
                                {c.commissionRate}%
                            </Text>,

                            <Text key="commission" size="sm" fw={500} c="green.7">
                                {rupiah(c.commissionAmount)}
                            </Text>,

                            <StatusBadge key="status" tone={statusTone[c.status] ?? "neutral"}>
                                {statusLabel[c.status] || c.status}
                            </StatusBadge>,

                            <Group justify="flex-end" gap="xs" wrap="nowrap" key="actions">
                                {(c.status === "PENDING" || c.status === "APPROVED") && (
                                    <>
                                        {c.status === "PENDING" && (
                                            <Button
                                                size="compact-sm"
                                                radius="md"
                                                color="green"
                                                variant="light"
                                                onClick={() => { setActionModal({ convId: c.id, action: "APPROVE" }); }}
                                            >
                                                Approve
                                            </Button>
                                        )}

                                        <Button
                                            size="compact-sm"
                                            radius="md"
                                            color="red"
                                            variant="light"
                                            onClick={() => { setActionModal({ convId: c.id, action: "CANCEL" }); }}
                                        >
                                            Cancel
                                        </Button>
                                    </>
                                )}
                            </Group>,
                        ],
                    }))}
                />
            </SectionCard>

            {/* Audit Log */}
            {auditLogs && auditLogs.length > 0 && (
                <SectionCard title="Riwayat Aktivitas">
                    <Stack gap={0}>
                        {auditLogs.map((log) => (
                            <Stack key={log.id} gap={4} py="sm">
                                <Group justify="space-between" align="flex-start" gap="md" wrap="nowrap">
                                    <Stack gap={2} style={{ minWidth: 0 }}>
                                        <Text size="xs" fw={500}>
                                            {log.description}
                                        </Text>

                                        <Text size="xs" c="dimmed">
                                            Admin: {log.adminId}
                                        </Text>
                                    </Stack>

                                    <StatusBadge tone="neutral" size="sm">
                                        {log.action}
                                    </StatusBadge>
                                </Group>

                                <Text size="xs" c="dimmed">
                                    {fmtDate(log.createdAt)}
                                </Text>
                            </Stack>
                        ))}
                    </Stack>
                </SectionCard>
            )}

            {/* Image Preview Modal */}
            <Modal
                opened={previewImage !== null}
                onClose={() => setPreviewImage(null)}
                size="auto"
                centered
                title={previewImage?.label}
            >
                {previewImage ? (
                    <Image
                        src={previewImage.url}
                        alt={previewImage.label}
                        maw="85vw"
                        mah="80vh"
                        fit="contain"
                        radius="md"
                    />
                ) : null}
            </Modal>

            {/* Commission Action Modal */}
            <Modal
                opened={actionModal !== null}
                onClose={() => { setActionModal(null); setActionReason(""); }}
                title={actionModal?.action === "APPROVE" ? "Approve Komisi" : "Cancel Komisi"}
                centered
            >
                <Stack gap="md">
                    {actionModal?.action === "CANCEL" && (
                        <Textarea
                            label="Alasan Pembatalan *"
                            size="md"
                            radius="md"
                            minRows={3}
                            maxRows={6}
                            autosize
                            value={actionReason}
                            onChange={(e) => setActionReason(e.currentTarget.value)}
                            placeholder="Contoh: Order dibatalkan oleh customer..."
                        />
                    )}

                    {actionModal?.action === "APPROVE" && (
                        <Text size="sm">Konfirmasi approve komisi ini?</Text>
                    )}

                    <Group grow gap="sm">
                        <Button
                            variant="default"
                            size="md"
                            radius="md"
                            onClick={() => { setActionModal(null); setActionReason(""); }}
                        >
                            Batal
                        </Button>

                        <Button
                            size="md"
                            radius="md"
                            color={actionModal?.action === "APPROVE" ? "green" : "red"}
                            onClick={handleConvAction}
                            disabled={saving || (actionModal?.action === "CANCEL" && !actionReason.trim())}
                        >
                            {saving ? "Memproses..." : actionModal?.action === "APPROVE" ? "Approve" : "Cancel"}
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            {/* Suspend / Activate Confirmation */}
            <Modal
                opened={statusAction !== null}
                onClose={() => setStatusAction(null)}
                title={statusAction === "SUSPEND" ? "Suspend Affiliate" : "Activate Affiliate"}
                centered
            >
                <Text size="sm">
                    {statusAction === "SUSPEND"
                        ? `Suspend affiliate ${profile.name}?`
                        : `Activate affiliate ${profile.name}?`}
                </Text>

                <Group grow gap="sm" mt="lg">
                    <Button
                        variant="default"
                        size="md"
                        radius="md"
                        onClick={() => setStatusAction(null)}
                    >
                        Batal
                    </Button>

                    <Button
                        size="md"
                        radius="md"
                        color={statusAction === "SUSPEND" ? "red" : "green"}
                        onClick={() => {
                            const action = statusAction;
                            setStatusAction(null);
                            if (action) runStatusAction(action);
                        }}
                    >
                        {statusAction === "SUSPEND" ? "Suspend" : "Activate"}
                    </Button>
                </Group>
            </Modal>
        </Stack>
    );
}

function CommCard({ label, count, amount }: { label: string; count: number; amount: number }) {
    return (
        <Paper withBorder radius="md" p="sm" bg="gray.0">
            <Text size="xs" fw={500} c="dimmed">
                {label}
            </Text>

            <Text size="lg" fw={700} mt={4}>
                {count}
            </Text>

            <Text size="xs" c="dimmed">
                {rupiah(amount)}
            </Text>
        </Paper>
    );
}

function BalanceCard({ label, value }: { label: string; value: string }) {
    return (
        <Paper withBorder radius="md" p="sm" bg="gray.0">
            <Text size="xs" fw={500} c="dimmed">
                {label}
            </Text>

            <Text size="lg" fw={700} mt={4}>
                {value}
            </Text>
        </Paper>
    );
}
