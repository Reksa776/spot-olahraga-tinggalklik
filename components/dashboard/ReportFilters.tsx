import Link from "next/link";

import { TableToolbar } from "@/components/dashboard/primitives";
import { Button } from "@/components/dashboard/ui/button";
import { Input, Label } from "@/components/dashboard/ui/input";

/**
 * ==========================================
 * REPORT FILTER BAR (server component)
 * ==========================================
 *
 * A plain `GET` form. The page it lives on is a server component, so the filters become a URL —
 * which is the property that makes a report shareable, bookmarkable and re-runnable, and it is why
 * the same query string can be handed straight to the download endpoint.
 *
 * ── WHY NATIVE CONTROLS ────────────────────────────────────────────────────────
 * The rest of the dashboard uses the shadcn `Input`/`Button` (both of which are plain wrappers and
 * are used here), but the two dropdowns are NATIVE `<select>` elements styled with the same token
 * classes. The radix `Select` keeps its value in component state and reflects it into form
 * submission through a synthetic element, which is fine for a client form and wrong for this one:
 * a filter that depends on hydration is a filter that silently reports the WRONG window the first
 * time someone opens the page in a fresh tab, and the whole point of this surface is that the
 * numbers it shows are the numbers it queried.
 *
 * The period shortcuts are links rather than more form state: each one is a complete, explicit
 * query, so "30 hari terakhir" is a URL someone can send to a colleague.
 *
 * The download links are plain `<a>` elements, not `next/link`: the endpoint answers with
 * `Content-Disposition: attachment`, which a client-side navigation cannot honour.
 */

/** One control width for every field, so the bar reads as a row rather than a jumble. */
const SELECT_CLASS =
    "h-10 w-full rounded-field border border-input bg-card px-3 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

export type ReportFilterValues = {
    from: string;
    to: string;
    eventId: string;
    status: string;
};

export function ReportFilterBar({
    action,
    values,
    events,
    statuses,
    periods,
    downloads,
    notice,
}: {
    action: string;
    values: ReportFilterValues;
    events: { id: string; title: string }[];
    statuses: { value: string; label: string }[];
    periods: { key: string; label: string; href: string; active: boolean }[];
    downloads: { key: string; label: string; href: string }[];
    notice?: string | null;
}) {
    return (
        <div className="flex flex-col gap-3">
            <TableToolbar className="mb-0">
                <form
                    method="get"
                    action={action}
                    className="flex w-full flex-wrap items-end gap-4"
                >
                    <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                        <Label htmlFor="report-from">Dari</Label>
                        <Input
                            id="report-from"
                            type="date"
                            name="from"
                            defaultValue={values.from}
                        />
                    </div>

                    <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                        <Label htmlFor="report-to">Sampai</Label>
                        <Input
                            id="report-to"
                            type="date"
                            name="to"
                            defaultValue={values.to}
                        />
                    </div>

                    <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                        <Label htmlFor="report-event">Event</Label>
                        <select
                            id="report-event"
                            name="eventId"
                            defaultValue={values.eventId}
                            className={SELECT_CLASS}
                        >
                            <option value="">Semua event</option>
                            {events.map((event) => (
                                <option key={event.id} value={event.id}>
                                    {event.title}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="flex min-w-44 flex-1 flex-col gap-1.5">
                        <Label htmlFor="report-status">Status pesanan</Label>
                        <select
                            id="report-status"
                            name="status"
                            defaultValue={values.status}
                            className={SELECT_CLASS}
                        >
                            <option value="">Semua status</option>
                            {statuses.map((status) => (
                                <option key={status.value} value={status.value}>
                                    {status.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="flex items-center gap-2">
                        <Button type="submit">Terapkan</Button>
                        <Link
                            href={action}
                            className="text-sm font-semibold text-muted-foreground underline-offset-4 hover:underline"
                        >
                            Reset
                        </Link>
                    </div>
                </form>
            </TableToolbar>

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground">
                        Periode
                    </span>

                    {periods.map((period) => (
                        <Link
                            key={period.key}
                            href={period.href}
                            aria-current={period.active ? "true" : undefined}
                            className={
                                period.active
                                    ? "rounded-field border border-primary bg-primary/10 px-3 py-1.5 text-[0.8125rem] font-semibold text-primary"
                                    : "rounded-field border border-input px-3 py-1.5 text-[0.8125rem] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                            }
                        >
                            {period.label}
                        </Link>
                    ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {downloads.map((download) => (
                        <a
                            key={download.key}
                            href={download.href}
                            className="inline-flex h-10 items-center gap-2 rounded-field border border-input bg-card px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
                        >
                            {download.label}
                        </a>
                    ))}
                </div>
            </div>

            {notice ? (
                <p className="rounded-field border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[0.8125rem] text-amber-700 dark:text-amber-300">
                    {notice}
                </p>
            ) : null}
        </div>
    );
}
