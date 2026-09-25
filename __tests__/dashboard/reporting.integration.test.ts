/**
 * ==========================================
 * DASHBOARD REPORTING + EXPORT (INTEGRATION, REAL DATABASE)
 * ==========================================
 *
 * The windowed report read model and the CSV/Excel export, exercised against the real database,
 * through the real `resolveAuthzScope` deciders and the real route handler for the download. Only
 * `@/auth` is mocked, and only so a session can be established without a browser.
 *
 * It pins the properties this surface exists to guarantee:
 *
 *   one definition  revenue is Σ PAID orders' `total`, tickets are `ISSUED`/`CHECKED_IN` rows,
 *                   refunds are refunds that reached `REFUNDED` and are summed from
 *                   `confirmedAmount`, and net = revenue − refunds in DECIMAL (never floating
 *                   point). Each figure is asserted against hand-computed values.
 *   tenancy         a tenant's numbers never include another tenant's; a forged `organizerId` is
 *                   a refusal, not a wider query; an actor with no financial read gets an empty
 *                   report rather than somebody else's revenue.
 *   authority       the download needs BOTH `report.transaction.read` and
 *                   `report.export.transaction`. A platform ADMIN with a membership holds the
 *                   first and NOT the second (`ADMIN_GRANT_REQUIRED`), so it is refused — the
 *                   rule that an ADMIN holds no financial power by default.
 *   same filters    the export's CSV is produced from the SAME parsed filters and the SAME where
 *                   builders as the summary, asserted by cross-checking the exported row count
 *                   against `summary.orders`.
 *   audited         every download writes `report.export.transaction`, and the metadata carries
 *                   counts/filters/sheet names — never an account number or a credential.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { inflateRawSync } from "node:zlib";

import { GET as exportReportGET } from "@/app/api/organizer/reports/export/route";
import { resolveAuthzScope } from "@/lib/authz";
import {
    buildDashboardTrend,
    DASHBOARD_REPORT_EXPORT_ROW_LIMIT,
    DASHBOARD_REPORT_ORDER_STATUS_LABELS,
    DASHBOARD_REPORT_ORDER_STATUSES,
    getDashboardReport,
    resolveDashboardReportFilters,
    toDashboardChartPoints,
} from "@/lib/dashboard/reports";
import { exportDashboardReport, __exportInternals } from "@/lib/dashboard/export";
import { prisma } from "@/lib/prisma";

jest.setTimeout(180_000);

const SUFFIX = `dash-rep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

/** A window that certainly contains `now()`-stamped fixture rows (both ends inclusive). */
const DAY = 24 * 60 * 60 * 1000;
const FROM_KEY = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
const TO_KEY = new Date(Date.now() + 1 * DAY).toISOString().slice(0, 10);

let ownerA: { id: string };
let ownerB: { id: string };
let platformAdmin: { id: string };
let checkinStaff: { id: string };
let buyer: { id: string };

let orgA: { id: string };
let orgB: { id: string };
let sportId: string;
let eventA: { id: string };
let eventB: { id: string };

const createdUsers: string[] = [];
let seq = 0;

/** `Ticket.@@unique([orderItemId, sequenceNo])` — one counter per order item. */
const sequenceByOrderItem = new Map<string, number>();

function nextKey(tag: string): string {
    seq += 1;
    return `${tag}-${seq}`;
}

beforeAll(async () => {
    const user = (tag: string, platformRole?: "ADMIN") =>
        prisma.user.create({
            data: {
                name: `${tag} ${SUFFIX}`,
                email: `${tag}-${SUFFIX}@example.test`,
                role: "CUSTOMER",
                ...(platformRole ? { platformRole } : {}),
            },
            select: { id: true },
        });

    ownerA = await user("owner-a");
    ownerB = await user("owner-b");
    platformAdmin = await user("admin", "ADMIN");
    checkinStaff = await user("checkin");
    buyer = await user("buyer");

    createdUsers.push(
        ownerA.id,
        ownerB.id,
        platformAdmin.id,
        checkinStaff.id,
        buyer.id
    );

    orgA = await prisma.organizer.create({
        data: {
            ownerUserId: ownerA.id,
            name: `Dash Rep A ${SUFFIX}`,
            slug: `dash-rep-a-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    orgB = await prisma.organizer.create({
        data: {
            ownerUserId: ownerB.id,
            name: `Dash Rep B ${SUFFIX}`,
            slug: `dash-rep-b-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.createMany({
        data: [
            { organizerId: orgA.id, userId: ownerA.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: orgB.id, userId: ownerB.id, role: "OWNER", status: "ACTIVE" },
            // A platform ADMIN WITH a tenant membership: it holds the report READ (ADMIN's
            // in-tenant map) but not the export permissions (ADMIN_GRANT_REQUIRED).
            { organizerId: orgA.id, userId: platformAdmin.id, role: "MANAGER", status: "ACTIVE" },
            // Least privilege: no orders, no revenue, no reports.
            { organizerId: orgA.id, userId: checkinStaff.id, role: "CHECKIN_STAFF", status: "ACTIVE" },
        ],
    });

    sportId = (
        await prisma.sport.create({
            data: { name: `Dash Rep Sport ${SUFFIX}`, slug: `dash-rep-sport-${SUFFIX}` },
            select: { id: true },
        })
    ).id;

    const event = (organizerId: string, creatorUserId: string, tag: string) =>
        prisma.event.create({
            data: {
                organizerId,
                sportId,
                title: `Event ${tag} ${SUFFIX}`,
                slug: `dash-rep-${tag}-${SUFFIX}`,
                eventCode: `DR-${tag}-${SUFFIX}`.slice(0, 40),
                status: "PUBLISHED",
                visibility: "UNLISTED",
                startAt: FUTURE,
                endAt: new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000),
                createdByUserId: creatorUserId,
            },
            select: { id: true },
        });

    eventA = await event(orgA.id, ownerA.id, "a");
    eventB = await event(orgB.id, ownerB.id, "b");
});

afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean) as string[];

    if (orgIds.length > 0) {
        // Settlements first: `Settlement.organizerId` and `preparedByUserId` are `Restrict`, so the
        // organizer and the user below cannot be removed while one is still pointing at them.
        await prisma.settlementItem.deleteMany({
            where: { settlement: { organizerId: { in: orgIds } } },
        });
        await prisma.settlement.deleteMany({ where: { organizerId: { in: orgIds } } });
        await prisma.refundItem.deleteMany({ where: { refund: { organizerId: { in: orgIds } } } });
        await prisma.refund.deleteMany({ where: { organizerId: { in: orgIds } } });
        await prisma.ticket.deleteMany({ where: { organizerId: { in: orgIds } } });
        await prisma.payment.deleteMany({ where: { organizerId: { in: orgIds } } });
        await prisma.eventOrderItem.deleteMany({ where: { order: { organizerId: { in: orgIds } } } });
        await prisma.eventOrder.deleteMany({ where: { organizerId: { in: orgIds } } });
        await prisma.ticketType.deleteMany({ where: { event: { organizerId: { in: orgIds } } } });
        await prisma.adminAuditLog.deleteMany({ where: { action: "report.export.transaction" } });
        await prisma.organizerMember.deleteMany({ where: { organizerId: { in: orgIds } } });
        await prisma.event.deleteMany({ where: { organizerId: { in: orgIds } } });
        await prisma.organizer.deleteMany({ where: { id: { in: orgIds } } });
    }

    if (sportId) {
        await prisma.sport.deleteMany({ where: { id: sportId } });
    }

    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
});

