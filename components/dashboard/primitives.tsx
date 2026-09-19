"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/dashboard/ui/alert";
import { Badge } from "@/components/dashboard/ui/badge";
import { Button } from "@/components/dashboard/ui/button";
import {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/dashboard/ui/card";
import { ScrollArea } from "@/components/dashboard/ui/misc";
import { Skeleton } from "@/components/dashboard/ui/separator";
import {
    Table,
    TableBody,
    TableCaption,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/dashboard/ui/table";

/**
 * ==========================================
 * DASHBOARD PRIMITIVES (shadcn/ui)
 * ==========================================
 *
 * The shared vocabulary every back-office page is built from. It has the same public API as the
 * Mantine version it replaces — same names, same props — so the 38 pages and 22 components that
 * consume it did not have to change while the foundation did.
 *
 *   PageHeader      the title block ~15 admin pages used to hand-roll
 *   SectionCard     the panel ~40 blocks used to hand-roll
 *   StatCard        the KPI tile, on the admin overview and five other pages
 *   StatusBadge     semantic status pills, so a page cannot invent its own green
 *   DataTable       the table, with its loading, empty and error states made explicit
 *   DataRow         the "label left, value right" row every summary panel renders
 *   LinkPagination  the server-renderable pager (hrefs are built here, not passed in)
 *   EmptyBlock / ErrorBlock / LoadingBlock   the three list states
 *
 * THE VISUAL LANGUAGE
 * -------------------
 * Three surfaces, and nothing invents a fourth:
 *
 *   PANEL  `SectionCard` / `DataTable`  — `rounded-card`, hairline `border-border`, `bg-card`,
 *                                         the one `shadow-card` elevation
 *   TILE   `StatCard`                   — the same panel, with the number as the hero
 *   ROW    `DataRow`                    — one rhythm for every activity list, hairline separated
 *
 * Type does the hierarchy (uppercase 11px labels, 14px body, 30px KPI numbers) and colour is only
 * ever used for one job: `primary` for the current action, a semantic tone for a status, and
 * `muted-foreground` for everything secondary. Every value is a token, so the accent switcher and
 * dark mode repaint the whole dashboard — including the pages that have not been touched yet.
 *
 * SERVER/CLIENT BOUNDARY
 * ----------------------
 * Everything here is a client component, but it is designed to be called FROM server components.
 * That constrains the props: no callbacks and no render functions, because a server component
 * cannot pass a function across the boundary. So `DataTable` takes already-built `cells` (ReactNode)
 * rather than a `render` function, `ErrorBlock` takes an `action` node rather than an `onRetry`
 * callback, and `LinkPagination` is given strings and builds its own hrefs. Client callers are free
 * to pass whatever they like into those nodes.
 */

/* ------------------------------------------------------------------------------------------------
 * SEMANTIC TONES
 * ------------------------------------------------------------------------------------------------
 * The brief is explicit that status colour stays semantic and must not be repainted with the accent.
 * One table, used everywhere, is how that stays true: a mapping that exists once cannot drift per
 * page. `destructive` is deliberately absent from the accent palettes for the same reason.
 */
export type Tone = "success" | "error" | "warn" | "info" | "pending" | "neutral" | "brand";

type BadgeVariant = "default" | "secondary" | "outline" | "success" | "warning" | "danger" | "info" | "muted";

const TONE_VARIANT: Record<Tone, BadgeVariant> = {
    success: "success",
    error: "danger",
    warn: "warning",
    info: "info",
    pending: "warning",
    neutral: "muted",
    brand: "default",
};

/** The tone's solid hue, for a dot or a chart series. Mirrors the badge palette above. */
const TONE_DOT: Record<Tone, string> = {
    success: "bg-emerald-500",
    error: "bg-destructive",
    warn: "bg-amber-500",
    info: "bg-sky-500",
    pending: "bg-amber-500",
    neutral: "bg-muted-foreground",
    brand: "bg-primary",
};

export function useToneColor(tone: Tone): string {
    return TONE_DOT[tone];
}

export function StatusBadge({
    tone = "neutral",
    children,
    size = "md",
    withDot = false,
}: {
    tone?: Tone;
    children: ReactNode;
    size?: "sm" | "md" | "lg";
    /** Prefixes a tone-coloured dot. Useful where several statuses sit in one column. */
    withDot?: boolean;
}) {
    return (
        <Badge
            variant={TONE_VARIANT[tone]}
            className={cn(
                size === "sm" && "px-2 py-0.5 text-[0.6875rem]",
                size === "lg" && "px-3 py-1 text-[0.8125rem]"
            )}
        >
            {withDot ? (
                <span
                    aria-hidden
                    className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])}
                />
            ) : null}
            {children}
        </Badge>
    );
}

