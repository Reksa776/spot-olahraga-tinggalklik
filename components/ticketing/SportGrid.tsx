import Link from "next/link";

import { sportLabel, sportTint } from "@/lib/ticketing/ui/sport-tint";

export type SportOption = {
    id: string;
    name: string;
    slug: string;
};

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

    return (
        <ul
            id={id}
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7"
        >
            {sports.map((sport) => {
                const count = counts?.[sport.slug];

                return (
                    <li key={sport.id}>
                        <Link
                            href={`/events?sport=${encodeURIComponent(sport.slug)}`}
                            className="group flex h-full flex-col items-start gap-3 rounded-2xl border border-ink-100 bg-white p-4 transition hover:-translate-y-0.5 hover:border-ink-200 hover:shadow-lg hover:shadow-ink-900/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                        >
                            <span
                                aria-hidden
                                className={`grid h-10 w-10 place-items-center rounded-xl text-sm font-black ring-1 ring-inset ${sportTint(
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
                    </li>
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
