/**
 * ==========================================
 * THE ACTIVE-ATTEMPT INVARIANT (BUG-01 / BUG-02)
 * ==========================================
 *
 * Real MySQL/InnoDB, the real services, the real guards, and only the socket stubbed — the
 * same contract as the other payment suites. What this suite pins is the invariant the
 * concurrency fix exists to provide:
 *
 *   FOR EVERY `EventOrder`, THERE IS AT MOST ONE ACTIVE PAYMENT ATTEMPT.
 *
 * "Active" is a STATUS question — `UNPAID` or `PENDING` — never "has an instrument landed
 * yet". A committed claim row with no URL/QR/number is IN FLIGHT: it must be reported as
 * `PAYMENT_CREATION_IN_PROGRESS`, never dismissed as "no attempt exists" (which is the hole
 * the concurrency fix closes).
 *
 * The two database-side halves are exercised independently:
 *
 *   * the transactional claim (serialized on the `eventorder` row) — `payment-races`
 *     group H covers the concurrent case; the tests here cover the sequential states it
 *     must distinguish;
 *   * the durable unique index on `Payment.activeOrderId` — A6/A7 hit it directly, so the
 *     invariant is proven even for a caller that bypasses the claim.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { ERROR_CODES } from "@/lib/api/errors";
import { requireOrganizerAccess } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createTicketType } from "@/lib/ticket-types/service";
import { createOrderPayment } from "@/lib/ticketing/payment/service";
import { voidOpenPayments } from "@/lib/ticketing/payment/void";

import {
    createOrder,
    customerScope,
    expectRejection,
    gatewayStub,
    installGatewayStub,
    nextRequest,
    setupFixtures,
    signInAs,
    teardownFixtures,
    type Fixtures,
} from "./payment-harness";

jest.setTimeout(120_000);

let f: Fixtures;
let fetchSpy: jest.SpyInstance;

/** Create or resume the provider session for the buyer's OWN order. */
async function pay(buyerId: string, orderNumber: string) {
    const actor = await customerScope(buyerId);

    return createOrderPayment({
        orderNumber,
        actor,
        request: {} as never,
        httpRequest: nextRequest(),
    });
}

/** A dedicated ticket type per test, so counter assertions are unambiguous. */
async function newType(name: string, quota = 30): Promise<string> {
    signInAs(f.ownerA.id);
    const scope = await requireOrganizerAccess(f.orgA.id, "event.read");

    const created = await createTicketType(scope, f.eventA.id, {
        name,
        price: "150000.00",
        quota,
    } as never);

    return created.id;
}

beforeAll(async () => {
    fetchSpy = installGatewayStub();
    f = await setupFixtures();
});

afterAll(async () => {
    fetchSpy.mockRestore();
    await teardownFixtures(f);
});

beforeEach(() => {
    gatewayStub.reset();
    signInAs(null);
});