/* ------------------------------------------------------------------------------------------------
 * PAGE HEADER
 * ------------------------------------------------------------------------------------------------
 * Title left, actions right, and a brand tick beside the eyebrow. On a narrow screen the actions
 * wrap under the title rather than being pushed off-canvas.
 */
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
        <div className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
            <div className="min-w-0 flex-1 basis-80">
                {eyebrow ? (
                    <div className="mb-1.5 flex items-center gap-2">
                        <span
                            aria-hidden
                            className="h-3.5 w-[3px] shrink-0 rounded-full bg-primary"
                        />
                        <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-primary">
                            {eyebrow}
                        </span>
                    </div>
                ) : null}

                <h1 className="text-2xl font-bold leading-tight tracking-tight">{title}</h1>

                {description ? (
                    <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                        {description}
                    </p>
                ) : null}
            </div>

            {actions ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
            ) : null}
        </div>
    );
}

/* ------------------------------------------------------------------------------------------------
 * SECTION CARD
 * ------------------------------------------------------------------------------------------------
 * The header is separated from the body by a hairline, which is what makes a stacked page readable:
 * the eye gets a rule to stop at instead of a run of whitespace.
 *
 * `padding` and `mih` are accepted for source compatibility with the Mantine version; `padding`
 * maps onto the same spacing scale and `mih` onto a minimum height, so a page that used them keeps
 * its proportions instead of collapsing.
 */
const PADDING_CLASS: Record<string, string> = {
    xs: "p-3",
    sm: "p-4",
    md: "p-4",
    lg: "p-5",
    xl: "p-6",
    "0": "p-0",
};

export function SectionCard({
    title,
    description,
    actions,
    children,
    padding,
    mih,
    className,
    bodyClassName,
}: {
    title?: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
    /** Accepted from the previous API: a spacing key, mapped onto the same scale. */
    padding?: string | number;
    /** Accepted from the previous API: a minimum height in pixels. */
    mih?: number;
    className?: string;
    bodyClassName?: string;
}) {
    const hasHeader = Boolean(title || actions);
    const paddingClass = padding !== undefined ? PADDING_CLASS[String(padding)] ?? "p-5" : "p-5";

    return (
        <Card className={cn("flex h-full flex-col", className)} style={mih ? { minHeight: mih } : undefined}>
            {hasHeader ? (
                <CardHeader className="flex-row items-start justify-between gap-3 border-b border-border pb-4">
                    <div className="min-w-0">
                        {title ? <CardTitle>{title}</CardTitle> : null}
                        {description ? (
                            <CardDescription className="mt-1">{description}</CardDescription>
                        ) : null}
                    </div>

                    {actions ? (
                        <CardAction className="flex items-center gap-2">{actions}</CardAction>
                    ) : null}
                </CardHeader>
            ) : null}

            {hasHeader ? (
                <CardContent className={cn(paddingClass, "min-h-0 flex-1", bodyClassName)}>
                    {children}
                </CardContent>
            ) : (
                <div className={cn(paddingClass, "min-h-0 flex-1", bodyClassName)}>{children}</div>
            )}
        </Card>
    );
}

