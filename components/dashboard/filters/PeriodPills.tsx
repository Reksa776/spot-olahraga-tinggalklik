import { REPORT_PERIOD_KEYS, REPORT_PERIOD_LABELS } from "@/lib/dashboard/filter-options";

import { FilterPills } from "./FilterPills";
import { buildPeriodField, type FilterUrlState } from "./filter-types";

/**
 * ==========================================
 * PERIOD PILLS — the window shortcuts, as visible one-click links
 * ==========================================
 *
 * The reports surface and the overview charts share ONE window, chosen with `?period=7d|30d|3m` or an
 * explicit `?from=&to=` pair. This is the shortcut row for both, so the two surfaces cannot offer
 * different windows or highlight differently.
 *
 * ── NO "SEMUA" OPTION, AND WHY ──────────────────────────────────────────────────
 * A period has no "unfiltered" state: the window is ALWAYS some range. So this field has no
 * `FILTER_ALL` member and an empty `value`, which means that when an explicit `from`/`to` range is in
 * force NO shortcut is highlighted — which is exactly the state the operator is in. Inventing a
 * "Custom" option would put a second, redundant control (the date inputs are already on screen) in
 * the row and would highlight it for a range the pipes never set.
 *
 * ── WHY THE SHORTCUT REPLACES THE RANGE ─────────────────────────────────────────
 * Each option's params set `period` and — because `from`/`to` are simply not in `current` — the merge
 * drops them. `resolveDashboardReportFilters` gives an explicit `from` precedence over a shortcut, so a
 * href that carried both would silently keep the OLD window when someone picked "7 hari". Carrying
 * neither leaves the parser exactly one thing to honour.
 *
 * ── THE OTHER FILTERS SURVIVE ───────────────────────────────────────────────────
 * `current` is the page's validated state (the report's event and order-status filters), so a shortcut
 * keeps them — the same property the pills had before the row was briefly a `<select>`.
 */
export function PeriodPills({
    basePath,
    current,
    active,
    label = "Periode",
    className,
}: {
    basePath: string;
    /** The page's validated query state: every other filter, so a shortcut preserves it. */
    current: FilterUrlState;
    /** The shortcut the URL is currently in, or `null` when an explicit range is in force. */
    active: string | null;
    label?: string;
    className?: string;
}) {
    const field = buildPeriodField({
        active,
        keys: REPORT_PERIOD_KEYS,
        labels: REPORT_PERIOD_LABELS,
        label,
    });

    return (
        <FilterPills
            field={field}
            basePath={basePath}
            current={current}
            className={className}
        />
    );
}
