import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Button, tuned for the TinggalKlik back office.
 *
 * The stock component's resting height is 36px, which the dashboard brief explicitly rejects
 * ("tiny buttons" is listed as a defect of the previous UI). The default here is 40px with 16px
 * horizontal padding, and `sm` (36px) is reserved for dense toolbar rows — so hierarchy is decided
 * by variant, not by shrinking the control.
 *
 * Colours are semantic tokens only (`bg-primary`, `text-primary-foreground`, `border-input`), which
 * is what makes the accent switcher repaint every button in the dashboard without touching a
 * component.
 */
const buttonVariants = cva(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-field text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                default: "bg-primary text-primary-foreground hover:bg-primary/90",
                destructive:
                    "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                outline:
                    "border border-input bg-card text-foreground hover:bg-muted hover:text-foreground",
                secondary:
                    "bg-secondary text-secondary-foreground hover:bg-secondary/70",
                ghost: "text-foreground hover:bg-muted",
                link: "text-primary underline-offset-4 hover:underline",
            },
            size: {
                default: "h-10 px-4 py-2 [&_svg]:size-4",
                sm: "h-9 px-3 text-[0.8125rem] [&_svg]:size-3.5",
                lg: "h-11 px-5 text-[0.9375rem] [&_svg]:size-4",
                icon: "size-10 [&_svg]:size-4",
                "icon-sm": "size-9 [&_svg]:size-3.5",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    }
);

function Button({
    className,
    variant,
    size,
    asChild = false,
    ...props
}: React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> & {
        asChild?: boolean;
    }) {
    const Comp = asChild ? Slot : "button";

    return (
        <Comp
            className={cn(buttonVariants({ variant, size }), className)}
            {...props}
        />
    );
}

export { Button, buttonVariants };
