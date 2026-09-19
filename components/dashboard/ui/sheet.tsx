"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Sheet — a Radix dialog that slides in from an edge.
 *
 * Used for exactly one thing in this dashboard: the mobile navigation drawer. `side="left"` with a
 * full-height panel is the phone/tablet behaviour the Mantine `AppShell.Navbar` had, and it keeps
 * the same guarantees — the drawer closes on navigation, on Escape and on overlay click, and the
 * body behind it cannot scroll while it is open (Radix handles both).
 */
const sheetVariants = cva(
    "fixed z-50 flex flex-col gap-0 bg-sidebar text-sidebar-foreground shadow-pop outline-none transition ease-in-out",
    {
        variants: {
            side: {
                top: "inset-x-0 top-0 h-auto border-b border-sidebar-border",
                bottom: "inset-x-0 bottom-0 h-auto border-t border-sidebar-border",
                left: "inset-y-0 left-0 h-full w-[276px] max-w-[85vw] border-r border-sidebar-border",
                right: "inset-y-0 right-0 h-full w-[276px] max-w-[85vw] border-l border-sidebar-border",
            },
        },
        defaultVariants: {
            side: "right",
        },
    }
);

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
    return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
    return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
    return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetContent({
    className,
    children,
    side = "right",
    showCloseButton = true,
    ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> &
    VariantProps<typeof sheetVariants> & { showCloseButton?: boolean }) {
    return (
        <SheetPrimitive.Portal>
            {/* Same reasoning as the dialog scrim: a dark backdrop in both appearances. */}
            <SheetPrimitive.Overlay
                data-slot="sheet-overlay"
                className="fixed inset-0 z-50 bg-ink-950/55 backdrop-blur-[2px]"
            />
            <SheetPrimitive.Content
                data-slot="sheet-content"
                className={cn(sheetVariants({ side }), className)}
                {...props}
            >
                {children}

                {showCloseButton ? (
                    <SheetPrimitive.Close
                        aria-label="Tutup"
                        className="absolute right-3 top-3 rounded-field p-1 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
                    >
                        <X className="size-4" />
                    </SheetPrimitive.Close>
                ) : null}
            </SheetPrimitive.Content>
        </SheetPrimitive.Portal>
    );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="sheet-header"
            className={cn("flex flex-col gap-1 px-4 pb-3 pt-4", className)}
            {...props}
        />
    );
}

function SheetTitle({
    className,
    ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
    return (
        <SheetPrimitive.Title
            data-slot="sheet-title"
            className={cn("text-sm font-semibold", className)}
            {...props}
        />
    );
}

function SheetDescription({
    className,
    ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
    return (
        <SheetPrimitive.Description
            data-slot="sheet-description"
            className={cn("text-xs text-sidebar-foreground/60", className)}
            {...props}
        />
    );
}

export {
    Sheet,
    SheetClose,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
};
