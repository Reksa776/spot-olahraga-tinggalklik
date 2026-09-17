import type { OrderStatus, PaymentStatus, Prisma } from "@prisma/client";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { requireOwnResource } from "@/lib/authz/guards";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz/permissions";
import { prisma } from "@/lib/prisma";

import { writeTicketingAudit } from "../audit-log";
import { withContentionRetry } from "../db-contention";
import {
    generateQrToken,
    generateTicketCode,
    hashQrToken,
    isUniqueViolation,
    uniqueViolationTargets,
} from "./reference";

/**
 * ==========================================
 * PHASE 8 — TICKET ISSUANCE (fulfilment)
 * ==========================================
 *
 * Turns one PAID, fulfilment-eligible `EventOrder` into exactly
 * `SUM(EventOrderItem.quantity)` `Ticket` rows — once, no matter how many times it is
 * called or how many callers call it at the same moment.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT PART OF THE PAYMENT TRANSACTION
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * Brief §18 closes the payment boundary: Phase 7's settlement is not modified to make
 * issuance safe. That is the right split anyway — the two have different failure
 * semantics. Settlement must be *exactly once* or the money is wrong; issuance must be
 * *at least once, converging to exactly once* or a buyer who paid while their request
 * died has no tickets. Making issuance a separate, re-runnable step is what lets the
 * second property exist without weakening the first.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * THE THREE MECHANISMS (each covers what the previous one cannot)
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 *   1. `SELECT … FOR UPDATE` on the `eventorder` row  → serialises concurrent issuers of
 *      the SAME order. With it, 10 simultaneous calls do one set of inserts and nine
 *      no-ops, instead of ten racing insert storms.
 *   2. `@@unique([orderItemId, sequenceNo])`          → the database is the final arbiter.
 *      Even if the lock were never taken, a second insert for the same slot CANNOT commit.
 *      This is why the guarantee is unconditional rather than "rely on the lock".
 *   3. Missing-sequence diffing                       → partial recovery. A crash after 3 of
 *      5 rows leaves 3; the next call creates 2, because the plan is derived from the rows
 *      that exist rather than from an "issued" flag.
 *
 * The gate is re-evaluated INSIDE the transaction, after the lock, against the committed
 * row — not against the pre-flight snapshot. A late settlement that sets
 * `fulfilmentBlockedAt` between the pre-flight read and the lock must still be honoured,
 * and the only way to promise that is to re-read it under the lock.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 *   • It does not touch `sold` / `reserved` / `version`. Inventory is Phase 5's canonical
 *     module and settlement already converted the seats; issuing a ticket is not a second
 *     sale. Asserted by the Phase 8 static guards.
 *   • It does not change order status, payment status, `paidAt` or `fulfilmentBlockedAt`.
 *     A blocked order stays blocked (brief §41): no auto-repair, no unblocking.
 *   • It does not re-price anything. `Ticket` has no money columns at all (design §19.1) —
 *     the price snapshot lives on `EventOrderItem` and stays there.
 *   • It does not send anything anywhere. No iPaymu, no WhatsApp, no email, no network
 *     call of any kind; QR generation is local and deterministic.
 *   • It returns NO QR token. See `./reference.ts` for why the wallet shows the public
 *     code and why §26.6 rejects handing the scanner token to a browser.
 */

/* ==========================================
 * TUNABLES (all justified, none magic)
 * ========================================== */

/**
 * How many times a single ticket row may regenerate its random code before giving up.
 *
 * A `ticketCode` collision is a birthday-problem event over a 40-bit space: not
 * impossible, vanishingly rare, and cheap to survive. Five attempts makes the residual
 * failure probability ~2^-180, which is why the exhausted case is reported as a server
 * fault rather than retried forever — by the time it fires, something else is wrong.
 */
const TICKET_CODE_ATTEMPTS = 5;

/**
 * Transaction budget for one issuance call.
 *
 * The unit of work is one row lock plus at most `quantity` small inserts, so a normal
 * call finishes in single-digit milliseconds. These are deliberately generous because the
 * realistic slow case is not the work but the QUEUE: ten simultaneous buyers of the same
 * order all contend for the same row lock, and a waiter that gives up early would turn a
 * queue into an error. A waiter that still exceeds this gets MySQL error 1205, which
 * `withContentionRetry` classifies as retryable and re-runs from the beginning.
 */
const ISSUANCE_MAX_WAIT_MS = 10_000;
const ISSUANCE_TIMEOUT_MS = 20_000;

/* ==========================================
 * TYPES
 * ========================================== */

