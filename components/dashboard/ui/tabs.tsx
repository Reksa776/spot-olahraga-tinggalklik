"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Tabs, tuned for the back office.
 *
 * The dashboard has exactly one segmented control today — the upload/URL switch in the image
 * uploader — and it is a mode picker over one panel rather than a set of route-like tabs. That is
 * what `Tabs` is: a roving-focus radio group with proper arrow-key handling and `aria-selected`,
 * which the previous hand-styled pair of buttons did not provide.
 *
 * The list carries the recessed track treatment (a `bg-muted` pill) and the active trigger lifts to
 * `bg-card`, which is the same "one selected surface among neutral ones" language the Button,
 * Badge and sidebar already use. Colours are tokens only, so the accent switcher repaints the
 * selected trigger.
 */
function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
    return (
        <TabsPrimitive.Root
            data-slot="tabs"
            className={cn("flex flex-col gap-2", className)}
            {...props}
        />
    );
}

function TabsList({
    className,
    ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
    return (
        <TabsPrimitive.List
            data-slot="tabs-list"
            className={cn(
                "inline-flex h-10 w-fit items-center justify-center gap-1 rounded-field border border-border bg-muted p-1 text-muted-foreground",
                className
            )}
            {...props}
        />
    );
}

function TabsTrigger({
    className,
    ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
    return (
        <TabsPrimitive.Trigger
            data-slot="tabs-trigger"
            className={cn(
                "inline-flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[calc(var(--radius-field)-3px)] px-3 text-[0.8125rem] font-semibold transition-colors outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring/40",
                "disabled:pointer-events-none disabled:opacity-50",
                "data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs",
                className
            )}
            {...props}
        />
    );
}

function TabsContent({
    className,
    ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
    return (
        <TabsPrimitive.Content
            data-slot="tabs-content"
            className={cn("flex-1 outline-none", className)}
            {...props}
        />
    );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
