/**
 * ==========================================
 * PHASE 5 — ATOMIC INVENTORY & OVERSELL PREVENTION (INTEGRATION)
 * ==========================================
 *
 * Runs the REAL conditional-SQL primitives against the REAL InnoDB database.
 *
 * Brief §21 requires exactly this and is explicit that pure unit tests are not
 * sufficient: "Use a real database integration test for the critical atomic operation.
 * Do not claim concurrency safety based only on pure unit tests." A mocked Prisma client
 * cannot demonstrate that one `UPDATE ... WHERE reserved + sold + n <= quota` serialises
 * under a row lock — it can only demonstrate that the code called the mock.
 *
 * The concurrency cases are run against the live connection pool, so the racing
 * statements genuinely execute in parallel on separate connections and the row lock is
 * what decides the winner.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import {
    confirmReservation,
    inventoryViolations,
    isInventoryConsistent,
    rawAvailable,
    releaseReservation,
    reserveQuota,
} from "@/lib/ticketing/inventory";

jest.setTimeout(180_000);

const SUFFIX = `p5i-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let userId: string;
let organizerId: string;
let eventId: string;

/** A fresh ticket type with an exact quota, so cases cannot contaminate each other. */
async function makeTicketType(quota: number, tag: string) {
    return prisma.ticketType.create({
        data: {
            eventId,
            name: `Type ${tag} ${SUFFIX}`,
            price: "100000.00",
            quota,
            isActive: true,
        },
        select: { id: true, quota: true, sold: true, reserved: true },
    });
}

async function snapshot(ticketTypeId: string) {
    return prisma.ticketType.findUniqueOrThrow({
        where: { id: ticketTypeId },
        select: { quota: true, sold: true, reserved: true },
    });
}

beforeAll(async () => {
    userId = (
        await prisma.user.create({
            data: {
                name: `inv-owner ${SUFFIX}`,
                email: `inv-owner-${SUFFIX}@example.test`,
                role: "CUSTOMER",
            },
            select: { id: true },
        })
    ).id;

    organizerId = (
        await prisma.organizer.create({
            data: {
                ownerUserId: userId,
                name: `Inv Org ${SUFFIX}`,
                slug: `inv-org-${SUFFIX}`,
                status: "ACTIVE",
            },
            select: { id: true },
        })
    ).id;

    const sportId = (
        await prisma.sport.create({
            data: { name: `Inv Sport ${SUFFIX}`, slug: `inv-sport-${SUFFIX}` },
            select: { id: true },
        })
    ).id;

    eventId = (
        await prisma.event.create({
            data: {
                organizerId,
                sportId,
                title: `Inv Event ${SUFFIX}`,
                slug: `inv-event-${SUFFIX}`,
                eventCode: `TKL-EVT-INV-${SUFFIX}`.slice(0, 40),
                startAt: FUTURE,
                createdByUserId: userId,
            },
            select: { id: true },
        })
    ).id;
});

afterAll(async () => {
    await prisma.ticketType.deleteMany({ where: { eventId } });
    await prisma.event.deleteMany({ where: { id: eventId } });
    await prisma.sport.deleteMany({ where: { slug: `inv-sport-${SUFFIX}` } });
    await prisma.organizerMember.deleteMany({ where: { organizerId } });
    await prisma.organizer.deleteMany({ where: { id: organizerId } });
    await prisma.user.deleteMany({ where: { id: userId } });
});

describe("brief §21 Case A — enough inventory", () => {
    test("quota 10, request 3 → success with 7 remaining", async () => {
        const type = await makeTicketType(10, "A");

        const result = await reserveQuota(type.id, 3);

        expect(result.ok).toBe(true);
        expect(result.ok && result.reserved).toBe(3);
        expect(result.ok && result.available).toBe(7);

        const row = await snapshot(type.id);
        expect(row).toEqual({ quota: 10, sold: 0, reserved: 3 });
        expect(isInventoryConsistent(row)).toBe(true);
    });
});

describe("brief §21 Case B — exact inventory", () => {
    test("quota 10, request 10 → success with 0 remaining", async () => {
        const type = await makeTicketType(10, "B");

        const result = await reserveQuota(type.id, 10);

        expect(result.ok).toBe(true);
        expect(result.ok && result.available).toBe(0);
        expect(rawAvailable(await snapshot(type.id))).toBe(0);
    });

    test("a further request against a full type is refused as SOLD_OUT", async () => {
        const type = await makeTicketType(10, "B2");

        expect((await reserveQuota(type.id, 10)).ok).toBe(true);

        const overflow = await reserveQuota(type.id, 1);

        expect(overflow.ok).toBe(false);
        expect(overflow.ok === false && overflow.reason).toBe("SOLD_OUT");
        expect(await snapshot(type.id)).toEqual({
            quota: 10,
            sold: 0,
            reserved: 10,
        });
    });
});

