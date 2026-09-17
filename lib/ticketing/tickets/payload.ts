import type { Prisma, TicketStatus } from "@prisma/client";

import { buildTicketQrPayload } from "./reference";

/**
 * ==========================================
 * CUSTOMER TICKET PAYLOAD (design §26.5 / §26.6)
 * ==========================================
 *
 * One builder for the wallet list and the e-ticket detail, so the two cannot drift apart,
 * and one place where it is decided what a buyer is allowed to see about their own ticket.
 *
 * ── WHAT IS NOT IN HERE (brief §22) ──────────────────────────────────────────────
 * No `organizerId`, no organizer membership, no `PermissionGrant`, no audit rows, no
 * `Payment` rows or provider references, no `qrTokenHash`, no `quota`/`sold`/`reserved`, no
 * `picProfileId`, no database ids. A ticket response contains the event, the ticket type
 * name, the code and the QR payload — nothing that belongs to the organizer or the
 * platform.
 *
 * ── WHY THERE IS NO MONEY IN HERE ────────────────────────────────────────────────
 * Design §19.1 gives `Ticket` no money columns at all; the immutable price snapshot lives
 * on `EventOrderItem` and is already exposed by `lib/ticketing/order-payload.ts`. A ticket
 * is an admission credential, not a receipt, so this module never formats a Decimal and
 * `D-61` (money representation) simply does not arise on this surface.
 */

/** The projection both builders read. Kept in one place so they cannot select differently. */
export const TICKET_WALLET_SELECT = {
    ticketCode: true,
    status: true,
    sequenceNo: true,
    attendeeName: true,
    issuedAt: true,
    checkedInAt: true,
    qrVersion: true,
    event: {
        select: {
            id: true,
            slug: true,
            title: true,
            startAt: true,
            endAt: true,
            venue: { select: { name: true } },
            sport: { select: { name: true } },
        },
    },
    ticketType: { select: { name: true } },
    order: { select: { orderNumber: true } },
} as const satisfies Prisma.TicketSelect;

type WalletRow = Prisma.TicketGetPayload<{ select: typeof TICKET_WALLET_SELECT }>;

export type TicketEventSummary = {
    id: string;
    slug: string;
    title: string;
    startAt: string;
    endAt: string | null;
    venueName: string | null;
    sportName: string;
};

export type TicketWalletItem = {
    ticketCode: string;
    status: TicketStatus;
    /** 1..quantity within its order line. Lets the UI say "ticket 2 of 3". */
    sequenceNo: number;
    /** Per-ticket holder name. `null` until per-ticket naming ships (design §19.1, post-MVP). */
    attendeeName: string | null;
    issuedAt: string | null;
    checkedInAt: string | null;
    ticketTypeName: string;
    orderNumber: string;
    /**
     * Where the buyer can view this ticket.
     *
     * Relative on purpose. Design §23.4 wants an absolute fallback link in the e-ticket
     * email, but delivery is a later phase and owns the app-origin helper
     * (`lib/app-origin.ts`); resolving an absolute origin here would make a read-only
     * wallet list fail whenever the request's host is not allow-listed.
     */
    walletUrl: string;
    event: TicketEventSummary;
};

export type TicketDetail = TicketWalletItem & {
    /**
     * The QR the buyer shows at the gate.
     *
     * `payload` is the exact string to encode — derived on the server from the ticket's
     * public code, never from a client value and never from a secret (see `./reference.ts`
     * for the full argument). `renderer` names the already-installed client renderer so the
     * UI cannot substitute a different one, mirroring
     * `app/api/events/[slug]/share/route.ts`.
     */
    qr: {
        payload: string;
        renderer: "qrcode.react";
        /**
         * Design §19.1's reissue counter. Exposed read-only: it tells a future scanner
         * cache and a support agent which credential generation the buyer is holding. No
         * Phase 8 code path increments it (`ticket.reissue` is a later phase).
         */
        version: number;
    };
    /**
     * Deliberately informational only. A future check-in phase resolves the code
     * server-side and decides admission there; nothing in this payload is authority
     * (brief §36: "QR is NOT authorization").
     */
    admission: {
        /** Whether the QR is worth showing at all right now. */
        scannable: boolean;
        /** Why not, when `scannable` is false. */
        reason: string | null;
    };
};