describe("the active-attempt invariant (BUG-01 / BUG-02)", () => {
    it("A1. a committed bare claim is IN_PROGRESS, and no provider call is made", async () => {
        const type = await newType("AA1");
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: type, quantity: 1 }],
            tag: "aa1",
        });

        // The exact row a claim leaves committed before its provider call lands: ACTIVE,
        // with no URL / QR / number.
        await prisma.payment.create({
            data: {
                orderId: order.orderId,
                organizerId: f.orgA.id,
                providerEnvironment: "SANDBOX",
                method: "QRIS",
                amount: order.total,
                currency: "IDR",
                status: "UNPAID",
                paymentReference: order.orderNumber,
                activeOrderId: order.orderId,
            },
        });

        const error = await expectRejection(() =>
            pay(f.buyerA.id, order.orderNumber)
        );

        expect(error.code).toBe(ERROR_CODES.CONFLICT);
        expect(error.details?.reason).toBe("PAYMENT_CREATION_IN_PROGRESS");

        // The bare row IS active, so no second session was asked of the provider.
        expect(gatewayStub.calls).toHaveLength(0);
        await expect(
            prisma.payment.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(1);
    });

    it("A2. an active attempt that already has an instrument is resumed", async () => {
        const type = await newType("AA2");
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: type, quantity: 1 }],
            tag: "aa2",
        });

        const first = await pay(f.buyerA.id, order.orderNumber);
        const second = await pay(f.buyerA.id, order.orderNumber);

        expect(second.resumed).toBe(true);
        expect(second.paymentReference).toBe(first.paymentReference);
        expect(second.paymentUrl).toBe(first.paymentUrl);
        expect(gatewayStub.calls).toHaveLength(1);
        await expect(
            prisma.payment.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(1);
    });

    it("A3. a terminal EXPIRED attempt does not block a new attempt", async () => {
        const type = await newType("AA3");
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: type, quantity: 1 }],
            tag: "aa3",
        });

        const first = await pay(f.buyerA.id, order.orderNumber);

        // The REAL void write, called exactly as the cancel/expire paths call it — but
        // without moving the order, so this isolates "terminal attempt" from "terminal
        // order". The order is still PENDING_PAYMENT, so a new attempt is legitimate.
        await prisma.$transaction((tx) => voidOpenPayments(tx, order.orderId));

        const retry = await pay(f.buyerA.id, order.orderNumber);

        expect(retry.resumed).toBe(false);
        expect(retry.paymentReference).not.toBe(first.paymentReference);
        expect(gatewayStub.calls).toHaveLength(2);

        const rows = await prisma.payment.findMany({
            where: { orderId: order.orderId },
            orderBy: { createdAt: "asc" },
            select: { status: true, activeOrderId: true },
        });

        expect(rows.map((row) => row.status)).toEqual(["EXPIRED", "PENDING"]);
        expect(rows.filter((row) => row.activeOrderId !== null)).toHaveLength(1);
    });

    it("A4. a terminal FAILED attempt does not block a new attempt", async () => {
        const type = await newType("AA4");
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: type, quantity: 1 }],
            tag: "aa4",
        });

        gatewayStub.failNext(503, { Status: 503, Message: "Service Unavailable" });
        await expectRejection(() => pay(f.buyerA.id, order.orderNumber));

        const failed = await prisma.payment.findFirstOrThrow({
            where: { orderId: order.orderId },
            select: { status: true, activeOrderId: true },
        });

        expect(failed.status).toBe("FAILED");
        // The active slot was released, so the durable index cannot wedge the retry.
        expect(failed.activeOrderId).toBeNull();

        const retry = await pay(f.buyerA.id, order.orderNumber);

        expect(retry.resumed).toBe(false);
        expect(gatewayStub.calls).toHaveLength(2);
        await expect(
            prisma.payment.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(2);
    });

    it("A5. a provider failure does not permanently wedge the order", async () => {
        const type = await newType("AA5");
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: type, quantity: 1 }],
            tag: "aa5",
        });

        gatewayStub.failNext(503, { Status: 503 });

        const error = await expectRejection(() =>
            pay(f.buyerA.id, order.orderNumber)
        );

        expect(error.code).toBe(ERROR_CODES.PROVIDER_UNAVAILABLE);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { status: true, paymentStatus: true },
        });

        expect(row.status).toBe("PENDING_PAYMENT");
        expect(row.paymentStatus).toBe("UNPAID");

        // The buyer retries, and the retry succeeds with a fresh reference.
        const retry = await pay(f.buyerA.id, order.orderNumber);

        expect(retry.resumed).toBe(false);
        expect(retry.paymentReference).toBe(`${order.orderNumber}#2`);
    });

    it("A6. the DATABASE rejects a second active attempt for one order (BUG-02)", async () => {
        const type = await newType("AA6");
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: type, quantity: 1 }],
            tag: "aa6",
        });

        await pay(f.buyerA.id, order.orderNumber);

        // A direct insert of a second ACTIVE row — the state BUG-01 could create — must be
        // rejected by the unique `activeOrderId` index, whatever code path tries it. The
        // reference is deliberately distinct, so the rejection can ONLY be the active-attempt
        // invariant, never `paymentReference`.
        await expect(
            prisma.payment.create({
                data: {
                    orderId: order.orderId,
                    organizerId: f.orgA.id,
                    providerEnvironment: "SANDBOX",
                    method: "QRIS",
                    amount: order.total,
                    currency: "IDR",
                    status: "PENDING",
                    paymentReference: `${order.orderNumber}#2`,
                    activeOrderId: order.orderId,
                },
            })
        ).rejects.toMatchObject({ code: "P2002" });

        await expect(
            prisma.payment.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(1);
    });

    it("A7. terminal attempts may coexist, and a new attempt is still creatable", async () => {
        const type = await newType("AA7");
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: type, quantity: 1 }],
            tag: "aa7",
        });

        // Two terminal rows, both with a NULL pointer. MySQL/MariaDB treat multiple NULLs as
        // distinct in a unique index, so history must never collide.
        await prisma.payment.createMany({
            data: [
                {
                    orderId: order.orderId,
                    organizerId: f.orgA.id,
                    providerEnvironment: "SANDBOX",
                    method: "QRIS",
                    amount: order.total,
                    currency: "IDR",
                    status: "FAILED",
                    paymentReference: `${order.orderNumber}#t1`,
                },
                {
                    orderId: order.orderId,
                    organizerId: f.orgA.id,
                    providerEnvironment: "SANDBOX",
                    method: "QRIS",
                    amount: order.total,
                    currency: "IDR",
                    status: "EXPIRED",
                    paymentReference: `${order.orderNumber}#t2`,
                },
            ],
        });

        await expect(
            prisma.payment.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(2);

        // Historical terminals do not block a legitimate new attempt.
        const fresh = await pay(f.buyerA.id, order.orderNumber);

        expect(fresh.resumed).toBe(false);
        await expect(
            prisma.payment.count({ where: { orderId: order.orderId } })
        ).resolves.toBe(3);
    });
});
