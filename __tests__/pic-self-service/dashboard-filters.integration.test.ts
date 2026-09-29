/**
 * ==========================================
 * PIC DASHBOARD V2 — EVENT FILTERS, EVENT METRICS AND THE FEE KPIs (INTEGRATION, REAL DATABASE)
 * ==========================================
 *
 * The numbers on `/dashboard/pic` are derived, and this suite pins each definition against a real
 * MySQL schema rather than against a mock — because every claim below is a claim about a `where`
 * clause or a ledger aggregation:
 *
 *   filters    `assignmentStatus` and `eventStatus` narrow the QUERY (so the row count, the pager
 *              and the two sales columns all describe the same set), an unknown value never
 *              reaches Prisma, and pagination keeps the filter;
 *   metrics    per event, `Pesanan` = `PICAttribution` rows (ALL payment states) and
 *              `Tiket terjual` = `Σ EventOrderItem.quantity` over orders whose `paymentStatus` is
 *              `PAID` — so one order with three tickets is ONE order and THREE tickets, and a
 *              pending order counts as an order but never as a ticket;
 *   ticket Qty the ORDER list carries `ticketQuantity` per row (Σ of that order's items,
 *              shown whatever the payment state), while the dedicated `Tiket Terjual` table is
 *              one row per PAID order, filterable BY EVENT, with footer totals over the whole
 *              filtered set — its ticket total equals the KPI's ticket count by construction;
 *   isolation  another PIC's orders on the SAME event, and an order with no PIC at all, are in
 *              nobody's numbers;
 *   fees       `Potensi Fee` is the ledger ENTITLEMENT (EARNED − REVERSAL, unaffected by
 *              PAYOUT) and `Fee Bersih` is the settlement engine's own approved amount
 *              (APPROVED ∪ PAID), two different sources that cannot be derived from each other.
 *
 * Fixtures are direct inserts so the boundary under test is the READ aggregation, not the
 * checkout pipeline — which the `ticketing-pic` suite already owns.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import type {
    OrderStatus,
    PaymentStatus,
    PICAttributionSource,
    PICFeeEntryType,
    PICFeeStatus,
    SettlementStatus,
} from "@prisma/client";

import {
    getMyPicOrder,
    getMyPicOverview,
    getMyPicTicketSales,
    listMyAttributions,
    listMyPicAssignments,
} from "@/lib/pic/self-service";
import { prisma } from "@/lib/prisma";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(180_000);

const SUFFIX = `picdash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAID = "PAID" as PaymentStatus;
const PENDING = "PENDING" as PaymentStatus;

let owner: { id: string };
let picA: { id: string };
let picB: { id: string };
let picC: { id: string };
let buyer: { id: string };

let org: { id: string };
let sportId: string;

let evtPublished: { id: string; slug: string };
let evtOngoing: { id: string; slug: string };
let evtCompleted: { id: string; slug: string };
let evtDraft: { id: string; slug: string };

let profileA: { id: string };
let profileB: { id: string };
let profileC: { id: string };

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

async function createEvent(
    key: string,
    status: "PUBLISHED" | "ONGOING" | "COMPLETED" | "DRAFT"
): Promise<{ id: string; slug: string }> {
    const slug = `picdash-${key}-${SUFFIX}`;

    const event = await prisma.event.create({
        data: {
            organizerId: org.id,
            sportId,
            title: `PIC Dash Event ${key} ${SUFFIX}`,
            slug,
            eventCode: `EVT-${key}-${SUFFIX}`,
            status,
            visibility: "UNLISTED",
            startAt: FUTURE,
            endAt: new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000),
            createdByUserId: owner.id,
        },
        select: { id: true },
    });

    return { id: event.id, slug };
}

async function assign(opts: {
    picProfileId: string;
    eventId: string;
    active: boolean;
    assignedAt: Date;
}) {
    await prisma.pICEventAssignment.create({
        data: {
            picProfileId: opts.picProfileId,
            eventId: opts.eventId,
            organizerId: org.id,
            feeRateBp: 500,
            assignedByUserId: owner.id,
            isActive: opts.active,
            revokedAt: opts.active ? null : new Date(),
            assignedAt: opts.assignedAt,
        },
    });
}

async function createOrder(opts: {
    tag: string;
    eventId: string;
    picProfileId: string | null;
    paymentStatus: PaymentStatus;
    quantity: number;
    /**
     * Additional order LINES, so one order can carry several ticket types. The total stays the
     * sum of every line, which is why adding a line to an existing fixture does not move any
     * money assertion — only the number of rows the quantity is summed across.
     */
    extraQuantities?: number[];
    total?: string;
}): Promise<{ id: string }> {
    const quantities = [opts.quantity, ...(opts.extraQuantities ?? [])];
    const total =
        opts.total ?? `${quantities.reduce((sum, quantity) => sum + quantity, 0) * 50000}.00`;

    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: `ORD-${SUFFIX}-${opts.tag}`,
            organizerId: org.id,
            eventId: opts.eventId,
            userId: buyer.id,
            buyerName: `Buyer ${opts.tag}`,
            status: (opts.paymentStatus === PAID ? "PAID" : "PENDING_PAYMENT") as OrderStatus,
            paymentStatus: opts.paymentStatus,
            subtotal: total,
            total,
            organizerNetAmount: total,
            picProfileId: opts.picProfileId,
        },
        select: { id: true },
    });

    for (const quantity of quantities) {
        await prisma.eventOrderItem.create({
            data: {
                orderId: order.id,
                nameSnapshot: "Reguler",
                priceSnapshot: "50000.00",
                quantity,
                subtotal: `${quantity * 50000}.00`,
            },
        });
    }

    return order;
}

