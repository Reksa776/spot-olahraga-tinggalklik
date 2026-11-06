/**
 * ==========================================
 * POST-ISSUANCE TICKET NOTIFICATION — ISSUANCE HOOK
 * ==========================================
 *
 * The notification hook must be a POST-COMMIT side effect of a real issuance, never part of
 * the transaction, and must be skipped when a call created no rows. These tests use the same
 * real checkout/settlement/issuance chain as the Phase 8 suites.
 *
 * They also prove the two properties that cannot be inferred from a row count:
 *
 *   • when the helper runs, the committed ticket rows are already visible to another query;
 *   • a duplicate issuance (`ALREADY_ISSUED`) does not call the helper again.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { prisma } from "@/lib/prisma";
import * as ticketIssuedModule from "@/lib/notifications/ticket-issued";
import type { TicketIssuedEnqueueResult } from "@/lib/notifications/ticket-issued";
import { TICKET_ISSUED_TEMPLATE_KEY } from "@/lib/notifications/ticket-issued-template";
import { generateTicketCode } from "@/lib/ticketing/tickets/reference";

import {
    createOrder,
    createPaidOrder,
    createType,
    installGatewayStub,
    issue,
    setupIssuanceFixtures,
    teardownIssuanceFixtures,
    ticketsFor,
    type Fixtures,
} from "./issuance-harness";

jest.setTimeout(300_000);

let f: Fixtures;
let fetchSpy: jest.SpyInstance;

async function newType(name: string, quota = 20): Promise<string> {
    return (await createType(f, name, { quota })).id;
}

function notificationRows(orderId: string) {
    return prisma.notification.findMany({
        where: {
            eventOrderId: orderId,
            templateKey: TICKET_ISSUED_TEMPLATE_KEY,
        },
        orderBy: { channel: "asc" },
        select: {
            id: true,
            channel: true,
            category: true,
            idempotencyKey: true,
            payload: true,
            deliveries: { select: { status: true } },
        },
    });
}

function skippedObservation(reason: string): TicketIssuedEnqueueResult {
    return {
        orderNumber: null,
        eligible: false,
        reason,
        email: "skipped",
        whatsapp: "skipped",
    };
}

beforeAll(async () => {
    f = await setupIssuanceFixtures();
    fetchSpy = installGatewayStub();
});

afterEach(() => {
    // Restore only the spies a test installed (notably the helper observation spy), then
    // re-install the gateway stub: `restoreAllMocks` also restores `global.fetch`, which
    // would otherwise break every later checkout fixture.
    jest.restoreAllMocks();
    fetchSpy = installGatewayStub();
});

afterAll(async () => {
    const orderIds = (
        await prisma.eventOrder.findMany({
            where: { eventId: { in: [f.eventA.id, f.eventB.id] } },
            select: { id: true },
        })
    ).map((row) => row.id);

    await prisma.notification.deleteMany({
        where: {
            eventOrderId: { in: orderIds },
            templateKey: TICKET_ISSUED_TEMPLATE_KEY,
        },
    });

    fetchSpy.mockRestore();
    await teardownIssuanceFixtures(f);
});

describe("issuance enqueues only after a committed creation", () => {
    it("creates the tickets and one notification per channel", async () => {
        const ticketTypeId = await newType("TIX-HOOK-VALID");
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "tix-hook-valid",
        });

        const result = await issue(order.orderNumber, f.buyerA.id);

        expect(result.outcome).toBe("ISSUED");
        expect(result.ticketsIssued).toBe(2);

        const tickets = await ticketsFor(order.orderId);
        expect(tickets).toHaveLength(2);

        const rows = await notificationRows(order.orderId);

        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.channel).sort()).toEqual([
            "email",
            "whatsapp",
        ]);
        expect(rows.every((row) => row.category === "TICKET")).toBe(true);
        expect(
            rows.every((row) => row.deliveries[0].status === "QUEUED")
        ).toBe(true);

        const email = rows.find((row) => row.channel === "email");

        expect(email?.idempotencyKey).toBe(
            `ticket-issued:${order.orderNumber}:email:v1`
        );
        expect(email?.payload).not.toBeNull();

        const payload = JSON.parse(email?.payload ?? "{}") as {
            ticketCount?: number;
            tickets?: { ticketCode: string }[];
        };

        expect(payload.ticketCount).toBe(2);
        expect(
            (payload.tickets ?? [])
                .map((ticket) => ticket.ticketCode)
                .sort()
        ).toEqual(tickets.map((ticket) => ticket.ticketCode).sort());
        expect(email?.payload).not.toContain("qrTokenHash");
        expect(email?.payload).not.toContain("TICKET:");
    });

    it("many tickets still produce one order-level notification per channel", async () => {
        const ticketTypeId = await newType("TIX-HOOK-MANY");
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 3,
            tag: "tix-hook-many",
        });

        const result = await issue(order.orderNumber, f.buyerA.id);
        expect(result.ticketsIssued).toBe(3);

        const rows = await notificationRows(order.orderId);

        expect(rows).toHaveLength(2);
        expect(
            rows.every((row) => {
                const payload = JSON.parse(row.payload ?? "{}") as {
                    ticketCount?: number;
                };

                return payload.ticketCount === 3;
            })
        ).toBe(true);
    });

    it("a duplicate issuance creates no additional notification", async () => {
        const ticketTypeId = await newType("TIX-HOOK-DUPLICATE");
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "tix-hook-duplicate",
        });

        const first = await issue(order.orderNumber, f.buyerA.id);
        const before = await notificationRows(order.orderId);

        const second = await issue(order.orderNumber, f.buyerA.id);
        const after = await notificationRows(order.orderId);

        expect(first.outcome).toBe("ISSUED");
        expect(second.outcome).toBe("ALREADY_ISSUED");
        expect(second.ticketsIssued).toBe(0);
        expect(after).toHaveLength(before.length);
        expect(after.map((row) => row.id)).toEqual(
            before.map((row) => row.id)
        );
    });

    it("a pre-existing partial ticket set is completed and notified once", async () => {
        const ticketTypeId = await newType("TIX-HOOK-PARTIAL");
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 3,
            tag: "tix-hook-partial",
        });

        const item = await prisma.eventOrderItem.findFirstOrThrow({
            where: { orderId: order.orderId },
            select: { id: true },
        });

        await prisma.ticket.create({
            data: {
                ticketCode: generateTicketCode(),
                qrTokenHash: `manual-${order.orderId}`,
                orderId: order.orderId,
                orderItemId: item.id,
                sequenceNo: 1,
                ticketTypeId,
                eventId: f.eventA.id,
                organizerId: f.orgA.id,
                status: "ISSUED",
                issuedAt: new Date(),
            },
        });

        const result = await issue(order.orderNumber, f.buyerA.id);

        expect(result.outcome).toBe("ISSUED");
        expect(result.ticketsIssued).toBe(2);
        expect(result.totalTickets).toBe(3);

        const rows = await notificationRows(order.orderId);

        expect(rows).toHaveLength(2);
        expect(
            rows.every((row) => {
                const payload = JSON.parse(row.payload ?? "{}") as {
                    ticketCount?: number;
                };

                return payload.ticketCount === 3;
            })
        ).toBe(true);
    });
});

describe("issuance survives notification failure", () => {
    it("a queue failure does not fail a committed issuance", async () => {
        const ticketTypeId = await newType("TIX-HOOK-QUEUE-FAIL");
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "tix-hook-queue-fail",
        });

        // A long order number makes both channel idempotency keys exceed the enqueue
        // contract's 191-character limit, so the helper records a channel failure. The
        // ticket rows must still be committed and the issuance must still return success.
        const longOrderNumber = `${order.orderNumber}-${"X".repeat(150)}`;

        await prisma.eventOrder.update({
            where: { id: order.orderId },
            data: { orderNumber: longOrderNumber },
        });

        const result = await issue(longOrderNumber, f.buyerA.id);

        expect(result.outcome).toBe("ISSUED");
        expect(result.ticketsIssued).toBe(2);
        expect(await ticketsFor(order.orderId)).toHaveLength(2);
        expect(await notificationRows(order.orderId)).toHaveLength(0);
    });

    it("an ineligible order creates neither tickets nor notifications", async () => {
        const ticketTypeId = await newType("TIX-HOOK-INELIGIBLE");
        const pending = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId, quantity: 1 }],
            tag: "tix-hook-ineligible",
        });

        await expect(
            issue(pending.orderNumber, f.buyerA.id)
        ).rejects.toBeDefined();

        expect(
            await prisma.ticket.count({ where: { orderId: pending.orderId } })
        ).toBe(0);
        expect(await notificationRows(pending.orderId)).toHaveLength(0);
    });
});

describe("concurrency and the created-rows gate", () => {
    it("simultaneous issuance produces one ticket set and one notification set", async () => {
        const ticketTypeId = await newType("TIX-HOOK-CONCURRENT");
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 3,
            tag: "tix-hook-concurrent",
        });

        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                issue(order.orderNumber, f.buyerA.id)
            )
        );

        expect(
            results.filter((result) => result.outcome === "ISSUED")
        ).toHaveLength(1);
        expect(
            results.filter((result) => result.outcome === "ALREADY_ISSUED")
        ).toHaveLength(4);
        expect(await ticketsFor(order.orderId)).toHaveLength(3);
        expect(await notificationRows(order.orderId)).toHaveLength(2);
    });

    it("the helper runs after commit and only when the call created rows", async () => {
        const ticketTypeId = await newType("TIX-HOOK-COMMIT");
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "tix-hook-commit",
        });

        const observations: {
            tickets: number;
            orderStatus: string | null;
        }[] = [];

        const spy = jest
            .spyOn(ticketIssuedModule, "enqueueTicketIssued")
            .mockImplementation(async (orderId: string) => {
                const [tickets, row] = await Promise.all([
                    prisma.ticket.count({ where: { orderId } }),
                    prisma.eventOrder.findUnique({
                        where: { id: orderId },
                        select: { status: true },
                    }),
                ]);

                observations.push({
                    tickets,
                    orderStatus: row?.status ?? null,
                });

                return skippedObservation("TEST_OBSERVATION");
            });

        const first = await issue(order.orderNumber, f.buyerA.id);
        const second = await issue(order.orderNumber, f.buyerA.id);

        expect(first.outcome).toBe("ISSUED");
        expect(second.outcome).toBe("ALREADY_ISSUED");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(observations).toEqual([{ tickets: 2, orderStatus: "PAID" }]);

        spy.mockRestore();
    });
});