describe("brief §21 Case C — insufficient inventory", () => {
    test("quota 10, request 11 → rejected and nothing changes", async () => {
        const type = await makeTicketType(10, "C");

        const result = await reserveQuota(type.id, 11);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toBe("SOLD_OUT");
        expect(await snapshot(type.id)).toEqual({ quota: 10, sold: 0, reserved: 0 });
    });

    test("a request is atomic: a partial hold is never taken", async () => {
        const type = await makeTicketType(10, "C2");

        expect((await reserveQuota(type.id, 7)).ok).toBe(true);

        // Only 3 remain; asking for 4 must take nothing at all, not hold 3.
        const result = await reserveQuota(type.id, 4);

        expect(result.ok).toBe(false);
        expect((await snapshot(type.id)).reserved).toBe(7);
    });
});

describe("brief §21 Case D — concurrent oversell", () => {
    test("available 10, two racing requests of 6 → exactly one succeeds", async () => {
        const type = await makeTicketType(10, "D");

        const [a, b] = await Promise.all([
            reserveQuota(type.id, 6),
            reserveQuota(type.id, 6),
        ]);

        const successes = [a, b].filter((result) => result.ok);

        // 6 + 6 = 12 > 10, so both cannot win. This is the assertion that would fail if
        // the guard were a read-then-write comparison in application code.
        expect(successes).toHaveLength(1);

        const losers = [a, b].filter((result) => !result.ok);
        expect(losers).toHaveLength(1);
        expect(losers[0].ok === false && losers[0].reason).toBe("SOLD_OUT");

        const row = await snapshot(type.id);
        expect(row.reserved).toBe(6);
        expect(row.reserved + row.sold).toBeLessThanOrEqual(row.quota);
        expect(isInventoryConsistent(row)).toBe(true);
    });

    test("N racing requests for the last few seats never exceed the quota", async () => {
        const quota = 5;
        const type = await makeTicketType(quota, "D2");

        // 10 simultaneous single-seat requests for 5 seats.
        const results = await Promise.all(
            Array.from({ length: 10 }, () => reserveQuota(type.id, 1))
        );

        const succeeded = results.filter((result) => result.ok).length;

        expect(succeeded).toBe(quota);

        const row = await snapshot(type.id);
        expect(row.reserved).toBe(quota);
        expect(row.sold).toBe(0);
        expect(inventoryViolations(row)).toEqual([]);
    });

    test("the design's 100-concurrent-buyers case: exactly 50 reservations, zero sales", async () => {
        // Design §11.6: "100 concurrent buyers, 50 tickets → Exactly 50 successful
        // reservations, 50 SOLD_OUT, sold + reserved == quota == 50, and zero issued
        // tickets until payment."
        const quota = 50;
        const type = await makeTicketType(quota, "D3");

        const results = await Promise.all(
            Array.from({ length: 100 }, () => reserveQuota(type.id, 1))
        );

        const succeeded = results.filter((result) => result.ok);
        const soldOut = results.filter(
            (result) => !result.ok && result.reason === "SOLD_OUT"
        );

        expect(succeeded).toHaveLength(quota);
        expect(soldOut).toHaveLength(100 - quota);

        const row = await snapshot(type.id);
        expect(row.reserved + row.sold).toBe(quota);
        expect(row.sold).toBe(0);
        expect(isInventoryConsistent(row)).toBe(true);
    });

    test("mixed sizes racing: the sum of winners never exceeds the quota", async () => {
        const quota = 20;
        const type = await makeTicketType(quota, "D4");

        const sizes = [4, 4, 4, 4, 4, 4, 7, 7, 7, 2, 2, 3];
        const results = await Promise.all(
            sizes.map((size) => reserveQuota(type.id, size))
        );

        const granted = results.reduce(
            (total, result) => total + (result.ok ? result.quantity : 0),
            0
        );

        const row = await snapshot(type.id);

        expect(granted).toBeLessThanOrEqual(quota);
        expect(row.reserved).toBe(granted);
        expect(isInventoryConsistent(row)).toBe(true);
    });
});

describe("inactive and missing types never hold quota", () => {
    test("an inactive type refuses a reservation with reason INACTIVE", async () => {
        const type = await prisma.ticketType.create({
            data: {
                eventId,
                name: `Inactive ${SUFFIX}`,
                price: "100000.00",
                quota: 10,
                isActive: false,
            },
            select: { id: true },
        });

        const result = await reserveQuota(type.id, 1);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toBe("INACTIVE");
        expect((await snapshot(type.id)).reserved).toBe(0);
    });

    test("an unknown id reports NOT_FOUND rather than SOLD_OUT", async () => {
        const result = await reserveQuota(`does-not-exist-${SUFFIX}`, 1);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toBe("NOT_FOUND");
    });

    test("a zero-quota type cannot be reserved", async () => {
        const type = await makeTicketType(0, "zero");

        const result = await reserveQuota(type.id, 1);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toBe("SOLD_OUT");
    });
});