/* ------------------------------------------------------------------------------------------------
 * FIXTURES
 * ------------------------------------------------------------------------------------------------
 * Seeded with raw Prisma: this suite tests a READ MODEL, so it must control the rows exactly
 * rather than route them through a service whose own behaviour is tested elsewhere.
 */

type SeededOrder = { orderId: string; orderItemId: string };

async function seedOrder(options: {
    organizerId: string;
    eventId: string;
    userId: string;
    total: string;
    paymentStatus: "PAID" | "PENDING";
    status: "PAID" | "PENDING_PAYMENT" | "CANCELLED" | "EXPIRED" | "REFUNDED";
    buyerName?: string;
}): Promise<SeededOrder> {
    const key = nextKey("ord");
    const total = new Prisma.Decimal(options.total);

    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: `DR-${SUFFIX}-${key}`,
            organizerId: options.organizerId,
            eventId: options.eventId,
            userId: options.userId,
            // Untrusted free text on purpose: a leading `=` is what a spreadsheet would execute,
            // and the comma forces RFC 4180 quoting so both CSV rules are exercised at once.
            buyerName: options.buyerName ?? `=SUM(A1:A2), ${SUFFIX}`,
            buyerEmail: `buyer-${key}-${SUFFIX}@example.test`,
            status: options.status,
            paymentStatus: options.paymentStatus,
            subtotal: total,
            platformFee: new Prisma.Decimal("0"),
            picFeeTotal: new Prisma.Decimal("0"),
            total,
            organizerNetAmount: total,
            paidAt: options.paymentStatus === "PAID" ? new Date() : null,
        },
        select: { id: true },
    });

    const item = await prisma.eventOrderItem.create({
        data: {
            orderId: order.id,
            nameSnapshot: "Fixture Ticket",
            priceSnapshot: total,
            quantity: 1,
            subtotal: total,
        },
        select: { id: true },
    });

    return { orderId: order.id, orderItemId: item.id };
}

async function seedTickets(options: {
    order: SeededOrder;
    organizerId: string;
    eventId: string;
    ticketTypeId: string;
    count: number;
    status: "ISSUED" | "CHECKED_IN" | "VOID";
}): Promise<void> {
    for (let index = 0; index < options.count; index += 1) {
        const key = nextKey("tkt");
        const sequence = (sequenceByOrderItem.get(options.order.orderItemId) ?? 0) + 1;

        sequenceByOrderItem.set(options.order.orderItemId, sequence);

        await prisma.ticket.create({
            data: {
                ticketCode: `DR-${SUFFIX}-${key}`,
                qrTokenHash: `hash-${SUFFIX}-${key}`,
                orderId: options.order.orderId,
                orderItemId: options.order.orderItemId,
                ticketTypeId: options.ticketTypeId,
                sequenceNo: sequence,
                eventId: options.eventId,
                organizerId: options.organizerId,
                status: options.status,
                issuedAt: new Date(),
            },
        });
    }
}

async function seedRefund(options: {
    organizerId: string;
    order: SeededOrder;
    requestedAmount: string;
    confirmedAmount: string;
    status: "REFUNDED" | "PENDING";
    userId: string;
}): Promise<void> {
    const key = nextKey("ref");

    await prisma.refund.create({
        data: {
            refundNumber: `DRR-${SUFFIX}-${key}`,
            organizerId: options.organizerId,
            eventOrderId: options.order.orderId,
            requestedByUserId: options.userId,
            requestedByRole: "CUSTOMER",
            requestedAmount: new Prisma.Decimal(options.requestedAmount),
            confirmedAmount: new Prisma.Decimal(options.confirmedAmount),
            status: options.status,
            reason: "Fixture refund",
        },
    });
}

