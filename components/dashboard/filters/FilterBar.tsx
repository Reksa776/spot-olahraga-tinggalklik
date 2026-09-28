import type { ReactNode } from "react";

import { TableToolbar, TextLink } from "@/components/dashboard/primitives";

import { DashboardFilterSearch } from "./DashboardFilterSearch";
import { FilterPills } from "./FilterPills";
import { hasActiveFilter, type FilterField, type FilterUrlState } from "./filter-types";

/**
 * ==========================================
 * FILTER BAR — one toolbar, visible choices
 * ==========================================
 *
 *   STATUS PEMBAYARAN [ Semua pembayaran ] [ Belum dibayar ] [ Lunas ] …
 *   [ Cari pesanan… ]                                   Reset filter
 *   Menampilkan pesanan dengan status pesanan Menunggu pembayaran — Tampilkan semua pesanan
 *
 * A SERVER component wrapping the existing `TableToolbar` primitive: the whole filter surface is
 * rendered HTML with no client boundary, so it is complete and correct in the first paint. Each
 * field is a labelled `FilterPills` row; the optional search box is the one client island (it has
 * to be — a text input needs to hold a draft), and it merges into the same URL.
 *
 * ── WHY THE GROUPS ARE CAPTIONED ────────────────────────────────────────────────
 * A single group reads as a row of pills above the table and needs no caption. Several groups would
 * be genuinely different filters (the users list pairs a role row with a search box), so each gets
 * its own uppercase label rather than becoming an indistinguishable wall of pills. The caption is the
 * field's `label`, which is also the `<nav>`'s `aria-label`.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────
 *   • no `useSearchParams` — the page passes the VALIDATED state as props, so the server stays the
 *     single reader of `searchParams`;
 *   • no per-page merge logic — `applyFilterChange` is the one implementation;
 *   • no field it was not given: a field only exists when the page built one, which is how a
 *     permission the operator lacks can never draw a control.
 *
 * ── WHY THE HINT IS ALSO THE DEEP-LINK NOTICE ───────────────────────────────────
 * A filter row only explains filters it OWNS. A parameter a page still honours for a drill-down
 * (the orders list's `?status=`, which the "Menunggu bayar" tile links to) has no pill and would
 * otherwise narrow the table invisibly. The `hint` slot is where that is stated, in words, next to
 * the controls — and it is NOT a control: there is no option list to choose from.
 *
 * `page` is dropped by `applyFilterChange` on every selection, so a filter change always lands on
 * page 1 while the pager keeps the filters across pages.
 *
 * ── WHY THERE IS A `bare` VARIANT ───────────────────────────────────────────────
 * A filter bar is normally the panel ABOVE a page's table. The PIC dashboard's "Event Saya" lives
 * inside a `SectionCard`, and the full form would nest one panel inside another — a second border,
 * radius and shadow for the same content. `bare` renders the identical control row without the
 * panel, so a section-scoped filter looks like part of its section instead of a widget dropped into
 * it. The controls, the captions, the reset link and the URL contract are byte-identical either way.
 */
export function FilterBar({
    basePath,
    fields,
    current,
    search,
    hint,
    resetLabel = "Reset filter",
    bare = false,
}: {
    basePath: string;
    fields: FilterField[];
    /** The page's validated query state, preserved across every selection. */
    current: FilterUrlState;
    /** Present only where the read model implements `q`. */
    search?: { value?: string; label?: string; placeholder?: string; name?: string };
    /**
     * One line explaining what the filters mean — or what is applied by a DEEP LINK. A node rather
     * than a string because the orders list uses it to state the order-status a KPI drill-down
     * carried, with the link that clears it. */
    hint?: ReactNode;
    resetLabel?: string;
    /** Render the control row without the surrounding panel (see the docblock above). */
    bare?: boolean;
}) {
    const isFiltered = hasActiveFilter(fields, search?.value);

    /* One group reads as a row; several need captions so they cannot be mistaken for one another. */
    const captioned = fields.length > 1;

    const controls = (
        <>
            {fields.map((field) => (
                <div key={field.name} className="flex w-full flex-col gap-1.5">
                    {captioned ? (
                        <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground">
                            {field.label}
                        </span>
                    ) : null}

                    <FilterPills field={field} basePath={basePath} current={current} />
                </div>
            ))}

            {search ? (
                <DashboardFilterSearch
                    name={search.name}
                    label={search.label}
                    placeholder={search.placeholder}
                    value={search.value}
                    basePath={basePath}
                    current={current}
                />
            ) : null}

            {isFiltered ? (
                <TextLink href={basePath} className="pb-2.5">
                    {resetLabel}
                </TextLink>
            ) : null}

            {hint ? (
                <span className="w-full text-xs text-muted-foreground">{hint}</span>
            ) : null}
        </>
    );

    // `TableToolbar` is the panel plus this exact flex row; `bare` keeps only the row, with the
    // same `mb-4` the panel carries so the space above the table is unchanged.
    return bare ? (
        <div className="mb-4 flex flex-wrap items-end gap-4">{controls}</div>
    ) : (
        <TableToolbar>{controls}</TableToolbar>
    );
}