/* ------------------------------------------------------------------------------------------------
 * STAT CARD
 * ------------------------------------------------------------------------------------------------
 * The number is the hero: 30px, tight tracking, tabular figures. The icon rides in a soft tinted
 * chip, which is the only place a semantic colour appears on an otherwise neutral tile.
 */
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
        <Card className="flex h-full flex-col p-5">
            <div className="flex items-start justify-between gap-3">
                <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground">
                    {label}
                </span>

                {icon ? (
                    <span
                        className={cn(
                            "flex size-9 shrink-0 items-center justify-center rounded-field",
                            tone === "error" && "bg-destructive/10 text-destructive",
                            tone === "success" && "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
                            tone === "info" && "bg-sky-500/12 text-sky-600 dark:text-sky-400",
                            tone === "pending" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                            tone === "warn" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                            tone === "neutral" && "bg-muted text-muted-foreground",
                            tone === "brand" && "bg-primary/10 text-primary"
                        )}
                    >
                        {icon}
                    </span>
                ) : null}
            </div>

            <div className="mt-4 text-[1.875rem] font-bold leading-none tracking-tight tabular-nums">
                {value}
            </div>

            {hint ? <p className="mt-2 text-xs text-muted-foreground">{hint}</p> : null}

            {footer ? (
                <>
                    <div className="my-4 h-px bg-border" />
                    {footer}
                </>
            ) : null}
        </Card>
    );
}

export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div
            className={cn(
                "grid grid-cols-1 gap-4 xs:grid-cols-2 xl:grid-cols-4",
                className
            )}
        >
            {children}
        </div>
    );
}

/* ------------------------------------------------------------------------------------------------
 * DATA ROW
 * ------------------------------------------------------------------------------------------------
 * `leading` is an icon, a rank chip or a badge; `trailing` is a value, a badge or a stacked pair.
 * `divider` is off for the first row in a list, which is how a panel avoids a rule at its top.
 */
export function DataRow({
    leading,
    title,
    meta,
    trailing,
    divider = true,
    align = "center",
    className,
}: {
    leading?: ReactNode;
    title?: ReactNode;
    meta?: ReactNode;
    trailing?: ReactNode;
    divider?: boolean;
    align?: "center" | "flex-start";
    className?: string;
}) {
    return (
        <div
            className={cn(
                "flex justify-between gap-4 py-3",
                align === "center" ? "items-center" : "items-start",
                divider && "border-t border-border",
                className
            )}
        >
            {leading ? <div className="shrink-0">{leading}</div> : null}

            {title || meta ? (
                <div className="min-w-0 flex-1">
                    {title ? (
                        <p className="truncate text-sm font-semibold leading-tight">{title}</p>
                    ) : null}
                    {meta ? (
                        <p className="mt-1 truncate text-xs text-muted-foreground">{meta}</p>
                    ) : null}
                </div>
            ) : (
                <div className="flex-1" />
            )}

            {trailing ? <div className="shrink-0">{trailing}</div> : null}
        </div>
    );
}

/* ------------------------------------------------------------------------------------------------
 * TABLE
 * ------------------------------------------------------------------------------------------------
 * The viewport is what scrolls (never the page), the three states are mutually exclusive, and a
 * failed fetch can never be mistaken for "no data".
 */
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

const ALIGN_CLASS: Record<"left" | "center" | "right", string> = {
    left: "text-left",
    center: "text-center",
    right: "text-right",
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
            <div className="flex flex-col gap-2">
                <Skeleton className="h-9 w-full" />
                {Array.from({ length: loadingRows }).map((_, index) => (
                    <Skeleton key={index} className="h-7 w-full" />
                ))}
            </div>
        );
    }

    if (rows.length === 0 && empty) {
        return <>{empty}</>;
    }

    return (
        <div className="flex flex-col gap-4">
            {/* Horizontal scroll rather than a collapsing layout: a 12-column order table stays
                readable on a phone instead of becoming illegible columns. */}
            <ScrollArea className="w-full">
                <Table style={minWidth ? { minWidth } : undefined}>
                    {caption ? <TableCaption>{caption}</TableCaption> : null}

                    <TableHeader>
                        <TableRow className="hover:bg-transparent">
                            {columns.map((column, index) => (
                                <TableHead
                                    key={index}
                                    className={ALIGN_CLASS[column.align ?? "left"]}
                                    style={{ width: column.width }}
                                >
                                    {column.header}
                                </TableHead>
                            ))}
                        </TableRow>
                    </TableHeader>

                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row.key}>
                                {row.cells.map((cell, index) => (
                                    <TableCell
                                        key={index}
                                        className={ALIGN_CLASS[columns[index]?.align ?? "left"]}
                                    >
                                        {cell}
                                    </TableCell>
                                ))}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </ScrollArea>

            {footer ? footer : null}
        </div>
    );
}

