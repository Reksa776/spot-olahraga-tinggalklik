import type { CSSProperties } from "react";

import Link from "next/link";

import Reveal, { revealDelay } from "@/components/ui/Reveal";
import { sportLabel, sportTint } from "@/lib/ticketing/ui/sport-tint";

export type SportOption = {
    id: string;
    name: string;
    slug: string;
};

/**
 * THE PHONE'S TILE PACE — and why there is a second pair of numbers at all.
 *
 * Above `md` the tile branch keeps the shared card cadence it has always used: `revealDelay()`'s
 * 70ms step, capped at 350ms, with the card step's own distance and duration. A phone is a different
 * reading situation, not a smaller desktop: fourteen tiles in a swipeable row, so a step the width
 * of an event row's is a queue a thumb can out-scroll — the visitor reaches the section, keeps
 * scrolling, and the tiles are still arriving underneath them. These two numbers are the phone's
 * answer: a fifth of the gap and a cap the whole row clears in about a tenth of a second, so the
 * tiles read as one row arriving rather than as fourteen arrivals.
 *
 * They are applied by `app/globals.css` in a `max-width: 767px` block (below Tailwind's `md`), and
 * NEVER as a base value — the token only exists inside that media query, so no width above it can see
 * the faster pace. The delay is per-tile, so it cannot be a fixed CSS value either: the component
 * writes both paces as custom properties and the stylesheet selects which one plays.
 */
export const SPORT_TILE_MOBILE_STEP_MS = 20;

/** The phone's cap: six steps, so the last tile waits ~120ms, never hundreds. */
export const SPORT_TILE_MOBILE_MAX_DELAY_MS = 120;

/**
 * The phone's stagger delay for the tile at `index`, capped exactly like `revealDelay()` so a longer
 * sport list cannot produce a longer wait.
 */
export function sportTileMobileDelay(index: number): number {
    return Math.min(index * SPORT_TILE_MOBILE_STEP_MS, SPORT_TILE_MOBILE_MAX_DELAY_MS);
}

type Props = {
    sports: SportOption[];
    /** Real published-event counts, keyed by sport slug. Absent slugs show no count. */
    counts?: Record<string, number>;
    /** Highlights one entry as the current filter. */
    activeSlug?: string;
    /** `tile` for the homepage grid, `chip` for the filter bar on /events. */
    variant?: "tile" | "chip";
    /** Section id, so a page can link straight to the grid (`/events#cabang-olahraga`). */
    id?: string;
};

/**
 * Sports, as a first-class navigation concept.
 *
 * The 14 seeded sports are the platform's own taxonomy — nothing is added, renamed or reordered
 * here, and there is no "other" bucket. Each entry links to the catalog filtered by that slug,
 * which is the only supported sport filter.
 *
 * Counts come from a real aggregate over published events; a sport with no published events simply
 * shows no number rather than a fabricated one.
 */
