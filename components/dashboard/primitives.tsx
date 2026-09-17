"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import {
    Alert,
    Anchor,
    Badge,
    Box,
    Button,
    Card,
    Divider,
    EmptyState,
    Group,
    Loader,
    Pagination,
    Paper,
    ScrollArea,
    SimpleGrid,
    Skeleton,
    Stack,
    Table,
    Text,
    ThemeIcon,
    Title,
} from "@mantine/core";

/**
 * ==========================================
 * DASHBOARD PRIMITIVES
 * ==========================================
 *
 * The dashboard is 38 pages and 22 components; without a small shared vocabulary every one of them
 * would compose Mantine differently and the result would be the "generic AI dashboard" the brief
 * rules out. These are deliberately FEW and each replaces repeated markup that already existed:
 *
 *   PageHeader      replaced  a bordered title block that ~15 admin pages hand-rolled
 *   SectionCard     replaced  `<div className="rounded-2xl border … p-5">` (~40 occurrences)
 *   StatCard        replaced  the four KPI tiles on the admin overview
 *   StatusBadge     replaced the ad-hoc tinted `<span>` status pills that each page hand-rolled
 *   DataTable       replaced  hand-written `<table>` blocks with no empty/loading/error state
 *   LinkPagination  replaced  the previous/next link pair on the server-rendered lists
 *   EmptyBlock / ErrorBlock / LoadingBlock   the three states most tables did not have at all
 *
 * SERVER/CLIENT BOUNDARY
 * ----------------------
 * Everything here is a client component (Mantine reads context), but it is designed to be called
 * FROM server components. That constrains the props: no callbacks and no render functions, because
 * a server component cannot pass a function across the boundary. So `DataTable` takes
 * already-built `cells` (ReactNode) rather than a `render` function, `ErrorBlock` takes an
 * `action` node rather than an `onRetry` callback, and `LinkPagination` is given strings and
 * builds its own hrefs. Client callers are free to pass whatever they like into those nodes.
 */

/* ------------------------------------------------------------------------------------------------
 * SEMANTIC TONES
 * ------------------------------------------------------------------------------------------------
 * The brief is explicit that status colour stays semantic and must not be repainted with the brand
 * colour. One table, used everywhere, is how that stays true: a mapping that exists once cannot
 * drift per page.
 */
export type Tone = "success" | "error" | "warn" | "info" | "pending" | "neutral" | "brand";

const TONE_COLOR: Record<Tone, string> = {
    success: "green",
    error: "red",
    warn: "yellow",
    info: "blue",
    pending: "orange",
    neutral: "gray",
    brand: "brand",
};

export function StatusBadge({
    tone = "neutral",
    children,
    size = "md",
}: {
    tone?: Tone;
    children: ReactNode;
    size?: "sm" | "md" | "lg";
}) {
    return (
        <Badge color={TONE_COLOR[tone]} variant="light" size={size} radius="sm">
            {children}
        </Badge>
    );
}

export function useToneColor(tone: Tone): string {
    return TONE_COLOR[tone];
}

/* ------------------------------------------------------------------------------------------------
 * PAGE HEADER
 * ------------------------------------------------------------------------------------------------ */
export function PageHeader({
    title,
    description,
    eyebrow,
    actions,
}: {
    title: ReactNode;
    description?: ReactNode;
    eyebrow?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <Group justify="space-between" align="flex-start" gap="lg" wrap="wrap" mb="lg">
            <Box style={{ minWidth: 0 }}>
                {eyebrow ? (
                    <Text size="sm" fw={600} c="brand.7" tt="uppercase" style={{ letterSpacing: "0.04em" }}>
                        {eyebrow}
                    </Text>
                ) : null}

                <Title order={1} mt={eyebrow ? 4 : 0}>
                    {title}
                </Title>

                {description ? (
                    <Text c="dimmed" size="sm" mt={6} maw={720}>
                        {description}
                    </Text>
                ) : null}
            </Box>

            {actions ? (
                <Group gap="sm" wrap="nowrap">
                    {actions}
                </Group>
            ) : null}
        </Group>
    );
}

