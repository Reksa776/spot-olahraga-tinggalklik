import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Alert with the dashboard's semantic tones.
 *
 * The back office uses alerts for three distinct jobs — a failed fetch (danger), a warning about a
 * destructive action (warning), and a neutral note about the current state (info) — and the
 * previous UI rendered each with a different hand-written tinted box. One component, one set of
 * tones.
 */
const alertVariants = cva(
    "relative flex w-full gap-3 rounded-card border px-4 py-3.5 text-sm",
    {
        variants: {
            variant: {
                default: "border-border bg-card text-card-foreground",
                info: "border-sky-500/25 bg-sky-500/8 text-foreground",
                warning: "border-amber-500/30 bg-amber-500/10 text-foreground",
                danger: "border-destructive/30 bg-destructive/8 text-foreground",
                success: "border-emerald-500/30 bg-emerald-500/10 text-foreground",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    }
);

function Alert({
    className,
    variant,
    ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
    return (
        <div
            role="alert"
            data-slot="alert"
            className={cn(alertVariants({ variant }), className)}
            {...props}
        />
    );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="alert-title"
            className={cn("text-sm font-semibold leading-tight", className)}
            {...props}
        />
    );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="alert-description"
            className={cn("text-sm text-muted-foreground", className)}
            {...props}
        />
    );
}

export { Alert, AlertTitle, AlertDescription };