export default function SportGrid({
    sports,
    counts,
    activeSlug,
    variant = "tile",
    id,
}: Props) {
    if (sports.length === 0) {
        return null;
    }

    if (variant === "chip") {
        return (
            <ul
                id={id}
                className="flex snap-x gap-2 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
            >
                <li className="shrink-0 snap-start">
                    <Link
                        href="/events"
                        aria-current={activeSlug ? undefined : "true"}
                        className={chipClass(!activeSlug)}
                    >
                        Semua cabang
                    </Link>
                </li>
                {sports.map((sport) => (
                    <li key={sport.id} className="shrink-0 snap-start">
                        <Link
                            href={`/events?sport=${encodeURIComponent(sport.slug)}`}
                            aria-current={activeSlug === sport.slug ? "true" : undefined}
                            className={chipClass(activeSlug === sport.slug)}
                        >
                            {sportLabel(sport.name)}
                        </Link>
                    </li>
                ))}
            </ul>
        );
    }

    /*
     * The TILE variant is the landing page's grid, and only it is staggered. The CHIP variant above
     * is the filter bar on `/events` — a horizontally scrollable row of already-active controls,
     * where a per-item entrance would animate the filter you are about to click and would fight the
     * snap scroller. So the animation is scoped to the branch that needs it rather than to the
     * component, which is also why `/events` is untouched by this pass.
     *
     * The tiles use the same `card` step the event rows do — a 16px rise and a 0.98 scale, 70ms
     * apart — so the two grids on the page clearly belong to one system. The tile is revealed as a
     * WHOLE: its tint chip and its label are the card, not three animated parts of one.
     *
     * The `card` step is the tile's step at every width, but the tile's PACE is not one number: above
     * `md` the tiles play the shared cadence above, and below it they run on their own
     * `SPORT_TILE_MOBILE_*` numbers (a 20ms step capped at 120ms, a 320ms 8px landing) selected by a
     * `max-width: 767px` block in `app/globals.css`. Desktop and tablet are therefore byte-for-byte
     * the same cadence they were; only the phone's fourteen-tile row is accelerated.
     */
    return (
        <ul
            id={id}
            /*
             * The same scroller recipe the event rows use: a negative margin plus matching padding
             * so the row bleeds to the container's edge while the PAGE never scrolls sideways (the
             * horizontal overflow is clipped by this list's own `overflow-x-auto`), fixed-width snap
             * targets on a phone and a tablet, and the original grid restored from `lg` up — four
             * across, seven on a wide desktop, so a large screen is never squeezed into one thin row.
             *
             * The 1px/2px padding top-and-bottom is what keeps the tile's 2px hover lift (and the
             * card shadow) from being clipped by the scroller's own box.
             */
            className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pt-1 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0 lg:pt-0 lg:pb-0 xl:grid-cols-7 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
        >
            {sports.map((sport, index) => {
                const count = counts?.[sport.slug];

                return (
                    <Reveal
                        as="li"
                        key={sport.id}
                        scroll
                        variant="card"
                        /*
                         * The pace rides on the element as two custom properties rather than as an
                         * inline `animation-delay`: the stylesheet plays `--tk-tile-delay` above
                         * `md` and `--tk-tile-delay-mobile` below it. One value cannot be right at
                         * both widths, and choosing one in CSS is what keeps the choice out of an
                         * `!important` fight with the markup.
                         */
                        className="reveal-tile w-[150px] shrink-0 snap-start sm:w-[168px] lg:w-auto"
                        style={
                            {
                                "--tk-tile-delay": `${revealDelay(index)}ms`,
                                "--tk-tile-delay-mobile": `${sportTileMobileDelay(index)}ms`,
                            } as CSSProperties
                        }
                    >
                        <Link
                            href={`/events?sport=${encodeURIComponent(sport.slug)}`}
                            /*
                             * `motion-safe:` on the hover lift, not a plain one: a visitor who asked
                             * for reduced motion gets the colour/border change (which communicates the
                             * hover) and NO movement at all, without needing a rule in the reduce
                             * block for it. The lift is 2px — the design deliberately removed the old
                             * heavy card raise, and 2px plus a border tint is the subtle version of it.
                             */
                            className="group flex h-full flex-col items-start gap-2.5 rounded-xl border border-ink-100 bg-white p-4 transition hover:border-ink-200 hover:bg-ink-50/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 motion-safe:hover:-translate-y-0.5"
                        >
                            <span
                                aria-hidden
                                className={`grid h-9 w-9 place-items-center rounded-lg text-xs font-black ring-1 ring-inset ${sportTint(
                                    sport.slug
                                )}`}
                            >
                                {sport.name.slice(0, 2).toUpperCase()}
                            </span>
                            <span className="text-sm font-bold text-ink-900 group-hover:text-brand-800">
                                {sportLabel(sport.name)}
                            </span>
                            <span className="mt-auto text-xs text-ink-500">
                                {typeof count === "number"
                                    ? `${count} event`
                                    : "Lihat event"}
                            </span>
                        </Link>
                    </Reveal>
                );
            })}
        </ul>
    );
}

function chipClass(active: boolean): string {
    return `inline-flex items-center rounded-full border px-3.5 py-2 text-xs font-bold whitespace-nowrap transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
        active
            ? "border-ink-900 bg-ink-900 text-white"
            : "border-ink-200 bg-white text-ink-700 hover:border-ink-900 hover:text-ink-900"
    }`;
}