/** One issued ticket, as far as any caller outside this module may see it. */
export type IssuedTicketRef = {
    ticketCode: string;
    orderItemId: string;
    sequenceNo: number;
    status: string;
};

export type TicketIssuanceResult = {
    /**
     * `ISSUED` — this call created at least one row.
     * `ALREADY_ISSUED` — the order was already complete; this call created nothing.
     *
     * Callers must not treat `ALREADY_ISSUED` as a failure: it is the normal outcome of a
     * refresh, a double-click or a replayed internal call.
     */
    outcome: "ISSUED" | "ALREADY_ISSUED";
    orderId: string;
    orderNumber: string;
    eventId: string;
    organizerId: string;
    /** Rows created by THIS call. `0` on an idempotent repeat. */
    ticketsIssued: number;
    /** Rows the order requires: `SUM(EventOrderItem.quantity)`. */
    expectedTickets: number;
    /** Committed `Ticket` rows for the order after this call. Equals `expectedTickets`. */
    totalTickets: number;
    tickets: IssuedTicketRef[];
};

/**
 * The eligibility inputs. Kept structurally narrow so the pure gate below is testable
 * without a database and can be applied to both the pre-flight row and the locked row.
 */
export type OrderFulfilmentState = {
    orderNumber: string;
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    paidAt: Date | null;
    fulfilmentBlockedAt: Date | null;
};

/* ==========================================
 * THE ELIGIBILITY GATE
 * ========================================== */

/**
 * The single definition of "may this order produce tickets?" — brief §5/§19.
 *
 * ORDER MATTERS. `fulfilmentBlockedAt` is checked FIRST because it is the *overspecified*
 * combination: a late settlement leaves the order terminally `CANCELLED`/`EXPIRED` **and**
 * `paymentStatus = PAID` **and** blocked. Checking status first would report "not paid"
 * for an order that took the customer's money, which is both wrong and the least useful
 * thing to tell an operator. The blocked branch names the real situation.
 *
 * Every failure here is deterministic and side-effect free: nothing is repaired, nothing
 * is released, nothing is created (brief §41).
 */
export function assertOrderIsFulfillable(order: OrderFulfilmentState): void {
    if (order.fulfilmentBlockedAt !== null) {
        throw AppError.conflict(
            "Pesanan ini ditahan untuk pemeriksaan operator, sehingga tiket tidak dapat diterbitkan.",
            {
                reason: "FULFILMENT_BLOCKED",
                orderNumber: order.orderNumber,
                status: order.status,
                paymentStatus: order.paymentStatus,
            }
        );
    }

    if (order.status !== "PAID") {
        throw new AppError(ERROR_CODES.PAYMENT_REQUIRED, {
            message: "Tiket hanya dapat diterbitkan untuk pesanan yang sudah dibayar.",
            details: {
                reason: "ORDER_NOT_PAID",
                orderNumber: order.orderNumber,
                status: order.status,
            },
        });
    }

    if (order.paymentStatus !== "PAID") {
        throw new AppError(ERROR_CODES.PAYMENT_REQUIRED, {
            message: "Pembayaran pesanan ini belum dikonfirmasi.",
            details: {
                reason: "ORDER_NOT_PAID",
                orderNumber: order.orderNumber,
                paymentStatus: order.paymentStatus,
            },
        });
    }

    // `PAID` + `PAID` with no timestamp is an inconsistent row rather than an unpaid one,
    // but the safe answer is the same and it is the one that cannot issue tickets from a
    // partially-written settlement.
    if (order.paidAt === null) {
        throw new AppError(ERROR_CODES.PAYMENT_REQUIRED, {
            message: "Pembayaran pesanan ini belum dikonfirmasi.",
            details: { reason: "ORDER_NOT_PAID", orderNumber: order.orderNumber },
        });
    }
}

/* ==========================================
 * ISSUANCE
 * ========================================== */

type OrderItemPlan = {
    orderItemId: string;
    ticketTypeId: string;
    quantity: number;
};

/**
 * Turn the persisted order lines into an issuance plan, or refuse.
 *
 * The quantity comes from `EventOrderItem.quantity` and from nothing else (brief §6):
 * not the request, not the ticket type's current quota, not the price, not availability.
 * The subscription is historical fact; the catalogue is not.
 */
