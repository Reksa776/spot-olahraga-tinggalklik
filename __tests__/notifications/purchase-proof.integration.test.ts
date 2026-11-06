/**
 * ==========================================
 * PHASE 2 — ENQUEUE, SWEEP AND SETTLEMENT HOOK (REAL DATABASE)
 * ==========================================
 *
 * These run on the isolated Jest schema. No transport is instantiated and nothing is sent: the
 * assertions are about the QUEUE ROWS a settlement produces, the idempotency keys they carry,
 * and the recovery sweep that can recreate a missed enqueue.
 *
 * Fixtures are written directly with Prisma (they are data shapes, not business decisions) and
 * every row is namespaced by `PREFIX` and removed afterwards. Legacy notification rows are never
 * touched.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { prisma } from "@/lib/prisma";
import { enqueuePurchaseProof } from "@/lib/notifications/purchase-proof";
import {
    purchaseProofIdempotencyKey,
    sweepMissingPurchaseProofs,
} from "@/lib/notifications/purchase-proof";
import { PURCHASE_PROOF_TEMPLATE_KEY } from "@/lib/notifications/purchase-proof-template";
import { settleVerifiedPayment } from "@/lib/ticketing/payment/settlement";

jest.setTimeout(180_000);

const PREFIX = `p2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const START = new Date("2026-12-01T00:00:00.000Z");
const END = new Date("2026-12-01T04:00:00.000Z");

let sequence = 0;

function nextRef(tag: string): string {
    sequence += 1;
    return `${PREFIX}-${tag}-${sequence}`;
}

type Fixture = {
    buyer: { id: string };
    owner: { id: string };
    sportId: string;
    organizer: { id: string };
    event: { id: string };
    venue: { id: string };
};

let fixture: Fixture;
const orderIds: string[] = [];

async function setupFixture(): Promise<Fixture> {
    const buyer = await prisma.user.create({
        data: {
            name: `P2 Buyer ${PREFIX}`,
            email: `p2-buyer-${PREFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    const owner = await prisma.user.create({
        data: {
            name: `P2 Owner ${PREFIX}`,
            email: `p2-owner-${PREFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    const sport = await prisma.sport.create({
        data: { name: `P2 Sport ${PREFIX}`, slug: `p2-sport-${PREFIX}` },
        select: { id: true },
    });

    const organizer = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `P2 Organizer ${PREFIX}`,
            slug: `p2-org-${PREFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    const venue = await prisma.venue.create({
        data: {
            organizerId: organizer.id,
            name: "GBK",
            address: "Jl. Pintu Satu Senayan",
            city: "Jakarta",
        },
        select: { id: true },
    });

    const event = await prisma.event.create({
        data: {
            organizerId: organizer.id,
            sportId: sport.id,
            venueId: venue.id,
            title: `P2 Event ${PREFIX}`,
            slug: `p2-event-${PREFIX}`,
            eventCode: `P2-${PREFIX}`,
            startAt: START,
            endAt: END,
            visibility: "UNLISTED",
            createdByUserId: owner.id,
            contactName: "Panitia",
            contactPhone: "081200000000",
        },
        select: { id: true },
    });

    return {
        buyer,
        owner,
        sportId: sport.id,
        organizer,
        event,
        venue,
    };
}

type OrderOverrides = {
    status?: "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "EXPIRED";
    paymentStatus?: "UNPAID" | "PENDING" | "PAID";
    paidAt?: Date | null;
    buyerEmail?: string | null;
    buyerPhone?: string | null;
    withReservation?: boolean;
    paymentMethod?: "VIRTUAL_ACCOUNT" | "QRIS";
};

async function createOrder(tag: string, overrides: OrderOverrides = {}) {
    const orderNumber = `P2-${PREFIX}-${tag}`.toUpperCase();
    const paidAt =
        overrides.paidAt === undefined
            ? new Date("2026-11-01T10:00:00.000Z")
            : overrides.paidAt;
    const status = overrides.status ?? "PAID";
    const paymentStatus = overrides.paymentStatus ?? "PAID";

    const ticketType = await prisma.ticketType.create({
        data: {
            eventId: fixture.event.id,
            name: `Reguler ${tag}`,
            price: "150000.00",
            quota: 100,
            sold: status === "PAID" ? 2 : 0,
            reserved: overrides.withReservation ? 2 : 0,
            isActive: true,
        },
        select: { id: true },
    });

    const order = await prisma.eventOrder.create({
        data: {
            orderNumber,
            organizerId: fixture.organizer.id,
            eventId: fixture.event.id,
            userId: fixture.buyer.id,
            buyerName: "Budi Santoso",
            buyerEmail:
                overrides.buyerEmail === undefined
                    ? `p2-proof-${PREFIX}@example.test`
                    : overrides.buyerEmail,
            buyerPhone:
                overrides.buyerPhone === undefined
                    ? "081234567890"
                    : overrides.buyerPhone,
            status,
            paymentStatus,
            subtotal: "300000.00",
            total: "300000.00",
            organizerNetAmount: "300000.00",
            paidAt,
            items: {
                create: [
                    {
                        ticketTypeId: ticketType.id,
                        nameSnapshot: "VIP",
                        priceSnapshot: "150000.00",
                        quantity: 2,
                        subtotal: "300000.00",
                    },
                ],
            },
        },
        select: { id: true, orderNumber: true },
    });

    orderIds.push(order.id);

    if (overrides.withReservation) {
        await prisma.ticketReservation.create({
            data: {
                orderId: order.id,
                ticketTypeId: ticketType.id,
                eventId: fixture.event.id,
                quantity: 2,
                status: "HELD",
                expiresAt: new Date(Date.now() + 30 * 60_000),
            },
        });
    }

    if (paymentStatus === "PAID") {
        await prisma.payment.create({
            data: {
                orderId: order.id,
                organizerId: fixture.organizer.id,
                providerEnvironment: "SANDBOX",
                method: overrides.paymentMethod ?? "VIRTUAL_ACCOUNT",
                channel: "bca",
                amount: "300000.00",
                paymentReference: nextRef("pay"),
                status: "PAID",
            },
        });
    }

    return { ...order, ticketTypeId: ticketType.id };
}

async function proofRows(orderId: string) {
    return prisma.notification.findMany({
        where: {
            eventOrderId: orderId,
            templateKey: PURCHASE_PROOF_TEMPLATE_KEY,
        },
        orderBy: { channel: "asc" },
        select: {
            id: true,
            channel: true,
            recipient: true,
            category: true,
            idempotencyKey: true,
            deliveries: { select: { channel: true, status: true } },
        },
    });
}

beforeAll(async () => {
    fixture = await setupFixture();
});

beforeEach(async () => {
    await prisma.notification.deleteMany({
        where: { idempotencyKey: { startsWith: PREFIX } },
    });
});

afterAll(async () => {
    await prisma.notification.deleteMany({
        where: {
            OR: [
                { idempotencyKey: { startsWith: PREFIX } },
                { eventOrderId: { in: orderIds } },
            ],
        },
    });
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.paymentTransaction.deleteMany({
        where: { orderId: { in: orderIds } },
    });
    await prisma.ticketReservation.deleteMany({
        where: { orderId: { in: orderIds } },
    });
    await prisma.ticket.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.eventOrderItem.deleteMany({
        where: { orderId: { in: orderIds } },
    });
    await prisma.eventOrder.deleteMany({ where: { id: { in: orderIds } } });

    if (fixture) {
        await prisma.adminAuditLog.deleteMany({
            where: { entityRef: { startsWith: `P2-${PREFIX}` } },
        });
        await prisma.ticketType.deleteMany({
            where: { eventId: fixture.event.id },
        });
        await prisma.event.deleteMany({ where: { id: fixture.event.id } });
        await prisma.venue.deleteMany({ where: { id: fixture.venue.id } });
        await prisma.organizer.deleteMany({ where: { id: fixture.organizer.id } });
        await prisma.sport.deleteMany({ where: { id: fixture.sportId } });
        await prisma.user.deleteMany({
            where: { id: { in: [fixture.buyer.id, fixture.owner.id] } },
        });
    }
});

describe("a SETTLED order enqueues one proof per channel", () => {
    test("the two rows use the owner's exact, independent idempotency keys", async () => {
        const order = await createOrder("keys");
        const outcome = await enqueuePurchaseProof(order.id);

        expect(outcome).toMatchObject({
            orderNumber: order.orderNumber,
            eligible: true,
            email: "created",
            whatsapp: "created",
        });

        const rows = await proofRows(order.id);

        expect(rows.map((row) => row.channel).sort()).toEqual([
            "email",
            "whatsapp",
        ]);
        expect(rows.map((row) => row.idempotencyKey).sort()).toEqual(
            [
                purchaseProofIdempotencyKey(order.orderNumber, "email"),
                purchaseProofIdempotencyKey(order.orderNumber, "whatsapp"),
            ].sort()
        );
        expect(rows.every((row) => row.category === "ORDER")).toBe(true);
        expect(
            rows.find((row) => row.channel === "whatsapp")?.recipient
        ).toBe("6281234567890");
        expect(rows.every((row) => row.deliveries.length === 1)).toBe(true);
        expect(
            rows.every((row) => row.deliveries[0].status === "QUEUED")
        ).toBe(true);
    });

    test("a replay reuses the rows instead of duplicating them", async () => {
        const order = await createOrder("replay");

        await enqueuePurchaseProof(order.id);
        const second = await enqueuePurchaseProof(order.id);

        expect(second).toMatchObject({
            eligible: true,
            email: "existing",
            whatsapp: "existing",
        });
        expect(await proofRows(order.id)).toHaveLength(2);
    });

    test("only SETTLED statuses enqueue: a late settlement is refused", async () => {
        const late = await createOrder("late", {
            status: "CANCELLED",
            paymentStatus: "PAID",
            paidAt: new Date("2026-11-02T10:00:00.000Z"),
        });

        const outcome = await enqueuePurchaseProof(late.id);

        expect(outcome).toMatchObject({
            eligible: false,
            reason: "NOT_SETTLED",
            email: "skipped",
            whatsapp: "skipped",
        });
        expect(await proofRows(late.id)).toHaveLength(0);
    });

    test("a pending order enqueues nothing", async () => {
        const pending = await createOrder("pending", {
            status: "PENDING_PAYMENT",
            paymentStatus: "PENDING",
            paidAt: null,
        });

        expect((await enqueuePurchaseProof(pending.id)).eligible).toBe(false);
        expect(await proofRows(pending.id)).toHaveLength(0);
    });

    test("channels are independent when a contact is missing", async () => {
        const order = await createOrder("one-channel", { buyerEmail: null });
        const outcome = await enqueuePurchaseProof(order.id);

        expect(outcome).toMatchObject({
            email: "skipped",
            whatsapp: "created",
        });

        const rows = await proofRows(order.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].channel).toBe("whatsapp");
    });
});

describe("the settlement hook is the single integration point", () => {
    test("SETTLED enqueues; ALREADY_PAID does not duplicate; LATE_SETTLEMENT does nothing", async () => {
        const order = await createOrder("settle", {
            status: "PENDING_PAYMENT",
            paymentStatus: "PENDING",
            paidAt: null,
            withReservation: true,
        });

        const settled = await settleVerifiedPayment({
            orderId: order.id,
            paymentId: null,
            provider: "ipaymu",
            providerTransactionId: null,
            providerSessionId: null,
            amountReported: "300000.00",
            providerFeeReported: null,
            statusCode: "00",
            channel: "bca",
            eventType: "PAID",
        });

        expect(settled.outcome).toBe("SETTLED");
        expect(await proofRows(order.id)).toHaveLength(2);

        const replay = await settleVerifiedPayment({
            orderId: order.id,
            paymentId: null,
            provider: "ipaymu",
            providerTransactionId: null,
            providerSessionId: null,
            amountReported: "300000.00",
            providerFeeReported: null,
            statusCode: "00",
            channel: "bca",
            eventType: "PAID",
        });

        expect(replay.outcome).toBe("ALREADY_PAID");
        expect(await proofRows(order.id)).toHaveLength(2);

        const late = await createOrder("settle-late", {
            status: "CANCELLED",
            paymentStatus: "UNPAID",
            paidAt: null,
        });

        const lateOutcome = await settleVerifiedPayment({
            orderId: late.id,
            paymentId: null,
            provider: "ipaymu",
            providerTransactionId: null,
            providerSessionId: null,
            amountReported: "300000.00",
            providerFeeReported: null,
            statusCode: "00",
            channel: "bca",
            eventType: "PAID",
        });

        expect(lateOutcome.outcome).toBe("LATE_SETTLEMENT");
        expect(await proofRows(late.id)).toHaveLength(0);
    });
});

describe("the recovery sweep only enqueues and is repeatable", () => {
    test("finds a paid order with no proof, creates it once, and never sends", async () => {
        const order = await createOrder("sweep", {
            paidAt: new Date("2000-01-01T00:00:00.000Z"),
        });

        const first = await sweepMissingPurchaseProofs({
            limit: 20,
            minAgeMs: 0,
            orderIds: [order.id],
        });

        expect(first).toMatchObject({ scanned: 1, eligible: 1 });
        expect(await proofRows(order.id)).toHaveLength(2);

        const second = await sweepMissingPurchaseProofs({
            limit: 20,
            minAgeMs: 0,
            orderIds: [order.id],
        });

        // The sweep has nothing left to do for this order: it did not recreate or duplicate it.
        expect(second).toMatchObject({ scanned: 0, emailCreated: 0, whatsappCreated: 0 });
        expect(await proofRows(order.id)).toHaveLength(2);
        expect(
            await prisma.notificationDelivery.count({
                where: {
                    notification: { eventOrderId: order.id },
                    status: "SENT",
                },
            })
        ).toBe(0);
    });

    test("never reads, rewrites or deletes an uncategorised legacy row", async () => {
        const legacyKey = `${PREFIX}-legacy`;
        const legacy = await prisma.notification.create({
            data: {
                idempotencyKey: legacyKey,
                channel: "whatsapp",
                recipient: "081200000000",
                // category/templateKey omitted, matching the 44 legacy rows.
            },
            select: { id: true, category: true, recipient: true },
        });

        await createOrder("sweep-legacy", {
            paidAt: new Date("2000-01-02T00:00:00.000Z"),
        });

        const order = await prisma.eventOrder.findFirstOrThrow({
            where: { orderNumber: `P2-${PREFIX}-SWEEP-LEGACY` },
            select: { id: true },
        });
        await sweepMissingPurchaseProofs({
            limit: 20,
            minAgeMs: 0,
            orderIds: [order.id],
        });

        const after = await prisma.notification.findUniqueOrThrow({
            where: { id: legacy.id },
            select: { category: true, recipient: true, templateKey: true },
        });

        expect(after).toEqual({
            category: null,
            recipient: "081200000000",
            templateKey: null,
        });
    });

    test("the batch size is bounded", async () => {
        for (let index = 0; index < 3; index += 1) {
            await createOrder(`bound-${index}`, {
                paidAt: new Date(`2001-01-0${index + 1}T00:00:00.000Z`),
            });
        }

        const ids = (
            await prisma.eventOrder.findMany({
                where: { orderNumber: { startsWith: `P2-${PREFIX}-BOUND` } },
                select: { id: true },
            })
        ).map((row) => row.id);

        const result = await sweepMissingPurchaseProofs({
            limit: 2,
            minAgeMs: 0,
            orderIds: ids,
        });

        expect(result.scanned).toBeLessThanOrEqual(2);
    });
});