async function seedScenario(): Promise<void> {
    const ticketType = (eventId: string, tag: string) =>
        prisma.ticketType.create({
            data: {
                eventId,
                name: `Tier ${tag} ${SUFFIX}`,
                price: new Prisma.Decimal("100000.00"),
                quota: 500,
            },
            select: { id: true },
        });

    const ticketTypeA = await ticketType(eventA.id, "a");
    const ticketTypeB = await ticketType(eventB.id, "b");

    // Organizer A: two PAID orders (150000 + 100000 = 250000), one awaiting payment, one whose
    // only tickets were voided (so the order exists but sells nothing).
    const paidA = await seedOrder({
        organizerId: orgA.id,
        eventId: eventA.id,
        userId: buyer.id,
        total: "150000.00",
        paymentStatus: "PAID",
        status: "PAID",
    });

    const pendingA = await seedOrder({
        organizerId: orgA.id,
        eventId: eventA.id,
        userId: buyer.id,
        total: "90000.00",
        paymentStatus: "PENDING",
        status: "PENDING_PAYMENT",
    });

    const voidOnlyA = await seedOrder({
        organizerId: orgA.id,
        eventId: eventA.id,
        userId: buyer.id,
        total: "70000.00",
        paymentStatus: "PAID",
        status: "PAID",
    });

    const paidB = await seedOrder({
        organizerId: orgB.id,
        eventId: eventB.id,
        userId: buyer.id,
        total: "500000.00",
        paymentStatus: "PAID",
        status: "PAID",
        buyerName: "Budi Santoso",
    });

    // Tickets: 2 ISSUED + 1 CHECKED_IN for A (one order), 2 VOID (which must NOT count), 1 for B.
    await seedTickets({
        order: paidA,
        organizerId: orgA.id,
        eventId: eventA.id,
        ticketTypeId: ticketTypeA.id,
        count: 2,
        status: "ISSUED",
    });
    await seedTickets({
        order: paidA,
        organizerId: orgA.id,
        eventId: eventA.id,
        ticketTypeId: ticketTypeA.id,
        count: 1,
        status: "CHECKED_IN",
    });
    await seedTickets({
        order: voidOnlyA,
        organizerId: orgA.id,
        eventId: eventA.id,
        ticketTypeId: ticketTypeA.id,
        count: 2,
        status: "VOID",
    });
    await seedTickets({
        order: paidB,
        organizerId: orgB.id,
        eventId: eventB.id,
        ticketTypeId: ticketTypeB.id,
        count: 1,
        status: "ISSUED",
    });

    // A settled refund of 40000 (counts) and a PENDING one (must NOT count).
    await seedRefund({
        organizerId: orgA.id,
        order: paidA,
        requestedAmount: "40000.00",
        confirmedAmount: "40000.00",
        status: "REFUNDED",
        userId: buyer.id,
    });
    await seedRefund({
        organizerId: orgA.id,
        order: pendingA,
        requestedAmount: "5000.00",
        confirmedAmount: "0.00",
        status: "PENDING",
        userId: buyer.id,
    });

    // One settled payment attempt, for the per-method breakdown.
    await prisma.payment.create({
        data: {
            orderId: paidA.orderId,
            organizerId: orgA.id,
            provider: "ipaymu",
            providerEnvironment: "SANDBOX",
            method: "QRIS",
            amount: new Prisma.Decimal("150000.00"),
            status: "PAID",
            paymentReference: `DR-${SUFFIX}-${nextKey("pay")}`,
        },
    });

}

const filters = (overrides = {}) =>
    resolveDashboardReportFilters({ from: FROM_KEY, to: TO_KEY, ...overrides });

async function scopeFor(userId: string) {
    const scope = await resolveAuthzScope(userId);

    if (!scope) throw new Error(`no scope for ${userId}`);

    return scope;
}

/* ================================================================================================
 * 1. FILTERS (pure)
 * ================================================================================================ */

describe("filter resolution", () => {
    it("treats a date-only range as inclusive Jakarta days", () => {
        const resolved = resolveDashboardReportFilters({
            from: "2026-03-05",
            to: "2026-03-05",
        });

        expect(resolved.fromKey).toBe("2026-03-05");
        expect(resolved.toKey).toBe("2026-03-05");
        expect(resolved.from.toISOString()).toBe("2026-03-04T17:00:00.000Z");
        expect(resolved.to.toISOString()).toBe("2026-03-05T16:59:59.999Z");
        expect(resolved.granularity).toBe("day");
    });

    it("resolves the period shortcuts relative to `to`", () => {
        const resolved = resolveDashboardReportFilters(
            { period: "7d", to: "2026-03-10" },
            { now: new Date("2026-03-10T03:00:00.000Z") }
        );

        expect(resolved.period).toBe("7d");
        expect(resolved.fromKey).toBe("2026-03-04");
        expect(resolved.toKey).toBe("2026-03-10");
    });

    it("refuses an unknown status in strict mode and ignores it in lenient mode", () => {
        const lenient = resolveDashboardReportFilters({ status: "PAOD" });
        expect(lenient.orderStatus).toBeNull();

        expect(() =>
            resolveDashboardReportFilters({ status: "PAOD" }, { strict: true })
        ).toThrow(/Status pesanan tidak dikenal/);
    });

    it("falls back to the default window on an impossible range, and says so", () => {
        const lenient = resolveDashboardReportFilters({
            from: "2026-03-20",
            to: "2026-03-01",
        });

        expect(lenient.rangeFallback).toBe(true);
        expect(lenient.toKey).toBe("2026-03-01");

        expect(() =>
            resolveDashboardReportFilters(
                { from: "2026-03-20", to: "2026-03-01" },
                { strict: true }
            )
        ).toThrow(/tidak valid/);
    });

    it("switches to weekly buckets only for a window longer than 92 days", () => {
        const daily = resolveDashboardReportFilters({
            from: "2026-01-01",
            to: "2026-03-01",
        });
        expect(daily.granularity).toBe("day");

        const weekly = resolveDashboardReportFilters({
            from: "2026-01-01",
            to: "2026-04-30",
        });
        expect(weekly.granularity).toBe("week");
    });

    it("clamps an over-long window in lenient mode and refuses it in strict mode", () => {
        const clamped = resolveDashboardReportFilters({
            from: "2020-01-01",
            to: "2026-01-01",
        });

        expect(clamped.clamped).toBe(true);
        expect(clamped.fromKey).toBe("2025-01-01");

        expect(() =>
            resolveDashboardReportFilters(
                { from: "2020-01-01", to: "2026-01-01" },
                { strict: true }
            )
        ).toThrow(/maksimal/);
    });
});

