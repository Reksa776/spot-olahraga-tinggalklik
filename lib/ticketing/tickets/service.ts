import type { Prisma } from "@prisma/client";

import { AppError } from "@/lib/api/errors";
import { requireOwnResource } from "@/lib/authz/guards";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz/permissions";
import { prisma } from "@/lib/prisma";

import { isTicketCode } from "./reference";
import {
    buildTicketDetail,
    buildWalletItem,
    TICKET_WALLET_SELECT,
    type TicketDetail,
    type TicketWalletPayload,
} from "./payload";
import type { TicketWalletQuery } from "./validation";

/**
 * ==========================================
 * PHASE 8 — THE BUYER'S TICKET WALLET (read side)
 * ==========================================
 *
 * Design §26.5 (`GET /api/tickets`) and §26.6 (`GET /api/tickets/{ticketCode}`) with one
 * substitution, forced by the tree as it stood: the routes live under `/api/ticketing/**`
 * because the retail siblings owned `/api/orders/**`. Retail is gone now, but ticketing
 * stays namespaced rather than renaming live endpoints.
 *
 * ── OWNERSHIP IS STRUCTURAL, NOT A CHECK ─────────────────────────────────────────
 * Every query below carries `holderUserId: <session user>` in its `where` clause. That is
 * the Phase 0 pattern the design mandates (§26: "Every one applies an ownership predicate
 * (`userId = session.user.id`) ... the Phase 0 pattern (`where: { id, userId }`) is
 * preserved and is mandatory"), and it is deliberately not a post-fetch comparison: a
 * predicate in the query cannot be forgotten between the fetch and the response.
 *
 * The consequence is the behaviour the brief asks for: another buyer's ticket is
 * `NOT_FOUND` (404), never `FORBIDDEN` (403). A 403 would confirm that the code exists.
 *
 * ── AND THE PERMISSION LAYER IS STILL APPLIED ────────────────────────────────────
 * `requireOwnResource(PERMISSIONS.TICKET_READ_OWN, actor.userId)` runs too, so a role that
 * has no `ticket.read.own` capability is refused even for its own tickets. The two controls
 * answer different questions (may this actor read own tickets? is this row theirs?) and both
 * must hold. Nothing here consults a request body: brief §27's forbidden fields
 * (`userId`, `organizerId`, `ticketStatus`, …) are not read anywhere in this module.
 */

/**
 * Default and maximum page size.
 *
 * Design §26.5 gives the wallet list pagination without a cap; §26.1 caps the order list at
 * 50, so the same ceiling is applied here rather than letting an authenticated caller ask
 * for an unbounded page.
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * `GET /api/ticketing/tickets` — the buyer's own tickets (design §26.5).
 *
 * Ordering is `event.startAt` ascending then `ticketCode`, i.e. deterministic and
 * meaningful: the next event a buyer is attending comes first, and tickets for the same
 * event stay grouped in a stable order. Deterministic ordering matters because the wallet
 * paginates — an unstable sort would show duplicates and skip rows across pages.
 */
export async function listOwnTickets(
    query: TicketWalletQuery,
    actor: AuthzScope
): Promise<TicketWalletPayload> {
    if (!actor?.userId) {
        throw AppError.validation("Pemanggil tidak terautentikasi.");
    }

    await requireOwnResource(PERMISSIONS.TICKET_READ_OWN, actor.userId);

    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const where: Prisma.TicketWhereInput = {
        holderUserId: actor.userId,
    };

    if (query.status) {
        where.status = query.status;
    }

    if (query.eventId) {
        where.eventId = query.eventId;
    }

    if (query.upcoming !== false) {
        // "Upcoming" is about the EVENT, not the ticket: a ticket for a past event is
        // still valid to view, it just is not what a buyer opens the wallet for. The
        // default-on behaviour is the design's (§26.5 `upcoming (default)`).
        where.event = { startAt: { gte: new Date() } };
    }

    const [total, rows] = await Promise.all([
        prisma.ticket.count({ where }),
        prisma.ticket.findMany({
            where,
            select: TICKET_WALLET_SELECT,
            orderBy: [{ event: { startAt: "asc" } }, { ticketCode: "asc" }],
            skip: (page - 1) * limit,
            take: limit,
        }),
    ]);

    return {
        items: rows.map(buildWalletItem),
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}

/**
 * `GET /api/ticketing/tickets/{ticketCode}` — one ticket, QR included (design §26.6).
 *
 * Brief §37 is explicit that an opaque code buys no anonymity: "Never make
 * `/api/ticketing/tickets/[ticketCode]` public merely because ticketCode is opaque."
 * Hence the same session + ownership predicate as the list.
 *
 * PHASE 16 — `now` is injectable for the same reason every other time-dependent predicate in
 * this tree takes one (`isEventCheckInOpen`, `advanceEventLifecycleBatch`, `expireDueReservations`):
 * the QR verdict depends on the clock, and a test must be able to assert a boundary exactly
 * instead of racing it. Production callers omit it and get the server clock.
 */
export async function getOwnTicket(
    ticketCode: string,
    actor: AuthzScope,
    now: Date = new Date()
): Promise<TicketDetail> {
    if (!actor?.userId) {
        throw AppError.validation("Pemanggil tidak terautentikasi.");
    }

    // Shape-check before touching the database: a code that cannot exist is a 404 without
    // a query, which also keeps obviously-malformed input out of the query log.
    if (!isTicketCode(ticketCode)) {
        throw AppError.notFound("Tiket tidak ditemukan.");
    }

    await requireOwnResource(PERMISSIONS.TICKET_READ_OWN, actor.userId);

    const row = await prisma.ticket.findFirst({
        where: { ticketCode, holderUserId: actor.userId },
        select: TICKET_WALLET_SELECT,
    });

    if (!row) {
        // Indistinguishable from "never existed" — brief §15: "Cross-customer access MUST
        // return 404. Do not return 403 where it would disclose that the ticket exists."
        throw AppError.notFound("Tiket tidak ditemukan.");
    }

    return buildTicketDetail(row, now);
}
