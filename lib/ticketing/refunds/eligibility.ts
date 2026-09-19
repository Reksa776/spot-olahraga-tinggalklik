import { Prisma } from "@prisma/client";

/**
 * ==========================================
 * REFUND ELIGIBILITY (Phase 10B, policy D-R03..D-R10)
 * ==========================================
 *
 * Every rule that decides whether a refund REQUEST is legal lives here, as a pure function
 * over rows the caller already read. Two reasons for the split:
 *
 *   1. The rules are the part a reviewer must be able to check without a database. The
 *      service below is orchestration and transaction plumbing; the policy is this file.
 *   2. The same predicate is re-checked inside the confirmed-settlement transaction, and a
 *      second, drifted copy of "is this ticket refundable?" is the classic way a race is
 *      introduced. There is exactly one copy, and it is here.
 *
 * Policy mapping (TICKETING_PHASE10B_REFUND_AUDIT.md):
 *
 *   D-R01/D-R08  full, partial, per-item and per-ticket refunds — eligibility is decided
 *                per SELECTED ticket, and the refundable amount is the sum of those
 *                tickets' purchase-time unit prices.
 *   D-R03        only a PAID order is refundable. A `PARTIALLY_REFUNDED` order remains
 *                refundable down to its remaining balance.
 *   D-R04        an ISSUED ticket is refundable when it is otherwise eligible.
 *   D-R05        a CHECKED-IN ticket is never refundable.
 *   D-R06        eligibility says nothing about quota: quota returns only after confirmed
 *                settlement (the service enforces that).
 *   D-R09        the requested amount may not exceed the order's remaining refundable
 *                balance (`total - refundedAmount`).
 *   D-R10        a ticket can be refunded at most once: `Ticket.refundItem` is unique, and
 *                an existing `RefundItem` (whatever the parent refund's status) blocks a
 *                second claim.
 *
 * ── WHAT THIS FUNCTION DELIBERATELY DOES NOT DECIDE ─────────────────────────────
 * It does not decide WHO may request (that is authorization, enforced by the service with
 * `requireOrganizerAccess` / `requireOwnResource`), and it does not decide whether a refund
 * is APPROVED. It answers only: for these tickets, on this order, is there a legal refund,
 * and for how much?
 */

export type RefundTicketCandidate = {
    id: string;
    ticketCode: string;
    status: string;
    checkedInAt: Date | null;
    refundedAt: Date | null;
    /** Present when the ticket has already been claimed by any refund. D-R10. */
    refundItem: { id: string } | null;
    orderItem: {
        id: string;
        nameSnapshot: string;
        /** The purchase-time UNIT price of one admittee (design §17.2 snapshot). */
        priceSnapshot: Prisma.Decimal;
        quantity: number;
    } | null;
};

export type RefundEligibilityInput = {
    order: {
        status: string;
        paymentStatus: string;
        total: Prisma.Decimal;
        refundedAmount: Prisma.Decimal;
        paidAt: Date | null;
    };
    event: {
        refundDeadlineAt: Date | null;
    } | null;
    /** The tickets the caller selected (or every eligible ticket, resolved by the service). */
    tickets: readonly RefundTicketCandidate[];
    now: Date;
};

/** A machine-readable reason a request is refused; mapped to an `AppError` by the service. */
export type RefundEligibilityFailure =
    | "ORDER_NOT_PAID"
    | "PAYMENT_NOT_PAID"
    | "REFUND_WINDOW_CLOSED"
    | "NOTHING_REFUNDABLE"
    | "TICKET_NOT_FOUND"
    | "TICKET_NOT_REFUNDABLE"
    | "TICKET_CHECKED_IN"
    | "TICKET_ALREADY_REFUNDED"
    | "AMOUNT_EXCEEDS_REFUNDABLE";

export type RefundEligibilityResult =
    | {
          eligible: true;
          /** The exact amount, derived from the database snapshots — never from a client. */
          amount: Prisma.Decimal;
          /** One entry per ticket to claim, carrying its own unit price. */
          lines: { ticketId: string; orderItemId: string; amount: Prisma.Decimal }[];
          /** `total - refundedAmount` before this request (informational). */
          refundableBefore: Prisma.Decimal;
      }
    | {
          eligible: false;
          reason: RefundEligibilityFailure;
          message: string;
          ticketId?: string;
          ticketCode?: string;
      };

function fail(
    reason: RefundEligibilityFailure,
    message: string,
    ticket?: { id: string; ticketCode: string }
): RefundEligibilityResult {
    return {
        eligible: false,
        reason,
        message,
        ...(ticket ? { ticketId: ticket.id, ticketCode: ticket.ticketCode } : {}),
    };
}