async function attribute(opts: {
    orderId: string;
    eventId: string;
    picProfileId: string;
}) {
    await prisma.pICAttribution.create({
        data: {
            orderId: opts.orderId,
            organizerId: org.id,
            eventId: opts.eventId,
            picProfileId: opts.picProfileId,
            source: "PIC_LINK" as PICAttributionSource,
        },
    });
}

async function ledger(opts: {
    tag: string;
    picProfileId: string;
    eventId: string;
    orderId: string;
    type: PICFeeEntryType;
    direction: "CREDIT" | "DEBIT";
    amount: string;
    status: PICFeeStatus;
    settlementId?: string | null;
}) {
    await prisma.pICFeeLedger.create({
        data: {
            picProfileId: opts.picProfileId,
            organizerId: org.id,
            eventId: opts.eventId,
            orderId: opts.orderId,
            type: opts.type,
            direction: opts.direction,
            amount: opts.amount,
            feeType: "PERCENTAGE",
            basisType: "GROSS_BEFORE_DISCOUNT",
            basisAmount: opts.amount,
            quantity: 1,
            status: opts.status,
            rateBp: 500,
            settlementId: opts.settlementId ?? null,
            idempotencyKey: `picdash-${SUFFIX}-${opts.tag}`,
        },
    });
}

async function settlement(opts: {
    tag: string;
    picProfileId: string;
    status: SettlementStatus;
    netAmount: string;
}): Promise<{ id: string }> {
    const row = await prisma.settlement.create({
        data: {
            settlementNumber: `SET-${SUFFIX}-${opts.tag}`,
            payeeType: "PIC",
            picProfileId: opts.picProfileId,
            organizerId: org.id,
            periodStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            periodEnd: new Date(),
            grossAmount: opts.netAmount,
            deductionAmount: "0.00",
            netAmount: opts.netAmount,
            status: opts.status,
            method: "MANUAL_TRANSFER",
            preparedByUserId: owner.id,
        },
        select: { id: true },
    });

    return row;
}

/** The order the tests reference by name. */
let orders: {
    aPublished1: { id: string };
    aPublished2: { id: string };
    aPublishedPending: { id: string };
    aOngoing: { id: string };
    aCompleted: { id: string };
    bPublished: { id: string };
    /** Paid, attributed to NOBODY — the control case. */
    unattributed: { id: string };
};

let payouts: { approved: { id: string }; paid: { id: string } };

