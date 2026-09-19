"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/dashboard/ui/button";

/**
 * ==========================================
 * PAGINATION
 * ==========================================
 *
 * Two shapes are needed in the back office, and they are deliberately separate components because
 * they answer different questions:
 *
 *   `Pagination*`   the shadcn markup — generic wrappers a caller composes. Used with `asChild` and
 *                   a `<Link>` for a server-rendered page, or a `<button>` for a client list.
 *   `Pager`         the dashboard's numbered control, for a CLIENT component that holds `page` in
 *                   state and re-fetches. It owns the windowing rule so a 40-page result does not
 *                   render 40 buttons.
 *
 * `LinkPagination` in `primitives.tsx` remains the server-rendered counterpart: it builds its own
 * hrefs from strings, because a server component cannot be handed a callback. A client list uses
 * `Pager` instead, for the same reason mirrored — it needs `onPageChange`, which cannot be an href.
 *
 * The windowing rule is intentionally identical to `LinkPagination`'s: first, last, and one either
 * side of the current page, with an ellipsis for each gap. Two pagers that window differently would
 * be a visible inconsistency on adjacent screens.
 */

function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
    return (
        <nav
            role="navigation"
            aria-label="Pagination"
            data-slot="pagination"
            className={cn("mx-auto flex w-full justify-center", className)}
            {...props}
        />
    );
}

function PaginationContent({ className, ...props }: React.ComponentProps<"ul">) {
    return (
        <ul
            data-slot="pagination-content"
            className={cn("flex flex-row flex-wrap items-center gap-1", className)}
            {...props}
        />
    );
}

function PaginationItem(props: React.ComponentProps<"li">) {
    return <li data-slot="pagination-item" {...props} />;
}

function PaginationLink({
    className,
    isActive,
    ...props
}: React.ComponentProps<typeof Button> & { isActive?: boolean }) {
    return (
        <Button
            data-slot="pagination-link"
            aria-current={isActive ? "page" : undefined}
            variant={isActive ? "default" : "outline"}
            size="icon-sm"
            className={cn("tabular-nums", className)}
            {...props}
        />
    );
}

function PaginationPrevious({
    className,
    ...props
}: React.ComponentProps<typeof PaginationLink>) {
    return (
        <PaginationLink aria-label="Halaman sebelumnya" className={className} {...props}>
            <ChevronLeft />
        </PaginationLink>
    );
}

function PaginationNext({
    className,
    ...props
}: React.ComponentProps<typeof PaginationLink>) {
    return (
        <PaginationLink aria-label="Halaman berikutnya" className={className} {...props}>
            <ChevronRight />
        </PaginationLink>
    );
}

function PaginationEllipsis({ className, ...props }: React.ComponentProps<"span">) {
    return (
        <span
            aria-hidden
            data-slot="pagination-ellipsis"
            className={cn(
                "flex size-9 items-center justify-center text-muted-foreground",
                className
            )}
            {...props}
        >
            <MoreHorizontal className="size-4" />
        </span>
    );
}

/**
 * The controlled pager: `page` in, `onPageChange` out. Renders nothing for a single page, which is
 * what keeps a small result set from carrying a dead control.
 */
function Pager({
    page,
    totalPages,
    onPageChange,
    label = "Halaman",
    className,
}: {
    page: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    /** The count line's noun, e.g. "Halaman". */
    label?: string;
    className?: string;
}) {
    if (totalPages <= 1) {
        return null;
    }

    /* Same window as `LinkPagination`: edges, neighbours, ellipsis between. */
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
        <div className={cn("flex flex-wrap items-center justify-between gap-4", className)}>
            <span className="text-sm text-muted-foreground">
                {label} {page} dari {totalPages}
            </span>

            <Pagination className="mx-0 w-auto">
                <PaginationContent>
                    <PaginationItem>
                        <PaginationPrevious
                            disabled={page <= 1}
                            onClick={() => onPageChange(Math.max(1, page - 1))}
                        />
                    </PaginationItem>

                    {windowed.map((target, index) =>
                        target === null ? (
                            <PaginationItem key={`gap-${index}`}>
                                <PaginationEllipsis />
                            </PaginationItem>
                        ) : (
                            <PaginationItem key={target}>
                                <PaginationLink
                                    isActive={target === page}
                                    onClick={() => onPageChange(target)}
                                >
                                    {target}
                                </PaginationLink>
                            </PaginationItem>
                        )
                    )}

                    <PaginationItem>
                        <PaginationNext
                            disabled={page >= totalPages}
                            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
                        />
                    </PaginationItem>
                </PaginationContent>
            </Pagination>
        </div>
    );
}

export {
    Pagination,
    PaginationContent,
    PaginationItem,
    PaginationLink,
    PaginationPrevious,
    PaginationNext,
    PaginationEllipsis,
    Pager,
};
