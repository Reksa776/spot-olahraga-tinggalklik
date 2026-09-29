/**
 * ==========================================
 * PIC DASHBOARD — `Tiket Terjual` IS ONE ROW PER PAID ORDER
 * ==========================================
 *
 * The section under test answers a question an event-level rollup cannot: "which ORDER produced
 * this sale?". A rollup of the same numbers answers "where are tickets moving?" — and silently
 * turns two orders on one event into one row whose ticket count belongs to neither of them. This
 * suite pins the row GRANULARITY against a real MySQL schema, because granularity is a property
 * of the `where`/`select` that actually runs, not of the component that renders the result:
 *
 *   rows       one row per PAYMENT-STATUS=PAID `EventOrder` in the caller's own PIC scope —
 *              two paid orders on ONE event are TWO rows, and the same event id appears on more
 *              than one row;
 *   per row    `Jumlah Tiket` = Σ that order's OWN `EventOrderItem.quantity`, and `Penjualan` =
 *              that order's own `total` — never the event's, never the page's;
 *   footer     orders / tickets / money are the read model's aggregates over the WHOLE filtered
 *              set (not the current page), and the ticket total is NOT any single row's count;
 *   PAID only  a PENDING order with tickets is an attribution, never a sale — and it stays
 *              visible in the attribution list, so its absence here is the payment state and not
 *              an empty fixture;
 *   filter     `eventId` narrows which orders are shown; it never collapses them into one row
 *              per event, and a foreign id narrows to an empty result rather than a leak;
 *   scope      another PIC's order on the SAME event is in nobody else's rows.
 *
 * The worked example the requirement names is reproduced literally: ORD-001 (10 tickets,
 * Rp150.000) and ORD-002 (3 tickets, Rp45.000) on one event are two rows, with a footer of
 * 13 tickets and Rp195.000 — not one row of 10, and not one row of 13 against the event.
 *
 * The multi-line order (one order, several ticket types, quantity summed) is pinned by
 * `dashboard-filters.integration.test.ts`; this suite keeps the single-line shape of the example
 * so the arithmetic is checkable at a glance.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import type { OrderStatus, PaymentStatus, PICAttributionSource } from "@prisma/client";

import { listMyAttributions, getMyPicTicketSales } from "@/lib/pic/self-service";
import { prisma } from "@/lib/prisma";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(180_000);

const SUFFIX = `picsales-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAID = "PAID" as PaymentStatus;
const PENDING = "PENDING" as PaymentStatus;
const PAGE_SIZE = 10;

/** The two orders of the requirement's example, on ONE event. */
const ORDER_NUMBERS = {
    first: `ORD-001-${SUFFIX}`,
    second: `ORD-002-${SUFFIX}`,
    pending: `ORD-003-${SUFFIX}`,
    otherPic: `ORD-004-${SUFFIX}`,
    otherEvent: `ORD-005-${SUFFIX}`,
};

const EVENT_TITLE = "Badminton Star Cirebon";
const EXPECTED_TICKETS = 10 + 3;
const EXPECTED_SALES = 150_000 + 45_000;

let owner: { id: string };
let picA: { id: string };
let picB: { id: string };
let buyer: { id: string };

let org: { id: string };
let sportId: string;

let eventOne: { id: string; slug: string };
let eventTwo: { id: string; slug: string };

let profileA: { id: string };
let profileB: { id: string };

let orders: {
    first: { id: string };
    second: { id: string };
    pending: { id: string };
    otherPic: { id: string };
    otherEvent: { id: string };
};

function signInAs(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: {
                      id: userId,
                      email: `${SUFFIX}-${userId}@example.test`,
                      name: "Fixture",
                  },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

async function createEvent(key: string, title: string) {
    const slug = `picsales-${key}-${SUFFIX}`;

    return prisma.event.create({
        data: {
            organizerId: org.id,
            sportId,
            title,
            slug,
            eventCode: `EVT-${key}-${SUFFIX}`,
            status: "PUBLISHED",
            visibility: "UNLISTED",
            startAt: FUTURE,
            endAt: new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000),
            createdByUserId: owner.id,
        },
        select: { id: true, slug: true },
    });
}