describe("confirm converts a hold into a sale", () => {
    test("reserved 3 → confirm 3 leaves sold 3, reserved 0", async () => {
        const type = await makeTicketType(10, "E");

        expect((await reserveQuota(type.id, 3)).ok).toBe(true);

        const confirmed = await confirmReservation(type.id, 3);

        expect(confirmed.ok).toBe(true);
        expect(confirmed.ok && confirmed.sold).toBe(3);
        expect(confirmed.ok && confirmed.reserved).toBe(0);
        expect(confirmed.ok && confirmed.available).toBe(7);
        expect(await snapshot(type.id)).toEqual({ quota: 10, sold: 3, reserved: 0 });
    });

    test("confirming more than is held is an integrity failure, not a sale", async () => {
        const type = await makeTicketType(10, "E2");

        expect((await reserveQuota(type.id, 2)).ok).toBe(true);

        const result = await confirmReservation(type.id, 3);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toBe("RESERVED_UNDERFLOW");
        // Nothing moved: `sold` must never be inflated by an unbacked confirm.
        expect(await snapshot(type.id)).toEqual({ quota: 10, sold: 0, reserved: 2 });
    });

    test("concurrent confirms of the same single hold: only one wins", async () => {
        const type = await makeTicketType(10, "E3");

        expect((await reserveQuota(type.id, 1)).ok).toBe(true);

        const results = await Promise.all([
            confirmReservation(type.id, 1),
            confirmReservation(type.id, 1),
        ]);

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        // The double confirm must not have produced sold = 2 from one held seat.
        expect(await snapshot(type.id)).toEqual({ quota: 10, sold: 1, reserved: 0 });
    });
});

describe("release returns held seats and cannot underflow", () => {
    test("releasing a hold returns it to availability", async () => {
        const type = await makeTicketType(10, "F");

        expect((await reserveQuota(type.id, 4)).ok).toBe(true);

        const released = await releaseReservation(type.id, 4);

        expect(released.reserved).toBe(0);
        expect(released.available).toBe(10);
        expect(await snapshot(type.id)).toEqual({ quota: 10, sold: 0, reserved: 0 });
    });

    test("a duplicate release cannot drive reserved negative", async () => {
        const type = await makeTicketType(10, "F2");

        expect((await reserveQuota(type.id, 3)).ok).toBe(true);

        await releaseReservation(type.id, 3);
        // The guard design §11.2 requires: `GREATEST(0, reserved - n)`.
        await releaseReservation(type.id, 3);

        const row = await snapshot(type.id);

        expect(row.reserved).toBe(0);
        expect(inventoryViolations(row)).toEqual([]);
    });

    test("releasing more than is held clamps instead of inflating availability", async () => {
        const type = await makeTicketType(10, "F3");

        expect((await reserveQuota(type.id, 2)).ok).toBe(true);

        await releaseReservation(type.id, 5);

        const row = await snapshot(type.id);

        expect(row.reserved).toBe(0);
        // Critically: availability is back to the full quota, not quota + 3.
        expect(rawAvailable(row)).toBe(10);
        expect(isInventoryConsistent(row)).toBe(true);
    });

    test("concurrent releases of one hold cannot inflate availability", async () => {
        const type = await makeTicketType(10, "F4");

        expect((await reserveQuota(type.id, 5)).ok).toBe(true);

        await Promise.all([
            releaseReservation(type.id, 5),
            releaseReservation(type.id, 5),
        ]);

        const row = await snapshot(type.id);

        expect(row.reserved).toBe(0);
        expect(rawAvailable(row)).toBe(10);
    });
});

describe("the version token advances on every inventory mutation", () => {
    test("reserve, confirm and release each bump version", async () => {
        const type = await makeTicketType(10, "G");

        const read = () =>
            prisma.ticketType.findUniqueOrThrow({
                where: { id: type.id },
                select: { version: true },
            });

        expect((await read()).version).toBe(0);

        await reserveQuota(type.id, 2);
        expect((await read()).version).toBe(1);

        await confirmReservation(type.id, 2);
        expect((await read()).version).toBe(2);

        await releaseReservation(type.id, 1);
        expect((await read()).version).toBe(3);
    });
});

describe("input guards", () => {
    test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
        "quantity %p is rejected before any statement runs",
        async (quantity) => {
            const type = await makeTicketType(10, "H");

            await expect(reserveQuota(type.id, quantity)).rejects.toThrow();
            expect((await snapshot(type.id)).reserved).toBe(0);
        }
    );
});
