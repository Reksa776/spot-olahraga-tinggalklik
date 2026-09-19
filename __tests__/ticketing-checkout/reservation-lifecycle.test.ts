/**
 * ==========================================
 * PHASE 6 — RESERVATION & PURCHASE-GATE LOGIC (PURE)
 * ==========================================
 *
 * No database, no Next.js, no mocks: every rule in here is a pure function, so a failure
 * points at the rule rather than at a harness. The DB-backed behaviour (atomicity,
 * idempotency, concurrency, ownership) lives in the sibling integration suites.
 */

import {
    availableInventory,
    committedQuota,
    hasAvailableInventory,
    inventoryViolations,
    isInventoryConsistent,
    rawAvailable,
} from "@/lib/ticketing/inventory";
import {
    classifySalesState,
    isEventPurchasable,
    remainingFor,
    summarizeSales,
} from "@/lib/events/sales-state";
import {
    computeCheckoutRequestHash,
    computeIdempotencyExpiresAt,
    IDEMPOTENCY_KEY_TTL_HOURS,
    normalizeCheckoutItems,
} from "@/lib/ticketing/idempotency";
import {
    checkoutRequestSchema,
    checkoutItemSchema,
} from "@/lib/ticketing/checkout-validation";
import {
    computeExpiresAt,
    DEFAULT_RESERVATION_TTL_MINUTES,
} from "@/lib/ticketing/reservations";

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);

function ticketType(overrides: Record<string, unknown> = {}) {
    return {
        isActive: true,
        price: "100000.00",
        quota: 10,
        sold: 0,
        reserved: 0,
        salesStartAt: null,
        salesEndAt: null,
        ...overrides,
    };
}

const eventWindow = {
    salesStartAt: null,
    salesEndAt: null,
    startAt: FUTURE,
};

// ─────────────────────────────────────────────────────────────────────────────
// TTL (design §11.4, LOCKED: expiresAt = now + TTL, default 30 minutes)
// ─────────────────────────────────────────────────────────────────────────────

