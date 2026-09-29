import Link from "next/link";

import type { FilterUrlState } from "@/components/dashboard/filters/filter-types";
import { Button } from "@/components/dashboard/ui/button";
import { Label } from "@/components/dashboard/ui/input";

/**
 * ==========================================
 * SINGLE-SELECT FILTER — a native `<select>` in a GET form
 * ==========================================
 *
 *   EVENT   [ Semua event ▼ ]  [ Terapkan ]   Reset filter
 *
 * The single-select counterpart of `FilterPills`, for the one filter shape pills cannot serve:
 * a list that comes from the DATA (events a PIC has sold in, one per row) rather than from a
 * small fixed enum. A pill row would be as long as the PIC's event history and would push the
 * table off the first screen, so the choice is a dropdown — which is also what the dashboard's
 * other event filter already is (`ReportFilterBar`'s native `<select name="eventId">` on
 * `/dashboard/reports`), so the two event filters read the same way.
 *
 * ── WHY A NATIVE SELECT IN A SERVER-RENDERED GET FORM ───────────────────────────
 * Exactly the reason `ReportFilterBar` gives: a filter that only exists after hydration is a
 * filter that can silently report the WRONG set on first paint, and this surface's whole point
 * is that the numbers shown are the numbers the server queried. The `<form method="get">` needs
 * no JavaScript at all, the resulting URL is the state (shareable, bookmarkable, honoured before
 * any client code runs), and `<span className="hidden">`-style hidden fields carry the page's
 * OTHER filters so applying this one cannot clear them.
 *
 * ── `defaultValue`, NOT `value`: THE CONTROL CANNOT DISAGREE WITH THE QUERY ─────
 * The page hands the ALREADY-VALIDATED value it queried with, and the select renders it as its
 * default. A value the option list does not contain — reachable only by hand-editing the URL —
 * is appended as its own labelled option rather than being swallowed: a control that showed
 * "Semua event" while an event filter was narrowing the table would be lying about the rows on
 * screen, which is worse than showing an unfamiliar choice. The table under it is empty in that
 * case, and both agree.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────
 *   • no `useSearchParams`, no client boundary, no `onChange`-auto-submit: the page passes the
 *     validated state and the browser submits the form;
 *   • no `page` in `preserve` — a filter change returns to page 1, which is the same rule
 *     `applyFilterChange` applies to every other filter;
 *   • no option it was not given, so a control can never offer a value the read model would
 *     have to widen the caller's scope to honour.
 */

/** One control width for every select, matching the report filter bar. */
const SELECT_CLASS =
    "h-10 w-full rounded-field border border-input bg-card px-3 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

/** The label of the synthetic option for a selected value the option list cannot name. */
const UNKNOWN_OPTION_LABEL = "Event tidak dikenal";

/** Scalar → one hidden field; an ARRAY → one hidden field per value (`?a=1&a=2`). */
function hiddenEntries(preserve: FilterUrlState) {
    const entries: { key: string; value: string }[] = [];

    for (const [key, value] of Object.entries(preserve)) {
        if (value === null || value === undefined || value === "") {
            continue;
        }

        if (typeof value === "string") {
            entries.push({ key, value });
            continue;
        }

        for (const member of value) {
            if (member === "") {
                continue;
            }

            entries.push({ key, value: member });
        }
    }

    return entries;
}

export function SingleSelectFilter({
    action,
    name,
    label,
    allLabel,
    value,
    options,
    preserve = {},
    submitLabel = "Terapkan",
    resetLabel = "Reset filter",
}: {
    /** The page this form submits to; also the target of the reset link. */
    action: string;
    /** The query parameter this control owns. */
    name: string;
    label: string;
    /** The label of the empty option — `Semua event`. */
    allLabel: string;
    /** The validated value the page actually queried with. `""` = unfiltered. */
    value: string;
    options: readonly { value: string; label: string }[];
    /** The page's other validated filters, preserved as hidden fields. `page` must NOT be here. */
    preserve?: FilterUrlState;
    submitLabel?: string;
    resetLabel?: string;
}) {
    const isFiltered = value !== "";
    const known = options.some((option) => option.value === value);

    return (
        <form
            method="get"
            action={action}
            className="mb-4 flex flex-wrap items-end gap-3"
        >
            {hiddenEntries(preserve).map((entry, index) => (
                <input
                    key={`${entry.key}-${index}`}
                    type="hidden"
                    name={entry.key}
                    value={entry.value}
                />
            ))}

            <div className="flex min-w-56 flex-col gap-1.5">
                <Label htmlFor={`filter-${name}`}>{label}</Label>

                <select
                    id={`filter-${name}`}
                    name={name}
                    defaultValue={value}
                    className={SELECT_CLASS}
                >
                    <option value="">{allLabel}</option>

                    {options.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}

                    {/* A selected value the options cannot name: the filter IS applied, and the
                        control says so instead of falling back to a "no filter" claim. */}
                    {isFiltered && !known ? (
                        <option value={value}>{UNKNOWN_OPTION_LABEL}</option>
                    ) : null}
                </select>
            </div>

            <Button type="submit">{submitLabel}</Button>

            {isFiltered ? (
                <Link
                    href={action}
                    className="pb-2.5 text-sm font-semibold text-muted-foreground underline-offset-4 hover:underline"
                >
                    {resetLabel}
                </Link>
            ) : null}
        </form>
    );
}
