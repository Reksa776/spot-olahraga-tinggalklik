"use client";

import { OrderItem } from "@prisma/client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";

import {
    Alert,
    Box,
    Button,
    Card,
    Grid,
    Group,
    Modal,
    Select,
    Skeleton,
    Stack,
    Text,
    Textarea,
    TextInput,
} from "@mantine/core";

import {
    ErrorBlock,
    PageHeader,
    SectionCard,
    StatusBadge,
    type Tone,
} from "@/components/dashboard/primitives";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * This is the most mutation-dense page in the admin area, so the handlers are untouched.
 * Preserved exactly: `loadOrder`, `loadTracking` (same endpoint, same response mapping into
 * `summary`/`details`/`deliveryStatus`/`manifest`, same `console.log`, same error toast), the
 * effect that triggers tracking on `order?.id`/`order?.trackingNumber`, `saveOrder`'s
 * "SHIPPED requires a resi" guard and its `PATCH` body (`status` + trimmed `trackingNumber`),
 * both refund branches (`approve` and `reject` with `reason || "Ditolak oleh admin"`) against
 * `/api/admin/orders/{id}/refund`, the `then-loadOrder` refresh, the loading skeleton, the
 * "Pesanan tidak ditemukan" state, `statuses`, `statusLabel` and `rupiah`.
 *
 * The one interaction that changed shape: the reject reason came from the shared `useDialog`
 * `prompt` helper, which belongs to the customer graph, so it is now a Mantine `Modal` with a
 * `Textarea`. The helper's `required: true` is preserved by disabling the confirm button while the
 * reason is empty, and cancelling still performs no request.
 */

type Order = {
    id: number;
    orderNumber: string;

    recipientName: string;
    phone: string;
    address: string;

    note: string | null;

    city: string | null;
    district: string | null;
    province: string | null;
    postalCode: string | null;

    latitude: number | null;
    longitude: number | null;

    shippingCourier: string | null;
    shippingService: string | null;

    trackingNumber: string | null;
    trackingUrl: string | null;
    paymentStatus: string;
    paidAt: string | null;

    subtotal: number;
    shippingCost: number;
    total: number;

    status: string;
    paymentMethod: string;

    createdAt: string;
    updatedAt: string;

    items: OrderItem[];
};

type TrackingManifest = {
    manifest_code: string;
    manifest_description: string;
    manifest_date: string;
    manifest_time: string;
    city_name: string;
    title: string;
};

type TrackingSummary = {
    courier_code: string;
    courier_name: string;
    waybill_number: string;
    service_code: string;
    waybill_date: string;
    shipper_name?: string;
    receiver_name?: string;
    origin: string;
    destination: string;
    status: string;
};

type TrackingDeliveryStatus = {
    status: string;
    pod_receiver?: string;
    pod_date?: string;
    pod_time?: string;
};

type TrackingData = {
    summary?: TrackingSummary;
    details?: unknown;
    deliveryStatus?: TrackingDeliveryStatus;
    manifest: TrackingManifest[];
};

const statuses = ["PENDING", "PAID", "PROCESSING", "SHIPPED", "COMPLETED", "CANCELLED"];

function statusLabel(status: string) {
    const labels: Record<string, string> = {
        PENDING: "Pending",
        PAID: "Dibayar",
        PROCESSING: "Diproses",
        SHIPPED: "Dikirim",
        COMPLETED: "Selesai",
        CANCELLED: "Dibatalkan",
    };

    return labels[status] ?? status;
}

function rupiah(value: number) {
    return `Rp ${Number(value).toLocaleString("id-ID")}`;
}

/**
 * The previous `getStatusStyle` returned three Tailwind tint strings. Re-expressed as the shared
 * semantic tones so a courier status reads the same as every other status in the dashboard:
 * DELIVERED → success, ON DELIVERY → warn, anything else → info. The order-status badge
 * deliberately does *not* use this: it goes through `orderStatusTone` below, because the order
 * lifecycle needs more than three buckets now that REFUND_PENDING and CANCELLED exist.
 */
