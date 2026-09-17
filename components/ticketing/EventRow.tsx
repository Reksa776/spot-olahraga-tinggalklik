import type { PublicEventCard } from "@/lib/events/catalog";

import EventCard from "@/components/events/EventCard";

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
 */
export default function EventRow({ events }: { events: PublicEventCard[] }) {
    return (
        <ul
            data-event-row
            className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-3 lg:overflow-visible lg:px-0 xl:grid-cols-4 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
        >
            {events.map((event) => (
                <li
                    key={event.slug}
                    className="w-[268px] shrink-0 snap-start sm:w-[300px] lg:w-auto"
                >
                    <EventCard event={event} />
                </li>
            ))}
        </ul>
    );
}
