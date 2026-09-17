import type { TicketWalletItem } from "@/lib/ticketing/tickets/payload";

/**
 * ==========================================
 * PHASE 9 — WALLET GROUPING (pure)
 * ==========================================
 *
 * The wallet's presentational layer (its views, and the one derived split), extracted so it is
 * testable without a renderer and so the page stays a thin projection of the server payload.
 *
 * ── WHAT IS AUTHORITATIVE AND WHAT IS PRESENTATION ───────────────────────────────
 * The **list** is authoritative and server-derived: `listOwnTickets` applies
 * `holderUserId = session.user.id` and the `ticket.read.own` permission, and its `upcoming`
 * flag is resolved in SQL against `event.startAt`.
 *
 * The **past** view is a presentation slice of the `all` response, computed here against the
 * list the server already authorised. That is deliberate and safe: it cannot widen what the
 * buyer may see (it only filters rows the server chose to return), and it does not pretend to
 * be a query filter. The alternative — a third server mode — would mean a second definition of
 * "past" (the catalog's own `endAt ?? startAt` rule) drifting from this one.
 */

export type WalletTimeSplit = {
    upcoming: TicketWalletItem[];
    past: TicketWalletItem[];
};

/**
 * Split the authorised list into "not yet started" and "already started".
 *
 * Uses `event.startAt`, the same boundary the server's `upcoming` flag uses, so the two views
 * cannot disagree about a ticket that is starting right now.
 */
export function splitWalletByTime(
    items: readonly TicketWalletItem[],
    now: Date = new Date()
): WalletTimeSplit {
    const upcoming: TicketWalletItem[] = [];
    const past: TicketWalletItem[] = [];
    const boundary = now.getTime();

    for (const item of items) {
        if (new Date(item.event.startAt).getTime() >= boundary) {
            upcoming.push(item);
        } else {
            past.push(item);
        }
    }

    return { upcoming, past };
}

/** The wallet's three views. `upcoming` and `all` are server modes; `past` is derived. */
export const WALLET_VIEWS = [
    { value: "upcoming", label: "Akan datang" },
    { value: "all", label: "Semua" },
    { value: "past", label: "Sudah lewat" },
] as const;

export type WalletView = (typeof WALLET_VIEWS)[number]["value"];

/** Coerce an untrusted `?view=` value to a known view, defaulting to `upcoming`. */
export function parseWalletView(value: string | undefined): WalletView {
    return WALLET_VIEWS.some((view) => view.value === value)
        ? (value as WalletView)
        : "upcoming";
}
