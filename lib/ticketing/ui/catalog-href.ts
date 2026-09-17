/**
 * ==========================================
 * PHASE 9 — CATALOG URL STATE (pure)
 * ==========================================
 *
 * The discovery surfaces are server-rendered and filter through **URL query parameters**, so
 * every filter control is a plain `<Link>` (or a GET `<form>`) and the resulting page is
 * shareable, bookmarkable, back-button-correct and crawlable. Brief §A5: "Use URL query
 * parameters for shareable searches where appropriate... Do not create client-only filtering
 * when server-side filtering is required for correctness/performance."
 *
 * Extracted from the page so the merge rules are testable without a DOM or a database, and so
 * the listing and the homepage build their links the same way:
 *
 *   - only the parameters the server actually accepts are ever emitted
 *     (`lib/events/validation.ts#catalogQuerySchema`): q, sport, city, dateFrom, dateTo,
 *     priceMax, hasTickets, sort, page;
 *   - empty/undefined values are DROPPED rather than sent as `?sport=`, so "Semua" really
 *     removes the filter instead of applying an empty one;
 *   - changing any filter RESETS pagination. This is the rule that is easy to get wrong and
 *     the reason this is a tested module: keeping `page=4` while the filter narrows the
 *     result set is how a user lands on an empty page 4 of a 1-page list.
 */

/** The parameters the public catalog understands. Values are strings: they come from the URL. */
export type CatalogParams = {
    q?: string;
    sport?: string;
    city?: string;
    dateFrom?: string;
    dateTo?: string;
    priceMax?: string;
    hasTickets?: string;
    sort?: string;
    page?: string;
};

const ALLOWED_KEYS = [
    "q",
    "sport",
    "city",
    "dateFrom",
    "dateTo",
    "priceMax",
    "hasTickets",
    "sort",
    "page",
] as const satisfies readonly (keyof CatalogParams)[];

/**
 * Sort options, mirrored from `CATALOG_SORT_VALUES` in `lib/events/validation.ts` with the
 * buyer-facing label. The values themselves are the server's allow-list; a label change here
 * cannot invent a sort the server would reject.
 */
export const CATALOG_SORT_OPTIONS = [
    { value: "startAt_asc", label: "Terdekat" },
    { value: "newest", label: "Terbaru" },
    { value: "price_asc", label: "Harga terendah" },
    { value: "price_desc", label: "Harga tertinggi" },
] as const;

export const DEFAULT_CATALOG_SORT = "startAt_asc";

/** Strip a search-params object down to the allow-listed, non-empty keys. */
export function normalizeCatalogParams(
    input: Record<string, string | undefined>
): CatalogParams {
    const output: CatalogParams = {};

    for (const key of ALLOWED_KEYS) {
        const value = input[key]?.trim();

        if (value) {
            output[key] = value;
        }
    }

    return output;
}

/**
 * Build a catalog href with `overrides` applied.
 *
 * `overrides` values are `undefined` to REMOVE a parameter, which is what a "Semua cabang"
 * chip needs. Any override other than `page` clears the page, per the note above.
 */
export function buildCatalogHref(
    current: Record<string, string | undefined>,
    overrides: Partial<Record<keyof CatalogParams, string | undefined>> = {},
    basePath = "/events"
): string {
    const merged: Record<string, string | undefined> = {
        ...current,
        ...overrides,
    };

    const changesFilters = Object.keys(overrides).some((key) => key !== "page");

    if (changesFilters && overrides.page === undefined) {
        merged.page = undefined;
    }

    const params = normalizeCatalogParams(merged);
    const query = new URLSearchParams(params).toString();

    return query ? `${basePath}?${query}` : basePath;
}

/** True when the given key is currently applied — used for chip/active states. */
export function isActiveParam(
    current: Record<string, string | undefined>,
    key: keyof CatalogParams,
    value?: string
): boolean {
    const present = current[key]?.trim();

    if (value === undefined) {
        return !present;
    }

    return present === value;
}