function trackingTone(status: string): Tone {
    switch (status) {
        case "DELIVERED":
            return "success";

        case "ON DELIVERY":
            return "warn";

        default:
            return "info";
    }
}

function orderStatusTone(status: string): Tone {
    switch (status) {
        case "PAID":
            return "info";

        case "PROCESSING":
            return "brand";

        case "SHIPPED":
            return "pending";

        case "COMPLETED":
            return "success";

        case "CANCELLED":
            return "neutral";

        case "REFUND_PENDING":
            return "warn";

        default:
            return "neutral";
    }
}

export default function AdminOrderDetailPage() {
    const params = useParams();

    const [tracking, setTracking] = useState<TrackingData | null>(null);

    const [trackingLoading, setTrackingLoading] = useState(false);

    const id = Array.isArray(params.id) ? params.id[0] : params.id;

    const [order, setOrder] = useState<Order | null>(null);

    const [loading, setLoading] = useState(true);

    const [saving, setSaving] = useState(false);

    const [status, setStatus] = useState("");

    const [trackingNumber, setTrackingNumber] = useState("");

    const [rejectOpen, setRejectOpen] = useState(false);

    const [rejectReason, setRejectReason] = useState("");

    async function loadTracking() {
        if (!order?.id || !order.trackingNumber) {
            setTracking(null);
            return;
        }

        try {
            setTrackingLoading(true);

            const response = await fetch(`/api/admin/orders/${order.id}/tracking`, {
                method: "GET",
                cache: "no-store",
            });

            const result = await response.json();

            console.log("ADMIN TRACKING RESPONSE:", result);

            if (!response.ok || !result.success) {
                throw new Error(result.message ?? "Gagal mengambil tracking.");
            }

            setTracking({
                summary: result.data?.summary ?? undefined,

                details: result.data?.details ?? undefined,

                deliveryStatus: result.data?.deliveryStatus ?? undefined,

                manifest: Array.isArray(result.data?.manifest)
                    ? result.data.manifest
                    : [],
            });
        } catch (error) {
            console.error("ADMIN TRACKING ERROR:", error);

            setTracking(null);

            toast.error(
                error instanceof Error ? error.message : "Gagal mengambil tracking."
            );
        } finally {
            setTrackingLoading(false);
        }
    }

    useEffect(() => {
        if (order?.id && order.trackingNumber) {
            loadTracking();
        } else {
            setTracking(null);
        }
    }, [order?.id, order?.trackingNumber]);

    async function loadOrder() {
        try {
            const response = await fetch(`/api/admin/orders/${id}`, {
                cache: "no-store",
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message ?? "Gagal mengambil order.");
            }

            setOrder(result.data);

            setStatus(result.data.status);

            setTrackingNumber(result.data.trackingNumber ?? "");
        } catch (error) {
            console.error(error);

            toast.error(
                error instanceof Error ? error.message : "Gagal mengambil order."
            );
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (id) {
            loadOrder();
        }
    }, [id]);

    async function saveOrder() {
        if (status === "SHIPPED" && !trackingNumber.trim()) {
            toast.error("Nomor resi wajib diisi sebelum status Dikirim.");
            return;
        }

        try {
            setSaving(true);

            const response = await fetch(`/api/admin/orders/${id}`, {
                method: "PATCH",

                headers: {
                    "Content-Type": "application/json",
                },

                body: JSON.stringify({
                    status,
                    trackingNumber: trackingNumber.trim(),
                }),
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message ?? "Gagal memperbarui order.");
            }

            toast.success("Pesanan berhasil diperbarui.");

            await loadOrder();
        } catch (error) {
            console.error(error);

            toast.error(
                error instanceof Error ? error.message : "Gagal memperbarui order."
            );
        } finally {
            setSaving(false);
        }
    }

    async function approveRefund() {
        if (!order) return;

        try {
            const response = await fetch(`/api/admin/orders/${order.id}/refund`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ action: "approve" }),
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal menyetujui refund.");
            }

            toast.success("Refund disetujui.");
            await loadOrder();
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : "Gagal menyetujui refund."
            );
        }
    }

    async function rejectRefund() {
        const reason = rejectReason;
        setRejectOpen(false);

        if (!order) return;

        try {
            const response = await fetch(`/api/admin/orders/${order.id}/refund`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "reject",
                    reason: reason || "Ditolak oleh admin",
                }),
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal menolak refund.");
            }

            toast.success("Refund ditolak.");
            await loadOrder();
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : "Gagal menolak refund."
            );
        }
    }

    if (loading) {
        return (
            <Stack gap="lg">
                <Skeleton height={20} width={160} radius="sm" />
                <Skeleton height={92} radius="md" />

                <Grid gap="lg">
                    <Grid.Col span={{ base: 12, lg: 8 }}>
                        <Stack gap="lg">
                            <Skeleton height={210} radius="md" />
                            <Skeleton height={330} radius="md" />
                        </Stack>
                    </Grid.Col>

                    <Grid.Col span={{ base: 12, lg: 4 }}>
                        <Skeleton height={300} radius="md" />
                    </Grid.Col>
                </Grid>
            </Stack>
        );
    }

    if (!order) {
        return (
            <Stack gap="lg">
                <ErrorBlock
                    title="Pesanan tidak ditemukan"
                    message="Pesanan ini tidak ada atau tidak dapat diakses."
                    action={
                        <Button
                            component={Link}
                            href="/admin/orders"
                            variant="default"
                            size="md"
                            radius="md"
                        >
                            Kembali ke order
                        </Button>
                    }
                />
            </Stack>
        );
    }

    return (
        <Stack gap="lg">
            {/* HEADER */}

            <Box>
                <Button
                    component={Link}
                    href="/admin/orders"
                    variant="subtle"
                    size="compact-md"
                    radius="md"
                    px={0}
                    mb="sm"
                >
                    ← Kembali ke Orderan
                </Button>

                <PageHeader
                    title={
                        <Group gap="md" wrap="wrap">
                            <Text span inherit>
                                {order.orderNumber}
                            </Text>

                            <StatusBadge tone={orderStatusTone(order.status)} size="lg">
                                {statusLabel(order.status)}
                            </StatusBadge>
                        </Group>
                    }
                    description="Detail pesanan dan pengiriman"
                    actions={
                        <Box ta={{ base: "left", sm: "right" }} w="100%">
                            <Text size="xs" c="dimmed">
                                Total pesanan
                            </Text>

                            <Text size="lg" fw={600}>
                                {rupiah(order.total)}
                            </Text>
                        </Box>
                    }
                />
            </Box>

            <Grid gap="lg">
                {/* CONTENT */}

                <Grid.Col span={{ base: 12, lg: 8 }}>
                    <Stack gap="lg">
                        {/* CUSTOMER */}

                        <SectionCard title="Informasi Pembeli">
                            <Grid gap="md">
                                <Grid.Col span={{ base: 12, sm: 6 }}>
                                    <Text size="xs" c="dimmed">
                                        Penerima
                                    </Text>

                                    <Text size="sm" fw={500} mt={4}>
                                        {order.recipientName}
                                    </Text>
                                </Grid.Col>

                                <Grid.Col span={{ base: 12, sm: 6 }}>
                                    <Text size="xs" c="dimmed">
                                        Nomor Telepon
                                    </Text>

                                    <Text size="sm" fw={500} mt={4}>
                                        {order.phone}
                                    </Text>
                                </Grid.Col>

                                <Grid.Col span={12}>
                                    <Text size="xs" c="dimmed">
                                        Alamat Pengiriman
                                    </Text>

                                    <Text size="sm" mt={4} style={{ lineHeight: 1.6 }}>
                                        {order.address}
                                    </Text>

                                    <Text size="xs" c="dimmed" mt={4}>
                                        {[
                                            order.district,
                                            order.city,
                                            order.province,
                                            order.postalCode,
                                        ]
                                            .filter(Boolean)
                                            .join(", ")}
                                    </Text>
                                </Grid.Col>
                            </Grid>
                        </SectionCard>

                        {/* SHIPPING */}

                        <SectionCard
                            title="Pengiriman"
                            description="Informasi layanan yang dipilih customer"
                        >
                            <Grid gap="md">
                                <Grid.Col span={{ base: 12, sm: 4 }}>
                                    <Text size="xs" c="dimmed">
                                        Kurir
                                    </Text>

                                    <Text size="sm" fw={600} mt={4} tt="uppercase">
                                        {order.shippingCourier ?? "-"}
                                    </Text>
                                </Grid.Col>

                                <Grid.Col span={{ base: 12, sm: 4 }}>
                                    <Text size="xs" c="dimmed">
                                        Layanan
                                    </Text>

                                    <Text size="sm" fw={500} mt={4}>
                                        {order.shippingService ?? "-"}
                                    </Text>
                                </Grid.Col>

                                <Grid.Col span={{ base: 12, sm: 4 }}>
                                    <Text size="xs" c="dimmed">
                                        Ongkir
                                    </Text>

                                    <Text size="sm" fw={600} mt={4}>
                                        {rupiah(order.shippingCost)}
                                    </Text>
                                </Grid.Col>
                            </Grid>
                        </SectionCard>

                        {/* TRACKING */}

                        <SectionCard
                            title="Tracking Pengiriman"
                            description="Riwayat perjalanan paket"
                            actions={
                                tracking?.summary?.status ? (
                                    <StatusBadge
                                        tone={trackingTone(tracking.summary.status)}
                                        size="lg"
                                    >
                                        {tracking.summary.status}
                                    </StatusBadge>
                                ) : undefined
                            }
                        >
                            {/* NO TRACKING NUMBER */}

                            {!order.trackingNumber && (
                                <Box
                                    pl="md"
                                    style={{ borderLeft: "2px solid var(--mantine-color-gray-3)" }}
                                >
                                    <Text size="sm" fw={500}>
                                        Nomor resi belum tersedia
                                    </Text>

                                    <Text size="sm" c="dimmed" mt={4}>
                                        Masukkan nomor resi pada panel update pesanan untuk
                                        melihat perjalanan paket.
                                    </Text>
                                </Box>
                            )}

                            {/* LOADING */}

                            {order.trackingNumber && trackingLoading && (
                                <Stack gap="lg">
                                    <Text size="xs" fw={500} c="dimmed">
                                        Mengambil data tracking...
                                    </Text>

                                    {Array.from({ length: 4 }).map((_, index) => (
                                        <Group gap="md" key={index} wrap="nowrap">
                                            <Skeleton height={16} width={16} circle />

                                            <Box style={{ flex: 1 }}>
                                                <Skeleton height={14} width="75%" radius="sm" />

                                                <Skeleton
                                                    height={12}
                                                    width={128}
                                                    mt="sm"
                                                    radius="sm"
                                                />
                                            </Box>
                                        </Group>
                                    ))}
                                </Stack>
                            )}

                            {/* EMPTY */}

                            {order.trackingNumber &&
                                !trackingLoading &&
                                (!tracking || tracking.manifest.length === 0) && (
                                    <Box
                                        pl="md"
                                        style={{
                                            borderLeft: "2px solid var(--mantine-color-gray-3)",
                                        }}
                                    >
                                        <Text size="sm" fw={500}>
                                            Riwayat tracking belum tersedia
                                        </Text>

                                        <Text size="sm" c="dimmed" mt={4}>
                                            Data perjalanan paket belum tersedia dari kurir.
                                        </Text>
                                    </Box>
                                )}

                            {/* TRACKING DATA */}

                            {tracking && !trackingLoading && tracking.manifest.length > 0 && (
                                <Stack gap="lg">
                                    {/* SUMMARY */}

                                    <Box
                                        style={{
                                            border: "1px solid var(--mantine-color-gray-3)",
                                            borderRadius: 8,
                                            overflow: "hidden",
                                        }}
                                    >
                                        <Grid gap={1} bg="var(--mantine-color-gray-3)">
                                            <Grid.Col span={{ base: 12, sm: 4 }}>
                                                <Box
                                                    bg="var(--mantine-color-gray-0)"
                                                    px="md"
                                                    py="sm"
                                                >
                                                    <Text size="xs" c="dimmed" tt="uppercase">
                                                        Asal
                                                    </Text>

                                                    <Text size="sm" fw={500} mt={4}>
                                                        {tracking.summary?.origin ?? "-"}
                                                    </Text>
                                                </Box>
                                            </Grid.Col>

                                            <Grid.Col span={{ base: 12, sm: 4 }}>
                                                <Box
                                                    bg="var(--mantine-color-gray-0)"
                                                    px="md"
                                                    py="sm"
                                                >
                                                    <Text size="xs" c="dimmed" tt="uppercase">
                                                        Tujuan
                                                    </Text>

                                                    <Text size="sm" fw={500} mt={4}>
                                                        {tracking.summary?.destination ?? "-"}
                                                    </Text>
                                                </Box>
                                            </Grid.Col>

                                            <Grid.Col span={{ base: 12, sm: 4 }}>
                                                <Box
                                                    bg="var(--mantine-color-gray-0)"
                                                    px="md"
                                                    py="sm"
                                                >
                                                    <Text size="xs" c="dimmed" tt="uppercase">
                                                        Status
                                                    </Text>

                                                    <Text
                                                        size="sm"
                                                        fw={600}
                                                        mt={4}
                                                        c={
                                                            tracking.summary?.status ===
                                                            "DELIVERED"
                                                                ? "green"
                                                                : "blue"
                                                        }
                                                    >
                                                        {tracking.summary?.status ?? "-"}
                                                    </Text>
                                                </Box>
                                            </Grid.Col>
                                        </Grid>
                                    </Box>

                                    {/* WAYBILL */}

                                    <Grid gap="md">
                                        <Grid.Col span={{ base: 12, sm: 4 }}>
                                            <Text size="xs" c="dimmed">
                                                Kurir
                                            </Text>

                                            <Text size="sm" fw={600} mt={4} tt="uppercase">
                                                {tracking.summary?.courier_name ??
                                                    order.shippingCourier ??
                                                    "-"}
                                            </Text>
                                        </Grid.Col>

                                        <Grid.Col span={{ base: 12, sm: 4 }}>
                                            <Text size="xs" c="dimmed">
                                                Nomor Resi
                                            </Text>

                                            <Text
                                                size="sm"
                                                fw={600}
                                                mt={4}
                                                style={{ wordBreak: "break-all" }}
                                            >
                                                {tracking.summary?.waybill_number ??
                                                    order.trackingNumber ??
                                                    "-"}
                                            </Text>
                                        </Grid.Col>

                                        <Grid.Col span={{ base: 12, sm: 4 }}>
                                            <Text size="xs" c="dimmed">
                                                Layanan
                                            </Text>

                                            <Text size="sm" fw={500} mt={4}>
                                                {tracking.summary?.service_code ??
                                                    order.shippingService ??
                                                    "-"}
                                            </Text>
                                        </Grid.Col>
                                    </Grid>

                                    {/* POD */}

                                    {tracking.deliveryStatus?.status === "DELIVERED" && (
                                        <Alert
                                            color="green"
                                            variant="light"
                                            radius="md"
                                            title="Paket sudah diterima"
                                        >
                                            {tracking.deliveryStatus.pod_receiver && (
                                                <Text size="xs">
                                                    Diterima oleh{" "}
                                                    {tracking.deliveryStatus.pod_receiver}
                                                </Text>
                                            )}

                                            {tracking.deliveryStatus.pod_date && (
                                                <Text size="xs" mt={4}>
                                                    {tracking.deliveryStatus.pod_date}{" "}
                                                    {tracking.deliveryStatus.pod_time ?? ""}
                                                </Text>
                                            )}
                                        </Alert>
                                    )}

                                    {/* TIMELINE */}

                                    <Box>
                                        <Box mb="lg">
                                            <Text size="sm" fw={600}>
                                                Riwayat Perjalanan
                                            </Text>

                                            <Text size="xs" c="dimmed" mt={2}>
                                                Status paket dari waktu ke waktu
                                            </Text>
                                        </Box>

                                        <Box>
                                            {[...tracking.manifest]
                                                .reverse()
                                                .map((item, index) => {
                                                    const isLatest = index === 0;

                                                    const isLast =
                                                        index ===
                                                        tracking.manifest.length - 1;

                                                    return (
                                                        <Group
                                                            key={`${item.manifest_date}-${item.manifest_time}-${index}`}
                                                            gap="md"
                                                            wrap="nowrap"
                                                            align="stretch"
                                                        >
                                                            <Stack
                                                                w={20}
                                                                align="center"
                                                                gap={0}
                                                                style={{ flexShrink: 0 }}
                                                            >
                                                                <Box
                                                                    mt={2}
                                                                    w={14}
                                                                    h={14}
                                                                    style={{
                                                                        borderRadius: "50%",
                                                                        border: `3px solid ${
                                                                            isLatest
                                                                                ? "var(--mantine-color-green-6)"
                                                                                : "var(--mantine-color-gray-4)"
                                                                        }`,
                                                                        background:
                                                                            "var(--mantine-color-white)",
                                                                        zIndex: 1,
                                                                    }}
                                                                />

                                                                {!isLast && (
                                                                    <Box
                                                                        w={1}
                                                                        style={{
                                                                            flex: 1,
                                                                            background:
                                                                                "var(--mantine-color-gray-3)",
                                                                        }}
                                                                    />
                                                                )}
                                                            </Stack>

                                                            <Box
                                                                style={{ minWidth: 0, flex: 1 }}
                                                                pb={isLast ? 4 : 28}
                                                            >
                                                                <Group gap="xs">
                                                                    <Text
                                                                        size="sm"
                                                                        fw={isLatest ? 600 : 500}
                                                                    >
                                                                        {
                                                                            item.manifest_description
                                                                        }
                                                                    </Text>

                                                                    {isLatest && (
                                                                        <Text
                                                                            size="xs"
                                                                            fw={600}
                                                                            c="green"
                                                                            tt="uppercase"
                                                                        >
                                                                            Terbaru
                                                                        </Text>
                                                                    )}
                                                                </Group>

                                                                <Group gap="xs" mt={4}>
                                                                    {item.city_name && (
                                                                        <Text size="xs" c="dimmed">
                                                                            {item.city_name}
                                                                        </Text>
                                                                    )}

                                                                    <Text size="xs" c="dimmed">
                                                                        {item.manifest_date} •{" "}
                                                                        {item.manifest_time}
                                                                    </Text>
                                                                </Group>

                                                                {item.title && (
                                                                    <Text size="xs" c="dimmed" mt={6}>
                                                                        {item.title}
                                                                    </Text>
                                                                )}
                                                            </Box>
                                                        </Group>
                                                    );
                                                })}
                                        </Box>
                                    </Box>
                                </Stack>
                            )}
                        </SectionCard>
                    </Stack>
                </Grid.Col>

                {/* SIDEBAR */}

                <Grid.Col span={{ base: 12, lg: 4 }}>
                    <Stack
                        gap="lg"
                        style={{ position: "sticky", top: 16, alignSelf: "flex-start" }}
                    >
                        <SectionCard
                            title="Update Pesanan"
                            description="Perbarui status dan nomor resi"
                        >
                            <Stack gap="md">
                                {/* STATUS */}

                                <Select
                                    label="Status Pesanan"
                                    size="md"
                                    radius="md"
                                    allowDeselect={false}
                                    value={status}
                                    onChange={(value) => setStatus(value ?? "")}
                                    data={statuses.map((item) => ({
                                        value: item,
                                        label: statusLabel(item),
                                    }))}
                                />

                                {/* TRACKING NUMBER */}

                                <TextInput
                                    label="Nomor Resi"
                                    size="md"
                                    radius="md"
                                    value={trackingNumber}
                                    onChange={(e) => setTrackingNumber(e.currentTarget.value)}
                                    placeholder="Masukkan nomor resi"
                                    description={`Kurir: ${
                                        order.shippingCourier?.toUpperCase() ?? "-"
                                    }`}
                                />

                                {/* SAVE */}

                                <Button
                                    type="button"
                                    size="md"
                                    radius="md"
                                    fullWidth
                                    loading={saving}
                                    disabled={saving}
                                    onClick={saveOrder}
                                >
                                    {saving ? "Menyimpan..." : "Simpan Perubahan"}
                                </Button>

                                <Text size="xs" c="dimmed" ta="center">
                                    Perubahan status dan resi akan langsung disimpan.
                                </Text>
                            </Stack>
                        </SectionCard>

                        {/* REFUND MANAGEMENT */}

                        {order.status === "REFUND_PENDING" && (
                            <Card
                                withBorder
                                radius="md"
                                padding="lg"
                                style={{
                                    borderColor: "var(--mantine-color-orange-3)",
                                    background: "var(--mantine-color-orange-0)",
                                }}
                            >
                                <Box>
                                    <Text size="sm" fw={600} c="orange.9">
                                        🔄 Refund Pending
                                    </Text>

                                    <Text size="xs" c="orange.7" mt={2}>
                                        Pelanggan meminta refund
                                    </Text>
                                </Box>

                                <Stack gap="sm" mt="md">
                                    <Text size="sm" c="orange.9">
                                        Total: {rupiah(order.total)}
                                    </Text>

                                    <Group gap="sm" grow>
                                        <Button
                                            color="green"
                                            size="md"
                                            radius="md"
                                            onClick={approveRefund}
                                        >
                                            ✓ Setujui
                                        </Button>

                                        <Button
                                            variant="default"
                                            color="red"
                                            size="md"
                                            radius="md"
                                            onClick={() => {
                                                setRejectReason("");
                                                setRejectOpen(true);
                                            }}
                                        >
                                            ✕ Tolak
                                        </Button>
                                    </Group>

                                    <Text size="xs" c="orange.7">
                                        Setelah menyetujui, proses refund melalui dashboard iPaymu.
                                    </Text>
                                </Stack>
                            </Card>
                        )}

                        {/* COMPLETED REFUND INFO */}

                        {order.status === "CANCELLED" &&
                            order.paymentStatus === "REFUNDED" && (
                                <Alert
                                    color="green"
                                    variant="light"
                                    radius="md"
                                    title="✓ Refund Selesai"
                                >
                                    <Text size="xs">Pesanan ini telah direfund</Text>
                                </Alert>
                            )}
                    </Stack>
                </Grid.Col>
            </Grid>

            {/* REJECT REASON */}

            <Modal
                opened={rejectOpen}
                onClose={() => setRejectOpen(false)}
                title="Alasan Penolakan"
                centered
            >
                <Textarea
                    label="Alasan penolakan refund"
                    size="md"
                    radius="md"
                    required
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.currentTarget.value)}
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
                        onClick={() => setRejectOpen(false)}
                    >
                        Batal
                    </Button>

                    <Button
                        color="red"
                        size="md"
                        radius="md"
                        disabled={!rejectReason.trim()}
                        onClick={rejectRefund}
                    >
                        Tolak Refund
                    </Button>
                </Group>
            </Modal>
        </Stack>
    );
}
