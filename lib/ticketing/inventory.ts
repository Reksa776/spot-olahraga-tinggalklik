import { Prisma, type PrismaClient } from "@prisma/client";

import { remainingFor } from "@/lib/events/sales-state";
import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * TICKET INVENTORY — CANONICAL AVAILABILITY & ATOMIC MUTATION
 * ==========================================
 *
 * Design §11.2 states the rule this module exists to obey:
 *
 *   "A single conditional `UPDATE` performs check-and-decrement atomically under the
 *    row lock, so no read-then-write race exists. The design adopts exactly this shape
 *    for ticket quota (never `SELECT` then `UPDATE`, never a JavaScript-side comparison
 *    as the guard)."
 *
 * WHY RAW SQL IS REQUIRED HERE (not a style choice)
 * -------------------------------------------------
 * The guard is `reserved + sold + n <= quota` — a comparison between three COLUMNS and
 * a parameter. Prisma's query builder can only compare a column against a VALUE, so
 * `updateMany({ where: { quota: { gte: ... } } })` cannot express it at all. The
 * alternative would be read-then-write in application code, which is exactly the race
 * the design forbids. So the atomic boundary is a parameterised `$executeRaw`
 * statement, mirroring the existing repository primitive in `lib/checkout.ts`
 * (`UPDATE flashsale SET saleStock = saleStock - n WHERE id = ? AND saleStock >= n`,
 * with `affectedRows === 0` meaning "insufficient"). That is the Phase 0/1 pattern the
 * brief tells us to preserve, not replace.
 *
 * All statements are tagged templates, so every value is sent as a bound parameter —
 * there is no string interpolation and therefore no injection surface. Verified against
 * the live schema: `tickettype` is InnoDB with camelCase columns (`quota`, `sold`,
 * `reserved`, `isActive`, `version`), so the row lock is a real one.
 *
 * PHASE 5 BOUNDARY — THE PRIMITIVE, NOT THE WORKFLOW
 * --------------------------------------------------
 * This module implements the three atomic statements of design §11.2 and nothing that
 * surrounds them. It does NOT create `TicketReservation` rows, does NOT read or write
 * TTLs, does NOT run a reaper, and does NOT touch orders, payments or tickets. Who
 * *calls* each primitive is a later phase's decision:
 *
 *   reserveQuota    ← Phase 6 checkout acquires quota for an order line
 *   confirmReservation ← Phase 7 settlement converts a hold into a sale
 *   releaseReservation ← Phase 6/7 cancel, expiry, or failed payment
 *
 * Phase 5 proves them (including the concurrent-oversell case the brief requires) and
 * leaves the orchestration alone.
 */

/** A Prisma client or an interactive-transaction client. */
export type InventoryDb = PrismaClient | Prisma.TransactionClient;

/**
 * The canonical **display** availability, per design §10.5: `quota - reserved - sold`.
 *
 * This re-exports `remainingFor` rather than reimplementing the formula, because the
 * brief requires exactly one canonical calculation and Phase 4 already established it
 * in `lib/events/sales-state.ts` (where it is also clamped at zero so a transiently
 * inconsistent row cannot display negative availability). If the formula ever changes,
 * it changes in one place.
 */
export const availableInventory = remainingFor;

/** The subset of a `TicketType` row this module needs. */
export type InventorySnapshot = {
    quota: number;
    sold: number;
    reserved: number;
    isActive?: boolean;
};

/**
 * Unclamped `quota - sold - reserved`.
 *
 * Deliberately separate from `availableInventory`: clamping is correct for display but
 * would HIDE an invariant violation. This raw value is what the invariant assertions
 * in the tests check, so a bug surfaces as a negative number instead of a tidy zero.
 */
export function rawAvailable(snapshot: InventorySnapshot): number {
    return snapshot.quota - snapshot.sold - snapshot.reserved;
}

/** Quota already committed to real demand (`sold` plus currently held `reserved`). */
export function committedQuota(snapshot: InventorySnapshot): number {
    return snapshot.sold + snapshot.reserved;
}

export type InventoryViolation =
    | "SOLD_NEGATIVE"
    | "RESERVED_NEGATIVE"
    | "COMMITTED_EXCEEDS_QUOTA"
    | "AVAILABLE_NEGATIVE";

/**
 * Design §11.6 invariant: `sold + reserved <= quota`, with neither counter negative.
 *
 * Enforced by the write paths rather than a database trigger — design §11.1 explains
 * why: "MySQL triggers are invisible to reviewers and hard to test". This function is
 * the single assertion shared by the primitive's tests, so every concurrency case is
 * checked against the same definition.
 */
