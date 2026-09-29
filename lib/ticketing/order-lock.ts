import type { Prisma } from "@prisma/client";

/**
 * ==========================================
 * EVENT-ORDER ROW LOCK — THE SHARED SERIALIZATION POINT
 * ==========================================
 *
 * `SELECT … FOR UPDATE` on one `eventorder` row, taken inside a caller's interactive
 * transaction. It exists as a named primitive for one reason: the payment layer must not
 * contain raw SQL. `__tests__/ticketing-payment/payment-wiring.test.ts` enforces that
 * ("no payment file contains raw SQL or a hand-rolled counter update"), because the payment
 * module is where money is decided and it must reach the database only through services. A
 * row lock is not an inventory write and not a hand-rolled counter update, but it IS raw
 * SQL — so it lives here, in a single documented place, and the payment service calls it
 * like any other primitive.
 *
 * ── WHAT IT SERIALIZES, AND THE LOCK ORDER ───────────────────────────────────────
 * Every order-scoped transition that must not interleave takes this lock first:
 *
 *   * the payment claim (`lib/ticketing/payment/service.ts`) — so two "Pay" clicks cannot
 *     both create an active attempt (BUG-01 / BUG-02);
 *   * the settlement CAS, the cancel CAS and the reservation reaper all write the
 *     `eventorder` row first as well, so they contend on the same row in the same
 *     order (order row → payment/reservations → ticket types). Consistent lock ORDER is
 *     what keeps these four transitions from deadlocking against each other under
 *     concurrency (brief §16/§17).
 *
 * ── WHY RAW SQL IS UNAVOIDABLE HERE ──────────────────────────────────────────────
 * Prisma has no `SELECT … FOR UPDATE` in its query builder; the only way to take a row lock
 * is a raw statement. It is a tagged template, so the order id is a bound parameter and
 * there is no interpolation.
 */
export async function lockEventOrderRow(
    tx: Prisma.TransactionClient,
    orderId: string
): Promise<void> {
    await tx.$queryRaw`SELECT id FROM eventorder WHERE id = ${orderId} FOR UPDATE`;
}
