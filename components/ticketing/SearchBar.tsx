import type { ReactNode } from "react";

type Props = {
    /** Current query, echoed back so a search stays editable after the fact. */
    defaultValue?: string;
    placeholder?: string;
    size?: "sm" | "lg";
    /** Carried as a hidden field so searching inside a sport keeps the sport filter. */
    sport?: string;
    /** Further filters to preserve across a re-search (city, dates, sort). */
    keep?: Record<string, string | undefined>;
    /** Rendered inside the field, left of the input — a "Semua cabang" selector slot. */
    leading?: ReactNode;
};

/**
 * A plain `GET` form to `/events`.
 *
 * A form rather than a fetch-and-render client component on purpose: the filter state belongs in
 * the URL (so a search is shareable, bookmarkable and server-rendered), and the server already
 * implements every filter. That also means the page works without JavaScript, which matters more
 * here than a snappier input.
 *
 * The submit control is a real `<button>` and the input is labelled — by `aria-label` rather than a
 * `<label for>`, so the component needs no generated id and stays a server component.
 */
export default function SearchBar({
    defaultValue,
    placeholder = "Cari event, pertandingan, atau olahraga…",
    size = "sm",
    sport,
    keep,
    leading,
}: Props) {
    const large = size === "lg";

    return (
        <form
            action="/events"
            method="get"
            role="search"
            className="w-full"
        >
            {sport ? <input type="hidden" name="sport" value={sport} /> : null}
            {keep
                ? Object.entries(keep).map(([key, value]) =>
                      value ? (
                          <input
                              key={key}
                              type="hidden"
                              name={key}
                              value={value}
                          />
                      ) : null
                  )
                : null}

            <div className="flex w-full items-stretch gap-2 rounded-xl border border-ink-200 bg-white p-1.5 transition focus-within:border-ink-900 focus-within:ring-4 focus-within:ring-ink-900/5">
                {leading ? (
                    <div className="hidden shrink-0 items-center sm:flex">
                        {leading}
                    </div>
                ) : null}

                <div className="flex min-w-0 flex-1 items-center gap-2 pl-2">
                    <svg
                        aria-hidden
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className={`h-5 w-5 shrink-0 text-ink-400 ${
                            large ? "text-ink-400" : ""
                        }`}
                    >
                        <circle cx="11" cy="11" r="7" />
                        <path d="m20 20-3.5-3.5" strokeLinecap="round" />
                    </svg>
                    <input
                        type="search"
                        name="q"
                        defaultValue={defaultValue}
                        placeholder={placeholder}
                        aria-label="Cari event, pertandingan, atau olahraga"
                        className={`min-w-0 flex-1 bg-transparent text-ink-900 placeholder:text-ink-400 focus:outline-none ${
                            large ? "h-12 text-base" : "h-10 text-sm"
                        }`}
                    />
                </div>

                <button
                    type="submit"
                    className={`shrink-0 rounded-xl bg-brand-600 font-semibold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                        large
                            ? "px-6 text-base"
                            : "px-4 text-sm"
                    }`}
                >
                    Cari
                </button>
            </div>
        </form>
    );
}
