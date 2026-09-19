import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Input, raised to the dashboard's comfortable resting height (40px) and using
 * `rounded-field` — the same radius as the Button it sits beside.
 *
 * `aria-invalid` styling is included because the migrated forms already surface server field errors
 * through that attribute; the visual state therefore cannot be forgotten on a new field.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
    return (
        <input
            type={type}
            data-slot="input"
            className={cn(
                "flex h-10 w-full min-w-0 rounded-field border border-input bg-card px-3 py-2 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-none",
                "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
                "placeholder:text-muted-foreground/70",
                "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
                "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
                "disabled:cursor-not-allowed disabled:opacity-60",
                className
            )}
            {...props}
        />
    );
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
    return (
        <textarea
            data-slot="textarea"
            className={cn(
                "flex min-h-24 w-full resize-y rounded-field border border-input bg-card px-3 py-2 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-none",
                "placeholder:text-muted-foreground/70",
                "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
                "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
                "disabled:cursor-not-allowed disabled:opacity-60",
                className
            )}
            {...props}
        />
    );
}

function Label({
    className,
    ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
    return (
        <LabelPrimitive.Root
            data-slot="label"
            className={cn(
                "flex items-center gap-2 text-[0.8125rem] font-medium leading-none text-foreground select-none",
                "group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-60",
                className
            )}
            {...props}
        />
    );
}

/**
 * Field wrapper: label, control, hint and error.
 *
 * Every migrated form had the same four-part structure hand-written (a `<label>`, the control, a
 * helper line, an error line). Centralising it is what makes "consistent labels, consistent helper
 * text, inline validation" true by construction rather than by review.
 */
function Field({
    label,
    hint,
    error,
    required,
    htmlFor,
    className,
    children,
}: {
    label?: React.ReactNode;
    hint?: React.ReactNode;
    error?: React.ReactNode;
    required?: boolean;
    htmlFor?: string;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div className={cn("flex flex-col gap-2", className)}>
            {label ? (
                <Label htmlFor={htmlFor}>
                    {label}
                    {required ? <span className="text-destructive">*</span> : null}
                </Label>
            ) : null}

            {children}

            {error ? (
                <p className="text-xs font-medium text-destructive">{error}</p>
            ) : hint ? (
                <p className="text-xs text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}

export { Input, Textarea, Label, Field };
