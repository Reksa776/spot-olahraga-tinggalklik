import { Box, Group, Stack, Text, ThemeIcon } from "@mantine/core";

import { EmptyBlock, SectionCard } from "@/components/dashboard/primitives";

type TopProduct = {
    productId: number;
    productName: string;
    quantity: number;
    revenue: number;
};

/**
 * "Produk Terlaris".
 *
 * The ranking badge, the truncation behaviour, the empty state and the `toLocaleString("id-ID")`
 * revenue formatting are all preserved from the Tailwind version. The empty state is upgraded from
 * a bare paragraph to the shared `EmptyBlock` so it matches every other empty panel in the back
 * office — the previous version rendered an empty bordered card with one grey line of text.
 */
export default function TopProductsCard({
    data,
}: {
    data: TopProduct[];
}) {
    return (
        <SectionCard title="Produk Terlaris" description="Produk dengan penjualan tertinggi.">
            {data.length === 0 ? (
                <EmptyBlock title="Belum ada data produk" description="Penjualan akan muncul di sini setelah ada transaksi." />
            ) : (
                <Stack gap={0}>
                    {data.map((product, index) => (
                        <Group
                            key={product.productId}
                            gap="md"
                            wrap="nowrap"
                            py="sm"
                            style={{
                                borderTop: index === 0 ? undefined : "1px solid var(--mantine-color-gray-2)",
                            }}
                        >
                            <ThemeIcon color="brand" variant="light" radius="xl" size="lg">
                                <Text size="sm" fw={700}>
                                    {index + 1}
                                </Text>
                            </ThemeIcon>

                            <Box style={{ minWidth: 0, flex: 1 }}>
                                <Text size="sm" fw={600} lineClamp={1}>
                                    {product.productName}
                                </Text>

                                <Text size="xs" c="dimmed" mt={2}>
                                    {product.quantity} unit terjual
                                </Text>
                            </Box>

                            <Text size="sm" fw={700} style={{ whiteSpace: "nowrap" }}>
                                Rp {product.revenue.toLocaleString("id-ID")}
                            </Text>
                        </Group>
                    ))}
                </Stack>
            )}
        </SectionCard>
    );
}
