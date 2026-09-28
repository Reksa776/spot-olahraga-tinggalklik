import type { EventStatus } from "@prisma/client";

/**
 * ==========================================
 * EVENT STATUS — ONE VOCABULARY FOR THE DASHBOARD
 * ==========================================
 *
 * `EventStatus` has seven members and the back office renders them in three places (the event
 * list, the event detail header, and the overview's "upcoming" panel). Each place used to carry
 * its own inline map, and they had drifted: the list coloured `COMPLETED` but not `CANCELLED` the
 * same way the detail page did, and `ONGOING` — a real, reachable, tick-driven state
 * (`PUBLISHED → ONGOING` at `startAt`) — was absent from every one of them, so a live event
 * rendered as a neutral grey badge indistinguishable from a draft. This module is the single
 * source those three surfaces now read, so a status cannot be added or re-toned in one place and
 * forgotten in the others.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────────
 * `PENDING_REVIEW` is NOT listed. It exists in the Prisma enum, but the design locked
 * self-publish (D-13): there is no approval queue, so no code path can put an event in that
 * state. Listing it here would advertise a state the product cannot produce — and `eventStatusTone`
 * falls back to `neutral` for anything unrecognised, so a row that somehow held it would still
 * render safely rather than crash.
 *
 * ── TONE IS SEMANTIC, NOT DECORATIVE ─────────────────────────────────────────────
 *   DRAFT      neutral  not live; nothing is on sale
 *   PUBLISHED  success  live and sellable
 *   ONGOING    brand    live and happening now — distinct from merely published
 *   COMPLETED  info     finished, not a failure
 *   CANCELLED  error    the one status an operator must not miss
 *   ARCHIVED   neutral  soft-deleted; terminal
 *
 * ── WHY THE FILTER LIST IS SEPARATE FROM THE TONE ────────────────────────────────
 * `EVENT_STATUS_FILTERS` is the set the dashboard is willing to QUERY. It is the same six values:
 * filtering by a state that cannot exist would return an empty page and read like a bug. The
 * service accepts any `EventStatus`, so the dashboard validates the URL parameter against this
 * list before it reaches Prisma — an unknown value in `?status=` is ignored rather than handed to
 * the query layer, where it would raise instead of rendering a page.
 */

/**
 * Every status a running system can produce, in lifecycle order.
 *
 * The tuple is `as const` so `EventStatusFilter` is a literal union and a typo in a page becomes a
 * compile error; it is also typed as a subset of the Prisma enum, so a rename in the schema breaks
 * the build here rather than silently at runtime.
 */
export const EVENT_STATUS_FILTERS = [
    "DRAFT",
    "PUBLISHED",
    "ONGOING",
    "COMPLETED",
    "CANCELLED",
    "ARCHIVED",
] as const satisfies readonly EventStatus[];

export type EventStatusFilter = (typeof EVENT_STATUS_FILTERS)[number];

/**
 * The badge tone for a status.
 *
 * An unrecognised value — `PENDING_REVIEW` today, or a value added to the enum before this table is
 * updated — renders `neutral` rather than throwing, because a status label is presentation and must
 * never be able to take a page down.
 */
export function eventStatusTone(status: string): "neutral" | "success" | "info" | "warn" | "error" | "brand" {
    switch (status) {
        case "PUBLISHED":
            return "success";
        case "ONGOING":
            return "brand";
        case "COMPLETED":
            return "info";
        case "CANCELLED":
            return "error";
        case "DRAFT":
        case "ARCHIVED":
        default:
            return "neutral";
    }
}

/**
 * Narrow a query-string value to a status the dashboard will query.
 *
 * Returns `null` for anything else, including `undefined`, so the caller can pass the result
 * straight to the service (which treats `null` as "no status filter") without a second guard.
 */
export function parseEventStatusFilter(
    value: string | undefined
): EventStatusFilter | null {
    return value !== undefined &&
        (EVENT_STATUS_FILTERS as readonly string[]).includes(value)
        ? (value as EventStatusFilter)
        : null;
}

/**
 * The product definition of "event aktif": `PUBLISHED` **or** `ONGOING`.
 *
 * Declared here rather than re-derived in the page so the dashboard's "Event aktif" tile and the
 * events list filter cannot disagree about what "active" means. It mirrors the overview read
 * model's own union exactly (no date, visibility or `startAt` inference).
 */
export const EVENT_ACTIVE_STATUSES = [
    "PUBLISHED",
    "ONGOING",
] as const satisfies readonly EventStatus[];

/**
 * Normalise a repeated `?status=` into the subset the dashboard will actually query.
 *
 * Next delivers a repeated parameter as `string[]` and a single one as `string`; both are
 * accepted. Every value is narrowed against `EVENT_STATUS_FILTERS`, so an unknown string can never
 * reach Prisma — where it would raise on the enum instead of rendering a page. Order is preserved
 * and duplicates are dropped.
 */
export function parseEventStatusFilters(
    value: string | string[] | undefined
): EventStatusFilter[] {
    if (value === undefined) {
        return [];
    }

    const values = Array.isArray(value) ? value : [value];
    const seen = new Set<EventStatusFilter>();

    for (const candidate of values) {
        if ((EVENT_STATUS_FILTERS as readonly string[]).includes(candidate)) {
            seen.add(candidate as EventStatusFilter);
        }
    }

    return [...seen];
}

/** True when a filter is exactly the "event aktif" union (`PUBLISHED` + `ONGOING`). */
export function isEventActiveStatusFilter(
    statuses: readonly string[]
): boolean {
    return (
        statuses.length === EVENT_ACTIVE_STATUSES.length &&
        EVENT_ACTIVE_STATUSES.every((status) => statuses.includes(status))
    );
}
