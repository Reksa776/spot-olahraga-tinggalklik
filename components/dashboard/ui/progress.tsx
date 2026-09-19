import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A determinate progress bar.
 *
 * Implemented on a plain `<div role="progressbar">` rather than over a Radix package: the dashboard
 * uses it in exactly one place (a voucher's redemption counter), it holds no state, and its whole
 * job is `aria-valuenow` plus a width. Pulling in a Radix dependency for that would be library
 * weight, not capability.
 *
 * The fill is `bg-primary`, so the accent switcher repaints it like every other affirmative surface,
 * and the track is `bg-muted`, matching the recessed treatment used by `TabsList` and `Badge`.
 * The value is clamped, so a caller computing a percentage from a live counter cannot overflow the
 * bar with a rounding artefact.
 */
function Progress({
    value = 0,
    max = 100,
    className,
    barClassName,
    ...props
}: React.ComponentProps<"div"> & {
    /** Current value. Clamped to `[0, max]`. */
    value?: number;
    max?: number;
    /** Class hook for the fill, for the rare case a semantic tone is wanted. */
    barClassName?: string;
}) {
    const clamped = Number.isFinite(value) ? Math.min(Math.max(value, 0), max) : 0;
    const percent = max > 0 ? (clamped / max) * 100 : 0;

    return (
        <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={clamped}
            data-slot="progress"
            className={cn(
                "relative h-2 w-full overflow-hidden rounded-full bg-muted",
                className
            )}
            {...props}
        >
            <div
                data-slot="progress-bar"
                className={cn("h-full rounded-full bg-primary transition-[width]", barClassName)}
                style={{ width: `${percent}%` }}
            />
        </div>
    );
}

export { Progress };
