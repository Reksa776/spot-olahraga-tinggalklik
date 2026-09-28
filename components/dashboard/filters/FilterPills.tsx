import Link from "next/link";

import { cn } from "@/lib/utils";

import {
    applyFilterChange,
    FILTER_ALL,
    type FilterField,
    type FilterUrlState,
} from "./filter-types";

/**
 * ==========================================
 * FILTER PILLS — visible, one-click, server-rendered
 * ==========================================
 *
 * One field rendered as a row of pill LINKS. A server component with no state, no hooks and no
 * client boundary, which is what makes it the right presentation for the dashboard's status
 * filters:
 *
 *   VISIBLE       every choice is on screen, so an operator can see what CAN be filtered instead
 *                 of having to open a control to discover it;
 *   ONE CLICK     a pill is a link — the filter cannot be mis-applied by pressing "apply", and
 *                 there is no dropdown left open behind the table;
 *   OBVIOUS       the active pill is `aria-current="true"` and carries the brand treatment, and
 *                 it is decided by the same value the SERVER queried with;
 *   NO JS         the selection is a URL, so it works before hydration, survives a refresh, is
 *                 shareable, and Back/Forward behave;
 *   PAGINATION    each pill's href is built from `current`, so the other filters and the search
 *                 term ride along, and the pager keeps whatever the pill selected.
 *
 * ── THE UNION STILL WORKS ───────────────────────────────────────────────────────
 * An option's href comes from its own `params`, so the NAMED UNIONS keep emitting the repeated
 * parameter the backend already parses (`?status=PENDING&status=PROCESSING`,
 * `?status=PUBLISHED&status=ONGOING`, `?status=REQUESTED&status=PENDING_APPROVAL`). The
 * presentation changed; the wire format and every predicate did not.
 *
 * ── ACCESSIBILITY ───────────────────────────────────────────────────────────────
 * The row is a labelled `<nav>`, so a screen reader announces which filter it is even when the
 * page renders a single group without a visible caption — and the active state is announced from
 * `aria-current`, not from a bullet character inside the label.
 */
export function FilterPills({
    field,
    basePath,
    current,
    className,
}: {
    field: FilterField;
    basePath: string;
    /** The page's validated query state: every other filter and the search term. */
    current: FilterUrlState;
    className?: string;
}) {
    return (
        <nav
            aria-label={field.label}
            className={cn("flex flex-wrap items-center gap-2", className)}
        >
            {field.options.map((option) => {
                const active = option.value === field.value;

                const changes: FilterUrlState = option.params ?? {
                    [field.name]: option.value === FILTER_ALL ? null : option.value,
                };

                return (
                    <Link
                        key={option.value}
                        href={applyFilterChange(basePath, current, changes)}
                        aria-current={active ? "true" : undefined}
                        className={cn(
                            "rounded-field border px-3 py-1.5 text-[0.8125rem] transition-colors",
                            active
                                ? "border-primary bg-primary/10 font-semibold text-primary"
                                : "border-input font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                    >
                        {option.label}
                    </Link>
                );
            })}
        </nav>
    );
}
