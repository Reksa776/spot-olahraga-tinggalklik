/**
 * ==========================================
 * SALES STATE AGGREGATION (pure)
 * ==========================================
 *
 * Design §10.5 requires the public payload to expose exactly three availability
 * signals — `remaining`, `isSoldOut` and `salesState: NOT_STARTED | OPEN | CLOSED |
 * SOLD_OUT` — and to do so **without exposing `quota`, `reserved` or `sold`**. This
 * module computes the display signals from the Phase 2 `TicketType` rows.
 *
 * PHASE 4 BOUNDARY
 * ----------------
 * This is a READ-ONLY derivation. It performs no reservation, mutates no counter and
 * implements no quota CAS — that is Phase 5 (§11.2) and the Phase 4 brief lists
 * "ticket quota/CAS" as forbidden. It exists in Phase 4 only because the public
 * catalog contract (§25.2) needs price and availability for the catalog cards the
 * brief requires.
 *
 * The module is pure and imports nothing, so every rule is unit-testable without a
 * database and cannot accidentally acquire a side effect.
 *
 * D-15 IS NOT DECIDED HERE
 * ------------------------
 * D-15 asks whether remaining stock should be visible at all. It is unresolved, so
 * `remaining` is never returned by this module. The public API surfaces it as `null`
 * — the design's own documented "organizer chooses to hide it" state (§10.5) — so the
 * response contract is stable and no sales-velocity data leaks while the decision is
 * pending. `isSoldOut` and `salesState` still convey everything a buyer needs to
 * choose a different tier.
 */

export const SALES_STATES = [
    "NOT_STARTED",
    "OPEN",
    "CLOSED",
    "SOLD_OUT",
] as const;

export type SalesState = (typeof SALES_STATES)[number];

/**
 * The minimal inventory shape the availability formula needs.
 *
 * Narrowed deliberately in Phase 5: `remainingFor` only ever reads these three fields,
 * and `lib/ticketing/inventory.ts` (which owns the atomic side of inventory) needs to
 * call it with a row that carries the counters and nothing else. Declaring the minimal
 * shape keeps ONE implementation of the formula while letting a counter-only row use
 * it — rather than a second copy of `quota - sold - reserved` appearing in the
 * inventory module. `TicketTypeSnapshot` widens this, so every existing caller is
 * unaffected.
 */
export type InventoryCounters = {
    quota: number;
    sold: number;
    reserved: number;
};

/** The subset of a `TicketType` row this module needs. */
export type TicketTypeSnapshot = {
    isActive: boolean;
    /** Prisma `Decimal` — accepted as anything numeric-coercible. */
    price: unknown;
    quota: number;
    sold: number;
    reserved: number;
    salesStartAt: Date | null;
    salesEndAt: Date | null;
};

/** The subset of an `Event` row this module needs. */
export type EventSalesWindow = {
    salesStartAt: Date | null;
    salesEndAt: Date | null;
    startAt: Date;
};

export type SalesSummary = {
    salesState: SalesState;
    isSoldOut: boolean;
    priceFrom: number | null;
    priceTo: number | null;
    /** Number of ACTIVE ticket types (used by the publish precondition). */
    activeTicketTypeCount: number;
    /**
     * True when at least one active ticket type has `quota > 0`. This is the
     * design §10.3 publish precondition, exposed here so publish and the catalog
     * agree on one definition instead of two.
     */
    hasSellableQuota: boolean;
};

function toNumber(value: unknown): number | null {
    if (value === null || value === undefined) {
        return null;
    }

    const n = Number(value);

    return Number.isFinite(n) ? n : null;
}

/**
 * Remaining seats for one ticket type.
 *
 * Clamped at zero: `sold` and `reserved` are independent counters that a refund or an
 * expired reservation could in principle leave slightly inconsistent, and a negative
 * "remaining" would display as availability.
 */
export function remainingFor(type: InventoryCounters): number {
    return Math.max(0, type.quota - type.sold - type.reserved);
}

/**
 * The sales state of a single ticket type, per design §25.3.
 *
 * PHASE 6 — EXPORTED (no behaviour change)
 * ----------------------------------------
 * This type and `classifySalesState` below were module-private in Phase 4/5. Phase 6
 * needs the **same** per-ticket-type verdict at checkout — a reservation must be
 * refused when the type is inactive, its window has not opened, its window has closed,
 * or it is exhausted — and brief §11 forbids a second implementation of the Phase 5
 * sales-state logic. Exporting the one implementation is the reuse; re-deriving
 * `quota - sold - reserved` and the window precedence in the checkout service would be
 * the duplicate the brief rules out.
 *
 * The function body and every existing caller are untouched, so the public catalog's
 * behaviour is unchanged.
 */
export type TicketTypeSalesState =
    | "NOT_STARTED"
    | "OPEN"
    | "CLOSED"
    | "SOLD_OUT";

type TypeState = TicketTypeSalesState;

/**
 * Classify one ticket type.
 *
 * Window precedence follows design §10.2: a null `Event.salesStartAt` means
 * "immediately after publish"; a null `Event.salesEndAt` means "until event start".
 * A ticket-type window overrides the event window when present, because the type is
 * the more specific statement.
 *
 * Exported as `classifySalesState` in Phase 6 (see the note on
 * `TicketTypeSalesState`). The internal name is kept so no call site above changes.
 */
