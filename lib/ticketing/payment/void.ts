import type { PaymentStatus, Prisma } from "@prisma/client";

/**
 * ==========================================
 * VOIDING AN OPEN PAYMENT ATTEMPT
 * ==========================================
 *
 * Design §26.4 requires cancellation to "release reservations (`reserved -= n`), **void the
 * open `Payment`**, and set `CANCELLED`", and §13.4's `PENDING → EXPIRED` row gives expiry
 * the same consequence ("release reservations; order `EXPIRED`"). Phase 6 could not
 * implement the payment half because no `Payment` row existed yet; Phase 7 creates them, so
 * both transitions must now close the attempt they are abandoning.
 *
 * Without this, cancelling or expiring an order would leave a `PENDING` payment session that
 * the provider still believes is payable. A later success delivery would then arrive for an
 * order that is already terminal — which the settlement path handles correctly as a late
 * settlement, but leaving a live session open against a dead order is a state we can simply
 * not create.
 *
 * ── WHY `EXPIRED` AND NOT `FAILED` ───────────────────────────────────────────────
 * `PaymentStatus` has no `CANCELLED`, so "void" has to be expressed with an existing value.
 * `FAILED` would be a lie about the provider's own report: §13.4 uses `FAILED` for "webhook
 * failed classification", i.e. the provider said the payment failed, which is a different
 * fact from "we abandoned this attempt". `EXPIRED` is the value §13.4 already assigns to a
 * session that lapsed ("`PENDING → EXPIRED` | expiry job (server clock) **or** gateway expiry
 * webhook | release reservations; order `EXPIRED`"), and a cancelled attempt is exactly a
 * session that will never be used. So `EXPIRED` is used for both, and the *reason* is
 * recorded on the audit row rather than encoded in the enum.
 *
 * `UNPAID` is included in the source states because a claim row that never received a
 * provider session (its process died between the claim and the response) is still an open
 * attempt and must not survive the order's death either.
 *
 * The update is guarded by the status list, so it is a conditional write: a payment that
 * already reached `PAID` is never downgraded by a late cancel or a reaper pass. That is the
 * same anti-resurrection discipline the order transitions use.
 */

/** The statuses `voidOpenPayments` may move. Anything else is left alone. */
export const VOIDABLE_PAYMENT_STATUSES: readonly PaymentStatus[] = [
    "UNPAID",
    "PENDING",
];

export async function voidOpenPayments(
    db: Prisma.TransactionClient,
    orderId: string,
    to: Extract<PaymentStatus, "EXPIRED"> = "EXPIRED"
): Promise<number> {
    const updated = await db.payment.updateMany({
        where: {
            orderId,
            status: { in: [...VOIDABLE_PAYMENT_STATUSES] },
        },
        data: { status: to },
    });

    return updated.count;
}