/** `total - refundedAmount`, floored at zero so a transiently inconsistent row cannot go negative. */
export function refundableBalance(order: {
    total: Prisma.Decimal;
    refundedAmount: Prisma.Decimal;
}): Prisma.Decimal {
    const remaining = new Prisma.Decimal(order.total).minus(
        new Prisma.Decimal(order.refundedAmount)
    );

    return remaining.isNegative() ? new Prisma.Decimal(0) : remaining;
}

/**
 * Apply D-R03/D-R04/D-R05/D-R09/D-R10 to a concrete set of selected tickets.
 *
 * The caller MUST have resolved the tickets to rows of this order; an unknown/mismatched
 * ticket is reported as `TICKET_NOT_FOUND` rather than silently dropped, because silently
 * dropping a line would refund less than the buyer asked for without saying so.
 */
export function evaluateRefundEligibility(
    input: RefundEligibilityInput
): RefundEligibilityResult {
    const { order, event, tickets, now } = input;

    // D-R03 — the order must be paid. `PARTIALLY_REFUNDED` is still an order that was paid,
    // and its remaining balance is what a further partial refund may claim.
    if (
        order.status !== "PAID" &&
        order.status !== "PARTIALLY_REFUNDED"
    ) {
        return fail(
            "ORDER_NOT_PAID",
            "Hanya pesanan yang sudah dibayar yang dapat direfund."
        );
    }

    if (order.paymentStatus !== "PAID" && order.paymentStatus !== "PARTIALLY_REFUNDED") {
        return fail(
            "PAYMENT_NOT_PAID",
            "Pembayaran pesanan ini belum terkonfirmasi."
        );
    }

    if (order.paidAt === null) {
        return fail(
            "PAYMENT_NOT_PAID",
            "Pesanan ini belum memiliki waktu pembayaran."
        );
    }

    // The event's own refund window, when the organizer set one. A deadline in the past
    // closes refunds; a null deadline leaves the window open.
    if (event?.refundDeadlineAt && event.refundDeadlineAt.getTime() <= now.getTime()) {
        return fail(
            "REFUND_WINDOW_CLOSED",
            "Batas waktu refund untuk acara ini sudah berakhir."
        );
    }

    if (tickets.length === 0) {
        return fail(
            "NOTHING_REFUNDABLE",
            "Tidak ada tiket yang dapat direfund."
        );
    }

    const lines: { ticketId: string; orderItemId: string; amount: Prisma.Decimal }[] = [];
    let amount = new Prisma.Decimal(0);

    for (const ticket of tickets) {
        // D-R10 — claimed at most once. The unique `RefundItem.ticketId` is the database's
        // backstop; this is the friendly refusal before the insert.
        if (ticket.refundItem || ticket.refundedAt) {
            return fail(
                "TICKET_ALREADY_REFUNDED",
                "Tiket ini sudah pernah direfund.",
                ticket
            );
        }

        // D-R05 — a checked-in admittee has been consumed and is not refundable.
        if (ticket.status === "CHECKED_IN" || ticket.checkedInAt !== null) {
            return fail(
                "TICKET_CHECKED_IN",
                "Tiket yang sudah check-in tidak dapat direfund.",
                ticket
            );
        }

        // D-R04 — only an ISSUED ticket (a real, delivered admission) is refundable. A
        // RESERVED/VOID ticket is not part of a paid, fulfilled order in the refundable
        // sense; REFUNDED was caught by the D-R10 guard above.
        if (ticket.status !== "ISSUED") {
            return fail(
                "TICKET_NOT_REFUNDABLE",
                "Tiket ini tidak berada pada status yang dapat direfund.",
                ticket
            );
        }

        if (!ticket.orderItem) {
            // The price snapshot is gone (order item deleted). Refunding would require
            // inventing an amount, which is forbidden, so this is refused.
            return fail(
                "TICKET_NOT_REFUNDABLE",
                "Harga tiket tidak dapat ditemukan.",
                ticket
            );
        }

        const lineAmount = new Prisma.Decimal(ticket.orderItem.priceSnapshot);

        lines.push({
            ticketId: ticket.id,
            orderItemId: ticket.orderItem.id,
            amount: lineAmount,
        });
        amount = amount.plus(lineAmount);
    }

    // D-R09 — never refund more than remains.
    const refundableBefore = refundableBalance(order);

    if (amount.greaterThan(refundableBefore)) {
        return fail(
            "AMOUNT_EXCEEDS_REFUNDABLE",
            "Jumlah refund melebihi sisa nilai pesanan yang dapat direfund."
        );
    }

    if (amount.lessThanOrEqualTo(0)) {
        return fail(
            "NOTHING_REFUNDABLE",
            "Tidak ada nilai yang dapat direfund."
        );
    }

    return { eligible: true, amount, lines, refundableBefore };
}
