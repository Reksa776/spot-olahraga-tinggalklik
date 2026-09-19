import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Table, styled as a working tool rather than a spreadsheet.
 *
 * Three decisions carry the "polished tables" requirement:
 *
 *   • the header is a slightly recessed `bg-muted/60` band with uppercase 11px labels, so the eye
 *     separates labels from data instantly;
 *   • rows are separated by a hairline and hover to `bg-muted/40`, which is what makes a wide table
 *     scannable without zebra striping;
 *   • numeric cells can opt into tabular figures (`tabular-nums`), so money columns line up as
 *     digits instead of ragged text.
 *
 * The scroll container lives in the wrapper (`DataTableViewport` in the dashboard primitives), not
 * here, because only the caller knows whether the table is full-bleed inside a card or padded.
 */
function Table({ className, ...props }: React.ComponentProps<"table">) {
    return (
        <table
            data-slot="table"
            className={cn("w-full caption-bottom border-collapse text-sm", className)}
            {...props}
        />
    );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
    return (
        <thead
            data-slot="table-header"
            className={cn("[&_tr]:border-b [&_tr]:border-border", className)}
            {...props}
        />
    );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
    return (
        <tbody
            data-slot="table-body"
            className={cn("[&_tr:last-child]:border-0", className)}
            {...props}
        />
    );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
    return (
        <tfoot
            data-slot="table-footer"
            className={cn("border-t border-border bg-muted/50 font-medium", className)}
            {...props}
        />
    );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
    return (
        <tr
            data-slot="table-row"
            className={cn(
                "border-b border-border transition-colors hover:bg-muted/40 data-[state=selected]:bg-muted",
                className
            )}
            {...props}
        />
    );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
    return (
        <th
            data-slot="table-head"
            className={cn(
                "h-11 whitespace-nowrap bg-muted/60 px-3 text-left align-middle text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground",
                className
            )}
            {...props}
        />
    );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
    return (
        <td
            data-slot="table-cell"
            className={cn("px-3 py-3 align-middle", className)}
            {...props}
        />
    );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
    return (
        <caption
            data-slot="table-caption"
            className={cn("mt-3 text-xs text-muted-foreground", className)}
            {...props}
        />
    );
}

export {
    Table,
    TableHeader,
    TableBody,
    TableFooter,
    TableHead,
    TableRow,
    TableCell,
    TableCaption,
};
