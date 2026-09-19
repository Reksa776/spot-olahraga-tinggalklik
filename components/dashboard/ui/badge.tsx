import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Badge, extended with the six semantic status variants the back office actually uses.
 *
 * The dashboard shows order, payment, refund, payout and connection states in dozens of places. A
 * page that tints its own pill is how one screen ends up with three different greens for
 * "completed", so the tones live here once: success, warning, danger, info, muted and the brand
 * `default`. Status colour is deliberately independent of the accent switcher — a failed payment is
 * red in every theme.
 */
const badgeVariants = cva(
    "inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors [&_svg]:pointer-events-none [&_svg]:size-3",
    {
        variants: {
            variant: {
                default: "border-transparent bg-primary/10 text-primary",
                secondary: "border-transparent bg-secondary text-secondary-foreground",
                outline: "border-border bg-transparent text-foreground",
                success: "border-transparent bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
                warning: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
                danger: "border-transparent bg-destructive/12 text-destructive",
                info: "border-transparent bg-sky-500/12 text-sky-700 dark:text-sky-300",
                muted: "border-transparent bg-muted text-muted-foreground",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    }
);

function Badge({
    className,
    variant,
    asChild = false,
    ...props
}: React.ComponentProps<"span"> &
    VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
    const Comp = asChild ? Slot : "span";

    return (
        <Comp
            data-slot="badge"
            className={cn(badgeVariants({ variant }), className)}
            {...props}
        />
    );
}

export { Badge, badgeVariants };
