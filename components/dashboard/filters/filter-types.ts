/**
 * ==========================================
 * DASHBOARD FILTER TYPES — ONE OPTION MODEL, ONE URL MERGE
 * ==========================================
 *
 * Every dashboard list filter is a *selection* that resolves to a set of query parameters, and the
 * URL is the only state. This module is that contract, and it is deliberately free of React and of
 * any server-only import, so the SAME definition drives
 *
 *   • the server-rendered pill rows (`FilterPills` / `FilterBar`), including the period
 *     shortcuts (`PeriodPills`), and
 *   • the one client island, the search box (`DashboardFilterSearch`).
 *
 * ── WHY THE FILTER CHOICES ARE PILLS, NOT A DROPDOWN ────────────────────────────
 * A dashboard status filter has a handful of members and an operator who is usually looking for one
 * of the two or three that are actionable. A `<select>` hides all of them behind a click, so the
 * operator cannot see what CAN be filtered and the row cannot show an active state at a glance. A
 * row of pills is visible, highlightable and one click; it also needs no JavaScript, so the filter
 * is applied by the URL itself before hydration. The one exception is the search box, which must
 * hold a draft and is therefore the only client island here.
 *
 * ── WHY AN OPTION CARRIES ITS PARAMS, NOT JUST A VALUE ─────────────────────────
 * A dashboard filter is not always "one value for one parameter". Three of the audited filters are
 * NAMED UNIONS of enum values ("Event aktif" = `PUBLISHED ∪ ONGOING`, "Perlu ditangani" =
 * `PENDING ∪ PROCESSING`, "Menunggu persetujuan" = `REQUESTED ∪ PENDING_APPROVAL`), and the URL
 * format for a union is the repeated parameter the backend already parses:
 *
 *   ?status=PENDING&status=PROCESSING
 *
 * A single HTML control cannot emit two values, so the mapping from "the option the operator
 * picked" to "the parameters that option means" has to be DATA rather than an inferred value. An
 * option therefore carries `params`, and `FILTER_ALL` carries the removal. That is what lets the
 * union stay a label in the UI while the wire format stays exactly what the services, the parsers,
 * `LinkPagination` and the KPI deep links already use.
 *
 * ── WHY `page` IS ALWAYS DROPPED ──────────────────────────────────────────────
 * Narrowing a list returns to its first page: page 7 of a 3-page result is an empty table, which
 * reads as "the filter found nothing". Dropping `page` on every change is the one rule that keeps
 * a filter change from ever landing on an out-of-range page.
 */

export type FilterParamValue = string | readonly string[] | null | undefined;

/** The query state a page hands to a filter control: validated values, keyed by parameter name. */
export type FilterUrlState = Record<string, FilterParamValue>;

/** The option value that means "no filter": it OMITS the field's own parameter. */
export const FILTER_ALL = "all";

/**
 * The option value used when the URL holds a combination the option list cannot name.
 *
 * Only reachable by editing the URL by hand (`?status=DRAFT&status=PAID`), but it must not be
 * silently rendered as "Semua": a control that claims "no filter" while a filter is applied is
 * worse than one that shows something unusual. The page's field builder appends a labelled option
 * for it instead.
 */
export const FILTER_COMBINATION = "__combination";

export type FilterOption = {
    /** Stable identity (the React key and the active-state comparison). Never empty. */
    value: string;
    label: string;
    /**
     * The parameters this option writes. `null` removes a parameter. An ARRAY writes a repeated
     * parameter (`?status=A&status=B`). Absent falls back to `{ [field.name]: value }`.
     */
    params?: FilterUrlState;
};

export type FilterField = {
    /** The query parameter this field owns (also the control's id). */
    name: string;
    label: string;
    /** The option value currently selected. */
    value: string;
    options: FilterOption[];
    /** Layout hint, so one field can be wider (search) than the rest. */
    className?: string;
};

/**
 * The field a period shortcut row is built from: `period` with NO "all" member.
 *
 * A window is never unfiltered, so this field has no `FILTER_ALL` option and an empty `value` — which
 * means an explicit `from`/`to` range highlights no shortcut instead of claiming one. Every option's
 * params set ONLY `period`, so the merge (`applyFilterChange`) drops `from`/`to` and the parser is
 * left with exactly one thing to honour.
 */