export function walletUrlFor(ticketCode: string): string {
    return `/ticketing/tickets/${ticketCode}`;
}

function toEventSummary(row: WalletRow): TicketEventSummary {
    return {
        id: row.event.id,
        slug: row.event.slug,
        title: row.event.title,
        startAt: row.event.startAt.toISOString(),
        endAt: row.event.endAt?.toISOString() ?? null,
        venueName: row.event.venue?.name ?? null,
        sportName: row.event.sport.name,
    };
}

function toWalletItem(row: WalletRow): TicketWalletItem {
    return {
        ticketCode: row.ticketCode,
        status: row.status,
        sequenceNo: row.sequenceNo,
        attendeeName: row.attendeeName,
        issuedAt: row.issuedAt?.toISOString() ?? null,
        checkedInAt: row.checkedInAt?.toISOString() ?? null,
        ticketTypeName: row.ticketType.name,
        orderNumber: row.order.orderNumber,
        walletUrl: walletUrlFor(row.ticketCode),
        event: toEventSummary(row),
    };
}

/**
 * The wallet list row (design §26.5).
 *
 * Note what is missing by design: the QR. §26.5 is explicit — "The QR token is not returned
 * by the list endpoint — only by the single-ticket endpoint, so a list response cached or
 * logged anywhere cannot leak scannable credentials."
 */
export function buildWalletItem(row: WalletRow): TicketWalletItem {
    return toWalletItem(row);
}

/**
 * The e-ticket detail row (design §26.6).
 *
 * The QR payload is built from the ticket's own code by a validating helper, so a malformed
 * row fails loudly here rather than producing an image that means nothing.
 */
export function buildTicketDetail(row: WalletRow): TicketDetail {
    const item = toWalletItem(row);
    const payload = buildTicketQrPayload(item.ticketCode);

    return {
        ...item,
        qr: {
            payload,
            renderer: "qrcode.react",
            version: row.qrVersion,
        },
        admission: describeAdmission(item.status),
    };
}

/**
 * Whether the ticket is currently a valid credential.
 *
 * Only `ISSUED` is. `RESERVED` is unpaid, `CHECKED_IN` has been used, and
 * `VOID`/`REFUNDED` are revoked — design §19.4's validation order ("Hash → lookup → status
 * → event match → payment state") ends in exactly this decision, which the future check-in
 * phase re-derives server-side. This function only decides whether the UI shows a live QR,
 * a used one, or an explanation.
 */
function describeAdmission(status: TicketStatus): {
    scannable: boolean;
    reason: string | null;
} {
    switch (status) {
        case "ISSUED":
            return { scannable: true, reason: null };
        case "CHECKED_IN":
            return { scannable: false, reason: "ALREADY_CHECKED_IN" };
        case "VOID":
            return { scannable: false, reason: "TICKET_VOID" };
        case "REFUNDED":
            return { scannable: false, reason: "TICKET_REFUNDED" };
        case "RESERVED":
            // Design §19.4: "Only `ISSUED` tickets validate. A `RESERVED` ticket is
            // rejected with `UNPAID`".
            return { scannable: false, reason: "NOT_PAID" };
        default:
            // Unreachable for the current enum. Kept, and conservative, so that adding a
            // status to `TicketStatus` in a later phase shows a non-scannable ticket
            // rather than a live QR for a state nobody reasoned about yet.
            return { scannable: false, reason: "UNKNOWN_STATUS" };
    }
}

export type TicketWalletPayload = {
    items: TicketWalletItem[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
};
