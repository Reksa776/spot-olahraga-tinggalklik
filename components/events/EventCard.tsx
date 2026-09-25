import Link from "next/link";

import type { PublicEventCard } from "@/lib/events/catalog";
import {
    formatEventDateShort,
    formatEventTime,
    formatPriceFrom,
} from "@/lib/ticketing/ui/format";
import { sportLabel, sportTint } from "@/lib/ticketing/ui/sport-tint";

/**
 * ==========================================
 * PHASE 9 — PUBLIC EVENT CARD
 * ==========================================
 *
 * Still presentational only: it renders exactly the fields `PublicEventCard` exposes, so it cannot
 * become a route through which an unexposed column reaches the browser (Phase 4's rule, unchanged).
 *
 * Phase 35 keeps the same contract and makes the card quieter: a plain photo (no gradient wash, no
 * calendar chip over the image), the sport as a small tinted tag, and availability as a text label
 * beside the price instead of a pill competing with the photo. The date and time now sit alongside
 * the venue in a single `<dl>`, so the card reads top-to-bottom like a listing, not a poster.
 *
 * The price is stated as "Mulai …" — the payload gives a minimum, and "Rp150.000" alone reads as
 * *the* price of a tiered event.
 *
 * The whole card stays one `<Link>` (the entire surface is the target) and contains no nested
 * interactive element, which would be invalid and would break keyboard order.
 */
export default function EventCard({ event }: { event: PublicEventCard }) {
    const badge = availabilityBadge(event);

    return (
        <Link
            href={`/e/${event.slug}`}
            className="group flex flex-col overflow-hidden rounded-xl border border-ink-100 bg-white shadow-sm transition hover:border-ink-200 hover:shadow-md hover:shadow-ink-900/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
            <div className="relative aspect-16/10 w-full overflow-hidden bg-ink-100">
                {event.bannerUrl ? (
                    // Plain <img>: the project does not configure next/image remote patterns for
                    // locally-served uploads, and these files are already server-processed.
                    <img
                        src={event.bannerUrl}
                        alt={event.title}
                        loading="lazy"
                        className="h-full w-full object-cover"
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center bg-ink-100">
                        <span className="text-sm font-semibold text-ink-400">
                            {event.sportName}
                        </span>
                    </div>
                )}
            </div>

            <div className="flex flex-1 flex-col gap-2.5 p-4">
                <div className="flex items-center justify-between gap-2">
                    <span
                        className={`inline-flex w-fit items-center rounded-md px-2 py-0.5 text-[0.7rem] font-bold ring-1 ring-inset ${sportTint(
                            event.sportSlug
                        )}`}
                    >
                        {sportLabel(event.sportName)}
                    </span>

                    {badge ? (
                        <span className={badge.className}>{badge.label}</span>
                    ) : null}
                </div>

                <h3 className="line-clamp-2 text-[0.95rem] leading-snug font-bold text-ink-900 group-hover:text-brand-800">
                    {event.title}
                </h3>

                <dl className="mt-auto space-y-1.5 text-[0.8rem] text-ink-500">
                    <meta itemProp="startDate" content={event.startAt} />
                    <div className="flex items-center gap-2">
                        <dt className="sr-only">Jadwal</dt>
                        <Icon path="M4 7h16v13H4zM4 11h16M9 4v4M15 4v4" />
                        <dd className="truncate">
                            {formatEventDateShort(event.startAt)} ·{" "}
                            {formatEventTime(event.startAt)} WIB
                        </dd>
                    </div>

                    <div className="flex items-center gap-2">
                        <dt className="sr-only">Lokasi</dt>
                        <Icon path="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
                        <dd className="truncate">
                            {event.venueName
                                ? `${event.venueName}${
                                      event.venueCity ? `, ${event.venueCity}` : ""
                                  }`
                                : "Lokasi menyusul"}
                        </dd>
                    </div>
                </dl>

                <div className="flex items-center justify-between gap-2 border-t border-ink-100 pt-3">
                    <p className="text-sm font-extrabold text-ink-900">
                        {formatPriceFrom(event.priceFrom)}
                    </p>
                    <span className="text-xs font-bold text-brand-700 group-hover:underline">
                        Lihat detail
                    </span>
                </div>
            </div>
        </Link>
    );
}

function Icon({ path }: { path: string }) {
    return (
        <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 shrink-0 text-ink-400"
        >
            <path d={path} />
        </svg>
    );
}

/**
 * The availability badge.
 *
 * `OPEN` is the only state without one: a badge saying "on sale" on every card is noise, and its
 * absence is not ambiguous once the other states are marked. Rendered as a labelling caption next
 * to the price, not a pill over the photograph.
 */
function availabilityBadge(
    event: PublicEventCard
): { label: string; className: string } | null {
    if (event.isSoldOut || event.salesState === "SOLD_OUT") {
        return { label: "Tiket habis", className: "text-xs font-bold text-red-600" };
    }

    if (event.salesState === "NOT_STARTED") {
        return { label: "Segera", className: "text-xs font-bold text-amber-600" };
    }

    if (event.salesState === "CLOSED") {
        return { label: "Ditutup", className: "text-xs font-bold text-ink-500" };
    }

    return null;
}