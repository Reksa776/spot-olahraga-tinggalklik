import { Box, Group, Stack, Text } from "@mantine/core";

import { EmptyBlock, SectionCard, StatusBadge, TextLink, type Tone } from "@/components/dashboard/primitives";

export type RecentOrder = {
    id: number;
    orderNumber: string;
    recipientName: string;
    total: string;
    status: string;
    paymentStatus: string;
    paymentMethod: string;
    createdAt: string;
    items: {
        productName: string;
        variantName: string;
        quantity: number;
    }[];
};

/**
 * "Pesanan Terbaru".
 *
 * `formatRupiah` is kept identical (`Rp ` + `toLocaleString("id-ID")`, with the value coerced from
 * the string the API returns), because changing the money formatting would be a behaviour change
 * rather than a UI one.
 *
 * The status pill becomes `StatusBadge`, which maps the *status* to a semantic tone instead of the
 * previous fixed grey — an order's state is now readable at a glance, which is the one substantive
 * presentation improvement here.
 */
const STATUS_TONE: Record<string, Tone> = {
    PENDING: "pending",
    PAID: "info",
    PROCESSING: "info",
    SHIPPED: "brand",
    COMPLETED: "success",
    CANCELLED: "error",
    REFUNDED: "neutral",
};

function formatRupiah(value: number) {
    return `Rp ${value.toLocaleString("id-ID")}`;
}

export default function RecentOrdersCard({
    data,
}: {
    data: RecentOrder[];
}) {
    return (
        <SectionCard
            title="Pesanan Terbaru"
            description="Transaksi terbaru di toko."
            actions={<TextLink href="/admin/orders">Lihat semua</TextLink>}
        >
            {data.length === 0 ? (
                <EmptyBlock title="Belum ada pesanan" description="Pesanan baru akan tampil di sini." />
            ) : (
                <Stack gap={0}>
                    {data.map((order, index) => (
                        <Group
                            key={order.id}
                            justify="space-between"
                            align="flex-start"
                            gap="md"
                            wrap="nowrap"
                            py="sm"
                            style={{
                                borderTop: index === 0 ? undefined : "1px solid var(--mantine-color-gray-2)",
                            }}
                        >
                            <Box style={{ minWidth: 0 }}>
                                <Text fw={600}>{order.orderNumber}</Text>

                                <Text size="sm" c="dimmed" mt={2}>
                                    {order.recipientName}
                                </Text>

                                {order.items[0] ? (
                                    <Text size="xs" c="dimmed" mt={2} lineClamp={1}>
                                        {order.items[0].productName} × {order.items[0].quantity}
                                    </Text>
                                ) : null}
                            </Box>

                            <Stack gap={6} align="flex-end">
                                <Text size="sm" fw={700} style={{ whiteSpace: "nowrap" }}>
                                    {formatRupiah(Number(order.total))}
                                </Text>

                                <StatusBadge tone={STATUS_TONE[order.status] ?? "neutral"} size="sm">
                                    {order.status}
                                </StatusBadge>
                            </Stack>
                        </Group>
                    ))}
                </Stack>
            )}
        </SectionCard>
    );
}
