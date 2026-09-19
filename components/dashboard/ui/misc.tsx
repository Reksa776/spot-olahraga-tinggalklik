"use client";

import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

/**
 * Four small Radix primitives, kept in one module because each is a few lines and each has exactly
 * one dashboard use. They are still the real shadcn components — same Radix root, same Tailwind
 * treatment, same accessibility behaviour — just not given a file each.
 *
 *   Tooltip     … icon-only actions and truncated values
 *   Avatar      … the topbar account chip (initials fallback, no image pipeline)
 *   Collapsible … the sidebar's grouped navigation rows
 *   ScrollArea  … the sidebar's own scroll region and the table viewport
 */

function TooltipProvider({
    delayDuration = 200,
    ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
    return (
        <TooltipPrimitive.Provider
            data-slot="tooltip-provider"
            delayDuration={delayDuration}
            {...props}
        />
    );
}

function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
    return (
        <TooltipProvider>
            <TooltipPrimitive.Root data-slot="tooltip" {...props} />
        </TooltipProvider>
    );
}

function TooltipTrigger(props: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
    return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
    className,
    sideOffset = 6,
    children,
    ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
    return (
        <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
                data-slot="tooltip-content"
                sideOffset={sideOffset}
                className={cn(
                    "z-50 w-fit rounded-field bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-pop",
                    className
                )}
                {...props}
            >
                {children}
            </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
    );
}

function Avatar({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Root>) {
    return (
        <AvatarPrimitive.Root
            data-slot="avatar"
            className={cn(
                "relative flex size-9 shrink-0 overflow-hidden rounded-full",
                className
            )}
            {...props}
        />
    );
}

function AvatarFallback({
    className,
    ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
    return (
        <AvatarPrimitive.Fallback
            data-slot="avatar-fallback"
            className={cn(
                "flex size-full items-center justify-center rounded-full bg-primary/12 text-xs font-bold text-primary",
                className
            )}
            {...props}
        />
    );
}

function Collapsible(props: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
    return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger(
    props: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>
) {
    return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent(
    props: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>
) {
    return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />;
}

function ScrollArea({
    className,
    children,
    ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
    return (
        <ScrollAreaPrimitive.Root
            data-slot="scroll-area"
            className={cn("relative overflow-hidden", className)}
            {...props}
        >
            <ScrollAreaPrimitive.Viewport className="size-full rounded-[inherit]">
                {children}
            </ScrollAreaPrimitive.Viewport>

            <ScrollAreaPrimitive.Scrollbar
                orientation="vertical"
                className="flex w-2 touch-none select-none p-0.5 transition-colors"
            >
                <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" />
            </ScrollAreaPrimitive.Scrollbar>

            <ScrollAreaPrimitive.Scrollbar
                orientation="horizontal"
                className="flex h-2 touch-none select-none flex-col p-0.5 transition-colors"
            >
                <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" />
            </ScrollAreaPrimitive.Scrollbar>
        </ScrollAreaPrimitive.Root>
    );
}

export {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    Avatar,
    AvatarFallback,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    ScrollArea,
};