/** A filter bar above a table or list, so a filtered page reads as "toolbar, then results". */
export function TableToolbar({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <Card className={cn("mb-4 p-4", className)}>
            <div className="flex flex-wrap items-end gap-4">{children}</div>
        </Card>
    );
}

/* ------------------------------------------------------------------------------------------------
 * STATES
 * ------------------------------------------------------------------------------------------------
 * Each is a different shape on purpose: empty is centred and quiet, error is an alert that cannot be
 * missed, loading is a placeholder. A page that renders the wrong one is a bug you can see.
 */
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
        <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                {icon ?? <span className="text-lg font-bold">—</span>}
            </span>

            <p className="text-sm font-semibold">{title}</p>

            {description ? (
                <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                    {description}
                </p>
            ) : null}

            {action ? <div className="mt-1">{action}</div> : null}
        </div>
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
        <Alert variant="danger">
            <div className="flex min-w-0 flex-1 flex-col gap-3">
                <AlertTitle>{title}</AlertTitle>
                <AlertDescription>{message}</AlertDescription>
                {action ? <div>{action}</div> : null}
            </div>
        </Alert>
    );
}

export function LoadingBlock({
    label = "Memuat…",
    height = 240,
}: {
    label?: ReactNode;
    height?: number;
}) {
    return (
        <div
            className="flex items-center justify-center gap-3"
            style={{ minHeight: height }}
        >
            <span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
            <span className="text-sm text-muted-foreground">{label}</span>
        </div>
    );
}

export function InfoNote({
    children,
    tone = "info",
    className,
}: {
    children: ReactNode;
    tone?: Tone;
    className?: string;
}) {
    return (
        <Alert
            variant={
                tone === "warn" || tone === "pending"
                    ? "warning"
                    : tone === "error"
                      ? "danger"
                      : tone === "success"
                        ? "success"
                        : "info"
            }
            className={className}
        >
            <AlertDescription className="text-foreground">{children}</AlertDescription>
        </Alert>
    );
}

/* ------------------------------------------------------------------------------------------------
 * ACCESS DENIED
 * ------------------------------------------------------------------------------------------------
 *
 * WHY A CLIENT COMPONENT
 * ----------------------
 * The back-office layouts are server components, and they must render a "you do not have access"
 * panel with a way out. A server component cannot build a linked button by handing a component
 * reference to a client one, so this component owns the `<Link>` itself and is called by props
 * (`actionHref` / `actionLabel`). That is the same constraint the Mantine version was built around,
 * and it is asserted by the boundary guard in `__tests__/ui-consolidation`.
 *
 * The copy is supplied by the caller because each surface explains a different denial (no organiser
 * membership, no platform role, the page-level permission the service rejected). The wording is
 * unchanged from the previous version.
 *
 * WHY THERE IS A `standalone` VARIANT
 * ------------------------------------
 * A denial is still a back-office route: `app/layout.tsx` renders the retail `<Footer>` for every
 * route, and `app/globals.css` suppresses it only under `body:has([data-dashboard-shell])`. When a
 * LAYOUT denies access it renders this panel *instead of* `DashboardShell`, so nothing carries the
 * marker and the marketing footer reappears underneath a "no access" card on `/organizer/**` and
 * `/platform/**`. `standalone` is those two call sites: it adds the marker and the page surface the
 * shell would otherwise supply.
 *
 * A PAGE-level denial (`/platform/sports`, `/platform/venues`) is rendered *inside* the shell,
 * which already carries both — so it keeps the default flat form and no marker is duplicated. In
 * either case this is presentational only: it grants nothing.
 */