export function inventoryViolations(
    snapshot: InventorySnapshot
): InventoryViolation[] {
    const violations: InventoryViolation[] = [];

    if (snapshot.sold < 0) {
        violations.push("SOLD_NEGATIVE");
    }

    if (snapshot.reserved < 0) {
        violations.push("RESERVED_NEGATIVE");
    }

    if (committedQuota(snapshot) > snapshot.quota) {
        violations.push("COMMITTED_EXCEEDS_QUOTA");
    }

    if (rawAvailable(snapshot) < 0) {
        violations.push("AVAILABLE_NEGATIVE");
    }

    return violations;
}

export function isInventoryConsistent(snapshot: InventorySnapshot): boolean {
    return inventoryViolations(snapshot).length === 0;
}

/** Guard every mutation input: a quantity is a positive whole number of seats. */
function assertPositiveQuantity(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error(
            `Inventory quantity must be a positive integer, received ${String(
                quantity
            )}`
        );
    }
}

type InventoryRow = {
    id: string;
    quota: number;
    sold: number;
    reserved: number;
    isActive: boolean;
};

/** One indexed primary-key read, used to classify a failed CAS and report state. */
async function readInventory(
    db: InventoryDb,
    ticketTypeId: string
): Promise<InventoryRow | null> {
    return db.ticketType.findUnique({
        where: { id: ticketTypeId },
        select: {
            id: true,
            quota: true,
            sold: true,
            reserved: true,
            isActive: true,
        },
    });
}

export type ReserveResult =
    | {
          ok: true;
          ticketTypeId: string;
          quantity: number;
          reserved: number;
          sold: number;
          quota: number;
          /** Post-reservation availability, clamped for display. */
          available: number;
      }
    | {
          ok: false;
          reason: "SOLD_OUT" | "INACTIVE" | "NOT_FOUND";
          ticketTypeId: string;
          quantity: number;
          /** Present for every reason except `NOT_FOUND`. */
          available: number | null;
      };

/**
 * Atomically acquire `quantity` seats: design §11.2 "Reserve (order creation)".
 *
 * ```sql
 * UPDATE tickettype
 *    SET reserved = reserved + n, version = version + 1
 *  WHERE id = ? AND isActive = true AND reserved + sold + n <= quota
 * ```
 *
 * `affectedRows === 0` means the guard rejected the request. Design §11.2 classifies
 * that as `SOLD_OUT`, and this returns a discriminated result instead of throwing so
 * the caller can roll back a multi-line transaction and name the offending type. Use
 * `assertReserved` at an API boundary to get the designed 409 / `SOLD_OUT` / 404 /
 * 409-`INACTIVE` envelope.
 *
 * `db` defaults to the base client but accepts a transaction client, because design
 * §11.2 requires this statement run "inside the same transaction as the state change it
 * belongs to" — so a future checkout can pair the hold with the order row atomically.
 */
export async function reserveQuota(
    ticketTypeId: string,
    quantity: number,
    db: InventoryDb = prisma
): Promise<ReserveResult> {
    assertPositiveQuantity(quantity);

    const affectedRows = await db.$executeRaw`
        UPDATE tickettype
           SET reserved = reserved + ${quantity},
               version = version + 1
         WHERE id = ${ticketTypeId}
           AND isActive = true
           AND reserved + sold + ${quantity} <= quota
    `;

    // Read back on BOTH paths: on success the caller needs the new availability, on
    // failure it is how we tell SOLD_OUT apart from INACTIVE / NOT_FOUND (the UPDATE
    // reports only "the guard failed", not which clause caused it).
    const row = await readInventory(db, ticketTypeId);

    if (affectedRows === 0) {
        if (!row) {
            return {
                ok: false,
                reason: "NOT_FOUND",
                ticketTypeId,
                quantity,
                available: null,
            };
        }

        if (!row.isActive) {
            return {
                ok: false,
                reason: "INACTIVE",
                ticketTypeId,
                quantity,
                available: rawAvailable(row),
            };
        }

        return {
            ok: false,
            reason: "SOLD_OUT",
            ticketTypeId,
            quantity,
            available: rawAvailable(row),
        };
    }

    // affectedRows === 1 implies the row existed (and is therefore non-null here).
    const updated = row as InventoryRow;

    return {
        ok: true,
        ticketTypeId,
        quantity,
        reserved: updated.reserved,
        sold: updated.sold,
        quota: updated.quota,
        available: availableInventory(updated),
    };
}

export type ConfirmResult =
    | {
          ok: true;
          ticketTypeId: string;
          quantity: number;
          reserved: number;
          sold: number;
          quota: number;
          available: number;
      }
    | {
          ok: false;
          reason: "RESERVED_UNDERFLOW" | "NOT_FOUND";
          ticketTypeId: string;
          quantity: number;
      };