/** One order, one ticket line — the shape the worked example is written in. */
async function createOrder(opts: {
    orderNumber: string;
    eventId: string;
    picProfileId: string;
    paymentStatus: PaymentStatus;
    quantity: number;
    total: string;
}): Promise<{ id: string }> {
    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: opts.orderNumber,
            organizerId: org.id,
            eventId: opts.eventId,
            userId: buyer.id,
            buyerName: `Buyer ${opts.orderNumber}`,
            status: (opts.paymentStatus === PAID ? "PAID" : "PENDING_PAYMENT") as OrderStatus,
            paymentStatus: opts.paymentStatus,
            subtotal: opts.total,
            total: opts.total,
            organizerNetAmount: opts.total,
            picProfileId: opts.picProfileId,
        },
        select: { id: true },
    });

    await prisma.eventOrderItem.create({
        data: {
            orderId: order.id,
            nameSnapshot: "Reguler",
            priceSnapshot: "5000.00",
            quantity: opts.quantity,
            subtotal: `${opts.quantity * 5000}.00`,
        },
    });

    return order;
}

beforeAll(async () => {
    owner = await prisma.user.create({
        data: {
            name: `PICSales Owner ${SUFFIX}`,
            email: `picsales-owner-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    function picUser(tag: string) {
        return prisma.user.create({
            data: {
                name: `PICSales ${tag} ${SUFFIX}`,
                email: `picsales-${tag}-${SUFFIX}@example.test`,
                role: "CUSTOMER",
                platformRole: "PIC",
            },
            select: { id: true },
        });
    }

    picA = await picUser("a");
    picB = await picUser("b");

    buyer = await prisma.user.create({
        data: {
            name: `PICSales Buyer ${SUFFIX}`,
            email: `picsales-buyer-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    org = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `PICSales Org ${SUFFIX}`,
            slug: `picsales-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    sportId = (
        await prisma.sport.create({
            data: { name: `PICSales Sport ${SUFFIX}`, slug: `picsales-sport-${SUFFIX}` },
            select: { id: true },
        })
    ).id;

    eventOne = await createEvent("one", `${EVENT_TITLE} ${SUFFIX}`);
    eventTwo = await createEvent("two", `Futsal Liga ${SUFFIX}`);

    async function profile(tag: string, userId: string) {
        return prisma.pICProfile.create({
            data: {
                userId,
                picCode: `PICSALES-${tag}-${SUFFIX}`,
                displayName: `PICSales ${tag} ${SUFFIX}`,
                status: "ACTIVE",
            },
            select: { id: true },
        });
    }

    profileA = await profile("A", picA.id);
    profileB = await profile("B", picB.id);

    orders = {
        // The requirement's example: the same event twice, 10 tickets then 3.
        first: await createOrder({
            orderNumber: ORDER_NUMBERS.first,
            eventId: eventOne.id,
            picProfileId: profileA.id,
            paymentStatus: PAID,
            quantity: 10,
            total: "150000.00",
        }),
        second: await createOrder({
            orderNumber: ORDER_NUMBERS.second,
            eventId: eventOne.id,
            picProfileId: profileA.id,
            paymentStatus: PAID,
            quantity: 3,
            total: "45000.00",
        }),
        // Attributed to A and never paid for: 7 tickets that must not reach the sales table.
        pending: await createOrder({
            orderNumber: ORDER_NUMBERS.pending,
            eventId: eventOne.id,
            picProfileId: profileA.id,
            paymentStatus: PENDING,
            quantity: 7,
            total: "35000.00",
        }),
        // B's own paid order on the SAME event — the isolation case.
        otherPic: await createOrder({
            orderNumber: ORDER_NUMBERS.otherPic,
            eventId: eventOne.id,
            picProfileId: profileB.id,
            paymentStatus: PAID,
            quantity: 4,
            total: "60000.00",
        }),
        // A's paid order on ANOTHER event — so "one row per order" is not "one row per event".
        otherEvent: await createOrder({
            orderNumber: ORDER_NUMBERS.otherEvent,
            eventId: eventTwo.id,
            picProfileId: profileA.id,
            paymentStatus: PAID,
            quantity: 1,
            total: "15000.00",
        }),
    };

    // Attribution is captured at checkout, so the PENDING order has one too — which is what
    // makes its absence from the sales table a statement about payment state.
    const attributions: {
        orderId: string;
        eventId: string;
        picProfileId: string;
    }[] = [
        { orderId: orders.first.id, eventId: eventOne.id, picProfileId: profileA.id },
        { orderId: orders.second.id, eventId: eventOne.id, picProfileId: profileA.id },
        { orderId: orders.pending.id, eventId: eventOne.id, picProfileId: profileA.id },
        { orderId: orders.otherPic.id, eventId: eventOne.id, picProfileId: profileB.id },
        { orderId: orders.otherEvent.id, eventId: eventTwo.id, picProfileId: profileA.id },
    ];

    for (const attribution of attributions) {
        await prisma.pICAttribution.create({
            data: {
                orderId: attribution.orderId,
                organizerId: org.id,
                eventId: attribution.eventId,
                picProfileId: attribution.picProfileId,
                source: "PIC_LINK" as PICAttributionSource,
            },
        });
    }
});

afterAll(async () => {
    const picIds = [profileA, profileB].filter(Boolean).map((profile) => profile.id);

    await prisma.pICAttribution.deleteMany({ where: { picProfileId: { in: picIds } } });
    await prisma.eventOrderItem.deleteMany({ where: { order: { userId: buyer.id } } });
    await prisma.eventOrder.deleteMany({ where: { userId: buyer.id } });
    await prisma.pICProfile.deleteMany({ where: { id: { in: picIds } } });
    await prisma.event.deleteMany({
        where: {
            id: {
                in: [eventOne, eventTwo]
                    .filter(Boolean)
                    .map((event) => event.id),
            },
        },
    });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.organizer.deleteMany({ where: { id: org?.id } });
    await prisma.user.deleteMany({
        where: { id: { in: [owner, picA, picB, buyer].filter(Boolean).map((u) => u.id) } },
    });
});

/** One page of the caller's sales, indexed by order number. */
async function salesByOrderNumber(
    userId: string,
    filters: Parameters<typeof getMyPicTicketSales>[1] = {}
) {
    const page = await getMyPicTicketSales(userId, filters);

    return {
        ...page,
        byNumber: new Map(page.items.map((item) => [item.orderNumber, item])),
    };
}

/* ==================================================================================
 * 1 + 6. ONE ROW PER PAID ORDER — two paid orders on ONE event are two rows
 * ================================================================================== */

describe("Tiket Terjual — one row per PAID order, never one row per event", () => {
    test("the worked example: ORD-001 and ORD-002 on one event are TWO rows", async () => {
        signInAs(picA.id);
        const sales = await salesByOrderNumber(picA.id, { eventId: eventOne.id });

        expect(sales.items).toHaveLength(2);
        expect(sales.pagination.total).toBe(2);

        // Two DIFFERENT orders…
        expect(new Set(sales.items.map((item) => item.orderId)).size).toBe(2);
        expect([...sales.byNumber.keys()].sort()).toEqual(
            [ORDER_NUMBERS.first, ORDER_NUMBERS.second].sort()
        );

        // …on the SAME event, which is exactly the case an event rollup would collapse.
        expect(sales.items.every((item) => item.eventId === eventOne.id)).toBe(true);
        expect(sales.items[0].eventTitle).toBe(`${EVENT_TITLE} ${SUFFIX}`);
        expect(sales.items[0].eventId).toBe(sales.items[1].eventId);
    });

    test("the unfiltered read repeats one event across rows instead of rolling it up", async () => {
        signInAs(picA.id);
        const sales = await getMyPicTicketSales(picA.id);

        // Three paid orders, two events: one row each, so a repeated event id is present.
        expect(sales.items).toHaveLength(3);
        expect(sales.pagination.total).toBe(3);
        expect(new Set(sales.items.map((item) => item.eventId)).size).toBe(2);
        expect(sales.items.filter((item) => item.eventId === eventOne.id)).toHaveLength(2);

        // Two rows of the SAME event, one of the other — and no row is an event.
        expect([...sales.items.map((item) => item.orderNumber)].sort()).toEqual(
            [ORDER_NUMBERS.first, ORDER_NUMBERS.second, ORDER_NUMBERS.otherEvent].sort()
        );
    });
});

/* ==================================================================================
 * 2 + 3 + 4. PER ROW: the order's OWN ticket count and the order's OWN total
 * ================================================================================== */

describe("Jumlah Tiket and Penjualan are the ROW's own figures", () => {
    test("ORD-001 shows 10 tickets and Rp150.000; ORD-002 shows 3 and Rp45.000", async () => {
        signInAs(picA.id);
        const sales = await salesByOrderNumber(picA.id, { eventId: eventOne.id });

        expect(sales.byNumber.get(ORDER_NUMBERS.first)).toMatchObject({
            eventId: eventOne.id,
            paymentStatus: PAID,
            ticketQuantity: 10,
        });
        expect(Number(sales.byNumber.get(ORDER_NUMBERS.first)!.orderTotal)).toBe(150_000);

        expect(sales.byNumber.get(ORDER_NUMBERS.second)).toMatchObject({
            eventId: eventOne.id,
            paymentStatus: PAID,
            ticketQuantity: 3,
        });
        expect(Number(sales.byNumber.get(ORDER_NUMBERS.second)!.orderTotal)).toBe(45_000);
    });

    test("each row's quantity is the sum of THAT order's own item rows", async () => {
        signInAs(picA.id);
        const sales = await salesByOrderNumber(picA.id, { eventId: eventOne.id });

        // The stored facts the row claims to read, read back from the database.
        for (const [orderNumber, order] of [
            [ORDER_NUMBERS.first, orders.first],
            [ORDER_NUMBERS.second, orders.second],
        ] as const) {
            const items = await prisma.eventOrderItem.findMany({
                where: { orderId: order.id },
                select: { quantity: true },
            });

            expect(sales.byNumber.get(orderNumber)!.ticketQuantity).toBe(
                items.reduce((sum, item) => sum + item.quantity, 0)
            );
        }

        // 10 and 3 — NOT the event's 13 on both rows, and not 13 on either.
        expect([...sales.items.map((item) => item.ticketQuantity)].sort((a, b) => a - b)).toEqual([
            3, 10,
        ]);
        expect(sales.items.every((item) => item.ticketQuantity !== EXPECTED_TICKETS)).toBe(true);
    });
});

/* ==================================================================================
 * 4 + 5. THE FOOTER: 13 tickets and the SUM of the two orders, over the whole set
 * ================================================================================== */

describe("the footer totals agree with the rows and are never a per-event aggregate", () => {
    test("Total tiket = 13 (10 + 3) and Total penjualan = Rp195.000", async () => {
        signInAs(picA.id);
        const sales = await getMyPicTicketSales(picA.id, { eventId: eventOne.id });

        expect(sales.totals).toMatchObject({ orders: 2, ticketsSold: EXPECTED_TICKETS });
        expect(Number(sales.totals.sales)).toBe(EXPECTED_SALES);

        // The three ways this could have gone wrong, each ruled out by name:
        expect(sales.totals.ticketsSold).not.toBe(10); // one order's count
        expect(sales.totals.ticketsSold).not.toBe(3); // the other one's
        expect(sales.totals.ticketsSold).not.toBe(sales.totals.orders); // ticket count ≠ order count
        expect(Number(sales.totals.sales)).toBe(150_000 + 45_000);
    });

    test("the totals describe the whole filtered set, not the page rendered", async () => {
        signInAs(picA.id);
        const page = await getMyPicTicketSales(picA.id, { eventId: eventOne.id, limit: 1 });

        expect(page.items).toHaveLength(1);
        // One row is visible; the footer still reports both orders and all 13 tickets.
        expect(page.totals).toMatchObject({ orders: 2, ticketsSold: EXPECTED_TICKETS });
        expect(Number(page.totals.sales)).toBe(EXPECTED_SALES);
        expect(page.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    });

    test("filtering to one event does not change the read model's own scale", async () => {
        signInAs(picA.id);

        const all = await getMyPicTicketSales(picA.id);
        // 10 + 3 + 1 across two events, read as rows rather than as events.
        expect(all.totals).toMatchObject({ orders: 3, ticketsSold: 14 });
        expect(Number(all.totals.sales)).toBe(210_000);

        const one = await getMyPicTicketSales(picA.id, { eventId: eventOne.id });
        // The filter narrows the set; it does not merge the two remaining rows.
        expect(one.items).toHaveLength(2);
        expect(one.totals).toMatchObject({ orders: 2, ticketsSold: EXPECTED_TICKETS });
    });
});

/* ==================================================================================
 * 6. PAID ONLY — the PENDING order is attributed, and is still not a sale
 * ================================================================================== */

describe("only PAID orders are rows in the table", () => {
    test("the PENDING order is absent, and its 7 tickets are not in the totals", async () => {
        signInAs(picA.id);
        const sales = await salesByOrderNumber(picA.id, { eventId: eventOne.id });

        expect(sales.byNumber.has(ORDER_NUMBERS.pending)).toBe(false);
        expect(sales.items.map((item) => item.orderNumber)).not.toContain(ORDER_NUMBERS.pending);
        expect(sales.totals.ticketsSold).toBe(EXPECTED_TICKETS);
        expect(sales.totals.ticketsSold).not.toBe(EXPECTED_TICKETS + 7);
    });

    test("the same order IS in the attribution list — so the row is held back by state alone", async () => {
        signInAs(picA.id);
        const attributions = await listMyAttributions(picA.id, { paymentStatus: PENDING });

        expect(attributions.map((row) => row.orderNumber)).toEqual([ORDER_NUMBERS.pending]);
        expect(attributions[0].ticketQuantity).toBe(7);
    });
});

/* ==================================================================================
 * 7. AUTHORIZATION — the rows are the caller's own, and only the caller's
 * ================================================================================== */

describe("the rows stay inside the caller's PIC scope", () => {
    test("another PIC's paid order on the SAME event is in nobody else's table", async () => {
        signInAs(picA.id);
        const salesA = await salesByOrderNumber(picA.id, { eventId: eventOne.id });

        expect(salesA.items.map((item) => item.orderNumber)).not.toContain(ORDER_NUMBERS.otherPic);
        expect(salesA.totals).toMatchObject({ orders: 2, ticketsSold: EXPECTED_TICKETS });

        // The same event id, read by B, returns B's own single order — 4 tickets, not 13.
        signInAs(picB.id);
        const salesB = await salesByOrderNumber(picB.id, { eventId: eventOne.id });

        expect(salesB.items.map((item) => item.orderNumber)).toEqual([ORDER_NUMBERS.otherPic]);
        expect(salesB.totals).toMatchObject({ orders: 1, ticketsSold: 4 });
        expect(Number(salesB.totals.sales)).toBe(60_000);
        expect(salesB.items.map((item) => item.orderNumber)).not.toContain(ORDER_NUMBERS.first);
    });

    test("a forged user id is a denial, not another PIC's rows", async () => {
        signInAs(picA.id);

        await expect(getMyPicTicketSales(picB.id, { eventId: eventOne.id })).rejects.toMatchObject(
            {
                code: "PIC_ACCESS_DENIED",
            }
        );
        await expect(listMyAttributions(picB.id)).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
    });
});

/* ==================================================================================
 * 8. THE EVENT FILTER NARROWS ROWS — it never re-groups them
 * ================================================================================== */

describe("the event filter keeps the per-order granularity", () => {
    test("the filtered rows are exactly the unfiltered rows of that event", async () => {
        signInAs(picA.id);

        const all = await getMyPicTicketSales(picA.id);
        const filtered = await getMyPicTicketSales(picA.id, { eventId: eventOne.id });

        const expected = all.items
            .filter((item) => item.eventId === eventOne.id)
            .map((item) => item.orderNumber)
            .sort();

        expect(filtered.items.map((item) => item.orderNumber).sort()).toEqual(expected);
        expect(filtered.items).toHaveLength(2);
        // Every row still names its own order and its own event — no synthetic event row.
        for (const item of filtered.items) {
            expect(item.orderNumber).toMatch(/^ORD-/);
            expect(item.eventId).toBe(eventOne.id);
        }
    });

    test("the filter survives paging, and the totals stay per-order sums", async () => {
        signInAs(picA.id);

        const first = await getMyPicTicketSales(picA.id, { eventId: eventOne.id, limit: 1 });
        const second = await getMyPicTicketSales(picA.id, {
            eventId: eventOne.id,
            limit: 1,
            page: 2,
        });

        expect(first.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
        expect(second.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });

        const seen = [...first.items, ...second.items];
        expect(seen).toHaveLength(2);
        expect(new Set(seen.map((item) => item.orderId)).size).toBe(2);
        expect(seen.reduce((sum, item) => sum + item.ticketQuantity, 0)).toBe(EXPECTED_TICKETS);

        for (const page of [first, second]) {
            expect(page.totals).toMatchObject({ orders: 2, ticketsSold: EXPECTED_TICKETS });
            expect(Number(page.totals.sales)).toBe(EXPECTED_SALES);
        }
    });

    test("an unknown event id is an empty page, not a regrouped one", async () => {
        signInAs(picA.id);

        const sales = await getMyPicTicketSales(picA.id, { eventId: "picsales-not-an-event" });

        expect(sales.items).toEqual([]);
        expect(sales.totals).toMatchObject({ orders: 0, ticketsSold: 0 });
        expect(Number(sales.totals.sales)).toBe(0);
        expect(sales.pagination).toEqual({
            page: 1,
            limit: PAGE_SIZE,
            total: 0,
            totalPages: 1,
        });
    });
});
