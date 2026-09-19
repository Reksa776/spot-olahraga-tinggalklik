"use client";

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Check, ChevronDown, ChevronUp, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The dashboard form controls, on the same `rounded-field` / `h-10` geometry as `Input` and
 * `Button`.
 *
 * These replace Mantine's `Select`, `MultiSelect`, `Checkbox`, `Switch` and `Radio`. The migrated
 * forms keep their own state, validation, payloads and mutation order — every one of them was
 * already driven by a plain `value`/`onChange` pair, which is exactly the contract these components
 * expose (`onValueChange` for Select/RadioGroup, `onCheckedChange` for Checkbox/Switch).
 */

function Select(props: React.ComponentProps<typeof SelectPrimitive.Root>) {
    return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectValue(props: React.ComponentProps<typeof SelectPrimitive.Value>) {
    return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
    className,
    children,
    ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
    return (
        <SelectPrimitive.Trigger
            data-slot="select-trigger"
            className={cn(
                "flex h-10 w-full items-center justify-between gap-2 rounded-field border border-input bg-card px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow]",
                "data-[placeholder]:text-muted-foreground/70",
                "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
                "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
                "disabled:cursor-not-allowed disabled:opacity-60",
                "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                className
            )}
            {...props}
        >
            {children}
            <SelectPrimitive.Icon asChild>
                <ChevronDown className="opacity-70" />
            </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
    );
}

function SelectContent({
    className,
    children,
    position = "popper",
    ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
    return (
        <SelectPrimitive.Portal>
            <SelectPrimitive.Content
                data-slot="select-content"
                position={position}
                className={cn(
                    "relative z-50 max-h-72 min-w-[8rem] overflow-hidden rounded-card border border-border bg-popover text-popover-foreground shadow-pop",
                    position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]",
                    className
                )}
                {...props}
            >
                <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center">
                    <ChevronUp className="size-4" />
                </SelectPrimitive.ScrollUpButton>

                <SelectPrimitive.Viewport className="p-1.5">{children}</SelectPrimitive.Viewport>

                <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center">
                    <ChevronDown className="size-4" />
                </SelectPrimitive.ScrollDownButton>
            </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
    );
}

function SelectItem({
    className,
    children,
    ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
    return (
        <SelectPrimitive.Item
            data-slot="select-item"
            className={cn(
                "relative flex w-full cursor-pointer select-none items-center gap-2 rounded-field py-2 pl-2.5 pr-8 text-sm outline-none",
                "focus:bg-muted focus:text-foreground",
                "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                className
            )}
            {...props}
        >
            <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>

            <span className="absolute right-2.5 flex size-4 items-center justify-center">
                <SelectPrimitive.ItemIndicator>
                    <Check className="size-4 text-primary" />
                </SelectPrimitive.ItemIndicator>
            </span>
        </SelectPrimitive.Item>
    );
}

function SelectGroup(props: React.ComponentProps<typeof SelectPrimitive.Group>) {
    return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectLabel({
    className,
    ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
    return (
        <SelectPrimitive.Label
            data-slot="select-label"
            className={cn(
                "px-2.5 py-1.5 text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground",
                className
            )}
            {...props}
        />
    );
}

function Checkbox({
    className,
    ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
    return (
        <CheckboxPrimitive.Root
            data-slot="checkbox"
            className={cn(
                "peer size-[18px] shrink-0 rounded-[4px] border border-input bg-card shadow-xs outline-none transition-colors",
                "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
                "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
                "focus-visible:ring-2 focus-visible:ring-ring/30",
                "disabled:cursor-not-allowed disabled:opacity-60",
                className
            )}
            {...props}
        >
            <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
                {props.checked === "indeterminate" ? (
                    <Minus className="size-3.5" />
                ) : (
                    <Check className="size-3.5" />
                )}
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
    );
}

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
    return (
        <SwitchPrimitive.Root
            data-slot="switch"
            className={cn(
                "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors outline-none",
                "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
                "focus-visible:ring-2 focus-visible:ring-ring/30",
                "disabled:cursor-not-allowed disabled:opacity-60",
                className
            )}
            {...props}
        >
            {/*
             * The knob uses the palette's lightest ink rather than a literal white: a toggle's knob is a
             * physical affordance and stays light in BOTH appearances (the platform convention, and
             * what upstream shadcn does too), but it is still a token, so it can never drift from
             * the palette.
             */}
            <SwitchPrimitive.Thumb className="pointer-events-none block size-5 rounded-full bg-ink-50 shadow-sm transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
        </SwitchPrimitive.Root>
    );
}

function RadioGroup({
    className,
    ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
    return (
        <RadioGroupPrimitive.Root
            data-slot="radio-group"
            className={cn("grid gap-2.5", className)}
            {...props}
        />
    );
}

function RadioGroupItem({
    className,
    ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
    return (
        <RadioGroupPrimitive.Item
            data-slot="radio-group-item"
            className={cn(
                "aspect-square size-[18px] shrink-0 rounded-full border border-input bg-card shadow-xs outline-none transition-colors",
                "data-[state=checked]:border-primary",
                "focus-visible:ring-2 focus-visible:ring-ring/30",
                "disabled:cursor-not-allowed disabled:opacity-60",
                className
            )}
            {...props}
        >
            <RadioGroupPrimitive.Indicator className="relative flex size-full items-center justify-center">
                <span className="size-2 rounded-full bg-primary" />
            </RadioGroupPrimitive.Indicator>
        </RadioGroupPrimitive.Item>
    );
}

/** A checkbox/switch/radio plus its label, so the label and control are always wired together. */
function FieldToggle({
    control,
    label,
    hint,
    className,
}: {
    control: React.ReactNode;
    label: React.ReactNode;
    hint?: React.ReactNode;
    className?: string;
}) {
    return (
        <label className={cn("flex cursor-pointer items-start gap-3", className)}>
            <span className="pt-0.5">{control}</span>

            <span className="flex flex-col gap-0.5">
                <span className="text-[0.8125rem] font-medium leading-tight">{label}</span>
                {hint ? (
                    <span className="text-xs text-muted-foreground">{hint}</span>
                ) : null}
            </span>
        </label>
    );
}

export {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
    Checkbox,
    Switch,
    RadioGroup,
    RadioGroupItem,
    FieldToggle,
};