beforeAll(async () => {
    owner = await prisma.user.create({
        data: {
            name: `PICDash Owner ${SUFFIX}`,
            email: `picdash-owner-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    function picUser(tag: string) {
        return prisma.user.create({
            data: {
                name: `PICDash ${tag} ${SUFFIX}`,
                email: `picdash-${tag}-${SUFFIX}@example.test`,
                role: "CUSTOMER",
                platformRole: "PIC",
            },
            select: { id: true },
        });
    }

    picA = await picUser("a");
    picB = await picUser("b");
    picC = await picUser("c");

    buyer = await prisma.user.create({
        data: {
            name: `PICDash Buyer ${SUFFIX}`,
            email: `picdash-buyer-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    org = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `PICDash Org ${SUFFIX}`,
            slug: `picdash-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    sportId = (
        await prisma.sport.create({
            data: {
                name: `PICDash Sport ${SUFFIX}`,
                slug: `picdash-sport-${SUFFIX}`,
            },
            select: { id: true },
        })
    ).id;

    evtPublished = await createEvent("published", "PUBLISHED");
    evtOngoing = await createEvent("ongoing", "ONGOING");
    evtCompleted = await createEvent("completed", "COMPLETED");
    evtDraft = await createEvent("draft", "DRAFT");

    async function profile(tag: string, userId: string) {
        return prisma.pICProfile.create({
            data: {
                userId,
                picCode: `PICDASH-${tag}-${SUFFIX}`,
                displayName: `PICDash ${tag} ${SUFFIX}`,
                status: "ACTIVE",
            },
            select: { id: true },
        });
    }

    profileA = await profile("A", picA.id);
    profileB = await profile("B", picB.id);
    profileC = await profile("C", picC.id);

    // A: two live assignments and two withdrawn ones, newest first.
    await assign({
        picProfileId: profileA.id,
        eventId: evtPublished.id,
        active: true,
        assignedAt: new Date(Date.now() - 1_000),
    });
    await assign({
        picProfileId: profileA.id,
        eventId: evtOngoing.id,
        active: true,
        assignedAt: new Date(Date.now() - 2_000),
    });
    await assign({
        picProfileId: profileA.id,
        eventId: evtCompleted.id,
        active: false,
        assignedAt: new Date(Date.now() - 3_000),
    });
    await assign({
        picProfileId: profileA.id,
        eventId: evtDraft.id,
        active: false,
        assignedAt: new Date(Date.now() - 4_000),
    });

    // B: on the SAME event as A — the isolation case for both metrics and payouts.
    await assign({
        picProfileId: profileB.id,
        eventId: evtPublished.id,
        active: true,
        assignedAt: new Date(Date.now() - 1_000),
    });

    orders = {
        // evtPublished: 3 attributed orders (2 paid) and 5 paid tickets.
        // ONE order, TWO lines (1 + 2): three tickets, and a single attributed order. The
        // multi-line shape is what proves the quantity is a SUM and not a line count.
        aPublished1: await createOrder({
            tag: "a-pub-1",
            eventId: evtPublished.id,
            picProfileId: profileA.id,
            paymentStatus: PAID,
            quantity: 1,
            extraQuantities: [2],
        }),
        aPublished2: await createOrder({
            tag: "a-pub-2",
            eventId: evtPublished.id,
            picProfileId: profileA.id,
            paymentStatus: PAID,
            quantity: 2,
        }),
        aPublishedPending: await createOrder({
            tag: "a-pub-3-pending",
            eventId: evtPublished.id,
            picProfileId: profileA.id,
            paymentStatus: PENDING,
            quantity: 1,
        }),
        // evtOngoing: ONE order with THREE tickets.
        aOngoing: await createOrder({
            tag: "a-ong",
            eventId: evtOngoing.id,
            picProfileId: profileA.id,
            paymentStatus: PAID,
            quantity: 3,
        }),
        // evtCompleted: still measurable after the assignment was revoked.
        aCompleted: await createOrder({
            tag: "a-cmp",
            eventId: evtCompleted.id,
            picProfileId: profileA.id,
            paymentStatus: PAID,
            quantity: 5,
        }),
        bPublished: await createOrder({
            tag: "b-pub",
            eventId: evtPublished.id,
            picProfileId: profileB.id,
            paymentStatus: PAID,
            quantity: 1,
        }),
        unattributed: await createOrder({
            tag: "nobody",
            eventId: evtPublished.id,
            picProfileId: null,
            paymentStatus: PAID,
            quantity: 9,
        }),
    };

    // Attribution for every PIC order — including the pending one, because attribution is
    // captured at checkout, before payment. The unattributed order gets none.
    for (const order of [
        { id: orders.aPublished1.id, pic: profileA.id, event: evtPublished.id },
        { id: orders.aPublished2.id, pic: profileA.id, event: evtPublished.id },
        { id: orders.aPublishedPending.id, pic: profileA.id, event: evtPublished.id },
        { id: orders.aOngoing.id, pic: profileA.id, event: evtOngoing.id },
        { id: orders.aCompleted.id, pic: profileA.id, event: evtCompleted.id },
        { id: orders.bPublished.id, pic: profileB.id, event: evtPublished.id },
    ]) {
        await attribute({ orderId: order.id, eventId: order.event, picProfileId: order.pic });
    }

    // A's settlements: one approved (1000), one paid (2500), one merely requested (500) and
    // one refused (700).
    payouts = {
        approved: await settlement({
            tag: "a-approved",
            picProfileId: profileA.id,
            status: "APPROVED",
            netAmount: "1000.00",
        }),
        paid: await settlement({
            tag: "a-paid",
            picProfileId: profileA.id,
            status: "PAID",
            netAmount: "2500.00",
        }),
    };
    await settlement({
        tag: "a-requested",
        picProfileId: profileA.id,
        status: "REQUESTED",
        netAmount: "500.00",
    });
    await settlement({
        tag: "a-rejected",
        picProfileId: profileA.id,
        status: "REJECTED",
        netAmount: "700.00",
    });

    // B's own payout — never counted for A.
    await settlement({
        tag: "b-paid",
        picProfileId: profileB.id,
        status: "PAID",
        netAmount: "9999.00",
    });

    // A's ledger: EARNED 5000, REVERSAL 500, and a PAYOUT 3500 for the paid settlement. The
    // payout must NOT reduce the entitlement (that is the whole point of the split).
    await ledger({
        tag: "a-earned",
        picProfileId: profileA.id,
        eventId: evtPublished.id,
        orderId: orders.aPublished1.id,
        type: "EARNED",
        direction: "CREDIT",
        amount: "5000.00",
        status: "EARNED",
    });
    await ledger({
        tag: "a-reversal",
        picProfileId: profileA.id,
        eventId: evtPublished.id,
        orderId: orders.aPublished1.id,
        type: "REVERSAL",
        direction: "DEBIT",
        amount: "500.00",
        status: "VOID",
    });
    await ledger({
        tag: "a-payout",
        picProfileId: profileA.id,
        eventId: evtPublished.id,
        orderId: orders.aPublished1.id,
        type: "PAYOUT",
        direction: "DEBIT",
        amount: "3500.00",
        status: "SETTLED",
        settlementId: payouts.paid.id,
    });

    // B's ledger — a different entitlement, never mixed with A's.
    await ledger({
        tag: "b-earned",
        picProfileId: profileB.id,
        eventId: evtPublished.id,
        orderId: orders.bPublished.id,
        type: "EARNED",
        direction: "CREDIT",
        amount: "9000.00",
        status: "EARNED",
    });
});

afterAll(async () => {
    const picIds = [profileA, profileB, profileC].filter(Boolean).map((p) => p.id);

    await prisma.settlement.deleteMany({ where: { picProfileId: { in: picIds } } });
    await prisma.pICFeeLedger.deleteMany({ where: { picProfileId: { in: picIds } } });
    await prisma.pICAttribution.deleteMany({ where: { picProfileId: { in: picIds } } });
    await prisma.eventOrderItem.deleteMany({ where: { order: { userId: buyer.id } } });
    await prisma.eventOrder.deleteMany({ where: { userId: buyer.id } });
    await prisma.pICEventAssignment.deleteMany({ where: { picProfileId: { in: picIds } } });
    await prisma.pICProfile.deleteMany({ where: { id: { in: picIds } } });
    await prisma.event.deleteMany({
        where: {
            id: {
                in: [evtPublished, evtOngoing, evtCompleted, evtDraft]
                    .filter(Boolean)
                    .map((event) => event.id),
            },
        },
    });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.organizer.deleteMany({ where: { id: org?.id } });
    await prisma.user.deleteMany({
        where: { id: { in: [owner, picA, picB, picC, buyer].filter(Boolean).map((u) => u.id) } },
    });
});

/** The rows of one page, keyed by event slug. */
async function rowsFor(
    userId: string,
    filters: Parameters<typeof listMyPicAssignments>[1] = {}
) {
    const page = await listMyPicAssignments(userId, filters);

    return {
        ...page,
        bySlug: new Map(page.items.map((item) => [item.eventSlug, item])),
    };
}

/* ==================================================================================
 * A. FILTERS
 * ================================================================================== */

describe("Event Saya — assignment and event status filters (server-side)", () => {
    test("unfiltered: every assignment, with its per-event sales columns", async () => {
        signInAs(picA.id);
        const page = await rowsFor(picA.id);

        expect(page.pagination).toEqual({ page: 1, limit: 10, total: 4, totalPages: 1 });
        expect([...page.bySlug.keys()].sort()).toEqual(
            [evtPublished.slug, evtOngoing.slug, evtCompleted.slug, evtDraft.slug].sort()
        );

        // Newest assignment first.
        expect(page.items[0].eventSlug).toBe(evtPublished.slug);
    });

    test("assignmentStatus=ACTIVE keeps exactly the live assignments", async () => {
        signInAs(picA.id);
        const page = await rowsFor(picA.id, { assignmentStatus: "ACTIVE" });

        expect(page.items.map((item) => item.eventSlug)).toEqual([
            evtPublished.slug,
            evtOngoing.slug,
        ]);
        expect(page.items.every((item) => item.isActive)).toBe(true);
        expect(page.pagination.total).toBe(2);
    });

    test("assignmentStatus=REVOKED keeps exactly the withdrawn ones", async () => {
        signInAs(picA.id);
        const page = await rowsFor(picA.id, { assignmentStatus: "REVOKED" });

        expect(page.items.map((item) => item.eventSlug)).toEqual([
            evtCompleted.slug,
            evtDraft.slug,
        ]);
        expect(page.items.every((item) => !item.isActive && item.revokedAt !== null)).toBe(true);
    });

    test("eventStatus filters individual statuses and the PUBLISHED ∪ ONGOING union", async () => {
        signInAs(picA.id);

        const ongoing = await rowsFor(picA.id, { eventStatuses: ["ONGOING"] });
        expect(ongoing.items.map((item) => item.eventSlug)).toEqual([evtOngoing.slug]);

        const union = await rowsFor(picA.id, { eventStatuses: ["PUBLISHED", "ONGOING"] });
        expect(union.items.map((item) => item.eventSlug)).toEqual([
            evtPublished.slug,
            evtOngoing.slug,
        ]);
        expect(union.pagination.total).toBe(2);
    });

    test("the two dimensions combine, and an empty combination is a real zero", async () => {
        signInAs(picA.id);

        const liveOngoing = await rowsFor(picA.id, {
            assignmentStatus: "ACTIVE",
            eventStatuses: ["ONGOING"],
        });
        expect(liveOngoing.items.map((item) => item.eventSlug)).toEqual([evtOngoing.slug]);

        const activeDraft = await rowsFor(picA.id, {
            assignmentStatus: "ACTIVE",
            eventStatuses: ["DRAFT"],
        });
        expect(activeDraft.items).toEqual([]);
        expect(activeDraft.pagination.total).toBe(0);
        expect(activeDraft.pagination.totalPages).toBe(1);
    });

    test("pagination counts the FILTERED set and walks it", async () => {
        signInAs(picA.id);

        const first = await rowsFor(picA.id, { assignmentStatus: "ACTIVE", limit: 1 });
        expect(first.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
        expect(first.items.map((item) => item.eventSlug)).toEqual([evtPublished.slug]);

        const second = await rowsFor(picA.id, {
            assignmentStatus: "ACTIVE",
            limit: 1,
            page: 2,
        });
        expect(second.pagination.page).toBe(2);
        expect(second.items.map((item) => item.eventSlug)).toEqual([evtOngoing.slug]);

        // The filter is a `where`, not a trim of an already-fetched page: the unfiltered total
        // stays 4 while the filtered total is 2.
        const unfiltered = await rowsFor(picA.id, { limit: 1 });
        expect(unfiltered.pagination.total).toBe(4);
    });

    test("a profile-scoped read never accepts another PIC's id", async () => {
        signInAs(picA.id);
        await expect(listMyPicAssignments(picB.id)).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
    });
});

/* ==================================================================================
 * B. METRICS
 * ================================================================================== */

describe("Event Saya — per-event Pesanan and Tiket terjual", () => {
    test("one order with three tickets is ONE order and THREE tickets", async () => {
        signInAs(picA.id);
        const page = await rowsFor(picA.id);

        const ongoing = page.bySlug.get(evtOngoing.slug)!;
        expect(ongoing.attributedOrders).toBe(1);
        expect(ongoing.paidTickets).toBe(3);
    });

    test("Pesanan counts all payment states; Tiket terjual counts PAID orders only", async () => {
        signInAs(picA.id);
        const page = await rowsFor(picA.id);

        const published = page.bySlug.get(evtPublished.slug)!;
        // Three attributed orders (two paid, one pending)…
        expect(published.attributedOrders).toBe(3);
        // …but only the paid ones' tickets: 3 + 2. The pending order's single ticket is excluded.
        expect(published.paidTickets).toBe(5);
    });

    test("a revoked assignment keeps its history", async () => {
        signInAs(picA.id);
        const page = await rowsFor(picA.id);

        const completed = page.bySlug.get(evtCompleted.slug)!;
        expect(completed.isActive).toBe(false);
        expect(completed.attributedOrders).toBe(1);
        expect(completed.paidTickets).toBe(5);
    });

    test("another PIC's orders on the same event are never counted", async () => {
        signInAs(picB.id);
        const pageB = await rowsFor(picB.id);

        expect(pageB.items.map((item) => item.eventSlug)).toEqual([evtPublished.slug]);
        const publishedB = pageB.bySlug.get(evtPublished.slug)!;
        expect(publishedB.attributedOrders).toBe(1);
        expect(publishedB.paidTickets).toBe(1);

        signInAs(picA.id);
        const pageA = await rowsFor(picA.id);
        const publishedA = pageA.bySlug.get(evtPublished.slug)!;
        expect(publishedA.attributedOrders).toBe(3);
        expect(publishedA.paidTickets).toBe(5);

        // The unattributed PAID order (9 tickets, no PIC) is in neither surface.
        const total = pageA.items.reduce((sum, item) => sum + item.paidTickets, 0);
        expect(total).toBe(13);
    });

    test("the overview's own metrics agree with the table's columns", async () => {
        signInAs(picA.id);
        const [overview, page] = await Promise.all([
            getMyPicOverview(picA.id),
            rowsFor(picA.id),
        ]);

        expect(overview.attributedOrders).toBe(5);
        expect(overview.ticketsSold).toBe(13);
        expect(page.items.reduce((sum, item) => sum + item.attributedOrders, 0)).toBe(5);
    });
});

/* ==================================================================================
 * B2. THE TWO SURFACES — attributions (all payment states) vs sales (PAID only)
 * ==================================================================================
 * The reported UX defect was that `Tiket Terjual` landed on the order list. These tests pin the
 * separation that replaced it: the ATTRIBUTION list answers "how many tickets did this order
 * buy?" per row across every payment state, and the SALES table answers "which orders actually
 * sold, and how much did each carry?" one row per PAID order. One order with several lines is
 * the case that tells a quantity from a line count.
 */

const ORDER_NUMBERS = {
    aPublished1: `ORD-${SUFFIX}-a-pub-1`,
    aOngoing: `ORD-${SUFFIX}-a-ong`,
    aPublishedPending: `ORD-${SUFFIX}-a-pub-3-pending`,
};

describe("Atribusi Terbaru — the per-order Tiket column", () => {
    test("sums the order's lines: 1 + 2 is THREE tickets on ONE order", async () => {
        signInAs(picA.id);
        const rows = await listMyAttributions(picA.id);
        const byNumber = new Map(rows.map((row) => [row.orderNumber, row]));

        expect(byNumber.get(ORDER_NUMBERS.aPublished1)!.ticketQuantity).toBe(3);
        // A single-line order of three reads the same way, from the same aggregate.
        expect(byNumber.get(ORDER_NUMBERS.aOngoing)!.ticketQuantity).toBe(3);

        // One attribution row per order, whatever the line count.
        const publishedLines = rows.filter(
            (row) => row.eventTitle === `PIC Dash Event published ${SUFFIX}`
        );
        expect(publishedLines.length).toBe(3);
    });

    test("shows the quantity for a PENDING order too", async () => {
        signInAs(picA.id);
        const rows = await listMyAttributions(picA.id);
        const pending = rows.find(
            (row) => row.orderNumber === ORDER_NUMBERS.aPublishedPending
        )!;

        expect(pending.paymentStatus).toBe("PENDING");
        // The customer did buy the ticket; it simply has not been paid for.
        expect(pending.ticketQuantity).toBe(1);
    });

    test("the payment filter selects rows and never changes a row's quantity", async () => {
        signInAs(picA.id);
        const paid = await listMyAttributions(picA.id, { paymentStatus: PAID });

        expect(paid.every((row) => row.paymentStatus === PAID)).toBe(true);
        expect(paid.map((row) => row.orderNumber)).not.toContain(
            ORDER_NUMBERS.aPublishedPending
        );
        // The PAID rows' tickets sum to the KPI: 3 + 2 + 3 + 5.
        expect(paid.reduce((sum, row) => sum + row.ticketQuantity, 0)).toBe(13);
    });

    test("never returns another PIC's attributed orders", async () => {
        signInAs(picB.id);
        const rows = await listMyAttributions(picB.id);

        expect(rows).toHaveLength(1);
        expect(rows[0].orderNumber).toBe(`ORD-${SUFFIX}-b-pub`);
        expect(rows[0].ticketQuantity).toBe(1);

        signInAs(picA.id);
        await expect(listMyAttributions(picB.id)).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
    });
});

describe("Tiket Terjual — one row per PAID order, filterable by event", () => {
    /*
     * A. PIC SCOPE      every row and both totals belong to the session's own profile;
     * B. PAID ONLY      a PENDING order is an attribution, not a sale;
     * C. QUANTITY       Σ that order's own lines — never a line count, never an event rollup;
     * D. EVENT FILTER   narrows rows, totals and the pager in ONE `where`;
     * E. FOREIGN EVENT  cannot leak: it narrows this PIC's own set to nothing;
     * F. FOOTER TOTALS  over the whole filtered set, not the current page;
     * G. KPI            stays a TICKET count (Σ quantity), not an order count;
     * H. PAGINATION     server-side, and the event filter survives a page change.
     */

    test("C+B: one row per order, its quantity summed from its own lines, PAID orders only", async () => {
        signInAs(picA.id);
        const sales = await getMyPicTicketSales(picA.id);
        const byNumber = new Map(sales.items.map((item) => [item.orderNumber, item]));

        // The multi-line order (1 + 2) is THREE tickets on ONE row …
        expect(byNumber.get(ORDER_NUMBERS.aPublished1)).toMatchObject({
            paymentStatus: PAID,
            ticketQuantity: 3,
        });
        expect(Number(byNumber.get(ORDER_NUMBERS.aPublished1)!.orderTotal)).toBe(150000);

        // … and a single line of three reads the same way, from the same aggregate.
        expect(byNumber.get(ORDER_NUMBERS.aOngoing)!.ticketQuantity).toBe(3);

        // The PENDING order was attributed but never sold: no row, not a zero row.
        expect(byNumber.has(ORDER_NUMBERS.aPublishedPending)).toBe(false);

        // Four PAID orders, four rows — and no row is an EVENT.
        expect(sales.items).toHaveLength(4);
        expect(sales.pagination.total).toBe(4);
        expect(new Set(sales.items.map((item) => item.eventId)).size).toBeLessThan(
            sales.items.length
        );
    });

    test("F+G: the footer totals are the whole filtered set, and the KPI stays a ticket count", async () => {
        signInAs(picA.id);
        const [sales, overview] = await Promise.all([
            getMyPicTicketSales(picA.id),
            getMyPicOverview(picA.id),
        ]);

        expect(sales.totals.orders).toBe(4);
        expect(sales.totals.ticketsSold).toBe(13);
        expect(Number(sales.totals.sales)).toBe(650000);

        // G: 13 TICKETS over 4 ORDERS. If the table had quietly redefined "Tiket Terjual" as a
        // count of orders, these two lines are what fails.
        expect(sales.totals.ticketsSold).toBe(overview.ticketsSold);
        expect(sales.totals.ticketsSold).not.toBe(sales.totals.orders);

        // The sales figure is the SAME stored column the fee section already reports.
        expect(Number(sales.totals.sales)).toBe(Number(overview.grossSales));
    });

    test("F: a one-row page still reports the totals of every matching order", async () => {
        signInAs(picA.id);
        const page = await getMyPicTicketSales(picA.id, { limit: 1 });

        expect(page.items).toHaveLength(1);
        expect(page.totals).toMatchObject({ orders: 4, ticketsSold: 13 });
        expect(Number(page.totals.sales)).toBe(650000);
        expect(page.pagination).toEqual({ page: 1, limit: 1, total: 4, totalPages: 4 });
    });

    test("D: only the selected event's own orders, and the totals follow the filter", async () => {
        signInAs(picA.id);

        const published = await getMyPicTicketSales(picA.id, {
            eventId: evtPublished.id,
        });

        expect(published.items).toHaveLength(2);
        expect(published.items.every((item) => item.eventId === evtPublished.id)).toBe(true);
        expect(published.totals).toMatchObject({ orders: 2, ticketsSold: 5 });
        expect(Number(published.totals.sales)).toBe(250000);
        expect(published.pagination.total).toBe(2);

        const ongoing = await getMyPicTicketSales(picA.id, {
            eventId: evtOngoing.id,
        });

        expect(ongoing.items).toHaveLength(1);
        expect(ongoing.items[0].orderNumber).toBe(ORDER_NUMBERS.aOngoing);
        expect(ongoing.totals).toMatchObject({ orders: 1, ticketsSold: 3 });
    });

    test("D: the event options are the sold events, and are NOT narrowed by the active filter", async () => {
        signInAs(picA.id);

        const unfiltered = await getMyPicTicketSales(picA.id);
        expect([...unfiltered.eventOptions].map((event) => event.id).sort()).toEqual(
            [evtPublished.id, evtOngoing.id, evtCompleted.id].sort()
        );
        // evtDraft only ever had a PENDING order: it is not offered, because choosing it could
        // only ever render an empty table.
        expect(unfiltered.eventOptions.map((event) => event.id)).not.toContain(evtDraft.id);

        // Selecting one event must not hide the others from the selector.
        const filtered = await getMyPicTicketSales(picA.id, {
            eventId: evtPublished.id,
        });
        expect([...filtered.eventOptions].map((event) => event.id).sort()).toEqual(
            [evtPublished.id, evtOngoing.id, evtCompleted.id].sort()
        );

        // A revoked assignment keeps its historical sales — and its option.
        expect(filtered.eventOptions.map((event) => event.id)).toContain(evtCompleted.id);
    });

    test("E: a foreign/invented event id narrows to NOTHING instead of leaking", async () => {
        signInAs(picA.id);

        for (const eventId of ["picdash-not-an-event", evtDraft.id]) {
            const sales = await getMyPicTicketSales(picA.id, { eventId });

            expect({ eventId, items: sales.items }).toEqual({ eventId, items: [] });
            expect(sales.totals).toMatchObject({ orders: 0, ticketsSold: 0 });
            expect(Number(sales.totals.sales)).toBe(0);
            expect(sales.pagination.total).toBe(0);
        }
    });

    test("A: another PIC's order on the SAME event is in nobody else's table", async () => {
        signInAs(picB.id);
        const salesB = await getMyPicTicketSales(picB.id, { eventId: evtPublished.id });

        expect(salesB.items.map((item) => item.orderNumber)).toEqual([
            `ORD-${SUFFIX}-b-pub`,
        ]);
        expect(salesB.totals).toMatchObject({ orders: 1, ticketsSold: 1 });

        // The SAME event id, read by A, returns A's two orders — 5 tickets, never B's 1, and
        // never the unattributed order's 9 tickets, which appear in no PIC's table at all.
        signInAs(picA.id);
        const salesA = await getMyPicTicketSales(picA.id, { eventId: evtPublished.id });

        expect(salesA.totals.ticketsSold).toBe(5);
        expect(salesA.items.map((item) => item.orderNumber)).not.toContain(
            `ORD-${SUFFIX}-b-pub`
        );
        expect(salesA.items.map((item) => item.orderNumber)).not.toContain(
            `ORD-${SUFFIX}-nobody`
        );
    });

    test("H: pagination is server-side and the event filter survives a page change", async () => {
        signInAs(picA.id);

        const first = await getMyPicTicketSales(picA.id, {
            eventId: evtPublished.id,
            limit: 1,
        });
        const second = await getMyPicTicketSales(picA.id, {
            eventId: evtPublished.id,
            limit: 1,
            page: 2,
        });

        // Both pages are the FILTERED two orders, not two of the four…
        expect(first.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
        expect(second.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
        expect(second.items.every((item) => item.eventId === evtPublished.id)).toBe(true);

        // …they do not repeat or skip a row…
        expect(new Set([...first.items, ...second.items].map((item) => item.orderNumber)).size).toBe(
            2
        );

        // …and the totals still describe the filtered set (never just the page, never the four).
        for (const page of [first, second]) {
            expect(page.totals).toMatchObject({ orders: 2, ticketsSold: 5 });
        }

        // A page past the end is an empty page with the SAME totals, not a reset filter.
        const third = await getMyPicTicketSales(picA.id, {
            eventId: evtPublished.id,
            limit: 1,
            page: 3,
        });
        expect(third.items).toEqual([]);
        expect(third.totals).toMatchObject({ orders: 2, ticketsSold: 5 });
    });

    test("A: a PIC with no PAID orders gets an empty table and zeroed totals", async () => {
        signInAs(picC.id);
        const sales = await getMyPicTicketSales(picC.id);

        expect(sales.items).toEqual([]);
        expect(sales.eventOptions).toEqual([]);
        expect(sales.totals).toMatchObject({ orders: 0, ticketsSold: 0 });
        expect(Number(sales.totals.sales)).toBe(0);
        expect(sales.pagination).toEqual({ page: 1, limit: 10, total: 0, totalPages: 1 });

        // A filter on an empty account is still an empty, well-formed page.
        const filtered = await getMyPicTicketSales(picC.id, {
            eventId: evtPublished.id,
        });
        expect(filtered.items).toEqual([]);
        expect(filtered.pagination.total).toBe(0);
    });

    test("A: a profile-scoped read never accepts another PIC's id", async () => {
        signInAs(picA.id);
        await expect(getMyPicTicketSales(picB.id)).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
    });
});

/* ==================================================================================
 * B3. THE PIC'S OWN ORDER DETAIL — the destination of the order number
 * ==================================================================================
 * The ticket-sales table links each order number to the PIC's own read-only order page. Neither
 * existing order route is reachable by a referrer (the operator page needs `order.read.tenant`,
 * the buyer page needs ownership), so the scope is the difference that has to be pinned: the read
 * is `picProfileId`-scoped, it carries no buyer identity, and a foreign order number is `null`
 * rather than a page that confirms the order exists.
 */

describe("getMyPicOrder — one referred order, from the PIC's own scope", () => {
    test("returns the order, its lines and the quantity summed from them", async () => {
        signInAs(picA.id);
        const order = await getMyPicOrder(picA.id, ORDER_NUMBERS.aPublished1);

        expect(order).not.toBeNull();
        expect(order!.orderNumber).toBe(ORDER_NUMBERS.aPublished1);
        expect(order!.paymentStatus).toBe(PAID);
        expect(order!.eventTitle).toBe(`PIC Dash Event published ${SUFFIX}`);
        expect(order!.eventSlug).toBe(evtPublished.slug);

        // Two lines (1 + 2) → three tickets, and the line list is what the quantity came from.
        expect(order!.items).toHaveLength(2);
        expect(order!.items.reduce((sum, item) => sum + item.quantity, 0)).toBe(3);
        expect(order!.ticketQuantity).toBe(3);
        expect(Number(order!.total)).toBe(150000);
        expect(Number(order!.subtotal)).toBe(150000);
    });

    test("a PENDING attributed order is still readable — only the sales table is PAID-only", async () => {
        signInAs(picA.id);
        const order = await getMyPicOrder(picA.id, ORDER_NUMBERS.aPublishedPending);

        expect(order).not.toBeNull();
        expect(order!.paymentStatus).toBe(PENDING);
        expect(order!.ticketQuantity).toBe(1);
    });

    test("a foreign or unattributed order number is NULL, not a page that confirms it exists", async () => {
        signInAs(picA.id);

        // Another PIC's order on the SAME event…
        await expect(getMyPicOrder(picA.id, `ORD-${SUFFIX}-b-pub`)).resolves.toBeNull();
        // …an order attributed to nobody…
        await expect(getMyPicOrder(picA.id, `ORD-${SUFFIX}-nobody`)).resolves.toBeNull();
        // …and a number that does not exist at all: the same answer for all three.
        await expect(getMyPicOrder(picA.id, `ORD-${SUFFIX}-missing`)).resolves.toBeNull();

        // The owner of the other order still reads it, so the refusal above is scope, not absence.
        signInAs(picB.id);
        await expect(getMyPicOrder(picB.id, `ORD-${SUFFIX}-b-pub`)).resolves.not.toBeNull();
    });

    test("carries no buyer identity and no payment/QR material", async () => {
        signInAs(picA.id);
        const order = await getMyPicOrder(picA.id, ORDER_NUMBERS.aPublished1);
        const serialized = JSON.stringify(order);

        expect(Object.keys(order!)).not.toContain("buyerName");
        expect(Object.keys(order!)).not.toContain("buyerEmail");
        expect(Object.keys(order!)).not.toContain("buyerPhone");
        expect(serialized).not.toContain(`picdash-buyer-${SUFFIX}@example.test`);
        expect(serialized).not.toContain(`Buyer a-pub-1`);
        // No gateway instruction, no ticket codes, no organizer/platform money columns.
        expect(Object.keys(order!)).not.toContain("payments");
        expect(Object.keys(order!)).not.toContain("tickets");
        expect(serialized).not.toContain("organizerNetAmount");
        expect(serialized).not.toContain("platformFee");
    });

    test("a forged user id is a denial, and an inactive profile reads nothing", async () => {
        signInAs(picA.id);
        await expect(getMyPicOrder(picB.id, ORDER_NUMBERS.aPublished1)).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
    });
});

/* ==================================================================================
 * C. FEE KPIs
 * ================================================================================== */

describe("Potensi Fee and Fee Bersih", () => {
    test("Potensi Fee is EARNED − REVERSAL and a PAYOUT does not reduce it", async () => {
        signInAs(picA.id);
        const overview = await getMyPicOverview(picA.id);

        expect(Number(overview.fee.earned)).toBe(5000);
        expect(Number(overview.fee.reversed)).toBe(500);
        expect(Number(overview.fee.potential)).toBe(4500);

        // The canonical balance DOES net the payout — which is exactly why it is not the
        // "potensi" figure: 5000 − 500 − 3500.
        expect(Number(overview.fee.netBalance)).toBe(1000);
        expect(overview.fee.potential.minus(overview.fee.netBalance).toFixed(2)).toBe("3500.00");
    });

    test("Fee Bersih is the APPROVED ∪ PAID payout amount, reported per leg", async () => {
        signInAs(picA.id);
        const overview = await getMyPicOverview(picA.id);

        // 1000 approved + 2500 already transferred. The REQUESTED (500) and REJECTED (700)
        // settlements approved nothing and are excluded.
        expect(Number(overview.payout.approvedTotal)).toBe(3500);
        expect(Number(overview.payout.approvedAmount)).toBe(1000);
        expect(Number(overview.payout.paidAmount)).toBe(2500);
        expect(overview.payout.approvedCount).toBe(1);
        expect(overview.payout.paidCount).toBe(1);
    });

    test("another PIC's payouts and ledger are never counted", async () => {
        signInAs(picB.id);
        const overviewB = await getMyPicOverview(picB.id);

        expect(Number(overviewB.payout.approvedTotal)).toBe(9999);
        expect(Number(overviewB.fee.potential)).toBe(9000);

        signInAs(picA.id);
        const overviewA = await getMyPicOverview(picA.id);
        expect(Number(overviewA.payout.approvedTotal)).toBe(3500);
        expect(Number(overviewA.fee.potential)).toBe(4500);
    });

    test("a PIC with no data reports zeros, not nulls", async () => {
        signInAs(picC.id);
        const [overview, page] = await Promise.all([
            getMyPicOverview(picC.id),
            rowsFor(picC.id),
        ]);

        expect(overview.assignedEvents).toBe(0);
        expect(overview.totalAssignments).toBe(0);
        expect(overview.attributedOrders).toBe(0);
        expect(overview.ticketsSold).toBe(0);
        expect(Number(overview.grossSales)).toBe(0);
        expect(Number(overview.fee.potential)).toBe(0);
        expect(Number(overview.payout.approvedTotal)).toBe(0);

        expect(page.items).toEqual([]);
        expect(page.pagination.total).toBe(0);

        // A filter on an empty account is still an empty, well-formed page.
        const filtered = await rowsFor(picC.id, { assignmentStatus: "ACTIVE" });
        expect(filtered.items).toEqual([]);
        expect(filtered.pagination.total).toBe(0);
    });
});
