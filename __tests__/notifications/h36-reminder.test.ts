import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * ==========================================
 * PHASE 4 — H-36 REMINDER (pure + mocked)
 * ==========================================
 *
 * HONEST LABELLING: this suite uses a MOCKED Prisma client and a MOCKED enqueue function. It
 * proves the calculation, the occurrence key, the payload/template, the query shape, the
 * reconciliation rules and the duplicate behaviour. It does NOT prove database concurrency,
 * real unique-index behaviour under two connections, or real delivery — those remain Phase 3G /
 * live-transport work.
 *
 * The scheduler is not invoked here: `__tests__/jobs/tick.test.ts` owns the lease/tick contract
 * and now expects three jobs.
 */

jest.mock("@/lib/prisma", () => ({
    prisma: {
        event: { findMany: jest.fn() },
        notificationDelivery: { findMany: jest.fn(), updateMany: jest.fn() },
    },
}));

jest.mock("@/lib/notifications/enqueue", () => ({
    enqueueNotification: jest.fn(),
    MAX_IDEMPOTENCY_KEY_LENGTH: 191,
}));

import { prisma } from "@/lib/prisma";
import { enqueueNotification } from "@/lib/notifications/enqueue";
import {
    H36_OFFSET_MS,
    h36ReminderIdempotencyKey,
    h36ReminderTargetAt,
    isH36ReminderDue,
    runH36ReminderSweep,
} from "@/lib/notifications/h36-reminder";
import {
    buildH36ReminderPayload,
    formatH36EventTime,
    H36_REMINDER_TEMPLATE_KEY,
    isValidTimeZone,
    renderH36Reminder,
} from "@/lib/notifications/h36-reminder-template";
import { hasTemplate, renderNotification } from "@/lib/notifications/templates";

const mockEventFindMany = prisma.event.findMany as unknown as jest.Mock;
const mockDeliveryFindMany =
    prisma.notificationDelivery.findMany as unknown as jest.Mock;
const mockDeliveryUpdateMany =
    prisma.notificationDelivery.updateMany as unknown as jest.Mock;
const mockEnqueueNotification =
    enqueueNotification as unknown as jest.Mock;

const ROOT = path.resolve(__dirname, "..", "..");
const START = new Date("2026-06-01T12:00:00.000Z");
const NOW = new Date(START.getTime() - H36_OFFSET_MS);

function eventRow(overrides: Record<string, unknown> = {}) {
    return {
        id: "event_1",
        title: "Jakarta Marathon",
        startAt: START,
        timezone: "Asia/Jakarta",
        organizerId: "org_1",
        venue: { name: "GBK", address: "Jl. Pintu Satu", city: "Jakarta" },
        tickets: [
            {
                id: "ticket_1",
                orderId: "order_1",
                holderUserId: "user_1",
                attendeePhone: "0812-3456-7890",
                holder: { phone: null },
            },
        ],
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockEventFindMany.mockResolvedValue([]);
    mockDeliveryFindMany.mockResolvedValue([]);
    mockDeliveryUpdateMany.mockResolvedValue({ count: 0 });
    mockEnqueueNotification.mockResolvedValue({
        notificationId: 1,
        deliveryId: "delivery_1",
        created: true,
    });
});

describe("P4-1. exactly thirty-six hours", () => {
    test("the target is the start instant minus 36h", () => {
        expect(h36ReminderTargetAt(START).getTime()).toBe(
            START.getTime() - 36 * 60 * 60 * 1000
        );
    });

    test("the due window is inclusive at the target and exclusive at the start", () => {
        const target = h36ReminderTargetAt(START);

        expect(isH36ReminderDue(START, new Date(target.getTime() - 1))).toBe(false);
        expect(isH36ReminderDue(START, target)).toBe(true);
        expect(isH36ReminderDue(START, new Date(START.getTime() - 1))).toBe(true);
        expect(isH36ReminderDue(START, START)).toBe(false);
        expect(isH36ReminderDue(START, new Date(START.getTime() + 60_000))).toBe(false);
    });
});