function planIssuance(
    orderNumber: string,
    items: readonly { id: string; quantity: number; ticketTypeId: string | null }[]
): OrderItemPlan[] {
    if (items.length === 0) {
        throw AppError.conflict("Pesanan ini tidak memiliki item tiket.", {
            reason: "ORDER_HAS_NO_ITEMS",
            orderNumber,
        });
    }

    const invalid = items.find((item) => item.quantity <= 0);

    if (invalid) {
        throw AppError.conflict("Jumlah tiket pada pesanan ini tidak valid.", {
            reason: "ORDER_ITEM_QUANTITY_INVALID",
            orderNumber,
            orderItemId: invalid.id,
            quantity: invalid.quantity,
        });
    }

    const orphan = items.find((item) => item.ticketTypeId === null);

    if (orphan) {
        throw AppError.conflict("Item pesanan ini kehilangan jenis tiketnya.", {
            reason: "ORDER_ITEM_WITHOUT_TICKET_TYPE",
            orderNumber,
            orderItemId: orphan.id,
        });
    }

    return items.map((item) => ({
        orderItemId: item.id,
        ticketTypeId: item.ticketTypeId as string,
        quantity: item.quantity,
    }));
}

/** The order fields both the pre-flight read and the locked re-read need. */
const ORDER_GATE_SELECT = {
    id: true,
    orderNumber: true,
    userId: true,
    eventId: true,
    organizerId: true,
    status: true,
    paymentStatus: true,
    paidAt: true,
    fulfilmentBlockedAt: true,
} as const;

const TICKET_REF_SELECT = {
    ticketCode: true,
    orderItemId: true,
    sequenceNo: true,
    status: true,
} as const;

/**
 * Take the row lock that serialises issuance for one order.
 *
 * ── WHY RAW SQL IS JUSTIFIED HERE (brief §32.5) ─────────────────────────────────
 *
 * Prisma's client has no row-locking read. The alternatives were all worse:
 *
 *   • Skip the lock and lean on the unique constraint alone. Correct, but the losers
 *     would each burn `quantity` failing inserts against rows the winner just wrote, and
 *     InnoDB's duplicate-key handling leaves shared locks behind — i.e. a deliberate
 *     deadlock generator on every double-click.
 *   • Serialise in application code. That is exactly the check-then-insert the brief
 *     forbids, and it does not compose across processes.
 *   • Invent an issuance-status column. A schema change to avoid one `SELECT … FOR UPDATE`
 *     — and it would still need the lock, because a status flag read outside a lock is
 *     just another racy precondition.
 *
 * So the lock is taken, and it is the ONLY raw statement in the ticketing ticket path
 * (asserted by the static guards). It reads the primary key only, so it depends on no
 * column name and no schema shape beyond `eventorder.id`, which `@@map("eventorder")`
 * fixes. `FOR UPDATE` locks the matched row for the rest of the transaction.
 *
 * Lock ORDER is deliberate and matches Phase 7's settlement: the `eventorder` row is
 * always taken first, so issuance and settlement can queue behind each other without ever
 * forming a cycle.
 */
async function lockOrderRow(
    tx: Prisma.TransactionClient,
    orderId: string
): Promise<void> {
    await tx.$queryRaw`SELECT id FROM eventorder WHERE id = ${orderId} FOR UPDATE`;
}

type CreatedTicket = { row: IssuedTicketRef; created: boolean };

/**
 * Insert one ticket, surviving the two unique constraints it can collide with.
 *
 * `(orderItemId, sequenceNo)` colliding means somebody else already created this exact
 * slot — the database has made the decision, so we adopt the existing row rather than
 * failing an operation whose outcome is already correct.
 *
 * `ticketCode` / `qrTokenHash` colliding is a fresh random value being unlucky, so the fix
 * is a new value.
 *
 * Both are `P2002`; the constraint named in the error is what distinguishes them.
 */