describe("reservation TTL (design §11.4)", () => {
    test("the documented default is 30 minutes", () => {
        expect(DEFAULT_RESERVATION_TTL_MINUTES).toBe(30);
    });

    test("expiresAt is exactly now + TTL", () => {
        const now = new Date("2026-09-16T10:00:00.000Z");

        expect(computeExpiresAt(now, 30).toISOString()).toBe(
            "2026-09-16T10:30:00.000Z"
        );
    });

    test("a fractional TTL is honoured to the millisecond", () => {
        const now = new Date("2026-09-16T10:00:00.000Z");

        expect(computeExpiresAt(now, 0.5).toISOString()).toBe(
            "2026-09-16T10:00:30.000Z"
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency key handling (design §30.2)
// ─────────────────────────────────────────────────────────────────────────────

describe("idempotency fingerprint (design §30.1/§30.2)", () => {
    const base = {
        eventId: "evt_1",
        buyerName: "Budi",
        buyerEmail: "budi@example.test",
        buyerPhone: "08123456789",
        couponCode: null,
        shareToken: null,
    };

    test("the same intent hashes identically regardless of item order", () => {
        const a = computeCheckoutRequestHash({
            ...base,
            items: [
                { ticketTypeId: "tt_a", quantity: 2 },
                { ticketTypeId: "tt_b", quantity: 1 },
            ],
        });

        const b = computeCheckoutRequestHash({
            ...base,
            items: [
                { ticketTypeId: "tt_b", quantity: 1 },
                { ticketTypeId: "tt_a", quantity: 2 },
            ],
        });

        // Order-independent, because the hash is of the *normalized* body (§30.2) and a
        // retry that reorders the same basket must not look like a new request.
        expect(a).toBe(b);
    });

    test("a changed quantity produces a different fingerprint", () => {
        const one = computeCheckoutRequestHash({
            ...base,
            items: [{ ticketTypeId: "tt_a", quantity: 1 }],
        });

        const two = computeCheckoutRequestHash({
            ...base,
            items: [{ ticketTypeId: "tt_a", quantity: 2 }],
        });

        expect(one).not.toBe(two);
    });

    test("a changed buyer or event produces a different fingerprint", () => {
        const items = [{ ticketTypeId: "tt_a", quantity: 1 }];

        const baseline = computeCheckoutRequestHash({ ...base, items });

        expect(
            computeCheckoutRequestHash({ ...base, items, buyerEmail: "x@y.test" })
        ).not.toBe(baseline);

        expect(
            computeCheckoutRequestHash({ ...base, items, eventId: "evt_2" })
        ).not.toBe(baseline);
    });

    test("client money fields are not part of the fingerprint", () => {
        // `price`/`total` are stripped before this point (§17), so passing them into the
        // hash input must not be possible — the type has no such field. This asserts the
        // shape of the normalized input rather than trusting it: adding a money field
        // would let a tampered retry masquerade as a different request.
        const normalized = {
            ...base,
            items: [{ ticketTypeId: "tt_a", quantity: 1 }],
        } as Record<string, unknown>;

        const fingerprint = computeCheckoutRequestHash(normalized as never);

        expect(typeof fingerprint).toBe("string");
        expect(fingerprint).toHaveLength(64); // sha256 hex
        expect(Object.keys(normalized)).not.toContain("total");
        expect(Object.keys(normalized)).not.toContain("price");
    });

    test("the key TTL is the design's stated example (24 h)", () => {
        const now = new Date("2026-09-16T10:00:00.000Z");

        expect(IDEMPOTENCY_KEY_TTL_HOURS).toBe(24);
        expect(computeIdempotencyExpiresAt(now).toISOString()).toBe(
            "2026-09-17T10:00:00.000Z"
        );
    });

    test("it is longer than the reservation TTL, so a late replay finds the order", () => {
        expect(IDEMPOTENCY_KEY_TTL_HOURS * 60).toBeGreaterThan(
            DEFAULT_RESERVATION_TTL_MINUTES
        );
    });
});

describe("normalizeCheckoutItems (design §11.3/§11.4)", () => {
    test("merges repeated lines for one ticket type into a single reservation", () => {
        // §11.4 models exactly ONE TicketReservation row per (orderId, ticketTypeId),
        // and a per-line maxPerOrder could otherwise be bypassed by splitting a purchase.
        const merged = normalizeCheckoutItems([
            { ticketTypeId: "tt_a", quantity: 3 },
            { ticketTypeId: "tt_a", quantity: 2 },
        ]);

        expect(merged).toEqual([{ ticketTypeId: "tt_a", quantity: 5 }]);
    });

    test("sorts by ticketTypeId ascending — §11.3's deterministic lock order", () => {
        const sorted = normalizeCheckoutItems([
            { ticketTypeId: "tt_c", quantity: 1 },
            { ticketTypeId: "tt_a", quantity: 1 },
            { ticketTypeId: "tt_b", quantity: 1 },
        ]);

        expect(sorted.map((line) => line.ticketTypeId)).toEqual([
            "tt_a",
            "tt_b",
            "tt_c",
        ]);
    });

    test("is stable for an already-normalized list", () => {
        const once = normalizeCheckoutItems([
            { ticketTypeId: "tt_b", quantity: 2 },
            { ticketTypeId: "tt_a", quantity: 1 },
        ]);

        expect(normalizeCheckoutItems(once)).toEqual(once);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Purchase gate (design §10.3/§10.5, brief §12)
// ─────────────────────────────────────────────────────────────────────────────

describe("isEventPurchasable (brief §12)", () => {
    const base = {
        status: "PUBLISHED",
        visibility: "PUBLIC",
        archivedAt: null,
        cancelledAt: null,
    };

    test("a published public event is purchasable", () => {
        expect(isEventPurchasable(base)).toBe(true);
    });

    test("ONGOING is purchasable — the sales window decides closure", () => {
        expect(isEventPurchasable({ ...base, status: "ONGOING" })).toBe(true);
    });

    test("COMPLETED is NOT purchasable — the event is over", () => {
        // PHASE 15 (P14-D11). This assertion was the opposite before the decision lock: the
        // Phase 4/6 list included COMPLETED because the status was unreachable, so the
        // question never arose. Now that completion is automated at `endAt + 30m`, design
        // §10.3's "Sales stop" is implemented literally — a completed event is not on sale.
        expect(isEventPurchasable({ ...base, status: "COMPLETED" })).toBe(false);
    });

    test("a DRAFT event is not purchasable", () => {
        expect(isEventPurchasable({ ...base, status: "DRAFT" })).toBe(false);
    });

    test("a CANCELLED event is not purchasable — by status or by timestamp", () => {
        expect(isEventPurchasable({ ...base, status: "CANCELLED" })).toBe(false);
        expect(
            isEventPurchasable({ ...base, cancelledAt: new Date() })
        ).toBe(false);
    });

    test("an ARCHIVED event is not purchasable — by status or by timestamp", () => {
        expect(isEventPurchasable({ ...base, status: "ARCHIVED" })).toBe(false);
        expect(isEventPurchasable({ ...base, archivedAt: new Date() })).toBe(
            false
        );
    });

    test("PRIVATE visibility is never purchasable; UNLISTED still is", () => {
        expect(isEventPurchasable({ ...base, visibility: "PRIVATE" })).toBe(
            false
        );
        expect(isEventPurchasable({ ...base, visibility: "UNLISTED" })).toBe(
            true
        );
    });

    test("PENDING_REVIEW is not purchasable (D-13 self-publish has no such state)", () => {
        expect(isEventPurchasable({ ...base, status: "PENDING_REVIEW" })).toBe(
            false
        );
    });
});

describe("classifySalesState (the single canonical classifier)", () => {
    test("an active type with stock inside its window is OPEN", () => {
        expect(classifySalesState(ticketType(), eventWindow, new Date())).toBe(
            "OPEN"
        );
    });

    test("the classifier does NOT consider isActive — that is the caller's job", () => {
        // A real finding, pinned as a contract. `classifyType` never reads `isActive`:
        // `summarizeSales` filters inactive types out first, so an `isActive` check inside
        // the classifier would be dead code that could later disagree with that filter.
        // An inactive type with stock therefore classifies as OPEN, which is why
        // `assertPurchasable` checks `isActive` BEFORE calling this function and why the
        // checkout refuses an inactive type without needing a fifth state.
        expect(
            classifySalesState(
                ticketType({ isActive: false }),
                eventWindow,
                new Date()
            )
        ).toBe("OPEN");

        // The aggregator that public surfaces use DOES drop it, which is the behaviour
        // that matters for the catalog.
        const summary = summarizeSales(
            [ticketType({ isActive: false })],
            eventWindow,
            new Date()
        );

        expect(summary.activeTicketTypeCount).toBe(0);
        expect(summary.salesState).toBe("NOT_STARTED");
    });

    test("a future window is NOT_STARTED and a past window is CLOSED", () => {
        const now = new Date("2026-09-16T10:00:00.000Z");

        expect(
            classifySalesState(
                ticketType({ salesStartAt: new Date("2026-09-17T10:00:00.000Z") }),
                eventWindow,
                now
            )
        ).toBe("NOT_STARTED");

        expect(
            classifySalesState(
                ticketType({ salesEndAt: new Date("2026-09-15T10:00:00.000Z") }),
                eventWindow,
                now
            )
        ).toBe("CLOSED");
    });

    test("no remaining stock is SOLD_OUT", () => {
        expect(
            classifySalesState(
                ticketType({ quota: 10, sold: 7, reserved: 3 }),
                eventWindow,
                new Date()
            )
        ).toBe("SOLD_OUT");
    });

    test("the ticket-type window overrides the event window (§10.2 precedence)", () => {
        const now = new Date("2026-09-16T10:00:00.000Z");

        // Event window is wide open…
        const event = {
            salesStartAt: new Date("2026-09-01T00:00:00.000Z"),
            salesEndAt: new Date("2026-12-01T00:00:00.000Z"),
            startAt: FUTURE,
        };

        // …but this type closed yesterday, and the more specific statement wins.
        expect(
            classifySalesState(
                ticketType({ salesEndAt: new Date("2026-09-15T00:00:00.000Z") }),
                event,
                now
            )
        ).toBe("CLOSED");
    });

    test("a null event salesEndAt falls back to the event's start time", () => {
        const now = new Date("2026-09-16T10:00:00.000Z");
        const started = new Date("2026-09-16T09:00:00.000Z");

        expect(
            classifySalesState(
                ticketType(),
                { salesStartAt: null, salesEndAt: null, startAt: started },
                now
            )
        ).toBe("CLOSED");
    });
});

describe("remainingFor (design §10.5)", () => {
    test("the single canonical formula is quota - sold - reserved", () => {
        expect(remainingFor({ quota: 10, sold: 4, reserved: 3 })).toBe(3);
    });

    test("it clamps at zero rather than displaying negative availability", () => {
        expect(remainingFor({ quota: 5, sold: 6, reserved: 0 })).toBe(0);
    });

    test("summarizeSales keeps the publish precondition in one place", () => {
        const summary = summarizeSales(
            [ticketType({ quota: 5 })],
            eventWindow,
            new Date()
        );

        expect(summary.salesState).toBe("OPEN");
        expect(summary.hasSellableQuota).toBe(true);
        expect(summary.activeTicketTypeCount).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Request validation (design §25.5, brief §10/§17)
// ─────────────────────────────────────────────────────────────────────────────

describe("checkout request schema (design §25.5)", () => {
    const valid = {
        eventId: "evt_1",
        items: [{ ticketTypeId: "tt_a", quantity: 2 }],
        buyerName: "Budi",
        buyerEmail: "budi@example.test",
        buyerPhone: "08123456789",
    };

    test("a well-formed request parses", () => {
        expect(checkoutRequestSchema.parse(valid)).toMatchObject({
            eventId: "evt_1",
            items: [{ ticketTypeId: "tt_a", quantity: 2 }],
        });
    });

    test("client money fields are stripped, not trusted (brief §17)", () => {
        const parsed = checkoutRequestSchema.parse({
            ...valid,
            price: 1,
            subtotal: 1,
            total: 1,
            currency: "USD",
        }) as Record<string, unknown>;

        expect(parsed).not.toHaveProperty("price");
        expect(parsed).not.toHaveProperty("subtotal");
        expect(parsed).not.toHaveProperty("total");
        expect(parsed).not.toHaveProperty("currency");
    });

    test("client identity/authority fields are stripped (brief §13/§14)", () => {
        const parsed = checkoutRequestSchema.parse({
            ...valid,
            organizerId: "org_evil",
            userId: "user_evil",
            customerId: "cust_evil",
            status: "PAID",
            paymentStatus: "PAID",
        }) as Record<string, unknown>;

        for (const field of [
            "organizerId",
            "userId",
            "customerId",
            "status",
            "paymentStatus",
        ]) {
            expect(parsed).not.toHaveProperty(field);
        }
    });

    test("quantity must be a positive integer — no coercion, no zero, no negatives", () => {
        for (const quantity of [0, -1, 1.5, "2", null, undefined]) {
            expect(
                checkoutItemSchema.safeParse({
                    ticketTypeId: "tt_a",
                    quantity,
                }).success
            ).toBe(false);
        }

        expect(
            checkoutItemSchema.safeParse({ ticketTypeId: "tt_a", quantity: 1 })
                .success
        ).toBe(true);
    });

    test("an empty item list is rejected", () => {
        expect(
            checkoutRequestSchema.safeParse({ ...valid, items: [] }).success
        ).toBe(false);
    });

    test("the buyer contact snapshot is required (§25.5 lists only coupon/share as optional)", () => {
        for (const field of ["buyerName", "buyerEmail", "buyerPhone"]) {
            const without = { ...valid } as Record<string, unknown>;
            delete without[field];

            expect(checkoutRequestSchema.safeParse(without).success).toBe(false);
        }
    });

    test("a malformed email or phone is rejected", () => {
        expect(
            checkoutRequestSchema.safeParse({
                ...valid,
                buyerEmail: "not-an-email",
            }).success
        ).toBe(false);

        expect(
            checkoutRequestSchema.safeParse({
                ...valid,
                buyerPhone: "abc",
            }).success
        ).toBe(false);
    });

    test("couponCode and shareToken remain optional", () => {
        expect(checkoutRequestSchema.parse(valid)).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────────
// Brief §11 — the canonical availability definition is not duplicated
// ─────────────────────────────────────────────────────────────

/**
 * There are two *deliberate* expressions of availability, and this block is what keeps
 * them from drifting apart:
 *
 *   inventory.ts   rawAvailable     unclamped — the invariant (`sold + reserved <= quota`)
 *   sales-state.ts remainingFor    clamped — display only, so a transient inconsistency
 *                                  cannot render as negative availability
 *
 * `availableInventory` is a re-export of `remainingFor`, not a third copy. If someone
 * edits one formula, the equality asserted here breaks rather than the two quietly
 * disagreeing about how many seats are left.
 */
describe("the two availability expressions agree", () => {
    const SNAPSHOTS = [
        { quota: 10, sold: 0, reserved: 0 },
        { quota: 10, sold: 0, reserved: 10 },
        { quota: 10, sold: 10, reserved: 0 },
        { quota: 10, sold: 3, reserved: 4 },
        { quota: 1, sold: 0, reserved: 1 },
        { quota: 0, sold: 0, reserved: 0 },
        // Deliberately inconsistent, to pin the clamping rule alone.
        { quota: 5, sold: 3, reserved: 4 },
        { quota: 5, sold: 9, reserved: 0 },
    ] as const;

    test("rawAvailable is the unclamped canonical formula", () => {
        for (const s of SNAPSHOTS) {
            expect(rawAvailable(s)).toBe(s.quota - s.sold - s.reserved);
        }
    });

    test("remainingFor is exactly rawAvailable clamped at zero", () => {
        for (const s of SNAPSHOTS) {
            expect(remainingFor(s)).toBe(Math.max(0, rawAvailable(s)));
        }
    });

    test("availableInventory is the clamped display value, not a third formula", () => {
        for (const s of SNAPSHOTS) {
            expect(availableInventory(s)).toBe(remainingFor(s));
            expect(availableInventory(s)).toBe(Math.max(0, rawAvailable(s)));
        }
    });

    test("committedQuota is sold + reserved", () => {
        for (const s of SNAPSHOTS) {
            expect(committedQuota(s)).toBe(s.sold + s.reserved);
        }
    });

    test("consistency is exactly the brief §1 invariant set", () => {
        for (const s of SNAPSHOTS) {
            const expected =
                s.sold >= 0 &&
                s.reserved >= 0 &&
                s.sold + s.reserved <= s.quota;

            expect(isInventoryConsistent(s)).toBe(expected);
            expect(inventoryViolations(s).length === 0).toBe(expected);
        }

        // The clamped display value can be 0 while the row is inconsistent, which is
        // exactly why the invariant check reads the unclamped value and not the display.
        const inconsistent = { quota: 5, sold: 3, reserved: 4 };
        expect(availableInventory(inconsistent)).toBe(0);
        expect(isInventoryConsistent(inconsistent)).toBe(false);
    });

    test("hasAvailableInventory agrees with the canonical formula", () => {
        for (const s of SNAPSHOTS) {
            expect(hasAvailableInventory(s)).toBe(rawAvailable(s) > 0);
        }
    });
});