/* ------------------------------------------------------------------------------------------------
 * SECTION CARD — the bordered panel ~40 dashboard blocks were hand-rolling
 * ------------------------------------------------------------------------------------------------ */
export function SectionCard({
    title,
    description,
    actions,
    children,
    padding,
    mih,
}: {
    title?: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
    padding?: string | number;
    mih?: number;
}) {
    return (
        <Card withBorder radius="md" padding={padding ?? "lg"} mih={mih}>
            {title || actions ? (
                <Group justify="space-between" align="flex-start" gap="md" mb={description ? 4 : "md"}>
                    <Box>
                        {title ? (
                            <Text fw={600} size="md">
                                {title}
                            </Text>
                        ) : null}

                        {description ? (
                            <Text c="dimmed" size="sm" mt={2}>
                                {description}
                            </Text>
                        ) : null}
                    </Box>

                    {actions ? (
                        <Group gap="xs" wrap="nowrap">
                            {actions}
                        </Group>
                    ) : null}
                </Group>
            ) : null}

            {title && !description ? <Box mt="md">{children}</Box> : children}
        </Card>
    );
}

/* ------------------------------------------------------------------------------------------------
 * STAT CARD
 * ------------------------------------------------------------------------------------------------ */
export function StatCard({
    label,
    value,
    hint,
    icon,
    tone = "brand",
    footer,
}: {
    label: ReactNode;
    value: ReactNode;
    hint?: ReactNode;
    icon?: ReactNode;
    tone?: Tone;
    footer?: ReactNode;
}) {
    return (
        <Card withBorder radius="md" padding="lg" h="100%">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Text size="sm" c="dimmed" fw={500}>
                    {label}
                </Text>

                {icon ? (
                    <ThemeIcon color={TONE_COLOR[tone]} variant="light" size="lg" radius="md">
                        {icon}
                    </ThemeIcon>
                ) : null}
            </Group>

            <Text fz={28} fw={700} mt="sm" lh={1.15}>
                {value}
            </Text>

            {hint ? (
                <Text size="xs" c="dimmed" mt={6}>
                    {hint}
                </Text>
            ) : null}

            {footer ? (
                <>
                    <Divider my="sm" />
                    {footer}
                </>
            ) : null}
        </Card>
    );
}

export function StatGrid({ children, minWidth = 220 }: { children: ReactNode; minWidth?: number }) {
    return (
        <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} spacing="md" verticalSpacing="md" style={{ "--sg-min": minWidth }}>
            {children}
        </SimpleGrid>
    );
}

/* ------------------------------------------------------------------------------------------------
 * TABLE
 * ------------------------------------------------------------------------------------------------ */
export type TableColumn = {
    header: ReactNode;
    align?: "left" | "center" | "right";
    width?: number | string;
};

export type TableRow = {
    /** Stable React key for the row. */
    key: string;
    /** One node per column, in the same order as `columns`. */
    cells: ReactNode[];
};

