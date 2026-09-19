"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui DropdownMenu.
 *
 * Two dashboard jobs: the topbar account menu (profile, view site, sign out) and the per-row action
 * menu on data tables. Radix provides the keyboard model and the focus return that the previous
 * Mantine `Menu` had, so behaviour is unchanged — only the surface treatment is new.
 */
function DropdownMenu(props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
    return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(
    props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>
) {
    return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuGroup(
    props: React.ComponentProps<typeof DropdownMenuPrimitive.Group>
) {
    return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuContent({
    className,
    sideOffset = 6,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
    return (
        <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
                data-slot="dropdown-menu-content"
                sideOffset={sideOffset}
                className={cn(
                    "z-50 min-w-52 overflow-hidden rounded-card border border-border bg-popover p-1.5 text-popover-foreground shadow-pop",
                    className
                )}
                {...props}
            />
        </DropdownMenuPrimitive.Portal>
    );
}

function DropdownMenuItem({
    className,
    variant = "default",
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
    variant?: "default" | "destructive";
}) {
    return (
        <DropdownMenuPrimitive.Item
            data-slot="dropdown-menu-item"
            className={cn(
                "relative flex cursor-pointer select-none items-center gap-2.5 rounded-field px-2.5 py-2 text-sm font-medium outline-none transition-colors",
                "focus:bg-muted focus:text-foreground",
                "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                variant === "destructive" &&
                    "text-destructive focus:bg-destructive/10 focus:text-destructive [&_svg]:text-destructive",
                className
            )}
            {...props}
        />
    );
}

function DropdownMenuCheckboxItem({
    className,
    children,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
    return (
        <DropdownMenuPrimitive.CheckboxItem
            data-slot="dropdown-menu-checkbox-item"
            className={cn(
                "relative flex cursor-pointer select-none items-center gap-2 rounded-field py-2 pl-8 pr-2.5 text-sm outline-none focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                className
            )}
            {...props}
        >
            <span className="absolute left-2.5 flex size-3.5 items-center justify-center">
                <DropdownMenuPrimitive.ItemIndicator>
                    <span className="size-2 rounded-full bg-primary" />
                </DropdownMenuPrimitive.ItemIndicator>
            </span>
            {children}
        </DropdownMenuPrimitive.CheckboxItem>
    );
}

function DropdownMenuLabel({
    className,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
    return (
        <DropdownMenuPrimitive.Label
            data-slot="dropdown-menu-label"
            className={cn(
                "px-2.5 py-1.5 text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground",
                className
            )}
            {...props}
        />
    );
}

function DropdownMenuSeparator({
    className,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
    return (
        <DropdownMenuPrimitive.Separator
            data-slot="dropdown-menu-separator"
            className={cn("-mx-1.5 my-1.5 h-px bg-border", className)}
            {...props}
        />
    );
}

export {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
};
