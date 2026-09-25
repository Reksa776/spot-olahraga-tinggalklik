/**
 * ==========================================
 * PIC SELF-SERVICE — REPORTING METRICS (INTEGRATION, REAL DATABASE)
 * ==========================================
 *
 * TESTS 13–17: the numbers behind the StatGrid and the Fee Summary are DERIVED, not
 * counted from a mutable counter, and each definition is pinned here:
 *
 *   13. assignedEvents   = ACTIVE assignments only (revoked discounted), total kept separate
 *   14. attributedOrders = every PICAttribution row regardless of the order's payment state
 *   15. ticketsSold / grossSales = PAID orders ONLY (a pending/failed/refunded order never
 *                          inflates a "sold" number — the dashboard revenue contract)
 *   16. fee earned/reversed/net = POSTED ledger aggregated by direction, net = CREDIT − DEBIT
 *                          in Decimal; the ledger list carries the reversal as a VOID DEBIT
 *   17. no `/api/pic` route exists: the surface is server-rendered reads only (a static,
 *                          architectural assertion — there is no public financial endpoint)
 *
 * Fixtures are direct inserts (organizer, sport, event, order, item, attribution, ledger)
 * so the boundary under test is the READ aggregation, not the checkout pipeline — which the
 * `ticketing-pic` suite already owns.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import fs from "node:fs";
import path from "node:path";

import type {
    OrderStatus,
    PaymentStatus,
    PICAttributionSource,
    PICFeeEntryType,
    PICFeeStatus,
} from "@prisma/client";

import { PIC_REFERRAL_SECRET_ENV } from "@/lib/pic/referral";
import {
    getMyFeeSummary,
    getMyPicOverview,
    listMyFeeLedger,
} from "@/lib/pic/self-service";
import { prisma } from "@/lib/prisma";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(180_000);

const SUFFIX = `picss-rep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let owner: { id: string };
let picUser: { id: string };
let buyer: { id: string };

let org: { id: string };
let sportId: string;
let evt1: { id: string };
let evt2: { id: string };
let evt3: { id: string };

let profile: { id: string };

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

function makeOrderNumber(): string {
    return `ORD-${SUFFIX}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createEvent(key: string): Promise<{ id: string }> {
    return prisma.event.create({
        data: {
            organizerId: org.id,
            sportId,
            title: `PICSS Rep Event ${key} ${SUFFIX}`,
            slug: `picss-rep-evt-${key}-${SUFFIX}`,
            eventCode: `EVT-${key}-${SUFFIX}`,
            status: "PUBLISHED",
            visibility: "UNLISTED",
            startAt: FUTURE,
            endAt: new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000),
            createdByUserId: owner.id,
        },
        select: { id: true },
    });
}

beforeAll(async () => {
    process.env[PIC_REFERRAL_SECRET_ENV] = `picss-rep-secret-${SUFFIX}`;

    owner = await prisma.user.create({
        data: {
            name: `PICSS Rep Owner ${SUFFIX}`,
            email: `picss-rep-owner-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    picUser = await prisma.user.create({
        data: {
            name: `PICSS Rep PIC ${SUFFIX}`,
            email: `picss-rep-pic-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            platformRole: "PIC",
        },
        select: { id: true },
    });

    buyer = await prisma.user.create({
        data: {
            name: `PICSS Rep Buyer ${SUFFIX}`,
            email: `picss-rep-buyer-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    org = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `PICSS Rep Org ${SUFFIX}`,
            slug: `picss-rep-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    sportId = (
        await prisma.sport.create({
            data: {
                name: `PICSS Rep Sport ${SUFFIX}`,
                slug: `picss-rep-sport-${SUFFIX}`,
            },
            select: { id: true },
        })
    ).id;

    evt1 = await createEvent("1");
    evt2 = await createEvent("2");
    evt3 = await createEvent("3");

    profile = await prisma.pICProfile.create({
        data: {
            userId: picUser.id,
            picCode: `PICSS-REP-${SUFFIX}`,
            displayName: `PICSS Rep ${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    // Assignments: evt1 + evt2 ACTIVE, evt3 REVOKED → assignedEvents must be 2 (total 3).
    for (const eventId of [evt1.id, evt2.id, evt3.id]) {
        await prisma.pICEventAssignment.create({
            data: {
                picProfileId: profile.id,
                eventId,
                organizerId: org.id,
                feeRateBp: 500,
                assignedByUserId: owner.id,
                isActive: eventId !== evt3.id,
                revokedAt: eventId === evt3.id ? new Date() : null,
            },
        });
    }

    // Orders. o1/o2 PAID (count for sales & tickets), o3 PENDING_PAYMENT (never counts for
    // sales), o4 PAID under the REVOKED assignment (an order carries its picProfileId at
    // checkout, so sales still attribute; attribution was captured pre-assignment-revoke).
    const paid = "PAID" as PaymentStatus;
    const pending = "PENDING" as PaymentStatus;

    const o1 = await prisma.eventOrder.create({
        data: {
            orderNumber: makeOrderNumber(),
            organizerId: org.id,
            eventId: evt1.id,
            userId: buyer.id,
            buyerName: "Buyer One",
            status: "PAID" as OrderStatus,
            paymentStatus: paid,
            subtotal: "150000.00",
            total: "150000.00",
            organizerNetAmount: "140000.00",
            picProfileId: profile.id,
        },
        select: { id: true },
    });

    const o2 = await prisma.eventOrder.create({
        data: {
            orderNumber: makeOrderNumber(),
            organizerId: org.id,
            eventId: evt2.id,
            userId: buyer.id,
            buyerName: "Buyer Two",
            status: "PAID" as OrderStatus,
            paymentStatus: paid,
            subtotal: "75000.00",
            total: "75000.00",
            organizerNetAmount: "70000.00",
            picProfileId: profile.id,
        },
        select: { id: true },
    });

    const o3 = await prisma.eventOrder.create({
        data: {
            orderNumber: makeOrderNumber(),
            organizerId: org.id,
            eventId: evt1.id,
            userId: buyer.id,
            buyerName: "Buyer Three",
            status: "PENDING_PAYMENT" as OrderStatus,
            paymentStatus: pending,
            subtotal: "50000.00",
            total: "50000.00",
            organizerNetAmount: "45000.00",
            picProfileId: profile.id,
        },
        select: { id: true },
    });

    const o4 = await prisma.eventOrder.create({
        data: {
            orderNumber: makeOrderNumber(),
            organizerId: org.id,
            eventId: evt3.id,
            userId: buyer.id,
            buyerName: "Buyer Four",
            status: "PAID" as OrderStatus,
            paymentStatus: paid,
            subtotal: "30000.00",
            total: "30000.00",
            organizerNetAmount: "28000.00",
            picProfileId: profile.id,
        },
        select: { id: true },
    });

    // Items: o1 → 2 tickets, o2 → 1 ticket, o3 → 1 ticket (excluded by payment), o4 → 1.
    async function item(orderId: string, price: string, quantity: number) {
        await prisma.eventOrderItem.create({
            data: {
                orderId,
                nameSnapshot: "Reguler",
                priceSnapshot: price,
                quantity,
                subtotal: String(Number(price) * quantity),
            },
        });
    }

    await item(o1.id, "150000.00", 2);
    await item(o2.id, "75000.00", 1);
    await item(o3.id, "50000.00", 1);
    await item(o4.id, "30000.00", 1);

    // Attributions for ALL FOUR orders (all statuses → attributedOrders must be 4).
    for (const order of [
        { id: o1.id, eventId: evt1.id },
        { id: o2.id, eventId: evt2.id },
        { id: o3.id, eventId: evt1.id },
        { id: o4.id, eventId: evt3.id },
    ]) {
        await prisma.pICAttribution.create({
            data: {
                orderId: order.id,
                organizerId: org.id,
                eventId: order.eventId,
                picProfileId: profile.id,
                source: "PIC_LINK" as PICAttributionSource,
            },
        });
    }

    // Ledger: o1 EARNED 5000, o1 REVERSAL −500 (VOID), o2 EARNED 2500.
    async function ledger(
        orderId: string,
        eventId: string,
        type: PICFeeEntryType,
        direction: "CREDIT" | "DEBIT",
        amount: string,
        status: PICFeeStatus,
        tag: string
    ) {
        await prisma.pICFeeLedger.create({
            data: {
                picProfileId: profile.id,
                organizerId: org.id,
                eventId,
                orderId,
                type,
                direction,
                amount,
                feeType: "PERCENTAGE",
                basisType: "GROSS_BEFORE_DISCOUNT",
                basisAmount: amount,
                quantity: 1,
                status,
                rateBp: 500,
                idempotencyKey: `picss-rep-${SUFFIX}-${tag}`,
            },
        });
    }

    await ledger(o1.id, evt1.id, "EARNED", "CREDIT", "5000.00", "EARNED", "earned-1");
    await ledger(o1.id, evt1.id, "REVERSAL", "DEBIT", "500.00", "VOID", "reversal-1");
    await ledger(o2.id, evt2.id, "EARNED", "CREDIT", "2500.00", "EARNED", "earned-2");
});

afterAll(async () => {
    await prisma.pICFeeLedger.deleteMany({ where: { picProfileId: profile.id } });
    await prisma.pICAttribution.deleteMany({ where: { picProfileId: profile.id } });
    await prisma.eventOrderItem.deleteMany({
        where: { order: { userId: buyer.id } },
    });
    await prisma.eventOrder.deleteMany({ where: { userId: buyer.id } });
    await prisma.pICEventAssignment.deleteMany({
        where: { picProfileId: profile.id },
    });
    await prisma.pICProfile.deleteMany({ where: { id: profile.id } });
    await prisma.event.deleteMany({
        where: { id: { in: [evt1?.id, evt2?.id, evt3?.id].filter(Boolean) as string[] } },
    });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.organizer.deleteMany({ where: { id: org?.id } });
    await prisma.user.deleteMany({
        where: { id: { in: [owner, picUser, buyer].filter(Boolean).map((u) => u.id) } },
    });
});

/* ==================================================================================
 * TEST 13 — assignedEvents counts ACTIVE assignments only
 * ================================================================================== */

