"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/dashboard/ui/button";
import { Input, Label } from "@/components/dashboard/ui/input";

import { applyFilterChange, type FilterUrlState } from "./filter-types";

/**
 * ==========================================
 * DASHBOARD FILTER SEARCH — the `q` box the read models already supported
 * ==========================================
 *
 * The audit found FIVE read models that implement `q` (`listOrganizerEvents`,
 * `listDashboardOrders`, `listDashboardPayments`, `listDashboardCustomers`, `listDashboardRefunds`)
 * and ZERO pages that rendered a control for it. This is that control: it turns an already-shipped
 * backend capability into a visible one, and changes no query semantics — the service's own
 * `contains` predicate and its validated column list do all the work.
 *
 * ── SUBMIT, NOT KEYSTROKE, NAVIGATION ──────────────────────────────────────────
 * Search is a real form submit (Enter or the button). Each navigation is a server round trip, so
 * firing one per keystroke would issue a request per character and race its own responses; the
 * explicit submit keeps one request per intent, and the browser's own form semantics keep Enter
 * working. The field's VALUE is server-resolved (`value` prop) and only the draft is local.
 *
 * The merge preserves every other filter, so searching never silently drops the pill selection —
 * and an emptied box removes `q` rather than leaving `?q=` behind.
 */
export function DashboardFilterSearch({
    name = "q",
    label = "Cari",
    placeholder,
    basePath,
    current,
    value,
    className = "flex min-w-56 flex-[2] flex-col gap-1.5",
}: {
    name?: string;
    label?: string;
    placeholder?: string;
    basePath: string;
    current: FilterUrlState;
    /** The applied search term, resolved by the page from `searchParams`. */
    value?: string;
    className?: string;
}) {
    const router = useRouter();
    const [draft, setDraft] = useState(value ?? "");
    const controlId = `filter-${name}`;

    function apply() {
        const trimmed = draft.trim();

        router.push(
            applyFilterChange(basePath, current, {
                [name]: trimmed === "" ? null : trimmed,
            })
        );
    }

    return (
        <form
            role="search"
            className={className}
            onSubmit={(event) => {
                event.preventDefault();
                apply();
            }}
        >
            <Label htmlFor={controlId}>{label}</Label>

            <div className="flex items-center gap-2">
                <Input
                    id={controlId}
                    type="search"
                    value={draft}
                    placeholder={placeholder}
                    onChange={(event) => setDraft(event.target.value)}
                />

                <Button type="submit" variant="outline" size="sm" className="h-10 shrink-0">
                    Cari
                </Button>
            </div>
        </form>
    );
}
