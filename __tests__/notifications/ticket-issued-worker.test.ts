/**
 * ==========================================
 * POST-ISSUANCE TICKET NOTIFICATION — WORKER (DRY RUN)
 * ==========================================
 *
 * The worker is the only sender, and it still cannot send. These tests prove the new TICKET
 * template and category behave like the rest of Phase 2 on the real queue:
 *
 *   • a valid row is rendered and recorded as SKIPPED / DRY_RUN_SIMULATED, never SENT;
 *   • invalid contacts are terminal SKIPs and never reach a transport;
 *   • a legacy `category IS NULL` row is invisible to the claim query;
 *   • the WhatsApp cap defers rather than fails;
 *   • no ticket code, recipient, or message body appears in the log.
 */

import { prisma } from "@/lib/prisma";
import { resolveNotificationConfig } from "@/lib/notifications/config";
import { enqueueNotification } from "@/lib/notifications/enqueue";
import { TICKET_ISSUED_TEMPLATE_KEY } from "@/lib/notifications/ticket-issued-template";
import { processNotificationBatch } from "@/lib/notifications/worker";
import { NOTIFICATION_WORKER_LOCK } from "@/lib/notifications/worker-lock";
import type {
    EmailTransport,
    OutboundEmail,
    OutboundWhatsApp,
    TransportContext,
    WhatsAppTransport,
} from "@/lib/notifications/types";

jest.setTimeout(120_000);