describe("P4-2. occurrence key and reschedule identity", () => {
    test("contains event, ticket, start instant and channel, and fits the outbox limit", () => {
        const key = h36ReminderIdempotencyKey({
            eventId: "event_1",
            ticketId: "ticket_1",
            startAt: START,
        });

        expect(key).toBe(
            `reminder.h36:event_1:ticket_1:${START.getTime()}:whatsapp:v1`
        );
        expect(key.length).toBeLessThanOrEqual(191);
    });

    test("a rescheduled start is a different occurrence", () => {
        const first = h36ReminderIdempotencyKey({
            eventId: "event_1",
            ticketId: "ticket_1",
            startAt: START,
        });
        const moved = h36ReminderIdempotencyKey({
            eventId: "event_1",
            ticketId: "ticket_1",
            startAt: new Date(START.getTime() + 60 * 60 * 1000),
        });

        expect(moved).not.toBe(first);
    });

    test("channels never share a key", () => {
        const whatsapp = h36ReminderIdempotencyKey({
            eventId: "event_1",
            ticketId: "ticket_1",
            startAt: START,
            channel: "whatsapp",
        });
        const email = h36ReminderIdempotencyKey({
            eventId: "event_1",
            ticketId: "ticket_1",
            startAt: START,
            channel: "email",
        });

        expect(email).not.toBe(whatsapp);
    });
});

describe("P4-3. payload and template", () => {
    test("the template is registered and renders without any contact data", () => {
        expect(hasTemplate(H36_REMINDER_TEMPLATE_KEY)).toBe(true);

        const payload = buildH36ReminderPayload({
            event: {
                title: "Jakarta Marathon",
                startAt: START,
                timezone: "Asia/Jakarta",
                venue: { name: "GBK", address: null, city: "Jakarta" },
            },
        });

        expect(payload).not.toBeNull();

        const rendered = renderNotification(
            H36_REMINDER_TEMPLATE_KEY,
            JSON.stringify(payload)
        );

        expect(rendered.subject).toContain("Jakarta Marathon");
        expect(rendered.subject).toContain("36 jam");
        expect(rendered.text).toContain("GBK");
        expect(rendered.text).not.toMatch(/0812|62812|@|TICKET:|qrToken/i);
    });

    test("an invalid start instant refuses the payload", () => {
        expect(
            buildH36ReminderPayload({
                event: {
                    title: "Broken",
                    startAt: new Date("not-a-date"),
                    timezone: "Asia/Jakarta",
                    venue: null,
                },
            })
        ).toBeNull();
    });

    test("an invalid timezone refuses the payload", () => {
        expect(isValidTimeZone("Asia/Jakarta")).toBe(true);
        expect(isValidTimeZone("Mars/Olympus")).toBe(false);

        expect(
            buildH36ReminderPayload({
                event: {
                    title: "Wrong zone",
                    startAt: START,
                    timezone: "Mars/Olympus",
                    venue: null,
                },
            })
        ).toBeNull();
    });

    test("the displayed time uses the event zone, not the host zone", () => {
        const iso = START.toISOString();

        // 12:00 UTC is 19:00 in Jakarta.
        expect(formatH36EventTime(iso, "Asia/Jakarta")).toMatch(/19[.:]00/);
        expect(formatH36EventTime(iso, "UTC")).toMatch(/12[.:]00/);
    });

    test("a malformed payload renders honestly instead of inventing a time", () => {
        const rendered = renderH36Reminder({ event: { title: "X" } });

        expect(rendered.text).toContain("waktu yang dijadwalkan");
    });
});