/* ================================================================================================
 * 2. THE TREND BUCKETS (pure)
 * ================================================================================================ */

describe("trend buckets", () => {
    it("folds the three projections per Jakarta day, keeping empty days at zero", () => {
        const resolved = resolveDashboardReportFilters({
            from: "2026-03-01",
            to: "2026-03-03",
        });

        const trend = buildDashboardTrend(
            resolved,
            [
                {
                    createdAt: new Date("2026-03-01T03:00:00.000Z"),
                    paymentStatus: "PAID",
                    total: new Prisma.Decimal("100000.00"),
                },
                {
                    createdAt: new Date("2026-03-01T05:00:00.000Z"),
                    paymentStatus: "PENDING",
                    total: new Prisma.Decimal("50000.00"),
                },
                {
                    createdAt: new Date("2026-03-03T02:00:00.000Z"),
                    paymentStatus: "PAID",
                    total: new Prisma.Decimal("250000.00"),
                },
            ],
            [{ createdAt: new Date("2026-03-01T04:00:00.000Z") }],
            [
                {
                    createdAt: new Date("2026-03-03T01:00:00.000Z"),
                    confirmedAmount: new Prisma.Decimal("40000.00"),
                },
            ]
        );

        expect(trend).toHaveLength(3);

        expect(trend[0]).toMatchObject({
            key: "2026-03-01",
            orders: 2,
            paidOrders: 1,
            ticketsSold: 1,
            revenue: "100000.00",
            refundAmount: "0.00",
            netRevenue: "100000.00",
        });

        // A day with no rows is a real zero, not a missing sample.
        expect(trend[1]).toMatchObject({
            key: "2026-03-02",
            orders: 0,
            revenue: "0.00",
            refundAmount: "0.00",
            netRevenue: "0.00",
        });

        expect(trend[2]).toMatchObject({
            key: "2026-03-03",
            orders: 1,
            paidOrders: 1,
            revenue: "250000.00",
            refundAmount: "40000.00",
            netRevenue: "210000.00",
        });
    });

    it("groups a long window into 7-day buckets anchored at the window start", () => {
        const resolved = resolveDashboardReportFilters({
            from: "2026-01-01",
            to: "2026-04-30",
        });

        const trend = buildDashboardTrend(resolved, [], [], []);

        expect(resolved.granularity).toBe("week");
        expect(trend[0].key).toBe("2026-01-01");
        expect(trend[0].label).toContain("–");
        expect(trend[1].key).toBe("2026-01-08");
    });

    it("converts money to numbers in exactly one place, for the charts", () => {
        const points = toDashboardChartPoints([
            {
                key: "2026-03-01",
                label: "1 Mar",
                orders: 2,
                paidOrders: 1,
                ticketsSold: 3,
                revenue: "150000.00",
                refundAmount: "50000.00",
                netRevenue: "100000.00",
            },
        ]);

        expect(points).toEqual([
            {
                label: "1 Mar",
                orders: 2,
                paidOrders: 1,
                ticketsSold: 3,
                revenue: 150000,
                refundAmount: 50000,
                netRevenue: 100000,
            },
        ]);
    });

    it("labels every status the schema has", () => {
        for (const status of DASHBOARD_REPORT_ORDER_STATUSES) {
            expect(DASHBOARD_REPORT_ORDER_STATUS_LABELS[status]).toBeTruthy();
        }
    });
});

/* ================================================================================================
 * 3. THE REPORT AGAINST REAL ROWS
 * ================================================================================================ */