const PREFIX = `tixw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CODE = "EVT-7K3M-9A2B";
const CODE_TWO = "EVT-4P8Q-2C5D";
const RECIPIENT = `ticket-worker-${PREFIX}@example.test`;
const PHONE = "081234567890";

let sequence = 0;

const ENABLED = resolveNotificationConfig({ NOTIFICATIONS_ENABLED: "true" });

const TICKET_PAYLOAD = {
    version: "v1",
    orderNumber: "TKL-ORD-2026-000777",
    event: {
        title: "Event Uji Tiket",
        startAt: "2026-12-01T00:00:00.000Z",
        endAt: "2026-12-01T04:00:00.000Z",
        timezone: "Asia/Jakarta",
        venueName: "GBK",
        venueAddress: "Jl. Pintu Satu Senayan",
        venueCity: "Jakarta",
    },
    ticketCount: 2,
    tickets: [{ ticketCode: CODE }, { ticketCode: CODE_TWO }],
    walletUrl: "http://localhost:3000/ticketing/tickets",
    store: null,
};

async function enqueueTicket(
    channel: "EMAIL" | "WHATSAPP",
    recipient: string
) {
    sequence += 1;

    return enqueueNotification({
        idempotencyKey: `${PREFIX}-${channel}-${sequence}`,
        channel,
        recipient,
        category: "TICKET",
        recipientType: "CUSTOMER",
        templateKey: TICKET_ISSUED_TEMPLATE_KEY,
        payload: TICKET_PAYLOAD,
    });
}

function logs(): { lines: string[]; sink: (line: string) => void } {
    const lines: string[] = [];
    return { lines, sink: (line) => lines.push(line) };
}

function transports() {
    const emailSend = jest.fn(
        async (_message: OutboundEmail, _context: TransportContext) =>
            ({ simulated: true }) as const
    );
    const whatsappSend = jest.fn(
        async (_message: OutboundWhatsApp, _context: TransportContext) =>
            ({ simulated: true }) as const
    );

    const email: EmailTransport = {
        name: "test-email",
        kind: "dry-run",
        send: emailSend,
    };
    const whatsapp: WhatsAppTransport = {
        name: "test-whatsapp",
        kind: "dry-run",
        send: whatsappSend,
    };

    return { email, whatsapp, emailSend, whatsappSend };
}

beforeEach(async () => {
    await prisma.notification.deleteMany({
        where: { templateKey: TICKET_ISSUED_TEMPLATE_KEY },
    });
    await prisma.notification.deleteMany({
        where: { idempotencyKey: { startsWith: PREFIX } },
    });
    await prisma.jobLock.deleteMany({
        where: { name: NOTIFICATION_WORKER_LOCK },
    });
});

afterAll(async () => {
    await prisma.notification.deleteMany({
        where: { templateKey: TICKET_ISSUED_TEMPLATE_KEY },
    });
    await prisma.notification.deleteMany({
        where: { idempotencyKey: { startsWith: PREFIX } },
    });
    await prisma.jobLock.deleteMany({
        where: { name: NOTIFICATION_WORKER_LOCK },
    });
});

describe("dry-run rendering", () => {
    test("a TICKET row is simulated, never SENT, and renders the ticket template", async () => {
        const email = await enqueueTicket("EMAIL", RECIPIENT);
        const whatsapp = await enqueueTicket("WHATSAPP", PHONE);
        const { email: emailTransport, whatsapp: whatsappTransport, emailSend, whatsappSend } =
            transports();

        const summary = await processNotificationBatch({
            config: { ...ENABLED, batchSize: 10 },
            log: () => undefined,
            transports: {
                email: emailTransport,
                whatsapp: whatsappTransport,
            },
            countWhatsAppSends: async () => 0,
            wait: async () => undefined,
        });

        expect(summary.sent).toBe(0);
        expect(summary.simulated).toBeGreaterThanOrEqual(2);
        expect(emailSend).toHaveBeenCalledTimes(1);
        expect(whatsappSend).toHaveBeenCalledTimes(1);

        const emailMessage = emailSend.mock.calls[0][0] as {
            to: string;
            subject: string;
            text: string;
        };
        const whatsappMessage = whatsappSend.mock.calls[0][0] as {
            to: string;
            text: string;
        };

        expect(emailMessage.to).toBe(RECIPIENT);
        expect(emailMessage.subject).toContain("Tiket Anda");
        expect(emailMessage.text).toContain(
            "Tiket Anda telah berhasil diterbitkan."
        );
        expect(emailMessage.text).toContain(CODE);
        expect(emailMessage.text).not.toContain("TICKET:");
        expect(whatsappMessage.to).toBe("6281234567890");
        expect(whatsappMessage.text).toContain(CODE);
        expect(whatsappMessage.text).not.toContain("TICKET:");

        for (const row of [email, whatsapp]) {
            const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
                where: { id: row.deliveryId },
                select: {
                    status: true,
                    errorCode: true,
                    providerMessageId: true,
                },
            });

            expect(delivery).toEqual({
                status: "SKIPPED",
                errorCode: "DRY_RUN_SIMULATED",
                providerMessageId: null,
            });
        }

        expect(
            await prisma.notification.count({
                where: {
                    idempotencyKey: { startsWith: PREFIX },
                    category: "TICKET",
                },
            })
        ).toBe(2);
    });
});

describe("terminal contact skips", () => {
    test("an invalid TICKET recipient never reaches a transport", async () => {
        const email = await enqueueTicket("EMAIL", "not-an-email");
        const whatsapp = await enqueueTicket("WHATSAPP", "0212345678");
        const { email: emailTransport, whatsapp: whatsappTransport, emailSend, whatsappSend } =
            transports();

        const summary = await processNotificationBatch({
            config: { ...ENABLED, batchSize: 10 },
            log: () => undefined,
            transports: {
                email: emailTransport,
                whatsapp: whatsappTransport,
            },
            countWhatsAppSends: async () => 0,
            wait: async () => undefined,
        });

        expect(summary.sent).toBe(0);
        expect(emailSend).not.toHaveBeenCalled();
        expect(whatsappSend).not.toHaveBeenCalled();

        for (const row of [email, whatsapp]) {
            const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
                where: { id: row.deliveryId },
                select: { status: true, errorCode: true },
            });

            expect(delivery).toEqual({
                status: "SKIPPED",
                errorCode: "INVALID_RECIPIENT",
            });
        }
    });
});

describe("queue boundaries", () => {
    test("a legacy category NULL row is never claimed", async () => {
        const legacy = await prisma.notification.create({
            data: {
                idempotencyKey: `${PREFIX}-legacy`,
                channel: "whatsapp",
                recipient: PHONE,
                deliveries: { create: [{ channel: "WHATSAPP" }] },
            },
            select: { id: true, deliveries: { select: { id: true } } },
        });
        const ticket = await enqueueTicket("EMAIL", RECIPIENT);

        const summary = await processNotificationBatch({
            config: { ...ENABLED, batchSize: 10 },
            log: () => undefined,
            countWhatsAppSends: async () => 0,
            wait: async () => undefined,
        });

        expect(summary.sent).toBe(0);

        const legacyAfter = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: legacy.deliveries[0].id },
            select: { status: true, attemptCount: true },
        });
        const ticketAfter = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: ticket.deliveryId },
            select: { status: true, errorCode: true },
        });

        expect(legacyAfter).toEqual({ status: "QUEUED", attemptCount: 0 });
        expect(ticketAfter).toEqual({
            status: "SKIPPED",
            errorCode: "DRY_RUN_SIMULATED",
        });
    });

    test("the WhatsApp cap defers rows instead of failing them", async () => {
        const first = await enqueueTicket("WHATSAPP", PHONE);
        const second = await enqueueTicket("WHATSAPP", "081298765432");
        const { whatsapp, whatsappSend } = transports();

        const summary = await processNotificationBatch({
            config: { ...ENABLED, batchSize: 10, whatsappDailyCap: 1 },
            log: () => undefined,
            transports: { whatsapp },
            countWhatsAppSends: async () => 0,
            wait: async () => undefined,
        });

        expect(summary.sent).toBe(0);
        expect(summary.simulated).toBe(1);
        expect(whatsappSend).toHaveBeenCalledTimes(1);

        const statuses = await prisma.notificationDelivery.findMany({
            where: { id: { in: [first.deliveryId, second.deliveryId] } },
            select: { status: true, errorCode: true },
        });

        expect(statuses).toEqual(
            expect.arrayContaining([
                { status: "SKIPPED", errorCode: "DRY_RUN_SIMULATED" },
                { status: "QUEUED", errorCode: null },
            ])
        );
    });
});

describe("log hygiene", () => {
    test("no ticket code, recipient, or message body is logged", async () => {
        await enqueueTicket("EMAIL", RECIPIENT);
        const capture = logs();

        await processNotificationBatch({
            config: { ...ENABLED, batchSize: 5 },
            log: capture.sink,
            countWhatsAppSends: async () => 0,
            wait: async () => undefined,
        });

        const joined = capture.lines.join("\n");

        expect(joined).not.toContain(RECIPIENT);
        expect(joined).not.toContain(CODE);
        expect(joined).not.toContain(CODE_TWO);
        expect(joined).not.toContain("Tiket Anda telah berhasil diterbitkan.");
        expect(joined).not.toContain("DRY_RUN_SIMULATED");
        expect(joined).toContain("notification.dispatch.simulated");
    });
});
