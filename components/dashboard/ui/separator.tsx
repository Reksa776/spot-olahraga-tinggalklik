import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";

import { cn } from "@/lib/utils";

function Separator({
    className,
    orientation = "horizontal",
    decorative = true,
    ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
    return (
        <SeparatorPrimitive.Root
            decorative={decorative}
            orientation={orientation}
            data-slot="separator"
            className={cn(
                "shrink-0 bg-border",
                orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
                className
            )}
            {...props}
        />
    );
}

/**
 * Skeleton: the dashboard's loading placeholder.
 *
 * Tables, cards and forms all load through this one treatment — a card-shaped block for a panel, a
 * row of thin bars for a table — so a slow page looks like the page it is becoming instead of a
 * spinner floating in an empty canvas.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="skeleton"
            className={cn("animate-pulse rounded-field bg-muted", className)}
            {...props}
        />
    );
}

export { Separator, Skeleton };