describe("getDashboardReport", () => {
    beforeAll(async () => {
        await seedScenario();
    });

    it("computes every figure from the authoritative rows, in decimal", async () => {
        const report = await getDashboardReport(await scopeFor(ownerA.id), filters());

        // created = 3 (2 PAID + 1 PENDING_PAYMENT); paid = 2 (150000 + 70000)
        expect(report.summary.orders).toBe(3);
        expect(report.summary.paidOrders).toBe(2);
        expect(report.summary.revenue).toBe("220000.00");
        // Only ISSUED/CHECKED_IN count: the two VOID tickets do not.
        expect(report.summary.ticketsSold).toBe(3);
        // Only the REFUNDED refund counts, and only its confirmedAmount.
        expect(report.summary.refunds).toBe(1);
        expect(report.summary.refundAmount).toBe("40000.00");
        expect(report.summary.netRevenue).toBe("180000.00");
        expect(report.summary.averageOrderValue).toBe("110000.00");

        // The distribution is NOT narrowed by a status filter (there is none here) and every
        // enum member is reported, so a zero is visible rather than absent.
        expect(report.orderStatus).toEqual([
            { status: "PENDING_PAYMENT", count: 1 },
            { status: "PAID", count: 2 },
            { status: "CANCELLED", count: 0 },
            { status: "EXPIRED", count: 0 },
            { status: "REFUNDED", count: 0 },
            { status: "PARTIALLY_REFUNDED", count: 0 },
        ]);

        // Per-event: tickets are counted within the window and attributed to the event.
        const event = report.byEvent.find((row) => row.eventId === eventA.id);
        expect(event).toMatchObject({
            paidOrders: 2,
            ticketsSold: 3,
            revenue: "220000.00",
            refundAmount: "40000.00",
            netRevenue: "180000.00",
        });

        // Payments settled inside the window, by method.
        expect(report.byMethod).toContainEqual({
            method: "QRIS",
            payments: 1,
            amount: "150000.00",
        });

        // The event dropdown is scoped to the actor's own organizer.
        expect(report.eventOptions.map((option) => option.id)).toEqual([eventA.id]);
    });

    it("narrows the money and the row set by the order-status filter", async () => {
        const report = await getDashboardReport(
            await scopeFor(ownerA.id),
            filters({ status: "PAID" })
        );

        expect(report.summary.orders).toBe(2);
        expect(report.summary.paidOrders).toBe(2);
        expect(report.summary.revenue).toBe("220000.00");

        const pending = await getDashboardReport(
            await scopeFor(ownerA.id),
            filters({ status: "PENDING_PAYMENT" })
        );

        // A not-yet-paid order is not money: revenue collapses to zero.
        expect(pending.summary.orders).toBe(1);
        expect(pending.summary.paidOrders).toBe(0);
        expect(pending.summary.revenue).toBe("0.00");
        // And the refund of a LUNAS order is NOT subtracted from a set that selected no money:
        // the refund's own order must satisfy the order filter too. Without that rule this figure
        // would read "-40000.00" — a negative net revenue for a filter that matched nothing sold.
        expect(pending.summary.refunds).toBe(0);
        expect(pending.summary.refundAmount).toBe("0.00");
        expect(pending.summary.netRevenue).toBe("0.00");

        // The distribution still describes the whole window, not the filtered slice.
        expect(pending.orderStatus.find((row) => row.status === "PAID")?.count).toBe(2);
    });

    it("filters by event", async () => {
        const report = await getDashboardReport(
            await scopeFor(ownerA.id),
            filters({ eventId: eventB.id })
        );

        // The event belongs to ANOTHER tenant, so nothing in this tenant matches it — the filter
        // is applied INSIDE the actor's scope rather than widening it.
        expect(report.summary.orders).toBe(0);
        expect(report.summary.revenue).toBe("0.00");
    });

    it("never includes another tenant's rows", async () => {
        const reportB = await getDashboardReport(await scopeFor(ownerB.id), filters());

        expect(reportB.summary.paidOrders).toBe(1);
        expect(reportB.summary.revenue).toBe("500000.00");
        expect(reportB.summary.ticketsSold).toBe(1);
        expect(reportB.summary.refunds).toBe(0);
        expect(reportB.byEvent.map((row) => row.eventId)).toEqual([eventB.id]);
    });

    it("refuses a forged organizerId rather than widening the query", async () => {
        await expect(
            getDashboardReport(
                await scopeFor(ownerB.id),
                filters({ organizerId: orgA.id })
            )
        ).rejects.toMatchObject({ code: "ORGANIZER_ACCESS_DENIED" });
    });

    it("answers an empty report for an actor with no financial read", async () => {
        const report = await getDashboardReport(await scopeFor(checkinStaff.id), filters());

        expect(report.summary.revenue).toBe("0.00");
        expect(report.summary.paidOrders).toBe(0);
        expect(report.byEvent).toEqual([]);
        expect(report.byMethod).toEqual([]);
        expect(report.eventOptions).toEqual([]);
        // The window is still reported, so "no permission" is distinguishable from "nothing".
        expect(report.range.fromKey).toBe(FROM_KEY);
    });
});

/* ================================================================================================
 * 4. THE EXPORT
 * ================================================================================================ */

function exportRequest(query: string): NextRequest {
    return new NextRequest(
        new URL(`https://tinggalklik.test/api/organizer/reports/export?${query}`),
        { method: "GET" }
    );
}

/** Read one entry out of a deflated ZIP produced by `buildXlsx`. */
function readZipEntry(archive: Uint8Array, name: string): string | null {
    const buffer = Buffer.from(archive);
    const target = Buffer.from(name);

    for (let offset = 0; offset + 30 <= buffer.length; offset += 1) {
        if (buffer.readUInt32LE(offset) !== 0x04034b50) continue;

        const compressedSize = buffer.readUInt32LE(offset + 18);
        const nameLength = buffer.readUInt16LE(offset + 26);
        const extraLength = buffer.readUInt16LE(offset + 28);
        const entryName = buffer.subarray(offset + 30, offset + 30 + nameLength);

        if (entryName.equals(target)) {
            const start = offset + 30 + nameLength + extraLength;
            const data = buffer.subarray(start, start + compressedSize);

            return inflateRawSync(data).toString("utf8");
        }

        offset += 30 + nameLength + extraLength + compressedSize - 1;
    }

    return null;
}