async function insertTicket(
    tx: Prisma.TransactionClient,
    input: {
        orderId: string;
        orderItemId: string;
        sequenceNo: number;
        ticketTypeId: string;
        eventId: string;
        organizerId: string;
        holderUserId: string;
        issuedAt: Date;
    }
): Promise<CreatedTicket> {
    for (let attempt = 0; attempt < TICKET_CODE_ATTEMPTS; attempt += 1) {
        try {
            const row = await tx.ticket.create({
                data: {
                    ticketCode: generateTicketCode(),
                    // The raw token exists only inside this expression: it is hashed and
                    // the plaintext is never bound to a variable, returned, or logged.
                    // `Ticket.qrTokenHash` is NOT NULL UNIQUE, so the row cannot be created
                    // without a real credential — which is why one is generated here even
                    // though Phase 8 has no delivery channel to send it down.
                    qrTokenHash: hashQrToken(generateQrToken()),
                    orderId: input.orderId,
                    orderItemId: input.orderItemId,
                    sequenceNo: input.sequenceNo,
                    ticketTypeId: input.ticketTypeId,
                    eventId: input.eventId,
                    organizerId: input.organizerId,
                    holderUserId: input.holderUserId,
                    // Design §19.2: tickets are created at settlement as `ISSUED`. The
                    // `RESERVED` state belongs to the pre-issued-quantity model (D-31),
                    // which this build does not use.
                    status: "ISSUED",
                    issuedAt: input.issuedAt,
                },
                select: TICKET_REF_SELECT,
            });

            return { row, created: true };
        } catch (error) {
            if (!isUniqueViolation(error)) {
                throw error;
            }

            const targets = uniqueViolationTargets(error);
            const slotTaken = targets.some((target) =>
                target.includes("orderItemId")
            );

            if (slotTaken) {
                const existing = await tx.ticket.findUnique({
                    where: {
                        orderItemId_sequenceNo: {
                            orderItemId: input.orderItemId,
                            sequenceNo: input.sequenceNo,
                        },
                    },
                    select: TICKET_REF_SELECT,
                });

                if (existing) {
                    return { row: existing, created: false };
                }
            }
            // Otherwise a random value collided (`ticketCode` / `qrTokenHash`) and the
            // loop draws fresh ones.
        }
    }

    throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
        message: "Gagal membuat kode tiket yang unik.",
        expose: false,
        details: {
            reason: "TICKET_CODE_GENERATION_EXHAUSTED",
            orderItemId: input.orderItemId,
            sequenceNo: input.sequenceNo,
            attempts: TICKET_CODE_ATTEMPTS,
        },
    });
}

/**
 * Prove the count invariants under the lock, where nothing can move beneath us.
 *
 * Brief §35: per order `SUM(quantity) == COUNT(tickets)`, and per line
 * `quantity == COUNT(tickets of that line)`. Deriving the expected count from the plan
 * (not from a constant, not from the request) is what makes this a real assertion.
 */
function assertTicketCountInvariant(
    lines: readonly OrderItemPlan[],
    tickets: readonly IssuedTicketRef[],
    orderNumber: string
): void {
    const expectedTotal = lines.reduce((total, line) => total + line.quantity, 0);

    if (tickets.length !== expectedTotal) {
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
            expose: false,
            details: {
                reason: "TICKET_COUNT_MISMATCH",
                orderNumber,
                expected: expectedTotal,
                actual: tickets.length,
            },
        });
    }

    for (const line of lines) {
        const actual = tickets.filter(
            (ticket) => ticket.orderItemId === line.orderItemId
        ).length;

        if (actual !== line.quantity) {
            throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
                expose: false,
                details: {
                    reason: "TICKET_LINE_COUNT_MISMATCH",
                    orderNumber,
                    orderItemId: line.orderItemId,
                    expected: line.quantity,
                    actual,
                },
            });
        }
    }
}

/**
 * Issue (or complete) the tickets of one paid order.
 *
 * Safe to call concurrently, repeatedly, and after a crash. Returns what it did rather
 * than a bare boolean, so a caller can tell "I fulfilled this" from "it was already
 * fulfilled" without a second query.
 */
