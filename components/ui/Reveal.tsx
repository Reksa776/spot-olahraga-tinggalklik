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
 *   • default   → `data-reveal`: plays once when the page is painted. For content above the fold,
 *                 where "entering the viewport" has already happened.
 *   • `scroll`  → `data-reveal-scroll`: plays once when the element ENTERS THE VIEWPORT. The
 *                 attribute is inert on its own — `components/ui/RevealObserver.tsx` is what
 *                 starts it, once per element, on the clock — and the stylesheet carries a
 *                 scroll-linked `animation-timeline: view()` entrance as the no-JavaScript path.
 *
 * ── THE DELAY IS PRESENTATIONAL, AND CAPPED ─────────────────────────────────────
 * `delay` is a number of milliseconds supplied by the caller (an index in a list), never data. It
 * becomes an inline `animation-delay`, which is written identically during the server render and in
 * the browser. In the one-shot mode that delay is real elapsed time — the items of a row genuinely
 * arrive 70ms apart — which is the only reason a stagger reads as one at all. `revealDelay()` caps
 * the value so a long list cannot produce a hundred distinct delays; beyond the cap every card
 * shares the last step, which reads as a group settling rather than a queue draining.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────
 * It never hides content itself, never waits for an animation to finish before an element becomes
 * interactive, and is fully neutralised under `prefers-reduced-motion` (see `globals.css`). It is
 * decoration over content that is already there.
 */

/**
 * One stagger step, in milliseconds.
 *
 * 70ms is inside the band that reads as a SEQUENCE rather than a queue: below ~40ms the items look
 * simultaneous, above ~90ms the row starts to feel like it is loading. Because the one-shot mode
 * runs on the clock, this number is literally the gap a visitor sees between two cards arriving.
 */
export const REVEAL_STEP_MS = 70;

/**
 * The cap, in milliseconds.
 *
 * Past this every item shares the final delay, so a row of four and a row of forty cost the same
 * last arrival (350ms) and a long list cannot crawl.
 */
export const REVEAL_MAX_DELAY_MS = 350;

/**
 * The stagger delay for the item at `index`.
 *
 * Capped, so `revealDelay(80)` and `revealDelay(200)` are the same value and neither makes the
 * list feel slow. `base` lets a list start after an already-animated header.
 */
export function revealDelay(index: number, base = 0): number {
    return base + Math.min(index * REVEAL_STEP_MS, REVEAL_MAX_DELAY_MS);
}

/**
 * The five rhythm steps. All five share ONE set of keyframes and differ only in distance, duration
 * and (for `scale`/`card`) the single scale factor — see the token block in `app/globals.css` — so
 * choosing a step chooses an intensity, never a different kind of movement.
 *
 *   `up`      — the default: a heading, a row of chips, a single block.
 *   `scale`   — the hero's treatment. The only step that scales above the fold, once per page.
 *   `section` — a below-the-fold section: the biggest and slowest movement on the page.
 *   `card`    — an event card or a sport tile, which lands from a 0.98 scale.
 *   `quiet`   — the footer's. Deliberately the least movement on the page.
 */
type Variant = "up" | "scale" | "section" | "card" | "quiet";

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
    /** Which rhythm step to play. Defaults to `up`. */
    variant?: Variant;
    /** Play once, when the element enters the viewport, instead of on first paint. */
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
