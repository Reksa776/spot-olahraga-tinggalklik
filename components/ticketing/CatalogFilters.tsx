import type { ReactNode } from "react";

import Link from "next/link";

import {
    CATALOG_SORT_OPTIONS,
    DEFAULT_CATALOG_SORT,
    type CatalogParams,
} from "@/lib/ticketing/ui/catalog-href";

import SearchBar from "./SearchBar";
import SportGrid, { type SportOption } from "./SportGrid";

type Props = {
    /** The validated, current query — every control is rendered from it. */
    params: CatalogParams;
    sports: SportOption[];
    total: number;
};

/**
 * The discovery controls on `/events`.
 *
 * Structure, and why:
 *
 *   1. **Search first**, full width — it is the primary action on a discovery surface.
 *   2. **Sport chips**, horizontally scrollable, driven by the platform's own 14 sports.
 *   3. **Advanced filters** behind `<details>`: city, max price, date range, sort. Collapsed by
 *      default because most buyers filter by sport or date, and an always-open 5-field panel is
 *      the "overcrowded navigation" failure the brief warns about. It opens automatically whenever
 *      one of those filters is already applied, so the current state is never hidden.
 *
 * Everything is a real `GET` to `/events` (form) or a `Link` (chips), so filtering is server-side,
 * shareable and works without JavaScript. Nothing here is authoritative: the server re-validates
 * every parameter against `catalogQuerySchema`, and no control can express a value the server
 * would reject (the sort list is the server's own allow-list).
 *
 * The advanced form carries the current `q` and `sport` as hidden fields, so submitting a city
 * filter does not silently discard the search the buyer just typed.
 */
export default function CatalogFilters({ params, sports, total }: Props) {
    const advancedActive = Boolean(
        params.city || params.priceMax || params.dateFrom || params.dateTo
    );

    const anyFilter = Boolean(
        params.q ||
            params.sport ||
            params.city ||
            params.priceMax ||
            params.dateFrom ||
            params.dateTo
    );

    return (
        <section
            aria-label="Filter event"
            className="rounded-2xl border border-ink-100 bg-white p-4 shadow-sm sm:p-5"
        >
            <SearchBar
                size="lg"
                defaultValue={params.q}
                keep={{
                    sport: params.sport,
                    city: params.city,
                    dateFrom: params.dateFrom,
                    dateTo: params.dateTo,
                    priceMax: params.priceMax,
                    sort: params.sort,
                }}
            />

            <div className="mt-4">
                <SportGrid
                    id="cabang-olahraga"
                    variant="chip"
                    sports={sports}
                    activeSlug={params.sport}
                />
            </div>

            <details
                className="mt-4 border-t border-ink-100 pt-4"
                open={advancedActive}
            >
                <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm font-bold text-ink-700 transition hover:text-ink-900">
                    <span>
                        Filter lanjutan
                        {advancedActive ? (
                            <span className="ml-2 rounded-full bg-brand-100 px-2 py-0.5 text-[0.65rem] font-bold text-brand-800">
                                aktif
                            </span>
                        ) : null}
                    </span>
                    <span className="text-xs font-semibold text-ink-400">
                        Kota, harga, tanggal
                    </span>
                </summary>

                <form
                    action="/events"
                    method="get"
                    className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
                >
                    {params.q ? (
                        <input type="hidden" name="q" value={params.q} />
                    ) : null}
                    {params.sport ? (
                        <input type="hidden" name="sport" value={params.sport} />
                    ) : null}

                    <Field label="Kota" htmlFor="filter-city">
                        <input
                            id="filter-city"
                            name="city"
                            type="text"
                            defaultValue={params.city}
                            placeholder="Bandung"
                            className={inputClass}
                        />
                    </Field>

                    <Field label="Harga maksimum" htmlFor="filter-price">
                        <input
                            id="filter-price"
                            name="priceMax"
                            type="number"
                            min={0}
                            step={1000}
                            inputMode="numeric"
                            defaultValue={params.priceMax}
                            placeholder="150000"
                            className={inputClass}
                        />
                    </Field>

                    <Field label="Dari tanggal" htmlFor="filter-from">
                        <input
                            id="filter-from"
                            name="dateFrom"
                            type="date"
                            defaultValue={params.dateFrom?.slice(0, 10)}
                            className={inputClass}
                        />
                    </Field>

                    <Field label="Sampai tanggal" htmlFor="filter-to">
                        <input
                            id="filter-to"
                            name="dateTo"
                            type="date"
                            defaultValue={params.dateTo?.slice(0, 10)}
                            className={inputClass}
                        />
                    </Field>

                    <Field label="Urutkan" htmlFor="filter-sort">
                        <select
                            id="filter-sort"
                            name="sort"
                            defaultValue={params.sort ?? DEFAULT_CATALOG_SORT}
                            className={inputClass}
                        >
                            {CATALOG_SORT_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </Field>

                    <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-5">
                        <button
                            type="submit"
                            className="rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
                        >
                            Terapkan filter
                        </button>

                        {anyFilter ? (
                            <Link
                                href="/events"
                                className="rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-600 transition hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
                            >
                                Hapus semua filter
                            </Link>
                        ) : null}
                    </div>
                </form>
            </details>

            <p
                aria-live="polite"
                className="mt-4 border-t border-ink-100 pt-3 text-xs font-semibold text-ink-500"
            >
                {total} event ditemukan
                {params.sport ? " untuk cabang ini" : ""}
            </p>
        </section>
    );
}

const inputClass =
    "w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:border-ink-900 focus:outline-none focus:ring-4 focus:ring-ink-900/5";

function Field({
    label,
    htmlFor,
    children,
}: {
    label: string;
    htmlFor: string;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <label
                htmlFor={htmlFor}
                className="text-xs font-bold tracking-wide text-ink-500 uppercase"
            >
                {label}
            </label>
            {children}
        </div>
    );
}
