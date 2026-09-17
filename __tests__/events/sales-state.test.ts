/**
 * ==========================================
 * PHASE 4 — SALES STATE AGGREGATION (pure)
 * ==========================================
 *
 * Covers design §10.5's availability contract and the §10.3 publish precondition
 * (`hasSellableQuota`), which the catalog and the publish gate both read from this one
 * module so the two can never disagree.
 */

import {
    remainingFor,
    summarizeSales,
    type EventSalesWindow,
    type TicketTypeSnapshot,
} from "@/lib/events/sales-state";

const NOW = new Date("2026-09-16T10:00:00.000Z");

function window(overrides: Partial<EventSalesWindow> = {}): EventSalesWindow {
    return {
        salesStartAt: null,
        salesEndAt: null,
        startAt: new Date("2026-12-01T10:00:00.000Z"),
        ...overrides,
    };
}

function ticket(overrides: Partial<TicketTypeSnapshot> = {}): TicketTypeSnapshot {
    return {
        isActive: true,
        price: 100000,
        quota: 100,
        sold: 0,
        reserved: 0,
        salesStartAt: null,
        salesEndAt: null,
        ...overrides,
    };
}

describe("remainingFor", () => {
    test("subtracts both sold and reserved from quota", () => {
        expect(remainingFor(ticket({ quota: 100, sold: 30, reserved: 20 }))).toBe(50);
    });

    test("clamps at zero so a transient over-count cannot display as availability", () => {
        expect(remainingFor(ticket({ quota: 10, sold: 12, reserved: 0 }))).toBe(0);
        expect(remainingFor(ticket({ quota: 0, sold: 0, reserved: 0 }))).toBe(0);
    });
});

describe("an event with no active ticket types", () => {
    test("is NOT_STARTED, not SOLD_OUT", () => {
        // The important assertion for Phase 4: before Phase 5 can create ticket types,
        // every event must NOT render as sold out — that would claim the event is
        // exhausted when nothing is on sale at all.
        const summary = summarizeSales([], window(), NOW);

        expect(summary.salesState).toBe("NOT_STARTED");
        expect(summary.isSoldOut).toBe(false);
        expect(summary.priceFrom).toBeNull();
        expect(summary.priceTo).toBeNull();
        expect(summary.activeTicketTypeCount).toBe(0);
        expect(summary.hasSellableQuota).toBe(false);
    });

    test("treats inactive types as non-existent", () => {
        const summary = summarizeSales([ticket({ isActive: false })], window(), NOW);

        expect(summary.salesState).toBe("NOT_STARTED");
        expect(summary.activeTicketTypeCount).toBe(0);
        expect(summary.priceFrom).toBeNull();
    });
});

describe("single ticket type", () => {
    test("is OPEN when the window is open and quota remains", () => {
        const summary = summarizeSales([ticket()], window(), NOW);

        expect(summary.salesState).toBe("OPEN");
        expect(summary.isSoldOut).toBe(false);
        expect(summary.hasSellableQuota).toBe(true);
    });

    test("is NOT_STARTED before the sales window opens", () => {
        const summary = summarizeSales(
            [ticket()],
            window({ salesStartAt: new Date("2026-11-01T00:00:00.000Z") }),
            NOW
        );

        expect(summary.salesState).toBe("NOT_STARTED");
        expect(summary.isSoldOut).toBe(false);
    });

    test("is SOLD_OUT when the counters exhaust the quota, even if reserved", () => {
        const summary = summarizeSales(
            [ticket({ quota: 50, sold: 20, reserved: 30 })],
            window(),
            NOW
        );

        expect(summary.salesState).toBe("SOLD_OUT");
        expect(summary.isSoldOut).toBe(true);
    });

    test("is CLOSED once the window has passed", () => {
        const summary = summarizeSales(
            [ticket()],
            window({ salesEndAt: new Date("2026-09-01T00:00:00.000Z") }),
            NOW
        );

        expect(summary.salesState).toBe("CLOSED");
        // A closed sale is not a sold-out one; conflating them would mislabel the event.
        expect(summary.isSoldOut).toBe(false);
    });

    test("a null event salesEndAt means 'until the event starts' (design §10.2)", () => {
        // startAt is in the future relative to NOW, so the window is still open.
        const summary = summarizeSales([ticket()], window(), NOW);

        expect(summary.salesState).toBe("OPEN");
    });

    test("a past event start with no explicit window closes sales", () => {
        const summary = summarizeSales(
            [ticket()],
            window({ startAt: new Date("2026-01-01T00:00:00.000Z") }),
            NOW
        );

        expect(summary.salesState).toBe("CLOSED");
    });

    test("a ticket-type window overrides the event window", () => {
        const summary = summarizeSales(
            [ticket({ salesStartAt: new Date("2026-09-16T09:00:00.000Z") })],
            window({ salesStartAt: new Date("2026-11-01T00:00:00.000Z") }),
            NOW
        );

        // The more specific statement wins, so sales are already open.
        expect(summary.salesState).toBe("OPEN");
    });
});

