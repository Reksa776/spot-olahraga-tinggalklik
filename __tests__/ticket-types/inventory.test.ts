/**
 * ==========================================
 * PHASE 5 — INVENTORY CALCULATIONS (pure)
 * ==========================================
 *
 * The arithmetic behind availability and the quota floor, with no database involved.
 *
 * Design §10.5 defines availability as `quota - reserved - sold` and §11.6 states the
 * invariant `sold + reserved <= quota`. Getting either wrong is invisible until real
 * money is involved, so both are pinned here, including the relationship between the
 * Phase 4 display helper (`remainingFor`, clamped) and the raw value (unclamped) that
 * the invariant assertions use.
 */

import { remainingFor } from "@/lib/events/sales-state";
import {
    availableInventory,
    committedQuota,
    hasAvailableInventory,
    inventoryViolations,
    isInventoryConsistent,
    quotaChangeViolations,
    rawAvailable,
} from "@/lib/ticketing/inventory";

describe("availability is quota - sold - reserved", () => {
    test.each([
        [{ quota: 10, sold: 0, reserved: 0 }, 10],
        [{ quota: 10, sold: 3, reserved: 0 }, 7],
        [{ quota: 10, sold: 0, reserved: 3 }, 7],
        [{ quota: 10, sold: 4, reserved: 3 }, 3],
        [{ quota: 10, sold: 10, reserved: 0 }, 0],
        [{ quota: 10, sold: 5, reserved: 5 }, 0],
        [{ quota: 0, sold: 0, reserved: 0 }, 0],
    ])("%j → %i available", (snapshot, expected) => {
        expect(rawAvailable(snapshot)).toBe(expected);
        expect(availableInventory(snapshot)).toBe(expected);
    });

    test("there is exactly ONE implementation of the formula", () => {
        // `availableInventory` is a re-export of Phase 4's `remainingFor`, not a second
        // copy. This asserts the aliasing so a future edit cannot silently fork them.
        expect(availableInventory).toBe(remainingFor);
    });

    test("the committed count is sold + reserved", () => {
        expect(committedQuota({ quota: 10, sold: 4, reserved: 3 })).toBe(7);
        expect(committedQuota({ quota: 10, sold: 0, reserved: 0 })).toBe(0);
    });

    test("display availability clamps at zero, the raw value does not", () => {
        // An over-committed row is a bug; the display must not show negative stock, but
        // the invariant check must still SEE the violation rather than a tidy zero.
        const broken = { quota: 5, sold: 4, reserved: 3 };

        expect(availableInventory(broken)).toBe(0);
        expect(rawAvailable(broken)).toBe(-2);
    });

    test("hasAvailableInventory is strictly greater than zero", () => {
        expect(hasAvailableInventory({ quota: 10, sold: 9, reserved: 0 })).toBe(true);
        // Exactly sold out is not available.
        expect(hasAvailableInventory({ quota: 10, sold: 10, reserved: 0 })).toBe(false);
        expect(hasAvailableInventory({ quota: 10, sold: 6, reserved: 4 })).toBe(false);
    });
});

describe("the inventory invariant (design §11.6)", () => {
    test("a consistent row has no violations", () => {
        expect(inventoryViolations({ quota: 10, sold: 5, reserved: 5 })).toEqual([]);
        expect(isInventoryConsistent({ quota: 10, sold: 5, reserved: 5 })).toBe(true);
        expect(isInventoryConsistent({ quota: 0, sold: 0, reserved: 0 })).toBe(true);
    });

    test("sold + reserved exceeding quota is caught", () => {
        const violations = inventoryViolations({ quota: 10, sold: 7, reserved: 4 });

        expect(violations).toContain("COMMITTED_EXCEEDS_QUOTA");
        expect(violations).toContain("AVAILABLE_NEGATIVE");
        expect(isInventoryConsistent({ quota: 10, sold: 7, reserved: 4 })).toBe(false);
    });

    test("a negative counter is caught even when the total still fits", () => {
        expect(inventoryViolations({ quota: 10, sold: -1, reserved: 0 })).toContain(
            "SOLD_NEGATIVE"
        );
        expect(inventoryViolations({ quota: 10, sold: 0, reserved: -1 })).toContain(
            "RESERVED_NEGATIVE"
        );
    });

    test("exactly at quota is consistent, one over is not", () => {
        expect(isInventoryConsistent({ quota: 10, sold: 10, reserved: 0 })).toBe(true);
        expect(isInventoryConsistent({ quota: 10, sold: 10, reserved: 1 })).toBe(false);
    });
});

describe("quota reduction is floor-limited (design §11.6, LOCKED)", () => {
    test("reducing to exactly sold + reserved is allowed", () => {
        // "Allowed only down to `sold + reserved`" — the boundary itself is permitted.
        expect(
            quotaChangeViolations({ quota: 100, sold: 8, reserved: 2 }, 10)
        ).toBeNull();
    });

    test("reducing below sold + reserved is refused, reporting the floor", () => {
        const violation = quotaChangeViolations({ quota: 100, sold: 8, reserved: 2 }, 9);

        expect(violation).not.toBeNull();
        expect(violation?.minimumQuota).toBe(10);
    });

    test("the worked example from the brief: quota 10 with 8 sold cannot become 5", () => {
        const violation = quotaChangeViolations({ quota: 10, sold: 8, reserved: 0 }, 5);

        expect(violation).not.toBeNull();
        expect(violation?.minimumQuota).toBe(8);
    });

    test("quota may be reduced to zero when nothing is committed", () => {
        expect(quotaChangeViolations({ quota: 10, sold: 0, reserved: 0 }, 0)).toBeNull();
    });

    test("an increase is never a violation", () => {
        expect(
            quotaChangeViolations({ quota: 10, sold: 10, reserved: 0 }, 50)
        ).toBeNull();
        expect(
            quotaChangeViolations({ quota: 10, sold: 8, reserved: 2 }, 1000)
        ).toBeNull();
    });

    test("reserved counts toward the floor, not just sold", () => {
        // A held-but-unpaid seat is committed demand; releasing it is a refund/cancel
        // concern, not something a quota edit may ignore.
        expect(
            quotaChangeViolations({ quota: 10, sold: 0, reserved: 3 }, 2)?.minimumQuota
        ).toBe(3);
    });
});
