import type { PublicEventCard } from "@/lib/events/catalog";

import EventCard from "@/components/events/EventCard";
import Reveal, { revealDelay } from "@/components/ui/Reveal";

/**
 * A homepage section's worth of events.
 *
 * TWO LAYOUTS, ONE DEFAULT. `layout="row"` is the original and still what every section but one
 * renders: horizontal snap-scroll on phones and tablets, a grid from `lg` up. That split is
 * deliberate: seven stacked full-width cards is a long scroll before the buyer reaches the next
 * section, whereas a peek-at-the-next-card row signals "there is more" and keeps each section to
 * roughly one screen.
 *
 * `layout="grid"` is the opt-in vertical variant, used ONLY by the "Baru ditambahkan" section — a
 * list of newly published events reads as a browse-able catalogue rather than as a teaser row, so
 * there the cards stack: one column on a phone, three from `lg` up. It is a variant of the LIST
 * (the same `Reveal`-wrapped items, the same capped stagger), not a different card: `EventCard` is
 * shared with `/events` and the event detail page and is never specialised here, which is what
 * keeps the other landing sections — Event terdekat above all — exactly as they were.
 *
 * The list keeps its `<ul>`/`<li>` semantics either way, so both layouts are still a list to a
 * screen reader and the scroll region is keyboard-reachable (the cards themselves are links).
 *
 * ── THE STAGGER LIVES ON THE `<li>`, NOT INSIDE THE CARD ─────────────────────────
 * Each list item is wrapped in `Reveal as="li"`, which renders ONE `<li>` (not an `<li>` inside an
 * `<li>`) and therefore changes no box, no column width and no snap target. The delay comes from the
 * shared capped `revealDelay`, so a row of four cards and a row of eight cost the same final delay —
 * past the cap every card shares the last step and the row reads as a group settling rather than a
 * queue draining.
 *
 * `EventCard` itself stays animation-free (its own contract test asserts that): the unit of motion
 * is the list item, never every nested element inside a card. The `card` step is what gives that
 * unit its landing — a 16px rise and a 0.98 scale, small enough to read as settling and applied to
 * the item as a whole, so the card's image, badge and price arrive together rather than in layers.
 */

/**
 * The horizontal row — the default, unchanged. The negative margin plus matching padding is what
 * lets the scroller bleed to the container's edges without the PAGE ever scrolling sideways: the
 * overflow is clipped by this list's own `overflow-x-auto`.
 */
const ROW_CLASS =
    "-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-3 lg:overflow-visible lg:px-0 xl:grid-cols-4 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]";

/** The row's item width: a fixed card on the scroller, a grid cell from `lg` up. */
const ROW_ITEM_CLASS = "w-[268px] shrink-0 snap-start sm:w-[300px] lg:w-auto";

/**
 * The vertical variant: no scroller, no fixed card width, no snap — just a responsive grid of the
 * same card. Mobile is a single column, so the banner reads as a banner; from `lg` the catalogue is
 * three across, which is as many as the card's copy can hold without the date and the venue
 * colliding.
 */
const GRID_CLASS = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3";

/**
 * `[&>a]:h-full` — the card is the item's only child and is taller-agnostic on its own, so the
 * variant stretches it to the grid row. That is scoped to this list (a direct-child selector on the
 * item) and deliberately NOT done inside `EventCard`, which `/events` and the event detail page also
 * render and whose contract this pass must not disturb.
 */
const GRID_ITEM_CLASS = "h-full [&>a]:h-full";

export default function EventRow({
    events,
    layout = "row",
}: {
    events: PublicEventCard[];
    /** `row` (default) is the horizontal snap-scroller; `grid` is the vertical card grid. */
    layout?: "row" | "grid";
}) {
    const vertical = layout === "grid";

    return (
        <ul
            data-event-row
            className={vertical ? GRID_CLASS : ROW_CLASS}
        >
            {events.map((event, index) => (
                <Reveal
                    as="li"
                    key={event.slug}
                    scroll
                    variant="card"
                    delay={revealDelay(index)}
                    className={vertical ? GRID_ITEM_CLASS : ROW_ITEM_CLASS}
                >
                    <EventCard event={event} />
                </Reveal>
            ))}
        </ul>
    );
}