export function DataTable({
    columns,
    rows,
    caption,
    loading = false,
    loadingRows = 5,
    error,
    empty,
    minWidth,
    footer,
}: {
    columns: TableColumn[];
    rows: TableRow[];
    caption?: ReactNode;
    loading?: boolean;
    loadingRows?: number;
    /** An error node. Rendered instead of the table so a failed fetch is never mistaken for "no data". */
    error?: ReactNode;
    /** An empty node. Rendered when `rows` is empty and there is no error and no loading. */
    empty?: ReactNode;
    minWidth?: number;
    footer?: ReactNode;
}) {
    if (error) {
        return <>{error}</>;
    }

    if (loading) {
        return (
            <Stack gap="xs">
                <Skeleton height={38} radius="sm" />
                {Array.from({ length: loadingRows }).map((_, index) => (
                    <Skeleton key={index} height={30} radius="sm" />
                ))}
            </Stack>
        );
    }

    if (rows.length === 0 && empty) {
        return <>{empty}</>;
    }

    return (
        <Stack gap="md">
            {/* Horizontal scroll rather than a collapsing layout: a 12-column order table stays
                readable on a phone instead of becoming illegible columns. */}
            <ScrollArea type="auto" offsetScrollbars>
                <Table
                    highlightOnHover
                    withTableBorder
                    verticalSpacing="sm"
                    horizontalSpacing="md"
                    style={minWidth ? { minWidth } : undefined}
                >
                    {caption ? <Table.Caption>{caption}</Table.Caption> : null}

                    <Table.Thead>
                        <Table.Tr>
                            {columns.map((column, index) => (
                                <Table.Th
                                    key={index}
                                    style={{
                                        textAlign: column.align ?? "left",
                                        width: column.width,
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    {column.header}
                                </Table.Th>
                            ))}
                        </Table.Tr>
                    </Table.Thead>

                    <Table.Tbody>
                        {rows.map((row) => (
                            <Table.Tr key={row.key}>
                                {row.cells.map((cell, index) => (
                                    <Table.Td
                                        key={index}
                                        style={{ textAlign: columns[index]?.align ?? "left" }}
                                    >
                                        {cell}
                                    </Table.Td>
                                ))}
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            </ScrollArea>

            {footer ? footer : null}
        </Stack>
    );
}

export function TableToolbar({ children }: { children: ReactNode }) {
    return (
        <Paper withBorder radius="md" p="md" mb="md">
            <Group gap="md" align="flex-end" wrap="wrap">
                {children}
            </Group>
        </Paper>
    );
}

/* ------------------------------------------------------------------------------------------------
 * STATES
 * ------------------------------------------------------------------------------------------------ */
export function EmptyBlock({
    title,
    description,
    icon,
    action,
}: {
    title: ReactNode;
    description?: ReactNode;
    icon?: ReactNode;
    action?: ReactNode;
}) {
    return (
        <EmptyState
            size="md"
            withIndicatorBackground
            title={title}
            description={description}
            icon={icon}
        >
            {action ? <EmptyState.Actions>{action}</EmptyState.Actions> : null}
        </EmptyState>
    );
}

export function ErrorBlock({
    message,
    action,
    title = "Gagal memuat data",
}: {
    message: ReactNode;
    action?: ReactNode;
    title?: ReactNode;
}) {
    return (
        <Alert color="red" variant="light" radius="md" title={title}>
            <Stack gap="sm" align="flex-start">
                <Text size="sm">{message}</Text>
                {action}
            </Stack>
        </Alert>
    );
}

export function LoadingBlock({ label = "Memuat…", height = 240 }: { label?: ReactNode; height?: number }) {
    return (
        <Group justify="center" align="center" gap="sm" mih={height}>
            <Loader size="sm" />
            <Text size="sm" c="dimmed">
                {label}
            </Text>
        </Group>
    );
}

export function InfoNote({ children, tone = "info" }: { children: ReactNode; tone?: Tone }) {
    return (
        <Alert color={TONE_COLOR[tone]} variant="light" radius="md">
            {children}
        </Alert>
    );
}

/* ------------------------------------------------------------------------------------------------
 * ACCESS DENIED
 * ------------------------------------------------------------------------------------------------
 *
 * WHY A CLIENT COMPONENT
 * ----------------------
 * Mantine's `Button` accepts `component={Link}`, but a component *reference* cannot be passed from a
 * server component across the RSC boundary — it fails at runtime with "Functions cannot be passed
 * directly to Client Components". The back-office layouts are server components, so they cannot
 * build that button themselves. This component does, and is why the layouts call it by props
 * (`actionHref` / `actionLabel`) instead of passing a component.
 *
 * WHY IT EXISTS AT ALL
 * --------------------
 * The three back-office layouts each hand-rolled the same "you do not have access" panel — three
 * copies of the same 640px centred `Alert` plus a way out. That is one panel now, so a change to
 * how an authorization failure is presented happens once. The copy is supplied by the caller
 * because each surface explains a different denial (no organiser membership, no platform role, the
 * page-level permission the service rejected).
 */
export function AccessDeniedPanel({
    title,
    body,
    actionHref,
    actionLabel,
}: {
    title: ReactNode;
    body?: ReactNode;
    actionHref?: string;
    actionLabel?: ReactNode;
}) {
    return (
        <Box maw={640} mx="auto" px="md" py={64}>
            <Alert color="yellow" variant="light" radius="md" title={title}>
                {body}

                {actionHref && actionLabel ? (
                    <Button
                        component={Link}
                        href={actionHref}
                        mt="md"
                        size="md"
                        color="ink"
                        radius="md"
                    >
                        {actionLabel}
                    </Button>
                ) : null}
            </Alert>
        </Box>
    );
}

/* ------------------------------------------------------------------------------------------------
 * PAGINATION
 * ------------------------------------------------------------------------------------------------
 * String-driven so a server component can render it: the hrefs are built here instead of being
 * passed in as a function.
 */
export function LinkPagination({
    page,
    totalPages,
    basePath,
    query = {},
    label = "Halaman",
}: {
    page: number;
    totalPages: number;
    basePath: string;
    query?: Record<string, string | number | undefined | null>;
    label?: string;
}) {
    if (totalPages <= 1) {
        return null;
    }

    function hrefFor(target: number): string {
        const params = new URLSearchParams();

        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null || value === "") continue;
            params.set(key, String(value));
        }

        if (target > 1) {
            params.set("page", String(target));
        }

        const qs = params.toString();
        return qs ? `${basePath}?${qs}` : basePath;
    }

    return (
        <Group justify="space-between" align="center" gap="md" wrap="wrap">
            <Text size="sm" c="dimmed">
                {label} {page} dari {totalPages}
            </Text>

            <Pagination
                total={totalPages}
                value={page}
                size="md"
                withEdges
                getItemProps={(item) => ({
                    component: Link,
                    href: hrefFor(item),
                })}
            />
        </Group>
    );
}

/* ------------------------------------------------------------------------------------------------
 * MISC
 * ------------------------------------------------------------------------------------------------ */
export function Money({ value, size = "sm", fw = 600 }: { value: ReactNode; size?: string; fw?: number }) {
    return (
        <Text size={size} fw={fw} style={{ whiteSpace: "nowrap" }}>
            {value}
        </Text>
    );
}

/**
 * A primary action that is comfortable to hit — `md`/`lg` is the dashboard's primary size.
 *
 * WHY IT TAKES `href` RATHER THAN A `component`
 * ---------------------------------------------
 * The same rule as `AccessDeniedPanel`: a *component reference* cannot cross the RSC boundary, so a
 * **server** page cannot write `<Button component={Link} />` — Mantine would receive a function and
 * fail at runtime with "Functions cannot be passed directly to Client Components". This client
 * component owns the `<Link>` instead, so a server page passes only strings and nodes.
 *
 * `variant` and `leftSection` exist because the dashboard's secondary/navigational buttons ("Edit",
 * "Reset Filter") need them; without those two props every server page would go back to hand-rolling
 * a link button and reintroduce the boundary violation.
 */
export function PrimaryAction({
    href,
    onClick,
    children,
    loading,
    color = "brand",
    disabled,
    variant = "filled",
    leftSection,
    size = "md",
}: {
    href?: string;
    onClick?: () => void;
    children: ReactNode;
    loading?: boolean;
    color?: string;
    disabled?: boolean;
    variant?: string;
    leftSection?: ReactNode;
    size?: "sm" | "md" | "lg";
}) {
    if (href) {
        return (
            <Button
                component={Link}
                href={href}
                variant={variant}
                size={size}
                color={color}
                radius="md"
                leftSection={leftSection}
            >
                {children}
            </Button>
        );
    }

    return (
        <Button
            variant={variant}
            size={size}
            color={color}
            radius="md"
            onClick={onClick}
            loading={loading}
            disabled={disabled}
            leftSection={leftSection}
        >
            {children}
        </Button>
    );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
    return (
        <Anchor component={Link} href={href} size="sm" fw={500}>
            {children}
        </Anchor>
    );
}