/**
 * Atomically convert a hold into a sale: design §11.2 "Confirm (payment settled)".
 *
 * ```sql
 * UPDATE tickettype
 *    SET reserved = reserved - n, sold = sold + n, version = version + 1
 *  WHERE id = ? AND reserved >= n
 * ```
 *
 * A zero row count here is an **integrity violation**, not a user error — design §11.2
 * calls it a "data-integrity alarm: reserved underflow (must never happen)", because
 * this runs behind a hold that was already acquired. It is reported as
 * `RESERVED_UNDERFLOW` rather than silently succeeding, and `assertConfirmed` escalates
 * it to a non-exposing `INTERNAL_ERROR`.
 *
 * `sold` is only ever incremented here and decremented by a refund from a later phase
 * (`Event.returnQuotaOnRefund`, decision D-08) — nothing in Phase 5 moves it.
 */
export async function confirmReservation(
    ticketTypeId: string,
    quantity: number,
    db: InventoryDb = prisma
): Promise<ConfirmResult> {
    assertPositiveQuantity(quantity);

    const affectedRows = await db.$executeRaw`
        UPDATE tickettype
           SET reserved = reserved - ${quantity},
               sold = sold + ${quantity},
               version = version + 1
         WHERE id = ${ticketTypeId}
           AND reserved >= ${quantity}
    `;

    const row = await readInventory(db, ticketTypeId);

    if (affectedRows === 0) {
        return {
            ok: false,
            reason: row ? "RESERVED_UNDERFLOW" : "NOT_FOUND",
            ticketTypeId,
            quantity,
        };
    }

    const updated = row as InventoryRow;

    return {
        ok: true,
        ticketTypeId,
        quantity,
        reserved: updated.reserved,
        sold: updated.sold,
        quota: updated.quota,
        available: availableInventory(updated),
    };
}

export type ReleaseResult = {
    ok: true;
    ticketTypeId: string;
    quantity: number;
    /** How many seats the guard actually removed (may be fewer than requested). */
    released: number;
    reserved: number;
    sold: number;
    quota: number;
    available: number;
};

/**
 * Atomically return held seats to availability: design §11.2 "Release (cancel / expire
 * / failed payment)".
 *
 * ```sql
 * UPDATE tickettype
 *    SET reserved = GREATEST(0, reserved - n), version = version + 1
 *  WHERE id = ?
 * ```
 *
 * The `GREATEST(0, ...)` guard is load-bearing: design §11.2 requires it "so a
 * duplicate release cannot drive reserved negative". A double release therefore cannot
 * corrupt the counter and cannot inflate availability beyond what was ever held — the
 * worst case is that a second release returns nothing to the pool.
 *
 * Returns `released` (the real decrement) because it can legitimately be less than
 * `quantity`; a caller that logs or reconciles should record the truth, not the intent.
 */
export async function releaseReservation(
    ticketTypeId: string,
    quantity: number,
    db: InventoryDb = prisma
): Promise<ReleaseResult> {
    assertPositiveQuantity(quantity);

    await db.$executeRaw`
        UPDATE tickettype
           SET reserved = GREATEST(0, reserved - ${quantity}),
               version = version + 1
         WHERE id = ${ticketTypeId}
    `;

    const updated = (await readInventory(db, ticketTypeId)) as InventoryRow;

    return {
        ok: true,
        ticketTypeId,
        quantity,
        released: Math.min(quantity, updated.reserved + quantity),
        reserved: updated.reserved,
        sold: updated.sold,
        quota: updated.quota,
        available: availableInventory(updated),
    };
}

/**
 * Design §11.6, the one quota rule the design calls out explicitly (LOCKED):
 *
 *   "Quota reduced by an organizer after sales → Allowed only down to `sold +
 *    reserved`; below that the request is rejected (`CONFLICT`)."
 *
 * Returns the violations for a proposed new quota, so the caller can build the
 * machine-readable conflict instead of guessing. An increase never violates anything,
 * so only reductions can fail.
 *
 * This is a pure predicate on three integers; the *decision* to allow an increase is
 * the different question the brief leaves to the design, and the design answers it
 * here: increases are permitted, reductions are floor-limited.
 */
export function quotaChangeViolations(
    snapshot: InventorySnapshot,
    nextQuota: number
): { minimumQuota: number } | null {
    const minimumQuota = committedQuota(snapshot);

    if (nextQuota < minimumQuota) {
        return { minimumQuota };
    }

    return null;
}

/**
 * Whether a ticket type can currently be bought from an inventory standpoint.
 *
 * This is the inventory half of availability only. The sales *window* half lives in
 * `lib/events/sales-state.ts` (`summarizeSales`), which is the canonical classifier for
 * `salesState`. Both are needed for a full answer, and neither duplicates the other.
 */
export function hasAvailableInventory(snapshot: InventorySnapshot): boolean {
    return rawAvailable(snapshot) > 0;
}

/** Internal helper kept exported for the concurrency tests. */
export const __internals = { readInventory, assertPositiveQuantity };
