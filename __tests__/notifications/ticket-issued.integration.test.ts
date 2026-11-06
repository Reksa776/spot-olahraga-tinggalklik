/**
 * ==========================================
 * POST-ISSUANCE TICKET NOTIFICATION — INTEGRATION
 * ==========================================
 *
 * Runs against the isolated Jest schema. No transport is constructed and nothing is sent:
 * every assertion is about the QUEUE ROWS an issuance produces, the independent idempotency
 * keys, the template limits, and the manual recovery sweep.
 *
 * Fixtures are written directly with Prisma because this suite is about the notification read
 * model, not about re-proving checkout. The issuance seam itself is covered by
 * `__tests__/ticketing-issuance/ticket-issued-hook.integration.test.ts`.
 */

import type {
    EventStatus,
    OrderStatus,
    PaymentStatus,
    TicketStatus,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { enqueuePurchaseProof } from "@/lib/notifications/purchase-proof";
import { PURCHASE_PROOF_TEMPLATE_KEY } from "@/lib/notifications/purchase-proof-template";
import {
    enqueueTicketIssued,
    sweepMissingTicketNotifications,
    ticketIssuedIdempotencyKey,
} from "@/lib/notifications/ticket-issued";
import {
    renderTicketIssued,
    TICKET_ISSUED_TEMPLATE_KEY,
} from "@/lib/notifications/ticket-issued-template";
import { renderNotification } from "@/lib/notifications/templates";
import { generateTicketCode } from "@/lib/ticketing/tickets/reference";

jest.setTimeout(180_000);

const PREFIX = `tix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const NOW = new Date("2026-12-01T12:00:00.000Z");
const ORIGIN = "https://app.example.test";
const INVALID_CODE = "EVT-0000-1111";

let sequence = 0;

function nextTag(tag: string): string {
    sequence += 1;
    return `${tag}-${sequence}`;
}

type Fixture = {
    buyer: { id: string };
    owner: { id: string };
    sportId: string;
    organizer: { id: string };
    venue: { id: string };
};

type TicketSpec = {
    status: TicketStatus;
    ticketCode?: string;
};

type OrderOptions = {
    status?: OrderStatus;
    paymentStatus?: PaymentStatus;
    paidAt?: Date | null;
    buyerEmail?: string | null;
    buyerPhone?: string | null;
    eventStatus?: EventStatus;
    startAt?: Date;
    endAt?: Date | null;
    quantity?: number;
    orderNumber?: string;
    tickets?: number | TicketSpec[];
};

let fixture: Fixture;
const orderIds: string[] = [];
const eventIds: string[] = [];
const ticketTypeIds: string[] = [];

async function setupFixture(): Promise<Fixture> {
    const buyer = await prisma.user.create({
        data: {
            name: `TIX Buyer ${PREFIX}`,
            email: `tix-buyer-${PREFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    const owner = await prisma.user.create({
        data: {
            name: `TIX Owner ${PREFIX}`,
            email: `tix-owner-${PREFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    const sport = await prisma.sport.create({
        data: { name: `TIX Sport ${PREFIX}`, slug: `tix-sport-${PREFIX}` },
        select: { id: true },
    });

    const organizer = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `TIX Organizer ${PREFIX}`,
            slug: `tix-org-${PREFIX}`,
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

    return {
        buyer,
        owner,
        sportId: sport.id,
        organizer,
        venue,
    };
}

async function createOrder(tag: string, options: OrderOptions = {}) {
    const event = await prisma.event.create({
        data: {
            organizerId: fixture.organizer.id,
            sportId: fixture.sportId,
            venueId: fixture.venue.id,
            title: `TIX Event ${tag} ${PREFIX}`,
            slug: `tix-event-${tag}-${PREFIX}`.toLowerCase(),
            eventCode: `TIX-${tag}-${PREFIX}`.toUpperCase(),
            startAt:
                options.startAt ??
                new Date(NOW.getTime() - 2 * 60 * 60_000),
            endAt:
                options.endAt === undefined
                    ? new Date(NOW.getTime() + 60 * 60_000)
                    : options.endAt,
            status: options.eventStatus ?? "PUBLISHED",
            visibility: "UNLISTED",
            createdByUserId: fixture.owner.id,
            contactName: "Panitia",
            contactPhone: "081200000000",
        },
        select: { id: true },
    });

    eventIds.push(event.id);

    const ticketType = await prisma.ticketType.create({
        data: {
            eventId: event.id,
            name: `Reguler ${tag}`,
            price: "150000.00",
            quota: 200,
            sold: 0,
            reserved: 0,
            isActive: true,
        },
        select: { id: true },
    });

    ticketTypeIds.push(ticketType.id);

    const specs: TicketSpec[] =
        typeof options.tickets === "number"
            ? Array.from({ length: options.tickets }, () => ({
                  status: "ISSUED" as const,
              }))
            : Array.isArray(options.tickets)
              ? options.tickets
              : [{ status: "ISSUED" as const }];

    const quantity =
        options.quantity ??
        (typeof options.tickets === "number"
            ? options.tickets
            : Array.isArray(options.tickets) && options.tickets.length > 0
              ? options.tickets.length
              : 1);

    const subtotal = `${(quantity * 150000).toFixed(2)}`;

    const order = await prisma.eventOrder.create({
        data: {
            orderNumber:
                options.orderNumber ??
                `TIX-${PREFIX}-${tag}`.toUpperCase(),
            organizerId: fixture.organizer.id,
            eventId: event.id,
            userId: fixture.buyer.id,
            buyerName: "Budi Santoso",
            buyerEmail:
                options.buyerEmail === undefined
                    ? `ticket-${PREFIX}@example.test`
                    : options.buyerEmail,
            buyerPhone:
                options.buyerPhone === undefined
                    ? "081234567890"
                    : options.buyerPhone,
            status: options.status ?? "PAID",
            paymentStatus: options.paymentStatus ?? "PAID",
            subtotal,
            total: subtotal,
            organizerNetAmount: subtotal,
            paidAt:
                options.paidAt === undefined
                    ? new Date(NOW.getTime() - 60 * 60_000)
                    : options.paidAt,
            items: {
                create: [
                    {
                        ticketTypeId: ticketType.id,
                        nameSnapshot: "Reguler",
                        priceSnapshot: "150000.00",
                        quantity,
                        subtotal,
                    },
                ],
            },
        },
        select: {
            id: true,
            orderNumber: true,
            items: { select: { id: true } },
        },
    });

    orderIds.push(order.id);

    const ticketCodes: string[] = [];

    for (const [index, spec] of specs.entries()) {
        const ticketCode = spec.ticketCode ?? generateTicketCode();

        await prisma.ticket.create({
            data: {
                ticketCode,
                qrTokenHash: `qr-${PREFIX}-${order.id}-${index}`,
                orderId: order.id,
                orderItemId: order.items[0].id,
                sequenceNo: index + 1,
                ticketTypeId: ticketType.id,
                eventId: event.id,
                organizerId: fixture.organizer.id,
                status: spec.status,
                issuedAt: spec.status === "ISSUED" ? NOW : null,
            },
        });

        ticketCodes.push(ticketCode);
    }

    return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        eventId: event.id,
        ticketTypeId: ticketType.id,
        ticketCodes,
    };
}

function ticketRows(orderId: string) {
    return prisma.notification.findMany({
        where: {
            eventOrderId: orderId,
            templateKey: TICKET_ISSUED_TEMPLATE_KEY,
        },
        orderBy: { channel: "asc" },
        select: {
            id: true,
            channel: true,
            recipient: true,
            category: true,
            idempotencyKey: true,
            payload: true,
            deliveries: { select: { channel: true, status: true } },
        },
    });
}

function parsePayload(value: string | null): Record<string, unknown> {
    if (!value) {
        throw new Error("Expected a stored notification payload.");
    }

    return JSON.parse(value) as Record<string, unknown>;
}

beforeAll(async () => {
    fixture = await setupFixture();
});

afterAll(async () => {
    await prisma.notification.deleteMany({
        where: {
            OR: [
                { eventOrderId: { in: orderIds } },
                { idempotencyKey: { startsWith: PREFIX } },
            ],
        },
    });
    await prisma.ticket.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.eventOrderItem.deleteMany({
        where: { orderId: { in: orderIds } },
    });
    await prisma.eventOrder.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.ticketType.deleteMany({
        where: { id: { in: ticketTypeIds } },
    });
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });

    if (fixture) {
        await prisma.venue.deleteMany({ where: { id: fixture.venue.id } });
        await prisma.organizer.deleteMany({
            where: { id: fixture.organizer.id },
        });
        await prisma.sport.deleteMany({ where: { id: fixture.sportId } });
        await prisma.user.deleteMany({
            where: { id: { in: [fixture.buyer.id, fixture.owner.id] } },
        });
    }
});

describe("first enqueue", () => {
    test("creates one email and one WhatsApp row under independent keys", async () => {
        const order = await createOrder(nextTag("first"), { tickets: 2 });

        const outcome = await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });

        expect(outcome).toMatchObject({
            orderNumber: order.orderNumber,
            eligible: true,
            email: "created",
            whatsapp: "created",
        });

        const rows = await ticketRows(order.orderId);

        expect(rows.map((row) => row.channel).sort()).toEqual([
            "email",
            "whatsapp",
        ]);
        expect(rows.map((row) => row.idempotencyKey).sort()).toEqual(
            [
                ticketIssuedIdempotencyKey(order.orderNumber, "email"),
                ticketIssuedIdempotencyKey(order.orderNumber, "whatsapp"),
            ].sort()
        );
        expect(rows.every((row) => row.category === "TICKET")).toBe(true);
        expect(
            rows.every((row) => row.deliveries.length === 1)
        ).toBe(true);
        expect(
            rows.every((row) => row.deliveries[0].status === "QUEUED")
        ).toBe(true);

        expect(
            rows.find((row) => row.channel === "email")?.recipient
        ).toBe(`ticket-${PREFIX}@example.test`);
        expect(
            rows.find((row) => row.channel === "whatsapp")?.recipient
        ).toBe("6281234567890");

        const payload = parsePayload(
            rows.find((row) => row.channel === "email")?.payload ?? null
        );

        expect(payload).toMatchObject({
            version: "v1",
            orderNumber: order.orderNumber,
            ticketCount: 2,
            walletUrl: `${ORIGIN}/ticketing/tickets`,
        });
        expect(
            (payload.tickets as { ticketCode: string }[])
                .map((ticket) => ticket.ticketCode)
                .sort()
        ).toEqual([...order.ticketCodes].sort());

        const serialized = JSON.stringify(payload);

        expect(serialized).not.toContain("qrTokenHash");
        expect(serialized).not.toContain("TICKET:");
        expect(serialized).not.toMatch(
            /"orderId"|"eventId"|"organizerId"|"ticketId"/
        );
    });

    test("a replay reuses both rows instead of duplicating them", async () => {
        const order = await createOrder(nextTag("replay"), { tickets: 1 });

        await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });
        const second = await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });

        expect(second).toMatchObject({
            eligible: true,
            email: "existing",
            whatsapp: "existing",
        });
        expect(await ticketRows(order.orderId)).toHaveLength(2);
    });
});

describe("channel independence", () => {
    test("email exists and WhatsApp missing: only WhatsApp is repaired", async () => {
        const order = await createOrder(nextTag("repair-wa"), {
            buyerPhone: null,
            tickets: 1,
        });

        const first = await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });

        expect(first).toMatchObject({
            email: "created",
            whatsapp: "skipped",
        });

        const emailBefore = (await ticketRows(order.orderId))[0];

        await prisma.eventOrder.update({
            where: { id: order.orderId },
            data: { buyerPhone: "081234567890" },
        });

        const second = await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });

        expect(second).toMatchObject({
            email: "existing",
            whatsapp: "created",
        });

        const rows = await ticketRows(order.orderId);

        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.channel === "email")?.id).toBe(
            emailBefore.id
        );
        expect(
            rows.find((row) => row.channel === "whatsapp")?.recipient
        ).toBe("6281234567890");
    });

    test("WhatsApp exists and email missing: only email is repaired", async () => {
        const order = await createOrder(nextTag("repair-email"), {
            buyerEmail: null,
            tickets: 1,
        });

        const first = await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });

        expect(first).toMatchObject({
            email: "skipped",
            whatsapp: "created",
        });

        const whatsappBefore = (await ticketRows(order.orderId))[0];

        await prisma.eventOrder.update({
            where: { id: order.orderId },
            data: { buyerEmail: `repaired-${PREFIX}@example.test` },
        });

        const second = await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });

        expect(second).toMatchObject({
            email: "created",
            whatsapp: "existing",
        });

        const rows = await ticketRows(order.orderId);

        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.channel === "whatsapp")?.id).toBe(
            whatsappBefore.id
        );
        expect(rows.find((row) => row.channel === "email")?.recipient).toBe(
            `repaired-${PREFIX}@example.test`
        );
    });

    test("purchase proof and ticket notification stay independent", async () => {
        const order = await createOrder(nextTag("proof-independent"), {
            tickets: 1,
        });

        const proof = await enqueuePurchaseProof(order.orderId);
        const ticket = await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });

        expect(proof).toMatchObject({
            eligible: true,
            email: "created",
            whatsapp: "created",
        });
        expect(ticket).toMatchObject({
            eligible: true,
            email: "created",
            whatsapp: "created",
        });

        const all = await prisma.notification.findMany({
            where: { eventOrderId: order.orderId },
            select: { templateKey: true, category: true, idempotencyKey: true },
        });

        expect(all).toHaveLength(4);
        expect(
            all.filter((row) => row.templateKey === PURCHASE_PROOF_TEMPLATE_KEY)
        ).toHaveLength(2);
        expect(
            all.filter((row) => row.templateKey === TICKET_ISSUED_TEMPLATE_KEY)
        ).toHaveLength(2);
        expect(all.filter((row) => row.category === "ORDER")).toHaveLength(2);
        expect(all.filter((row) => row.category === "TICKET")).toHaveLength(2);
        expect(
            all.every((row) => !row.idempotencyKey.startsWith("purchase-proof") ||
                row.templateKey === PURCHASE_PROOF_TEMPLATE_KEY)
        ).toBe(true);
    });
});

describe("contact handling", () => {
    test("an invalid address is stored verbatim, never guessed", async () => {
        const order = await createOrder(nextTag("invalid-contact"), {
            buyerEmail: "not-an-email",
            buyerPhone: "0212345678",
            tickets: 1,
        });

        const outcome = await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });

        expect(outcome).toMatchObject({
            email: "created",
            whatsapp: "created",
        });

        const rows = await ticketRows(order.orderId);

        expect(rows.find((row) => row.channel === "email")?.recipient).toBe(
            "not-an-email"
        );
        expect(
            rows.find((row) => row.channel === "whatsapp")?.recipient
        ).toBe("0212345678");
        expect(
            rows.find((row) => row.channel === "whatsapp")?.recipient
        ).not.toMatch(/^628/);
    });

    test("missing contacts skip the channel without inventing a recipient", async () => {
        const order = await createOrder(nextTag("no-contact"), {
            buyerEmail: null,
            buyerPhone: null,
            tickets: 1,
        });

        const outcome = await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });

        expect(outcome).toMatchObject({
            eligible: true,
            email: "skipped",
            whatsapp: "skipped",
        });
        expect(await ticketRows(order.orderId)).toHaveLength(0);
    });
});

describe("template limits and ticket eligibility", () => {
    test("more than 20 tickets prints at most 20 codes and points to the wallet", async () => {
        const order = await createOrder(nextTag("many"), { tickets: 25 });

        await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });

        const email = (await ticketRows(order.orderId)).find(
            (row) => row.channel === "email"
        );
        const payload = parsePayload(email?.payload ?? null);

        expect(payload.ticketCount).toBe(25);
        expect(payload.tickets).toHaveLength(25);

        const rendered = renderNotification(
            TICKET_ISSUED_TEMPLATE_KEY,
            email?.payload ?? null
        );

        for (let index = 0; index < 20; index += 1) {
            expect(rendered.text).toContain(`${index + 1}. ${order.ticketCodes[index]}`);
        }

        expect(rendered.text).not.toContain(`21. ${order.ticketCodes[20]}`);
        expect(rendered.text).toContain(
            "Seluruh tiket dapat dilihat melalui halaman Tiket Saya."
        );
        expect(rendered.text).toContain(`${ORIGIN}/ticketing/tickets`);
    });

    test("VOID, REFUNDED, CHECKED_IN and malformed codes are not printed", async () => {
        const order = await createOrder(nextTag("statuses"), {
            tickets: [
                { status: "ISSUED" },
                { status: "ISSUED" },
                { status: "VOID" },
                { status: "REFUNDED" },
                { status: "CHECKED_IN" },
                { status: "ISSUED", ticketCode: INVALID_CODE },
            ],
        });

        const outcome = await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });

        expect(outcome).toMatchObject({
            email: "created",
            whatsapp: "created",
        });

        const email = (await ticketRows(order.orderId)).find(
            (row) => row.channel === "email"
        );
        const payload = parsePayload(email?.payload ?? null);
        const codes = (
            payload.tickets as { ticketCode: string }[]
        ).map((ticket) => ticket.ticketCode);

        expect(payload.ticketCount).toBe(2);
        expect(codes).toEqual(order.ticketCodes.slice(0, 2));

        const rendered = renderTicketIssued(payload);

        expect(rendered.text).not.toContain(order.ticketCodes[2]);
        expect(rendered.text).not.toContain(order.ticketCodes[3]);
        expect(rendered.text).not.toContain(order.ticketCodes[4]);
        expect(rendered.text).not.toContain(INVALID_CODE);
        expect(rendered.text).not.toContain("TICKET:");
    });
});

describe("recovery sweep eligibility", () => {
    test("PAID + ISSUED + inside the window is eligible and repeatable", async () => {
        const order = await createOrder(nextTag("sweep-window"), {
            tickets: 1,
        });

        const first = await sweepMissingTicketNotifications({
            now: NOW,
            minAgeMs: 0,
            orderIds: [order.orderId],
        });

        expect(first).toMatchObject({
            scanned: 1,
            eligible: 1,
            emailCreated: 1,
            whatsappCreated: 1,
            failed: 0,
        });
        expect(await ticketRows(order.orderId)).toHaveLength(2);

        const second = await sweepMissingTicketNotifications({
            now: NOW,
            minAgeMs: 0,
            orderIds: [order.orderId],
        });

        expect(second).toMatchObject({
            scanned: 0,
            emailCreated: 0,
            whatsappCreated: 0,
        });
        expect(await ticketRows(order.orderId)).toHaveLength(2);
        expect(
            await prisma.notificationDelivery.count({
                where: {
                    notification: {
                        eventOrderId: order.orderId,
                        templateKey: TICKET_ISSUED_TEMPLATE_KEY,
                    },
                    status: "SENT",
                },
            })
        ).toBe(0);
    });

    test("an order younger than the 120 second grace period is skipped", async () => {
        const order = await createOrder(nextTag("sweep-young"), {
            paidAt: new Date(NOW.getTime() - 60_000),
            tickets: 1,
        });

        const skipped = await sweepMissingTicketNotifications({
            now: NOW,
            orderIds: [order.orderId],
        });

        expect(skipped.scanned).toBe(0);
        expect(await ticketRows(order.orderId)).toHaveLength(0);

        const eligible = await sweepMissingTicketNotifications({
            now: NOW,
            minAgeMs: 0,
            orderIds: [order.orderId],
        });

        expect(eligible.scanned).toBe(1);
        expect(await ticketRows(order.orderId)).toHaveLength(2);
    });

    test("more than 30 minutes after event end is skipped", async () => {
        const order = await createOrder(nextTag("sweep-late"), {
            endAt: new Date(NOW.getTime() - 31 * 60_000),
            tickets: 1,
        });

        const result = await sweepMissingTicketNotifications({
            now: NOW,
            minAgeMs: 0,
            orderIds: [order.orderId],
        });

        expect(result.scanned).toBe(0);
        expect(await ticketRows(order.orderId)).toHaveLength(0);
    });

    test("exactly endAt + 30 minutes is inside the approved boundary", async () => {
        const order = await createOrder(nextTag("sweep-boundary"), {
            endAt: new Date(NOW.getTime() - 30 * 60_000),
            tickets: 1,
        });

        const result = await sweepMissingTicketNotifications({
            now: NOW,
            minAgeMs: 0,
            orderIds: [order.orderId],
        });

        expect(result).toMatchObject({
            scanned: 1,
            eligible: 1,
            emailCreated: 1,
            whatsappCreated: 1,
        });
    });

    test("CANCELLED and ARCHIVED events are skipped", async () => {
        const cancelled = await createOrder(nextTag("sweep-cancelled"), {
            eventStatus: "CANCELLED",
            tickets: 1,
        });
        const archived = await createOrder(nextTag("sweep-archived"), {
            eventStatus: "ARCHIVED",
            tickets: 1,
        });

        const result = await sweepMissingTicketNotifications({
            now: NOW,
            minAgeMs: 0,
            orderIds: [cancelled.orderId, archived.orderId],
        });

        expect(result.scanned).toBe(0);
        expect(await ticketRows(cancelled.orderId)).toHaveLength(0);
        expect(await ticketRows(archived.orderId)).toHaveLength(0);
    });

    test("no issued tickets means no candidate", async () => {
        const noTickets = await createOrder(nextTag("sweep-empty"), {
            tickets: [],
        });
        const nonIssued = await createOrder(nextTag("sweep-non-issued"), {
            tickets: [
                { status: "VOID" },
                { status: "REFUNDED" },
                { status: "CHECKED_IN" },
            ],
        });

        const result = await sweepMissingTicketNotifications({
            now: NOW,
            minAgeMs: 0,
            orderIds: [noTickets.orderId, nonIssued.orderId],
        });

        expect(result.scanned).toBe(0);
        expect(await ticketRows(noTickets.orderId)).toHaveLength(0);
        expect(await ticketRows(nonIssued.orderId)).toHaveLength(0);
    });

    test("a partially notified order has only the missing channel repaired", async () => {
        const order = await createOrder(nextTag("sweep-partial"), {
            tickets: 1,
        });

        await enqueueTicketIssued(order.orderId, {
            now: NOW,
            appOrigin: ORIGIN,
        });

        const before = await ticketRows(order.orderId);
        const emailBefore = before.find((row) => row.channel === "email");

        await prisma.notification.deleteMany({
            where: {
                eventOrderId: order.orderId,
                templateKey: TICKET_ISSUED_TEMPLATE_KEY,
                channel: "whatsapp",
            },
        });

        const result = await sweepMissingTicketNotifications({
            now: NOW,
            minAgeMs: 0,
            orderIds: [order.orderId],
        });

        expect(result).toMatchObject({
            scanned: 1,
            eligible: 1,
            emailCreated: 0,
            whatsappCreated: 1,
        });

        const after = await ticketRows(order.orderId);

        expect(after).toHaveLength(2);
        expect(after.find((row) => row.channel === "email")?.id).toBe(
            emailBefore?.id
        );
    });

    test("an uncategorised legacy row is never touched", async () => {
        const order = await createOrder(nextTag("sweep-legacy"), {
            tickets: 1,
        });

        const legacy = await prisma.notification.create({
            data: {
                idempotencyKey: `${PREFIX}-legacy`,
                channel: "whatsapp",
                recipient: "081200000000",
                eventOrderId: order.orderId,
                deliveries: { create: [{ channel: "WHATSAPP" }] },
            },
            select: {
                id: true,
                category: true,
                templateKey: true,
                recipient: true,
                deliveries: { select: { status: true } },
            },
        });

        const result = await sweepMissingTicketNotifications({
            now: NOW,
            minAgeMs: 0,
            orderIds: [order.orderId],
        });

        expect(result.scanned).toBe(1);
        expect(await ticketRows(order.orderId)).toHaveLength(2);

        const after = await prisma.notification.findUniqueOrThrow({
            where: { id: legacy.id },
            select: {
                category: true,
                templateKey: true,
                recipient: true,
                deliveries: { select: { status: true } },
            },
        });

        expect(after).toEqual({
            category: null,
            templateKey: null,
            recipient: "081200000000",
            deliveries: [{ status: "QUEUED" }],
        });
    });

    test("the batch never exceeds the configured limit", async () => {
        const orders = [];

        for (let index = 0; index < 3; index += 1) {
            orders.push(
                await createOrder(nextTag(`sweep-bound-${index}`), {
                    paidAt: new Date(
                        NOW.getTime() - (3 - index) * 60 * 60_000
                    ),
                    tickets: 1,
                })
            );
        }

        const result = await sweepMissingTicketNotifications({
            now: NOW,
            minAgeMs: 0,
            limit: 2,
            orderIds: orders.map((order) => order.orderId),
        });

        expect(result.scanned).toBe(2);
        expect(
            await prisma.notification.count({
                where: {
                    eventOrderId: {
                        in: orders.map((order) => order.orderId),
                    },
                    templateKey: TICKET_ISSUED_TEMPLATE_KEY,
                },
            })
        ).toBe(4);
    });

    test("one order's enqueue failure does not stop the others", async () => {
        // 170 characters fits the 191-character order column, while
        // `ticket-issued:<order>:email:v1` (193) and `…:whatsapp:v1` (196) exceed the
        // enqueue contract's 191-character idempotency-key limit. That is a real queue
        // failure without mocking the database.
        const longOrderNumber = `${PREFIX}-${"X".repeat(170 - PREFIX.length - 1)}`;

        const failing = await createOrder(nextTag("sweep-failing"), {
            orderNumber: longOrderNumber,
            tickets: 1,
        });
        const healthy = await createOrder(nextTag("sweep-healthy"), {
            tickets: 1,
        });

        const result = await sweepMissingTicketNotifications({
            now: NOW,
            minAgeMs: 0,
            orderIds: [failing.orderId, healthy.orderId],
        });

        expect(result).toMatchObject({
            scanned: 2,
            eligible: 2,
            failed: 1,
            emailCreated: 1,
            whatsappCreated: 1,
        });
        expect(await ticketRows(failing.orderId)).toHaveLength(0);
        expect(await ticketRows(healthy.orderId)).toHaveLength(2);
    });
});