describe("export authorization", () => {
    it("refuses an actor without the export permission (ADMIN holds read, not export)", async () => {
        const scope = await scopeFor(platformAdmin.id);

        await expect(
            exportDashboardReport(scope, filters(), "csv")
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses an actor with no financial read at all", async () => {
        await expect(
            exportDashboardReport(await scopeFor(checkinStaff.id), filters(), "xlsx")
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("answers 403 on the route rather than an empty file", async () => {
        const { auth } = require("@/auth") as { auth: jest.Mock };
        auth.mockResolvedValue({
            user: { id: platformAdmin.id, email: `admin-${SUFFIX}@example.test`, name: "Fixture" },
            expires: new Date(Date.now() + 60_000).toISOString(),
        });

        const response = await exportReportGET(
            exportRequest(`format=csv&from=${FROM_KEY}&to=${TO_KEY}`)
        );

        expect(response.status).toBe(403);

        const body = await response.json();
        expect(body).toMatchObject({ success: false, code: "FORBIDDEN" });
    });

    it("answers a validation error for an unknown format, before any query runs", async () => {
        const { auth } = require("@/auth") as { auth: jest.Mock };
        auth.mockResolvedValue({
            user: { id: ownerA.id, email: `owner-a-${SUFFIX}@example.test`, name: "Fixture" },
            expires: new Date(Date.now() + 60_000).toISOString(),
        });

        const response = await exportReportGET(
            exportRequest(`format=pdf&from=${FROM_KEY}&to=${TO_KEY}`)
        );

        expect(response.status).toBe(400);
        expect((await response.json()).code).toBe("VALIDATION_ERROR");
    });

    it("refuses a cross-tenant organizerId through the route", async () => {
        const { auth } = require("@/auth") as { auth: jest.Mock };
        auth.mockResolvedValue({
            user: { id: ownerB.id, email: `owner-b-${SUFFIX}@example.test`, name: "Fixture" },
            expires: new Date(Date.now() + 60_000).toISOString(),
        });

        const response = await exportReportGET(
            exportRequest(
                `format=csv&from=${FROM_KEY}&to=${TO_KEY}&organizerId=${orgA.id}`
            )
        );

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect((await response.json()).code).toBe("ORGANIZER_ACCESS_DENIED");
    });
});

describe("export content", () => {
    beforeAll(async () => {
        const { auth } = require("@/auth") as { auth: jest.Mock };
        auth.mockResolvedValue({
            user: { id: ownerA.id, email: `owner-a-${SUFFIX}@example.test`, name: "Fixture" },
            expires: new Date(Date.now() + 60_000).toISOString(),
        });
    });

    it("downloads a BOM-prefixed CSV whose rows are exactly the report's order set", async () => {
        const scope = await scopeFor(ownerA.id);

        const report = await getDashboardReport(scope, filters());
        const csvExport = await exportDashboardReport(scope, filters(), "csv");

        expect(csvExport.fileName).toBe(
            `laporan-transaksi-${FROM_KEY}_${TO_KEY}.csv`
        );
        expect(csvExport.contentType).toBe("text/csv; charset=utf-8");

        const csv = csvExport.body as string;

        expect(csv.startsWith("\uFEFF")).toBe(true);
        // Header order is the export contract.
        expect(csv).toContain(
            "orderNumber,createdAt,paidAt,event,penyelenggara,pembeli,emailPembeli,status,statusPembayaran,subtotal,diskon,total,mataUang"
        );
        // RFC 4180: one header + one line per order, and the count matches the summary.
        const lines = csv.trimEnd().split("\r\n");
        expect(lines).toHaveLength(report.summary.orders + 1);

        // Formula injection is neutralised on untrusted text (the leading `'`), and the comma in
        // the value is quoted per RFC 4180.
        expect(csv).toContain(`"'=SUM(A1:A2), ${SUFFIX}"`);
        // Money keeps its exact decimal representation rather than a rounded number, and the
        // row set is the whole filtered window (the unpaid order is in it too).
        expect(csv).toContain("150000.00");
        expect(csv).toContain("90000.00");
    });

    it("downloads a multi-sheet workbook whose sheets mirror the report", async () => {
        const scope = await scopeFor(ownerA.id);
        const workbook = await exportDashboardReport(scope, filters(), "xlsx");

        expect(workbook.fileName).toBe(`laporan-transaksi-${FROM_KEY}_${TO_KEY}.xlsx`);
        expect(workbook.contentType).toBe(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        // An OWNER holds `settlement.prepare` as well, so the payout sheet is present. (The
        // export permission does NOT imply it: the sheet is added only when the actor may settle
        // in the organizer the export is scoped to, so a role holding the export alone — e.g. via
        // a grant on a membership without settlement — would get a workbook without this tab.)
        expect(workbook.sheets).toEqual([
            "Ringkasan",
            "Pesanan",
            "Penjualan Tiket",
            "Refund",
            "Pencairan",
        ]);

        const bytes = workbook.body as Uint8Array;

        // A real ZIP: the local file header magic, and a parseable central directory.
        expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

        const workbookXml = readZipEntry(bytes, "xl/workbook.xml");
        expect(workbookXml).not.toBeNull();

        for (const sheet of workbook.sheets) {
            expect(workbookXml).toContain(`name="${sheet}"`);
        }

        const ordersXml = readZipEntry(bytes, "xl/worksheets/sheet2.xml");
        expect(ordersXml).toContain("inlineStr");
        // Money is numeric with a number format, so a column can be summed in Excel.
        expect(ordersXml).toContain('s="2"');
    });

    it("records the download in the audit log, with counts and no sensitive value", async () => {
        const scope = await scopeFor(ownerA.id);

        await exportDashboardReport(scope, filters(), "xlsx");

        const audit = await prisma.adminAuditLog.findFirst({
            where: { action: "report.export.transaction", actorUserId: ownerA.id },
            orderBy: { createdAt: "desc" },
        });

        expect(audit).not.toBeNull();
        expect(audit?.entityType).toBe("Report");
        expect(audit?.afterState).toMatchObject({ format: "xlsx" });
        expect(String(audit?.description)).toContain("xlsx");
        expect(JSON.stringify(audit?.afterState)).not.toMatch(/bankAccountNumber|buyerEmail/);
    });
});

/* ================================================================================================
 * 5. THE PAYOUT SHEET'S WINDOW AND ITS CAP
 * ================================================================================================
 *
 * The Pencairan sheet is the one sheet whose window cannot be pushed into the query: a settlement
 * is a PAYOUT with a COVERAGE PERIOD, not a row that happens on a day, and `listSettlements` has
 * no date predicate. These tests pin the two properties that fix depends on:
 *
 *   the window      a row is in only when its own `periodStart … periodEnd` INTERSECTS the report
 *                   window, so a payout that ends exactly on the window's first instant (or starts
 *                   exactly on its last) is present, and one wholly outside it is absent. The
 *                   fixture makes `createdAt` CONTRADICT the period on purpose — the bulk rows were
 *                   created a month before a window they belong to, and the excluded rows were
 *                   created inside a window they do not belong to — so a filter that used a
 *                   creation date instead of the period fails BOTH directions of this test.
 *   the cap         exactly `DASHBOARD_REPORT_EXPORT_ROW_LIMIT` rows in the window means
 *                   `truncated: false`; one more means `DASHBOARD_REPORT_EXPORT_ROW_LIMIT` rows
 *                   with `truncated: true`, stated on the Ringkasan sheet, so a cut file can never
 *                   be read as a complete one.
 *
 * Authority is untouched by the scan and that is asserted here too: `listSettlements` re-decides
 * `settlement.prepare` inside every page, so another tenant's rows are unreachable however many
 * pages the scan walks.
 */

/** How many bulk payouts land INSIDE the window. Edges below add 4, to reach the cap exactly. */
const BULK_IN_WINDOW = 19_996;
/** The payout sheet's cap, spelled out so the arithmetic above is checkable at a glance. */
const CAP = DASHBOARD_REPORT_EXPORT_ROW_LIMIT;
const BULK_BASE = new Date(Date.now() - 3 * DAY);
const SETTLEMENT_PREFIX = `DRS-${SUFFIX}`;

/**
 * Seed settlements with raw Prisma.
 *
 * `createdAt` is always given explicitly and is always DISTINCT: `listSettlements` pages on
 * `createdAt desc`, and a tie would make which rows land in which page unspecified. Within this
 * fixture the stamp deliberately contradicts the period (see the section comment).
 */
async function seedSettlements(options: {
    organizerId: string;
    preparedByUserId: string;
    prefix: string;
    periods: readonly { start: Date; end: Date }[];
    /** The stamp on the first row; each next row is one millisecond later. */
    createdAtBase: Date;
}): Promise<string[]> {
    const rows = options.periods.map((period, index) => ({
        settlementNumber: `${options.prefix}-${index}`,
        payeeType: "ORGANIZER" as const,
        organizerId: options.organizerId,
        periodStart: period.start,
        periodEnd: period.end,
        grossAmount: new Prisma.Decimal("100000.00"),
        deductionAmount: new Prisma.Decimal("1000.00"),
        netAmount: new Prisma.Decimal("99000.00"),
        method: "MANUAL_TRANSFER" as const,
        status: "PAID" as const,
        bankName: "Bank Fixture",
        bankAccountName: "PIC Fixture",
        // The STORED number: the export must only ever see the masked payload form.
        bankAccountNumber: "1234567890123456",
        preparedByUserId: options.preparedByUserId,
        createdAt: new Date(options.createdAtBase.getTime() + index),
        paidAt: new Date(options.createdAtBase.getTime() + index),
        updatedAt: new Date(options.createdAtBase.getTime() + index),
    }));

    // Chunked: one statement for every row at once would exceed the database's bound-parameter
    // limit long before it reached the cap this suite is about.
    for (let offset = 0; offset < rows.length; offset += 1_000) {
        await prisma.settlement.createMany({ data: rows.slice(offset, offset + 1_000) });
    }

    return rows.map((row) => row.settlementNumber);
}

describe("the payout sheet's window and cap", () => {
    let bulkNumbers: string[] = [];
    /** Inside the window because its period straddles or touches a boundary. */
    let edgeNumbers: string[] = [];
    /** Wholly outside the window, but CREATED inside it — must not be exported. */
    let outsideNumbers: string[] = [];
    let otherTenantNumbers: string[] = [];

    beforeAll(async () => {
        const window = filters();

        expect(CAP).toBe(20_000);

        bulkNumbers = await seedSettlements({
            organizerId: orgA.id,
            preparedByUserId: ownerA.id,
            prefix: `${SETTLEMENT_PREFIX}-bulk`,
            periods: Array.from({ length: BULK_IN_WINDOW }, (_, index) => ({
                // Sub-second steps keep 19 996 distinct periods inside one afternoon, which keeps
                // the whole block inside the window — the uniqueness constraint needs a distinct
                // `(periodStart, periodEnd)` per row, not a distinct day.
                start: new Date(BULK_BASE.getTime() + index),
                end: new Date(BULK_BASE.getTime() + index + 60 * 60 * 1000),
            })),
            // A month before the window they belong to.
            createdAtBase: new Date(Date.now() - 30 * DAY),
        });

        edgeNumbers = await seedSettlements({
            organizerId: orgA.id,
            preparedByUserId: ownerA.id,
            prefix: `${SETTLEMENT_PREFIX}-edge`,
            periods: [
                // Starts before the window, ends inside it.
                { start: new Date(Date.now() - 30 * DAY), end: new Date(Date.now() - 1 * DAY) },
                // Starts inside it, ends long after.
                { start: new Date(Date.now()), end: new Date(Date.now() + 40 * DAY) },
                // Ends exactly on the window's first instant.
                {
                    start: new Date(Date.now() - 20 * DAY),
                    end: new Date(window.from.getTime()),
                },
                // Starts exactly on the window's last instant.
                {
                    start: new Date(window.to.getTime()),
                    end: new Date(window.to.getTime() + 60 * 60 * 1000),
                },
            ],
            createdAtBase: new Date(Date.now()),
        });

        outsideNumbers = await seedSettlements({
            organizerId: orgA.id,
            preparedByUserId: ownerA.id,
            prefix: `${SETTLEMENT_PREFIX}-out`,
            periods: [
                { start: new Date(Date.now() - 60 * DAY), end: new Date(Date.now() - 59 * DAY) },
                { start: new Date(Date.now() + 60 * DAY), end: new Date(Date.now() + 61 * DAY) },
            ],
            // The newest rows in the table, so a creation-date filter would export exactly these.
            createdAtBase: new Date(Date.now() + 1_000),
        });

        // The other tenant: one in-window payout that must never appear in A's sheet.
        otherTenantNumbers = await seedSettlements({
            organizerId: orgB.id,
            preparedByUserId: ownerB.id,
            prefix: `${SETTLEMENT_PREFIX}-b`,
            periods: [
                { start: new Date(Date.now() - 3 * DAY), end: new Date(Date.now() - 2 * DAY) },
            ],
            createdAtBase: new Date(Date.now()),
        });
    });

    it("keeps a payout only when its own period intersects the window", async () => {
        const { rows, truncated } = await __exportInternals.loadDashboardReportSettlementRows(
            await scopeFor(ownerA.id),
            filters()
        );

        // 19 996 bulk + 4 straddling rows, and the cap is NOT reached by one row.
        expect(rows).toHaveLength(CAP);
        expect(truncated).toBe(false);

        const exported = new Set(rows.map((row) => row.settlementNumber));

        // Every in-window row is here, including the two that only TOUCH a boundary day.
        for (const number of [...bulkNumbers, ...edgeNumbers]) {
            expect(exported.has(number)).toBe(true);
        }

        // The two rows whose period lies wholly outside the window are not — even though their
        // `createdAt` is inside it, and even though they were created after every other row (so a
        // creation-date filter would have returned ONLY them).
        for (const number of outsideNumbers) {
            expect(exported.has(number)).toBe(false);
        }

        // And the masked account number is the payload's, never the stored column.
        expect(rows[0].bankAccountNumber).toBe("••••3456");
    });

    it("never reaches another tenant's payouts, however many pages it scans", async () => {
        const other = await __exportInternals.loadDashboardReportSettlementRows(
            await scopeFor(ownerB.id),
            filters()
        );

        // B has one in-window payout, while A has far more than the cap: the scan is bounded by the
        // CALLER's scope, not by the size of the table.
        expect(other.rows.map((row) => row.settlementNumber)).toEqual(otherTenantNumbers);
        expect(other.truncated).toBe(false);
    });

    it("cuts at the cap, reports it on the Ringkasan sheet and audits it", async () => {
        const scope = await scopeFor(ownerA.id);

        // One more in-window payout than the sheet can carry.
        const extra = await seedSettlements({
            organizerId: orgA.id,
            preparedByUserId: ownerA.id,
            prefix: `${SETTLEMENT_PREFIX}-over`,
            periods: [
                { start: new Date(Date.now() - 2 * DAY), end: new Date(Date.now() - 1 * DAY) },
            ],
            createdAtBase: new Date(Date.now() + 2_000),
        });

        try {
            const { rows, truncated } = await __exportInternals.loadDashboardReportSettlementRows(
                scope,
                filters()
            );

            expect(rows).toHaveLength(CAP);
            expect(truncated).toBe(true);

            // `createdAt desc`: the newest rows are kept, so the extra row is in and the OLDEST
            // bulk row is the one that fell off the end.
            expect(rows.map((row) => row.settlementNumber)).toContain(extra[0]);
            expect(rows.map((row) => row.settlementNumber)).not.toContain(bulkNumbers[0]);

            const workbook = await exportDashboardReport(scope, filters(), "xlsx");
            const bytes = workbook.body as Uint8Array;

            expect(workbook.sheets).toEqual([
                "Ringkasan",
                "Pesanan",
                "Penjualan Tiket",
                "Refund",
                "Pencairan",
            ]);

            const summaryXml = readZipEntry(bytes, "xl/worksheets/sheet1.xml");
            expect(summaryXml).not.toBeNull();
            // The workbook SAYS it was cut, and states the payout sheet's selection rule.
            expect(summaryXml).toContain(
                `Sebagian sheet dipotong pada ${CAP} baris`
            );
            expect(summaryXml).toContain("bersinggungan");

            const payoutXml = readZipEntry(bytes, "xl/worksheets/sheet5.xml");
            expect(payoutXml).not.toBeNull();
            // A header row plus exactly the cap — not 20 001 rows of data.
            expect(((payoutXml as string).match(/<row /g) ?? []).length).toBe(CAP + 1);
            // The sheet is the window, not the tenant's history …
            expect(payoutXml).not.toContain(outsideNumbers[0]);
            expect(payoutXml).not.toContain(otherTenantNumbers[0]);
            // … and its account numbers are the masked form only.
            expect(payoutXml).toContain("••••3456");
            expect(payoutXml).not.toContain("1234567890123456");

            const audit = await prisma.adminAuditLog.findFirst({
                where: { action: "report.export.transaction", actorUserId: ownerA.id },
                orderBy: { createdAt: "desc" },
            });

            expect(audit?.afterState).toMatchObject({ format: "xlsx", truncated: true });
        } finally {
            await prisma.settlement.deleteMany({
                where: { settlementNumber: { in: extra } },
            });
        }
    });

    it("leaves the CSV format untouched by any of it", async () => {
        const scope = await scopeFor(ownerA.id);

        const report = await getDashboardReport(scope, filters());
        const csv = await exportDashboardReport(scope, filters(), "csv");

        // The CSV is the transaction dataset and nothing else: no payout sheet exists in it, so
        // thousands of settlements must not add a row.
        expect(csv.sheets).toEqual(["Pesanan"]);
        expect((csv.body as string).trimEnd().split("\r\n")).toHaveLength(
            report.summary.orders + 1
        );
        expect(csv.body as string).not.toContain(SETTLEMENT_PREFIX);
    });
});
