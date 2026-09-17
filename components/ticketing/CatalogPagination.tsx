import Link from "next/link";

import {
    buildCatalogHref,
    type CatalogParams,
} from "@/lib/ticketing/ui/catalog-href";

type Props = {
    params: CatalogParams;
    page: number;
    totalPages: number;
};

/**
 * Page navigation for the catalog.
 *
 * Real links, not buttons, and built through `buildCatalogHref` so a page change preserves every
 * active filter (and drops nothing). Renders nothing when there is only one page, because a
 * one-page paginator is furniture.
 *
 * The window is capped at seven visible numbers with ellipses, so a large result set cannot push
 * the controls off a 375px screen.
 */
export default function CatalogPagination({ params, page, totalPages }: Props) {
    if (totalPages <= 1) {
        return null;
    }

    const pages = pageWindow(page, totalPages);

    return (
        <nav
            aria-label="Navigasi halaman"
            className="mt-8 flex flex-wrap items-center justify-center gap-1.5"
        >
            {page > 1 ? (
                <Link
                    href={buildCatalogHref(params, { page: String(page - 1) })}
                    rel="prev"
                    className={linkClass(false)}
                >
                    Sebelumnya
                </Link>
            ) : null}

            {pages.map((entry, index) =>
                entry === "gap" ? (
                    <span
                        key={`gap-${index}`}
                        aria-hidden
                        className="px-2 text-sm text-ink-400"
                    >
                        …
                    </span>
                ) : (
                    <Link
                        key={entry}
                        href={buildCatalogHref(params, { page: String(entry) })}
                        aria-current={entry === page ? "page" : undefined}
                        aria-label={`Halaman ${entry}`}
                        className={linkClass(entry === page)}
                    >
                        {entry}
                    </Link>
                )
            )}

            {page < totalPages ? (
                <Link
                    href={buildCatalogHref(params, { page: String(page + 1) })}
                    rel="next"
                    className={linkClass(false)}
                >
                    Berikutnya
                </Link>
            ) : null}
        </nav>
    );
}

function linkClass(active: boolean): string {
    return `inline-flex min-w-9 items-center justify-center rounded-lg border px-3 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
        active
            ? "border-ink-900 bg-ink-900 text-white"
            : "border-ink-200 bg-white text-ink-700 hover:border-ink-900 hover:text-ink-900"
    }`;
}

/** `1 … 4 5 6 … 20` — first, last and a window around the current page. */
function pageWindow(page: number, totalPages: number): (number | "gap")[] {
    const window = 1;
    const entries: (number | "gap")[] = [];

    for (let candidate = 1; candidate <= totalPages; candidate += 1) {
        const isEdge = candidate === 1 || candidate === totalPages;
        const isNear = Math.abs(candidate - page) <= window;

        if (isEdge || isNear) {
            entries.push(candidate);
        } else if (entries[entries.length - 1] !== "gap") {
            entries.push("gap");
        }
    }

    return entries;
}
