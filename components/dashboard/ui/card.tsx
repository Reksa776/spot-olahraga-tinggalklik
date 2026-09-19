import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Card — the dashboard's only panel surface.
 *
 * One treatment, used by every card, table wrapper and dialog body: `rounded-card`, a hairline
 * `border-border`, `bg-card` and the single resting `shadow-card`. Nothing in the dashboard adds a
 * second shadow or a second radius, which is what keeps thirty panels on a page looking like one
 * product instead of thirty widgets.
 *
 * The padding lives on `CardContent`/`CardHeader` rather than the root so a card can hold a
 * full-bleed table (header padded, table flush) without a wrapper hack.
 */
function Card({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="card"
            className={cn(
                "rounded-card border border-border bg-card text-card-foreground shadow-card",
                className
            )}
            {...props}
        />
    );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="card-header"
            className={cn("flex flex-col gap-1 px-5 pt-5", className)}
            {...props}
        />
    );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="card-title"
            className={cn("text-[0.9375rem] font-semibold leading-tight", className)}
            {...props}
        />
    );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="card-description"
            className={cn("text-xs leading-relaxed text-muted-foreground", className)}
            {...props}
        />
    );
}

/** Optional right-hand slot on a header row (a count, a link, a small action). */
function CardAction({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="card-action"
            className={cn("ml-auto shrink-0 self-start", className)}
            {...props}
        />
    );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="card-content" className={cn("p-5", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="card-footer"
            className={cn("flex items-center gap-2 px-5 pb-5", className)}
            {...props}
        />
    );
}

export {
    Card,
    CardHeader,
    CardTitle,
    CardDescription,
    CardAction,
    CardContent,
    CardFooter,
};