describe("TEST 13 — assignedEvents is the ACTIVE-assignment count", () => {
    test("two active, one revoked: assignedEvents = 2, total = 3", async () => {
        signInAs(picUser.id);
        const overview = await getMyPicOverview(picUser.id);

        expect(overview.assignedEvents).toBe(2);
        expect(overview.totalAssignments).toBe(3);
    });
});

/* ==================================================================================
 * TEST 14 — attributedOrders counts every attribution, all payment states
 * ================================================================================== */

describe("TEST 14 — attributedOrders is the full attribution row count", () => {
    test("four attributed orders (three paid, one pending) all count", async () => {
        signInAs(picUser.id);
        const overview = await getMyPicOverview(picUser.id);

        expect(overview.attributedOrders).toBe(4);
    });
});

/* ==================================================================================
 * TEST 15 — tickets sold and gross sales are PAID-only
 * ================================================================================== */

describe("TEST 15 — ticketsSold and grossSales never count unpaid orders", () => {
    test("2 + 1 + 1 tickets, 150k + 75k + 30k = 255k; the pending 50k order counts nowhere", async () => {
        signInAs(picUser.id);
        const overview = await getMyPicOverview(picUser.id);

        expect(overview.ticketsSold).toBe(4);
        expect(Number(overview.grossSales)).toBe(255000);
        expect(overview.grossSales.toFixed(2)).toBe("255000.00");
    });
});