describe("P4-4. recipient eligibility (mocked database)", () => {
    test("enqueues one WhatsApp reminder for an eligible issued ticket", async () => {
        mockEventFindMany.mockResolvedValue([eventRow()]);

        const result = await runH36ReminderSweep({ now: NOW });

        expect(mockEnqueueNotification).toHaveBeenCalledTimes(1);

        const input = mockEnqueueNotification.mock.calls[0][0];

        expect(input.channel).toBe("WHATSAPP");
        expect(input.recipient).toBe("6281234567890");
        expect(input.templateKey).toBe(H36_REMINDER_TEMPLATE_KEY);
        expect(input.idempotencyKey).toBe(
            `reminder.h36:event_1:ticket_1:${START.getTime()}:whatsapp:v1`
        );
        expect(input.eventId).toBe("event_1");
        expect(input.ticketId).toBe("ticket_1");
        expect(input.category).toBe("TICKET");

        expect(result.enqueued).toBe(1);
        expect(result.scannedEvents).toBe(1);
        expect(result.scannedTickets).toBe(1);
    });

    test("the query carries the paid-order and issued-ticket rules, not a new policy", async () => {
        await runH36ReminderSweep({ now: NOW });

        const query = mockEventFindMany.mock.calls[0][0];
        const ticketWhere = query.select.tickets.where;

        expect(query.where).toMatchObject({
            status: "PUBLISHED",
            cancelledAt: null,
            archivedAt: null,
        });
        expect(ticketWhere.status).toBe("ISSUED");
        expect(ticketWhere.order).toMatchObject({
            status: "PAID",
            paymentStatus: "PAID",
        });
        expect(ticketWhere.order.paidAt).toEqual({ not: null });
        expect(query.where.startAt.gt).toBe(NOW);
        expect(query.where.startAt.lte.getTime()).toBe(
            NOW.getTime() + H36_OFFSET_MS
        );
    });

    test("missing and invalid phone numbers are skipped, never guessed", async () => {
        mockEventFindMany.mockResolvedValue([
            eventRow({
                tickets: [
                    {
                        id: "ticket_1",
                        orderId: "order_1",
                        holderUserId: null,
                        attendeePhone: null,
                        holder: { phone: null },
                    },
                    {
                        id: "ticket_2",
                        orderId: "order_1",
                        holderUserId: null,
                        attendeePhone: "not-a-phone",
                        holder: { phone: null },
                    },
                ],
            }),
        ]);

        const result = await runH36ReminderSweep({ now: NOW });

        expect(mockEnqueueNotification).not.toHaveBeenCalled();
        expect(result.skippedNoContact).toBe(1);
        expect(result.skippedInvalidContact).toBe(1);
    });

    test("two tickets sharing one phone get one reminder, not two", async () => {
        mockEventFindMany.mockResolvedValue([
            eventRow({
                tickets: [
                    {
                        id: "ticket_1",
                        orderId: "order_1",
                        holderUserId: "user_1",
                        attendeePhone: "0812-3456-7890",
                        holder: { phone: null },
                    },
                    {
                        id: "ticket_2",
                        orderId: "order_1",
                        holderUserId: "user_1",
                        attendeePhone: "+62 812 3456 7890",
                        holder: { phone: null },
                    },
                ],
            }),
        ]);

        const result = await runH36ReminderSweep({ now: NOW });

        expect(mockEnqueueNotification).toHaveBeenCalledTimes(1);
        expect(result.enqueued).toBe(1);
        expect(result.skippedDuplicateRecipient).toBe(1);
    });

    test("the holder phone is used when the attendee phone is absent", async () => {
        mockEventFindMany.mockResolvedValue([
            eventRow({
                tickets: [
                    {
                        id: "ticket_1",
                        orderId: "order_1",
                        holderUserId: "user_1",
                        attendeePhone: null,
                        holder: { phone: "+62 812 3456 7890" },
                    },
                ],
            }),
        ]);

        await runH36ReminderSweep({ now: NOW });

        expect(mockEnqueueNotification.mock.calls[0][0].recipient).toBe(
            "6281234567890"
        );
    });

    test("an invalid event instant skips all its tickets", async () => {
        mockEventFindMany.mockResolvedValue([
            eventRow({ startAt: new Date("not-a-date") }),
        ]);

        const result = await runH36ReminderSweep({ now: NOW });

        expect(mockEnqueueNotification).not.toHaveBeenCalled();
        expect(result.skippedIneligible).toBe(1);
    });
});