function classifyType(
    type: TicketTypeSnapshot,
    event: EventSalesWindow,
    now: Date
): TypeState {
    const windowStart = type.salesStartAt ?? event.salesStartAt ?? null;
    const windowEnd =
        type.salesEndAt ?? event.salesEndAt ?? event.startAt ?? null;

    if (windowStart && windowStart.getTime() > now.getTime()) {
        return "NOT_STARTED";
    }

    if (windowEnd && windowEnd.getTime() < now.getTime()) {
        return "CLOSED";
    }

    return remainingFor(type) <= 0 ? "SOLD_OUT" : "OPEN";
}

/**
 * Aggregate the sales state of an event from its ticket types.
 *
 * Aggregation rule, stated once so it is not re-derived elsewhere:
 *   any type OPEN        → OPEN        (something can be bought right now)
 *   else any type SOLD_OUT → SOLD_OUT  (was open and exhausted)
 *   else any type CLOSED → CLOSED      (the window has passed)
 *   else                 → NOT_STARTED
 *
 * An event with **no active ticket types** is `NOT_STARTED` with `isSoldOut: false`.
 * That is deliberate and is the Phase 5 seam: the design's enum has no "not yet
 * configured" value, and reporting `SOLD_OUT` would claim the event is exhausted when
 * in fact nothing is on sale. It also keeps every Phase 4 event from displaying as
 * sold out before Phase 5 can create ticket types.
 */
/**
 * The canonical per-ticket-type sales verdict — see `classifyType`.
 *
 * PRECONDITION: `type.isActive` must already have been considered by the caller. This
 * function deliberately does NOT read `isActive`, because its original caller
 * (`summarizeSales`) filters inactive types out first and a second `isActive` check in
 * here would be dead code that could later disagree with that filter. Verified by test:
 * an inactive type with stock and an open window classifies as `OPEN`.
 *
 * Phase 6 checkout therefore checks `isActive` **before** calling this (see
 * `assertPurchasable` in `lib/ticketing/checkout.ts`), so an inactive type is refused
 * with `SALES_NOT_OPEN` rather than relying on this verdict — and it does not need a fifth
 * state to do it.
 */
export const classifySalesState = classifyType;

/**
 * The subset of an `Event` row that decides whether its tickets may be bought.
 */
export type EventPurchaseGate = {
    status: string;
    visibility: string;
    archivedAt: Date | null;
    cancelledAt: Date | null;
};

/**
 * May tickets for this event be bought at all?
 *
 * PHASE 6. This is the **purchase** counterpart of the catalog's display rule, and it
 * is deliberately the same rule rather than a second opinion:
 *
 *   - `PUBLISHED | ONGOING | COMPLETED` — identical to the Phase 4 event-detail
 *     `isAvailable` expression. A `DRAFT` event is not on sale, and `CANCELLED` /
 *     `ARCHIVED` are separate statuses so they are excluded by this list, not by an
 *     extra check that could drift.
 *   - `visibility !== PRIVATE` — Phase 4 reserves `PRIVATE` and never exposes it
 *     through the API. `UNLISTED` stays purchasable by direct link, which is the point
 *     of the value.
 *   - `archivedAt === null` — an archived event is history.
 *   - `cancelledAt === null` — belt and braces for an event cancelled without its
 *     status being flipped; the schema carries both, so relying on `status` alone would
 *     be trusting one of two columns that can disagree.
 *
 * Pure, so the whole matrix is unit-testable without a database. The catalog's inline
 * equivalent is intentionally left as it is: rewriting a public display path during the
 * checkout phase would risk changing what buyers see for no functional gain. That the
 * two expressions agree is asserted by test instead.
 */
export function isEventPurchasable(event: EventPurchaseGate): boolean {
    const sellableStatus =
        event.status === "PUBLISHED" ||
        event.status === "ONGOING" ||
        event.status === "COMPLETED";

    return (
        sellableStatus &&
        event.visibility !== "PRIVATE" &&
        event.archivedAt === null &&
        event.cancelledAt === null
    );
}

export function summarizeSales(
    types: readonly TicketTypeSnapshot[],
    event: EventSalesWindow,
    now: Date = new Date()
): SalesSummary {
    const active = types.filter((t) => t.isActive);

    if (active.length === 0) {
        return {
            salesState: "NOT_STARTED",
            isSoldOut: false,
            priceFrom: null,
            priceTo: null,
            activeTicketTypeCount: 0,
            hasSellableQuota: false,
        };
    }

    const prices = active
        .map((t) => toNumber(t.price))
        .filter((p): p is number => p !== null);

    const states = active.map((t) => classifyType(t, event, now));

    let salesState: SalesState;

    if (states.includes("OPEN")) {
        salesState = "OPEN";
    } else if (states.includes("SOLD_OUT")) {
        salesState = "SOLD_OUT";
    } else if (states.includes("CLOSED")) {
        salesState = "CLOSED";
    } else {
        salesState = "NOT_STARTED";
    }

    return {
        salesState,
        isSoldOut: salesState === "SOLD_OUT",
        priceFrom: prices.length > 0 ? Math.min(...prices) : null,
        priceTo: prices.length > 0 ? Math.max(...prices) : null,
        activeTicketTypeCount: active.length,
        hasSellableQuota: active.some((t) => t.quota > 0),
    };
}
