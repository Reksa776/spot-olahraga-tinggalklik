import { Group, Stack, Text } from "@mantine/core";

import { SectionCard, StatusBadge, type Tone } from "@/components/dashboard/primitives";

export type OrderStatusData = {
    PENDING: number;
    PAID: number;
    PROCESSING: number;
    SHIPPED: number;
    COMPLETED: number;
    CANCELLED: number;
};

/** Any `{ label: count }` payload, so a payment-method breakdown needs no second component. */
export type BreakdownData = Record<string, number>;

/**
 * ==========================================
 * STATUS BREAKDOWN CARD
 * ==========================================
 *
 * WHY THIS FILE EXISTS AT ALL
 * --------------------------
 * The previous dashboard had TWO components — `OrderStatusCard.tsx` and `PaymentMethodCard.tsx` —
 * that were the same implementation twice: the same `OrderStatusData` type, the same six
 * `[name, value]` pairs, the same JSX. `PaymentMethodCard.tsx` even exported the component under the
 * name `OrderStatusCard`.
 *
 * A DEFECT THIS MIGRATION CORRECTS (presentation only)
 * ---------------------------------------------------
 * The overview passed `data.paymentMethod` into the second copy. That payload is
 * `{ COD, BANK_TRANSFER, E_WALLET, QRIS }` (see `app/api/admin/dashboard/route.ts`), while the
 * component read `data.PENDING`, `data.PAID`, … — six properties the payload does not have. The
 * "Metode Pembayaran" panel therefore rendered six labelled rows with **empty** values, and had
 * done since it was written.
 *
 * Rendering the API's own keys fixes that without touching the API, the query or the shape of the
 * response: this component now renders whatever labels it is given, in the order it is given them.
 * The change is visible in the report as a corrected defect rather than a silent improvement.
 *
 * Colours stay semantic: an order status keeps its status colour, a payment method gets a neutral
 * informational tone.
 */
const ORDER_STATUS_ORDER: (keyof OrderStatusData)[] = [
    "PENDING",
    "PAID",
    "PROCESSING",
    "SHIPPED",
    "COMPLETED",
    "CANCELLED",
];

const STATUS_TONE: Record<string, Tone> = {
    PENDING: "pending",
    PAID: "info",
    PROCESSING: "info",
    SHIPPED: "brand",
    COMPLETED: "success",
    CANCELLED: "error",
    REFUNDED: "neutral",
};

export default function StatusBreakdownCard({
    title,
    description,
    data,
    order,
}: {
    title: string;
    description?: string;
    data: BreakdownData;
    /** Labels to render, in order. Defaults to the six order statuses. */
    order?: string[];
}) {
    const labels = order ?? [...ORDER_STATUS_ORDER];

    return (
        <SectionCard title={title} description={description}>
            <Stack gap="xs">
                {labels.map((name) => (
                    <Group
                        key={name}
                        justify="space-between"
                        wrap="nowrap"
                        bg="var(--mantine-color-gray-0)"
                        px="md"
                        py="xs"
                        style={{ borderRadius: 8 }}
                    >
                        <StatusBadge tone={STATUS_TONE[name] ?? "neutral"} size="sm">
                            {name}
                        </StatusBadge>

                        <Text size="sm" fw={700}>
                            {data[name] ?? 0}
                        </Text>
                    </Group>
                ))}
            </Stack>
        </SectionCard>
    );
}