export function buildPeriodField(config: {
    active: string | null;
    keys: readonly string[];
    labels: Record<string, string>;
    label?: string;
}): FilterField {
    const { active, keys, labels, label = "Periode" } = config;

    return {
        name: "period",
        label,
        value: active ?? "",
        options: keys.map((key) => ({
            value: key,
            label: labels[key] ?? key,
            params: { period: key },
        })),
    };
}

/**
 * Merge a filter change into the current query and return the href to navigate to.
 *
 * The other filters are preserved as they were, `page` is dropped, and `null`/`""`/`undefined`
 * remove a parameter. Arrays are appended once per value, which is how a union survives a change
 * to a different field.
 */
export function applyFilterChange(
    basePath: string,
    current: FilterUrlState,
    changes: FilterUrlState
): string {
    const merged: FilterUrlState = { ...current, ...changes };

    delete merged.page;

    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(merged)) {
        if (value === null || value === undefined || value === "") {
            continue;
        }

        if (typeof value === "string") {
            params.set(key, value);
            continue;
        }

        for (const entry of value) {
            if (entry === "") {
                continue;
            }

            params.append(key, entry);
        }
    }

    const query = params.toString();

    return query ? `${basePath}?${query}` : basePath;
}

/** Is any field (or the search box) currently narrowing the list? Drives the "Reset filter" link. */
export function hasActiveFilter(
    fields: readonly FilterField[],
    search?: string
): boolean {
    return (
        fields.some((field) => field.value !== FILTER_ALL) ||
        Boolean(search && search !== "")
    );
}

/** Set equality, order-independent. A union is recognised however its values were ordered. */
export function sameValueSet(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && b.every((entry) => a.includes(entry));
}

/** A NAMED UNION option — "Aktif", "Perlu Ditangani", "Menunggu Persetujuan". */
export type FilterUnionOption = {
    /** The option value, e.g. `active`, `needs_handling`, `awaiting_approval`. */
    value: string;
    label: string;
    /** The enum members the union stands for. Emitted as a REPEATED parameter. */
    statuses: readonly string[];
    /** Extra parameters the union also writes. */
    params?: FilterUrlState;
};

/**
 * Build one field (a row of pills) from the enum members a page may select.
 *
 * The returned `value` is resolved from the VALIDATED values the URL carried, so the row always
 * highlights the state the server queried with — never a local guess. Three cases:
 *
 *   · nothing selected            → `FILTER_ALL`, whose option removes the field's parameter (and
 *                                   which is what makes "Semua status" a visible first pill);
 *   · the named union             → the union's own key (order-independent);
 *   · exactly one member          → that member.
 *
 * A combination the option list cannot name (only reachable by editing the URL by hand, e.g.
 * `?status=DRAFT&status=PAID`) gets a SYNTHETIC option showing what is actually applied. That is
 * deliberate: a control that rendered "Semua" while a filter was in force would be lying about the
 * rows on screen, which is worse than showing an unusual label.
 *
 * Every option writes ONLY its own field: one row cannot move a parameter belonging to another row,
 * so two rows can never disagree with each other about the state they are showing.
 */
export function buildFilterField(config: {
    name: string;
    label: string;
    /** The option label for "no filter" — `Semua status`, `Semua pembayaran`, … */
    allLabel: string;
    /** The validated, deduped values the URL currently carries for this field. */
    values: readonly string[];
    /** Every member the control may select, in the order it should be offered. */
    members: readonly string[];
    labels: Record<string, string>;
    union?: FilterUnionOption;
    className?: string;
}): FilterField {
    const { name, label, allLabel, values, members, labels, union, className } = config;

    const options: FilterOption[] = [
        { value: FILTER_ALL, label: allLabel, params: { [name]: null } },
    ];

    if (union) {
        options.push({
            value: union.value,
            label: union.label,
            params: union.params ?? { [name]: [...union.statuses] },
        });
    }

    for (const member of members) {
        options.push({
            value: member,
            label: labels[member] ?? member,
            params: { [name]: member },
        });
    }

    let value = FILTER_ALL;

    if (values.length > 0) {
        if (union && sameValueSet(values, union.statuses)) {
            value = union.value;
        } else if (values.length === 1 && members.includes(values[0])) {
            value = values[0];
        } else {
            value = FILTER_COMBINATION;

            options.push({
                value: FILTER_COMBINATION,
                label: values.map((entry) => labels[entry] ?? entry).join(" + "),
                params: { [name]: [...values] },
            });
        }
    }

    return { name, label, value, options, className };
}
