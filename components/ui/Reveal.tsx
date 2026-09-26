import type {
    CSSProperties,
    ElementType,
    HTMLAttributes,
    ReactNode,
} from "react";

/**
 * ==========================================
 * REVEAL — THE PAGE-ENTRANCE PRIMITIVE
 * ==========================================
 *
 * A single presentational wrapper that opts an element into the CSS entrance system declared in
 * `app/globals.css` (`[data-reveal]` / `[data-reveal-scroll]`). It renders NO JavaScript: there is
 * no `"use client"`, no state, no effect, so a page that uses it stays a server component and the
 * markup is identical on the server and in the browser (no hydration mismatch is possible).
 *
 * ── WHY A COMPONENT AT ALL ──────────────────────────────────────────────────────
 * The alternative is writing `data-reveal` plus an inline `animation-delay` at every call site.
 * The wrapper exists so the STAGGER RULE lives in one place — `revealDelay()` — instead of being a
 * formula copy-pasted into four pages, and so the delay can be capped once for all lists. It adds
 * no runtime behaviour beyond setting two attributes and one style.
 *
 * ── THE TWO MODES ───────────────────────────────────────────────────────────────
 *   • default   → `data-reveal`: plays once when the page is painted (entrance).
 *   • `scroll`  → `data-reveal-scroll`: plays as the element enters the viewport via
 *                 `animation-timeline: view()`. In a browser without view-timeline support the
 *                 attribute has no CSS rule and the element is simply visible.
 *
 * ── THE DELAY IS PRESENTATIONAL, AND CAPPED ─────────────────────────────────────
 * `delay` is a number of milliseconds supplied by the caller (an index in a list), never data. It
 * becomes an inline `animation-delay`, which is written identically during the server render and in
 * the browser. `revealDelay()` caps the value so a long list cannot produce a hundred distinct
 * delays — beyond the cap every card shares the last step, which reads as a group settling rather
 * than a queue draining.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────
 * It never hides content itself, never waits for an animation to finish before an element becomes
 * interactive, and is fully neutralised under `prefers-reduced-motion` (see `globals.css`). It is
 * decoration over content that is already there.
 */

/** One stagger step. 60 ms reads as a sequence without ever feeling like a queue. */
export const REVEAL_STEP_MS = 60;

/** The cap. Past this every item shares the final delay, so a long list cannot crawl. */
export const REVEAL_MAX_DELAY_MS = 300;

/**
 * The stagger delay for the item at `index`.
 *
 * Capped, so `revealDelay(80)` and `revealDelay(200)` are the same value and neither makes the
 * list feel slow. `base` lets a list start after an already-animated header.
 */
export function revealDelay(index: number, base = 0): number {
    return base + Math.min(index * REVEAL_STEP_MS, REVEAL_MAX_DELAY_MS);
}

type Variant = "up" | "scale";

type RevealProps = {
    /**
     * Optional only so the component can be constructed with `createElement` in tests without
     * repeating the children twice; every real call site passes them.
     */
    children?: ReactNode;
    /**
     * The element to render. Defaults to `div`. Use it to keep semantics (`p`, `h1`, `li`,
     * `section`) instead of nesting a wrapper around a block that already has meaning.
     */
    as?: ElementType;
    /** Stagger delay in ms. Omitted/0 writes no inline style at all. */
    delay?: number;
    /** `up` (default) or `scale` for a hero-like block. */
    variant?: Variant;
    /** Play as the element scrolls into view instead of on first paint. */
    scroll?: boolean;
    className?: string;
    style?: CSSProperties;
} & Omit<HTMLAttributes<HTMLElement>, "children" | "className" | "style">;

export default function Reveal({
    children,
    as,
    delay = 0,
    variant = "up",
    scroll = false,
    className,
    style,
    ...rest
}: RevealProps) {
    const Tag = (as ?? "div") as ElementType;

    /*
     * One attribute per mode. `data-reveal="up"` is spelled explicitly rather than relying on the
     * bare attribute, so `[data-reveal="scale"]` has a symmetrical counterpart to read.
     */
    const animationAttribute = scroll
        ? { "data-reveal-scroll": variant }
        : { "data-reveal": variant };

    return (
        <Tag
            {...animationAttribute}
            {...rest}
            className={className}
            style={
                delay > 0
                    ? { animationDelay: `${delay}ms`, ...style }
                    : style
            }
        >
            {children}
        </Tag>
    );
}