describe("P4-5. duplicate and concurrent enqueue", () => {
    test("a repeated tick is an existing occurrence, not a second row", async () => {
        mockEventFindMany.mockResolvedValue([eventRow()]);
        mockEnqueueNotification.mockResolvedValue({
            notificationId: 1,
            deliveryId: "delivery_1",
            created: false,
        });

        const result = await runH36ReminderSweep({ now: NOW });

        expect(result.enqueued).toBe(0);
        expect(result.existing).toBe(1);
    });

    test("two concurrent runs converge on one occurrence key", async () => {
        mockEventFindMany.mockResolvedValue([eventRow()]);

        const seen = new Set<string>();

        mockEnqueueNotification.mockImplementation(
            async (input: { idempotencyKey: string }) => {
                const created = !seen.has(input.idempotencyKey);
                seen.add(input.idempotencyKey);

                return {
                    notificationId: 1,
                    deliveryId: "delivery_1",
                    created,
                };
            }
        );

        const [first, second] = await Promise.all([
            runH36ReminderSweep({ now: NOW }),
            runH36ReminderSweep({ now: NOW }),
        ]);

        expect(seen.size).toBe(1);
        expect(mockEnqueueNotification).toHaveBeenCalledTimes(2);
        expect(first.enqueued + second.enqueued).toBe(1);
        expect(first.existing + second.existing).toBe(1);
    });
});

describe("P4-6. cancellation and reschedule reconciliation", () => {
    function queuedRow(event: Record<string, unknown>, payloadStart: string) {
        return {
            id: "delivery_1",
            notification: {
                payload: JSON.stringify({ event: { startAt: payloadStart } }),
                event,
            },
        };
    }

    test("a rescheduled event retires the old queued occurrence", async () => {
        mockDeliveryFindMany.mockResolvedValue([
            queuedRow(
                {
                    status: "PUBLISHED",
                    startAt: new Date(START.getTime() + 3_600_000),
                    cancelledAt: null,
                    archivedAt: null,
                },
                START.toISOString()
            ),
        ]);
        mockDeliveryUpdateMany.mockResolvedValue({ count: 1 });

        const result = await runH36ReminderSweep({ now: NOW });

        expect(mockDeliveryUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "delivery_1", status: "QUEUED" },
                data: expect.objectContaining({
                    status: "SKIPPED",
                    errorCode: "REMINDER_SUPERSEDED",
                }),
            })
        );
        expect(result.superseded).toBe(1);
    });

    test("a cancelled event retires its queued reminder", async () => {
        mockDeliveryFindMany.mockResolvedValue([
            queuedRow(
                {
                    status: "CANCELLED",
                    startAt: START,
                    cancelledAt: new Date(),
                    archivedAt: null,
                },
                START.toISOString()
            ),
        ]);
        mockDeliveryUpdateMany.mockResolvedValue({ count: 1 });

        await runH36ReminderSweep({ now: NOW });

        expect(mockDeliveryUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    errorCode: "REMINDER_EVENT_CANCELLED",
                }),
            })
        );
    });

    test("an event that already started retires the queued reminder", async () => {
        mockDeliveryFindMany.mockResolvedValue([
            queuedRow(
                {
                    status: "PUBLISHED",
                    startAt: START,
                    cancelledAt: null,
                    archivedAt: null,
                },
                START.toISOString()
            ),
        ]);
        mockDeliveryUpdateMany.mockResolvedValue({ count: 1 });

        await runH36ReminderSweep({
            now: new Date(START.getTime() + 60_000),
        });

        expect(mockDeliveryUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    errorCode: "REMINDER_WINDOW_PASSED",
                }),
            })
        );
    });
});

describe("P4-7. dry-run safety", () => {
    test("the reminder module cannot reach a transport and never sends", () => {
        const source = readFileSync(
            path.join(ROOT, "lib/notifications/h36-reminder.ts"),
            "utf8"
        )
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:])\/\/.*$/gm, "$1");

        expect(source).not.toMatch(/transports|baileys|nodemailer|smtp/i);
        expect(source).not.toMatch(/\.send\s*\(/);
        expect(source).not.toMatch(/claimDueDeliveries|markDeliverySent/);
    });
});
