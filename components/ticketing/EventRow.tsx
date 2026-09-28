import type { PublicEventCard } from "@/lib/events/catalog";

import EventCard from "@/components/events/EventCard";
import Reveal, { revealDelay } from "@/components/ui/Reveal";

/**
 * A homepage section's worth of events.
 *
 * Horizontal snap-scroll on phones and tablets, a four-column grid from `lg` up. That split is
 * deliberate: seven stacked full-width cards is a long scroll before the buyer reaches the next
 * section, whereas a peek-at-the-next-card row signals "there is more" and keeps each section to
 * roughly one screen.
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
export default function EventRow({ events }: { events: PublicEventCard[] }) {
    return (
        <ul
            data-event-row
            className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-3 lg:overflow-visible lg:px-0 xl:grid-cols-4 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
        >
            {events.map((event, index) => (
                <Reveal
                    as="li"
                    key={event.slug}
                    scroll
                    variant="card"
                    delay={revealDelay(index)}
                    className="w-[268px] shrink-0 snap-start sm:w-[300px] lg:w-auto"
                >
                    <EventCard event={event} />
                </Reveal>
            ))}
        </ul>
    );
}
