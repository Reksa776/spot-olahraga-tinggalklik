import Link from "next/link";
import { Box, Card, Group, Text, ThemeIcon } from "@mantine/core";
import { FiArrowRight } from "react-icons/fi";

/**
 * A quick-action tile on the admin overview.
 *
 * Still a single `<Link>` that covers the whole tile, so the click target is unchanged and stays
 * keyboard-navigable — but the hover treatment family is now the same as the sidebar (`brand`
 * theme colour) instead of the `hover:-translate-y-0.5` + shadow dance, which the brief lists as an
 * "excessive animation" tell. The whole tile is the target; nothing became icon-only, so no
 * accessible name was lost.
 */
export default function AdminMenuCard({
    href,
    icon: Icon,
    title,
    description,
}: {
    href: string;
    icon: React.ComponentType<{ size?: number | string }>;
    title: string;
    description: string;
}) {
    return (
        <Card
            component={Link}
            href={href}
            withBorder
            radius="md"
            padding="lg"
            h="100%"
            styles={{
                root: {
                    transition: "border-color 150ms ease, background-color 150ms ease",
                    "&:hover": {
                        borderColor: "var(--mantine-color-brand-4)",
                        backgroundColor: "var(--mantine-color-brand-0)",
                    },
                },
            }}
        >
            <Group align="flex-start" gap="md" wrap="nowrap">
                <ThemeIcon color="brand" variant="light" radius="md" size={44}>
                    <Icon size={20} />
                </ThemeIcon>

                <Box style={{ minWidth: 0, flex: 1 }}>
                    <Group justify="space-between" gap="sm" wrap="nowrap">
                        <Text fw={600}>{title}</Text>
                        <FiArrowRight size={18} color="var(--mantine-color-gray-5)" />
                    </Group>

                    <Text size="sm" c="dimmed" mt={4}>
                        {description}
                    </Text>
                </Box>
            </Group>
        </Card>
    );
}