export function AccessDeniedPanel({
    title,
    body,
    actionHref,
    actionLabel,
    standalone = false,
}: {
    title: ReactNode;
    body?: ReactNode;
    actionHref?: string;
    actionLabel?: ReactNode;
    /** Render as a whole back-office surface (used by the layouts, which replace the shell). */
    standalone?: boolean;
}) {
    const panel = (
        <div className="mx-auto w-full max-w-xl px-4 py-16">
            <Card className="p-8">
                <div className="flex flex-col items-center gap-4 text-center">
                    <span className="flex size-12 items-center justify-center rounded-full bg-amber-500/15 text-lg font-bold text-amber-600 dark:text-amber-400">
                        !
                    </span>

                    <h2 className="text-lg font-semibold leading-tight">{title}</h2>

                    {body ? (
                        <div className="text-sm leading-relaxed text-muted-foreground">{body}</div>
                    ) : null}

                    {actionHref && actionLabel ? (
                        <Button asChild variant="secondary" className="mt-1">
                            <Link href={actionHref}>{actionLabel}</Link>
                        </Button>
                    ) : null}
                </div>
            </Card>
        </div>
    );

    if (!standalone) return panel;

    return (
        <div
            data-dashboard-shell
            className="flex min-h-screen w-full flex-col bg-background text-foreground"
        >
            {panel}
        </div>
    );
}

/* ------------------------------------------------------------------------------------------------
 * PAGINATION
 * ------------------------------------------------------------------------------------------------
 * String-driven so a server component can render it: the hrefs are built here instead of being
 * passed in as a function. The count line is on the left, the control on the right.
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

    /*
     * A compact window of page numbers with first/last, so a long list does not render 40 links.
     * The window is `null` where an ellipsis belongs.
     */
    const windowed: (number | null)[] = [];
    const push = (value: number | null) => {
        if (windowed[windowed.length - 1] !== value) windowed.push(value);
    };

    for (let target = 1; target <= totalPages; target += 1) {
        const isEdge = target === 1 || target === totalPages;
        const isNear = Math.abs(target - page) <= 1;

        if (isEdge || isNear) push(target);
        else push(null);
    }

    return (
        <Card className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <span className="text-sm text-muted-foreground">
                    {label} {page} dari {totalPages}
                </span>

                <nav aria-label={label} className="flex items-center gap-1">
                    <Button asChild variant="outline" size="sm" aria-disabled={page <= 1}>
                        <Link
                            href={hrefFor(Math.max(1, page - 1))}
                            aria-hidden={page <= 1}
                            tabIndex={page <= 1 ? -1 : undefined}
                        >
                            Sebelumnya
                        </Link>
                    </Button>

                    {windowed.map((target, index) =>
                        target === null ? (
                            <span
                                key={`gap-${index}`}
                                className="px-1.5 text-sm text-muted-foreground"
                            >
                                …
                            </span>
                        ) : (
                            <Button
                                key={target}
                                asChild
                                size="sm"
                                variant={target === page ? "default" : "outline"}
                                className="tabular-nums"
                            >
                                <Link
                                    href={hrefFor(target)}
                                    aria-current={target === page ? "page" : undefined}
                                >
                                    {target}
                                </Link>
                            </Button>
                        )
                    )}

                    <Button
                        asChild
                        variant="outline"
                        size="sm"
                        aria-disabled={page >= totalPages}
                    >
                        <Link
                            href={hrefFor(Math.min(totalPages, page + 1))}
                            aria-hidden={page >= totalPages}
                            tabIndex={page >= totalPages ? -1 : undefined}
                        >
                            Berikutnya
                        </Link>
                    </Button>
                </nav>
            </div>
        </Card>
    );
}

/* ------------------------------------------------------------------------------------------------
 * MISC
 * ------------------------------------------------------------------------------------------------
 */
