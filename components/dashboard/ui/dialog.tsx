"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Dialog — the ONLY confirmation surface in the dashboard.
 *
 * The back office previously had two: Mantine's `Modal` and the shared customer-facing
 * `components/ui/Dialog.tsx` (a `useDialog()` provider mounted by the ROOT layout and used by
 * retail pages). The dashboard uses this one, and it deliberately does NOT reuse the retail
 * component: that component belongs to the customer graph, and a dashboard restyle must not be able
 * to change a customer-facing confirmation.
 *
 * Behaviour carried over from the migrated `Modal` call sites, unchanged: the same title, the same
 * body wording, the same cancel/confirm buttons, the same in-flight disabled state, and the same
 * `onOpenChange` semantics (`false` on Escape, on overlay click and on the close button).
 */
function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
    return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
    return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal(props: React.ComponentProps<typeof DialogPrimitive.Portal>) {
    return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
    return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
    className,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
    return (
        <DialogPrimitive.Overlay
            data-slot="dialog-overlay"
            className={cn(
                /*
                 * The scrim is the one surface that must NOT follow the appearance token: it exists
                 * to darken whatever is behind it. `ink-950` is this project's darkest ink, so it is
                 * a palette token rather than a literal, and the result is a dark backdrop in both
                 * light and dark mode — the behaviour a modal overlay is supposed to have.
                 */
                "fixed inset-0 z-50 bg-ink-950/55 backdrop-blur-[2px]",
                "data-[state=open]:animate-in data-[state=closed]:animate-out",
                className
            )}
            {...props}
        />
    );
}

function DialogContent({
    className,
    children,
    showCloseButton = true,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean;
}) {
    return (
        <DialogPortal>
            <DialogOverlay />
            <DialogPrimitive.Content
                data-slot="dialog-content"
                className={cn(
                    "fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-card border border-border bg-card p-6 text-card-foreground shadow-pop outline-none",
                    "max-h-[calc(100vh-2rem)] overflow-y-auto",
                    className
                )}
                {...props}
            >
                {children}

                {showCloseButton ? (
                    <DialogPrimitive.Close
                        aria-label="Tutup"
                        className="absolute right-4 top-4 rounded-field p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                        <X className="size-4" />
                    </DialogPrimitive.Close>
                ) : null}
            </DialogPrimitive.Content>
        </DialogPortal>
    );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="dialog-header"
            className={cn("flex flex-col gap-1.5 pr-8", className)}
            {...props}
        />
    );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="dialog-footer"
            className={cn(
                "mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
                className
            )}
            {...props}
        />
    );
}

function DialogTitle({
    className,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
    return (
        <DialogPrimitive.Title
            data-slot="dialog-title"
            className={cn("text-base font-semibold leading-tight", className)}
            {...props}
        />
    );
}

function DialogDescription({
    className,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
    return (
        <DialogPrimitive.Description
            data-slot="dialog-description"
            className={cn("text-sm leading-relaxed text-muted-foreground", className)}
            {...props}
        />
    );
}

export {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogOverlay,
    DialogPortal,
    DialogTitle,
    DialogTrigger,
};