export async function issueTicketsForOrder(params: {
    orderNumber: string;
    actor: AuthzScope;
    request?: Request;
}): Promise<TicketIssuanceResult> {
    if (!params.actor?.userId) {
        // Defensive: every route reaches this through `requireAuth()`. Stated as 401 rather
        // than 400 so that a future caller which forgets the guard fails closed and
        // legibly instead of looking like a malformed request.
        throw new AppError(ERROR_CODES.UNAUTHORIZED, {
            message: "Anda harus masuk untuk menerbitkan tiket.",
        });
    }

    const order = await prisma.eventOrder.findFirst({
        // The ownership predicate is part of the lookup, not a check afterwards: an order
        // that is not this buyer's does not exist as far as this function is concerned.
        where: { orderNumber: params.orderNumber, userId: params.actor.userId },
        select: {
            ...ORDER_GATE_SELECT,
            items: {
                select: { id: true, quantity: true, ticketTypeId: true },
                orderBy: { createdAt: "asc" },
            },
        },
    });

    if (!order) {
        throw AppError.notFound("Pesanan tidak ditemukan.");
    }

    // Re-resolve the scope against the LIVE session and use THAT for the audit row.
    // The caller's scope object may predate a role change (Phase 6 found this the hard
    // way); the permission decision belongs to `lib/authz`, never to a passed-in snapshot.
    const actor = await requireOwnResource(
        PERMISSIONS.TICKET_ISSUE_OWN,
        order.userId
    );

    const lines = planIssuance(order.orderNumber, order.items);
    const expectedTickets = lines.reduce((total, line) => total + line.quantity, 0);

    // Fast refusal for the common cases, before opening a transaction. The authoritative
    // check is the one under the lock below — this one only avoids pointless work.
    assertOrderIsFulfillable(order);

    const dispatched = await withContentionRetry(async () => {
        return prisma.$transaction(
            async (tx) => {
                await lockOrderRow(tx, order.id);

                const current = await tx.eventOrder.findUniqueOrThrow({
                    where: { id: order.id },
                    select: ORDER_GATE_SELECT,
                });

                // The committed state — including anything a late settlement wrote
                // between the pre-flight read and this lock — is what decides.
                assertOrderIsFulfillable(current);

                const existing = await tx.ticket.findMany({
                    where: { orderId: order.id },
                    select: TICKET_REF_SELECT,
                    orderBy: [{ orderItemId: "asc" }, { sequenceNo: "asc" }],
                });

                const present = new Set(
                    existing.map((row) => `${row.orderItemId}#${row.sequenceNo}`)
                );
                const created: IssuedTicketRef[] = [];

                for (const line of lines) {
                    for (
                        let sequenceNo = 1;
                        sequenceNo <= line.quantity;
                        sequenceNo += 1
                    ) {
                        if (present.has(`${line.orderItemId}#${sequenceNo}`)) {
                            continue;
                        }

                        const attempt = await insertTicket(tx, {
                            orderId: order.id,
                            orderItemId: line.orderItemId,
                            sequenceNo,
                            ticketTypeId: line.ticketTypeId,
                            eventId: order.eventId,
                            organizerId: order.organizerId,
                            holderUserId: order.userId,
                            issuedAt: current.paidAt ?? new Date(),
                        });

                        if (attempt.created) {
                            created.push(attempt.row);
                            present.add(`${line.orderItemId}#${sequenceNo}`);
                        }
                    }
                }

                // Read the whole set back under the lock so the invariant is asserted
                // against committed rows, and the returned list is the order's real
                // contents rather than just what this call happened to add.
                const tickets = await tx.ticket.findMany({
                    where: { orderId: order.id },
                    select: TICKET_REF_SELECT,
                    orderBy: [{ orderItemId: "asc" }, { sequenceNo: "asc" }],
                });

                assertTicketCountInvariant(lines, tickets, order.orderNumber);

                return { created, tickets };
            },
            { maxWait: ISSUANCE_MAX_WAIT_MS, timeout: ISSUANCE_TIMEOUT_MS }
        );
    });

    if (!dispatched.ok) {
        // Ten deadlock/lock-timeout retries means the database is genuinely saturated.
        // Reported as a conflict (the caller may retry) rather than a 500, and with no
        // internal detail in the message.
        throw AppError.conflict(
            "Server sedang sibuk. Silakan coba lagi sebentar lagi.",
            { reason: "CONTENTION_EXHAUSTED", orderNumber: order.orderNumber }
        );
    }

    const { created, tickets } = dispatched.value;

    // Audit ONLY a call that actually created rows. A refresh, a double-click or a
    // replayed internal call must not smear "ticket issued" rows across the ledger —
    // brief §26 ("duplicate issuance does not create misleading duplicate audit") and
    // §39 (no unnecessary writes). Awaiting matches Phase 7's settlement, and the helper
    // swallows its own failures so a busy audit table cannot fail a fulfilment.
    if (created.length > 0) {
        await writeTicketingAudit({
            action: "ticket.issue",
            actor,
            actorOrganizerId: null,
            organizerId: order.organizerId,
            entityType: "Ticket",
            // One call issues N rows, so the reference is the ORDER: a per-row audit would
            // be N near-identical writes and would say less than one accurate row.
            entityRef: order.orderNumber,
            description:
                "Tiket diterbitkan untuk pesanan yang sudah dibayar.",
            request: params.request,
            afterState: {
                orderNumber: order.orderNumber,
                orderId: order.id,
                eventId: order.eventId,
                ticketsIssued: created.length,
                totalTickets: tickets.length,
                expectedTickets,
                status: "ISSUED",
                ticketCodes: created.map((ticket) => ticket.ticketCode),
            },
        });
    }

    return {
        outcome: created.length > 0 ? "ISSUED" : "ALREADY_ISSUED",
        orderId: order.id,
        orderNumber: order.orderNumber,
        eventId: order.eventId,
        organizerId: order.organizerId,
        ticketsIssued: created.length,
        expectedTickets,
        totalTickets: tickets.length,
        tickets,
    };
}
