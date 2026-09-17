import crypto from "crypto";

/**
 * ==========================================
 * CHECKOUT IDEMPOTENCY (design §30.1 / §30.2)
 * ==========================================
 *
 * Design §25.5 marks checkout idempotency **Required**, and §30.1 gives the exact
 * mechanism:
 *
 *   Key                : client-supplied `Idempotency-Key` header
 *   Uniqueness         : `IdempotencyKey.(userId, scope, key)` UNIQUE
 *   Duplicate behaviour: "Returns the **existing** order (200/201) instead of reserving
 *                        quota twice"
 *
 * §30.3 explains why this is a constraint and not a check: read-then-create is a
 * time-of-check/time-of-use race in which two concurrent submits both read "not exists"
 * and both create. The database is the only arbiter, so the second insert must lose.
 *
 * This module owns the *key* half (scope, expiry, request fingerprint). The insert and
 * the P2002 resolution live in `lib/ticketing/checkout.ts`, because §30.1 requires the
 * key row to be written **in the same transaction** that creates the order.
 *
 * WHY A REQUEST HASH
 * ------------------
 * §30.2's table is explicit that a reused key with a *different* body must fail loudly:
 *
 *   | Same key, **different** `requestHash` | `409 CONFLICT` — the client reused a key
 *     for a different payload. Silently treating it as the same request would hide a
 *     real bug |
 *
 * Without the hash, a client that reuses one key for a genuinely different basket would
 * silently receive the first order back — the exact bug the design says must surface.
 */

/** §30.2: the `scope` value is the logical operation, e.g. `POST /api/checkout`. */
export const IDEMPOTENCY_SCOPE_CHECKOUT = "POST /api/checkout";

/**
 * §30.2: "Key expired | Treat as new; the TTL (e.g. 24 h) bounds table growth and
 * matches the order's useful retry window".
 *
 * The design supplies 24 h as its example and the column is nullable, so the value is
 * taken from the design rather than invented. Note it is deliberately longer than the
 * reservation TTL: a replay after the reservation has expired should return the
 * *expired* order (so the buyer learns what happened) rather than silently creating a
 * second one.
 *
 * Nothing purges expired keys: that is a housekeeping job and there is no scheduler in
 * this phase (see `lib/ticketing/reservations.ts` on the same boundary).
 */
export const IDEMPOTENCY_KEY_TTL_HOURS = 24;

export function computeIdempotencyExpiresAt(now: Date): Date {
    return new Date(now.getTime() + IDEMPOTENCY_KEY_TTL_HOURS * 60 * 60 * 1000);
}

/**
 * The normalized shape the fingerprint is computed over.
 *
 * Callers MUST pass the *normalized* request — duplicate ticket-type lines merged and
 * the list sorted — because §30.2 says the hash is of the "normalized body". Without
 * that, the same intent expressed as `[A:2, B:1]` and `[B:1, A:2]` would hash
 * differently and a retry would be treated as a new request, creating a second order.
 */
export type NormalizedCheckoutRequest = {
    eventId: string;
    buyerName: string;
    buyerEmail: string;
    buyerPhone: string;
    couponCode?: string | null;
    shareToken?: string | null;
    items: readonly { ticketTypeId: string; quantity: number }[];
};

/**
 * Stable SHA-256 fingerprint of the normalized checkout intent.
 *
 * Built field by field rather than by `JSON.stringify(body)`: object key order is not a
 * contract, and a fingerprint that changes when a key is reordered would turn harmless
 * retries into duplicate orders.
 *
 * Deliberately NOT part of the fingerprint: any client-supplied `price`, `subtotal`,
 * `total` or `currency`. Those are ignored for pricing (brief §17), so letting them
 * change the fingerprint would let a tampered retry masquerade as a different request.
 */
export function computeCheckoutRequestHash(
    request: NormalizedCheckoutRequest
): string {
    const canonical = JSON.stringify({
        eventId: request.eventId,
        buyerName: request.buyerName,
        buyerEmail: request.buyerEmail,
        buyerPhone: request.buyerPhone,
        couponCode: request.couponCode ?? null,
        shareToken: request.shareToken ?? null,
        items: [...request.items]
            .sort((a, b) => (a.ticketTypeId < b.ticketTypeId ? -1 : 1))
            .map((item) => [item.ticketTypeId, item.quantity]),
    });

    return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Merge repeated ticket-type lines into one line per type, preserving order of first
 * appearance, then sort by `ticketTypeId` ascending.
 *
 * Merging is required by the design, not a convenience: §11.4 models exactly one
 * `TicketReservation` row per `(orderId, ticketTypeId)`, so two lines for the same type
 * would otherwise produce two rows for the same key. Without this, a client could also
 * bypass a per-type `maxPerOrder` by splitting one purchase across two lines — a real
 * hole, since `maxPerOrder` is validated per line.
 *
 * Sorting by `ticketTypeId` is §11.3's rule ("always iterate ticket types sorted by
 * `ticketTypeId`"), which exists to give concurrent multi-line checkouts a deterministic
 * lock-acquisition order and so avoid the classic two-transaction deadlock.
 */
export function normalizeCheckoutItems(
    items: readonly { ticketTypeId: string; quantity: number }[]
): { ticketTypeId: string; quantity: number }[] {
    const merged = new Map<string, number>();

    for (const item of items) {
        merged.set(
            item.ticketTypeId,
            (merged.get(item.ticketTypeId) ?? 0) + item.quantity
        );
    }

    return Array.from(merged.entries())
        .map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity }))
        .sort((a, b) => (a.ticketTypeId < b.ticketTypeId ? -1 : 1));
}