export function Money({
    value,
    size = "sm",
    fw = 600,
}: {
    value: ReactNode;
    size?: string;
    fw?: number;
}) {
    return (
        <span
            className="whitespace-nowrap tabular-nums"
            style={{
                fontSize: size === "xs" ? "0.75rem" : size === "sm" ? "0.875rem" : undefined,
                fontWeight: fw,
            }}
        >
            {value}
        </span>
    );
}

/**
 * A link button, for a *server* page.
 *
 * WHY IT TAKES `href` RATHER THAN A `component`
 * ---------------------------------------------
 * The same rule as `AccessDeniedPanel`: a component reference cannot cross the server/client
 * boundary, so a server page cannot write `<Button asChild><Link/></Button>` inline — the Link would
 * be a function prop on a client component and fail at runtime. This client component owns the
 * `<Link>`, so a server page passes only strings and nodes.
 *
 * `variant` and `leftSection` exist because the dashboard's secondary and navigational buttons
 * ("Edit", "Reset Filter", "Laporan") need them; without those props every server page would go back
 * to hand-rolling a link and reintroduce the boundary violation.
 */
export function PrimaryAction({
    href,
    onClick,
    children,
    loading,
    color,
    disabled,
    variant = "filled",
    leftSection,
    size = "md",
    className,
    type = "submit",
}: {
    href?: string;
    onClick?: () => void;
    children: ReactNode;
    loading?: boolean;
    /** Legacy prop from the Mantine API: `"ink"` renders the neutral variant. */
    color?: string;
    disabled?: boolean;
    /** `filled` | `light` | `outline` | `subtle` (Mantine names) or the shadcn names directly. */
    variant?: string;
    leftSection?: ReactNode;
    size?: "sm" | "md" | "lg";
    className?: string;
    /**
     * Defaults to `"submit"` — the HTML default for a `<button>` with no `type`, and therefore the
     * behaviour every call site already had under Mantine. A form's primary action is almost always
     * a submit, and the handful of call sites that open a dialog are outside any `<form>`, where
     * `submit` is inert. Passing `"button"` explicitly is how a caller opts out.
     */
    type?: "button" | "submit" | "reset";
}) {
    /*
     * Mantine's variant names and shadcn's are mapped here, once, so a page can keep the prop it
     * already had. `color="ink"` was the previous "neutral, not brand" intent and becomes the
     * outline variant.
     */
    const VARIANT_MAP: Record<string, "default" | "secondary" | "outline" | "ghost"> = {
        filled: "default",
        light: "secondary",
        subtle: "ghost",
        outline: "outline",
        default: "default",
        secondary: "secondary",
        ghost: "ghost",
    };

    const shadcnVariant =
        color === "ink" ? "outline" : VARIANT_MAP[variant] ?? "default";

    const sizeProp = size === "sm" ? "sm" : size === "lg" ? "lg" : "default";

    const content = (
        <>
            {loading ? (
                <span className="size-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" />
            ) : (
                leftSection
            )}
            {children}
        </>
    );

    if (href) {
        return (
            <Button asChild variant={shadcnVariant} size={sizeProp} className={className}>
                <Link href={href}>{content}</Link>
            </Button>
        );
    }

    return (
        <Button
            type={type}
            variant={shadcnVariant}
            size={sizeProp}
            onClick={onClick}
            disabled={disabled || loading}
            className={className}
        >
            {content}
        </Button>
    );
}

export function TextLink({
    href,
    children,
    className,
}: {
    href: string;
    children: ReactNode;
    className?: string;
}) {
    return (
        <Link
            href={href}
            className={cn(
                "text-sm font-semibold text-primary underline-offset-4 hover:underline",
                className
            )}
        >
            {children}
        </Link>
    );
}

/**
 * A quiet heading for a block that is NOT a card — used where a page groups several panels under
 * one label and a full `SectionCard` header would nest a panel inside a panel.
 */
export function SectionHeading({
    title,
    description,
    actions,
}: {
    title: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
                <h2 className="text-lg font-semibold leading-tight tracking-tight">{title}</h2>
                {description ? (
                    <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                ) : null}
            </div>

            {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
        </div>
    );
}