describe("aggregation across several ticket types", () => {
    test("ANY open type makes the event OPEN", () => {
        const summary = summarizeSales(
            [
                ticket({ quota: 10, sold: 10 }), // sold out
                ticket({}, ),
            ],
            window(),
            NOW
        );

        expect(summary.salesState).toBe("OPEN");
        expect(summary.isSoldOut).toBe(false);
    });

    test("SOLD_OUT only when nothing is open and something is exhausted", () => {
        const summary = summarizeSales(
            [ticket({ quota: 5, sold: 5 }), ticket({ quota: 5, sold: 5 })],
            window(),
            NOW
        );

        expect(summary.salesState).toBe("SOLD_OUT");
        expect(summary.isSoldOut).toBe(true);
    });

    test("CLOSED wins over NOT_STARTED", () => {
        const summary = summarizeSales(
            [
                ticket({ salesStartAt: new Date("2026-11-01T00:00:00.000Z") }), // not started
                ticket({ salesEndAt: new Date("2026-09-01T00:00:00.000Z") }), // closed
            ],
            window(),
            NOW
        );

        expect(summary.salesState).toBe("CLOSED");
    });
});

describe("price range", () => {
    test("reports the min and max across active types", () => {
        const summary = summarizeSales(
            [ticket({ price: 50000 }), ticket({ price: 250000 }), ticket({ price: 100000 })],
            window(),
            NOW
        );

        expect(summary.priceFrom).toBe(50000);
        expect(summary.priceTo).toBe(250000);
    });

    test("ignores inactive types when computing the range", () => {
        const summary = summarizeSales(
            [ticket({ price: 100000 }), ticket({ price: 1, isActive: false })],
            window(),
            NOW
        );

        expect(summary.priceFrom).toBe(100000);
        expect(summary.priceTo).toBe(100000);
    });

    test("accepts a Decimal-like value (string) and coerces it", () => {
        // Prisma `Decimal` is not a JS number; it must not become NaN.
        const summary = summarizeSales([ticket({ price: "175000.00" })], window(), NOW);

        expect(summary.priceFrom).toBe(175000);
        expect(summary.priceTo).toBe(175000);
    });

    test("reports no range when the active types carry no usable price", () => {
        const summary = summarizeSales([ticket({ price: null })], window(), NOW);

        expect(summary.priceFrom).toBeNull();
        expect(summary.priceTo).toBeNull();
        // Still a usable sales state — the missing price is a display concern.
        expect(summary.salesState).toBe("OPEN");
    });
});

describe("hasSellableQuota — the design §10.3 publish precondition", () => {
    test("true when an active type has quota above zero", () => {
        expect(summarizeSales([ticket({ quota: 1 })], window(), NOW).hasSellableQuota).toBe(
            true
        );
    });

    test("false when the only active type has zero quota", () => {
        expect(summarizeSales([ticket({ quota: 0 })], window(), NOW).hasSellableQuota).toBe(
            false
        );
    });

    test("false when the only type with quota is inactive", () => {
        expect(
            summarizeSales([ticket({ quota: 500, isActive: false })], window(), NOW)
                .hasSellableQuota
        ).toBe(false);
    });

    test("a sold-out type STILL satisfies the precondition (quota exists, stock does not)", () => {
        // The precondition is about the event being configured to sell something, not
        // about current availability. Publishing an exhausted event is allowed; the
        // catalog will show it as SOLD_OUT.
        const summary = summarizeSales(
            [ticket({ quota: 10, sold: 10 })],
            window(),
            NOW
        );

        expect(summary.hasSellableQuota).toBe(true);
        expect(summary.isSoldOut).toBe(true);
    });
});