/* ==================================================================================
 * TEST 16 — fee figures come from the POSTED ledger; net = CREDIT − DEBIT
 * ================================================================================== */

describe("TEST 16 — fee summary is ledger-derived", () => {
    test("earned 7500, reversed 500, net 7000", async () => {
        signInAs(picUser.id);
        const [overview, summary] = await Promise.all([
            getMyPicOverview(picUser.id),
            getMyFeeSummary(picUser.id),
        ]);

        expect(Number(overview.feeEarned)).toBe(7500);
        expect(Number(overview.feeReversed)).toBe(500);
        expect(Number(overview.netFee)).toBe(7000);

        expect(Number(summary.earned)).toBe(7500);
        expect(Number(summary.reversed)).toBe(500);
        expect(Number(summary.net)).toBe(7000);

        // Decimal arithmetic, not float: net is exactly 7000.00.
        expect(summary.net.toFixed(2)).toBe("7000.00");
    });

    test("the ledger list carries the reversal as a VOID DEBIT and stays EARNED/VOID-only", async () => {
        signInAs(picUser.id);
        const entries = await listMyFeeLedger(picUser.id);

        expect(entries).toHaveLength(3);

        const reversal = entries.find((entry) => entry.type === "REVERSAL");
        expect(reversal).toBeDefined();
        expect(reversal!.direction).toBe("DEBIT");
        expect(reversal!.status).toBe("VOID");
        expect(Number(reversal!.amount)).toBe(500);

        // In the current engine only EARNED and VOID rows exist — that IS the observable
        // vocabulary, and the page renders exactly these statuses. Never "Paid out".
        const statuses = new Set(entries.map((entry) => entry.status));
        expect(statuses).toEqual(new Set(["EARNED", "VOID"]));

        const credits = entries.filter((entry) => entry.direction === "CREDIT");
        const debits = entries.filter((entry) => entry.direction === "DEBIT");
        expect(credits).toHaveLength(2);
        expect(debits).toHaveLength(1);
    });
});

/* ==================================================================================
 * TEST 17 — no public PIC financial endpoint exists
 * ================================================================================== */

describe("TEST 17 — the PIC self-service surface is server-rendered reads only", () => {
    test("there is no app/api/pic route (and no other PIC endpoint under app/api)", () => {
        const apiRoot = path.resolve(__dirname, "../../app/api");

        function collect(dir: string, acc: string[]): string[] {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    collect(full, acc);
                } else if (entry.name.endsWith(".ts")) {
                    acc.push(path.relative(apiRoot, full));
                }
            }

            return acc;
        }

        const routes = collect(apiRoot, []);

        // Only the FIRST path segment counts: `admin/pic/…` and `organizer/pic/…` are the
        // legitimate PIC-management endpoints this feature REUSES (never duplicated). The
        // forbidden shape is a NEW top-level section — `/api/pic`, `/api/referral`,
        // `/api/attribution`, `/api/fee` — which would be a second, unguarded write surface
        // for the same business data.
        const selfServiceRoots = ["pic", "referral", "attribution", "fee"];

        const picRoutes = routes.filter((route) => {
            const firstSegment = route.split("/")[0].toLowerCase();
            return selfServiceRoots.some((root) =>
                firstSegment.includes(root)
            );
        });

        expect(picRoutes).toEqual([]);
    });
});