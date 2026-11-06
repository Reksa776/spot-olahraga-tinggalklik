/**
 * ==========================================
 * PHASE 2 — WORKER POLICY (REAL QUEUE, DRY RUN)
 * ==========================================
 *
 * The worker is the only sender, and in Phase 2 it still cannot send. These tests exercise the
 * Phase 2 additions on the real queue:
 *
 *   • an invalid recipient is a terminal SKIP, never a transport call;
 *   • WhatsApp is paused before each send and is capped per day (deferred, never failed);
 *   • the delivery outcomes are SKIPPED / DRY_RUN_SIMULATED, never SENT;
 *   • no recipient, body or ticket code reaches the log.
 */

import { prisma } from "@/lib/prisma";
import { resolveNotificationConfig } from "@/lib/notifications/config";
import { enqueueNotification } from "@/lib/notifications/enqueue";
import { PURCHASE_PROOF_TEMPLATE_KEY } from "@/lib/notifications/purchase-proof-template";
import { processNotificationBatch } from "@/lib/notifications/worker";
import { NOTIFICATION_WORKER_LOCK } from "@/lib/notifications/worker-lock";
import type {
    EmailTransport,
    WhatsAppTransport,
} from "@/lib/notifications/types";

jest.setTimeout(120_000);

const PREFIX = `p2w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let sequence = 0;

const ENABLED = resolveNotificationConfig({ NOTIFICATIONS_ENABLED: "true" });

const PROOF_PAYLOAD = {
    version: "v1",
    orderNumber: "TKL-ORD-2026-000999",
    buyerName: "Budi Santoso",
    paidAt: "2026-11-04T10:15:00.000Z",
    createdAt: "2026-11-04T10:00:00.000Z",
    currency: "IDR",
    items: [
        {
            name: "VIP",
            quantity: 1,
            unitPrice: "150000.00",
            subtotal: "150000.00",
        },
    ],
    itemCount: 1,
    subtotal: "150000.00",
    discount: "0.00",
    total: "150000.00",
    paymentMethod: "QRIS",
    paymentChannel: "mpm",
    paymentStatus: "PAID",
    event: {
        title: "Event Uji",
        startAt: "2026-12-01T00:00:00.000Z",
        endAt: null,
        timezone: "Asia/Jakarta",
        venueName: null,
        venueAddress: null,
        venueCity: null,
    },
    organizerName: "Panitia Uji",
    store: null,
    tickets: [{ ticketCode: "EVT-7K3M-9A2B" }],
};

async function enqueueProof(
    channel: "EMAIL" | "WHATSAPP",
    recipient: string
) {
    sequence += 1;

    return enqueueNotification({
        idempotencyKey: `${PREFIX}-${channel}-${sequence}`,
        channel,
        recipient,
        category: "ORDER",
        recipientType: "CUSTOMER",
        templateKey: PURCHASE_PROOF_TEMPLATE_KEY,
        payload: PROOF_PAYLOAD,
    });
}

function logs(): { lines: string[]; sink: (line: string) => void } {
    const lines: string[] = [];
    return { lines, sink: (line) => lines.push(line) };
}

beforeEach(async () => {
    // Scope: every purchase-proof row in the isolated TEST database. Other suites have already
    // finished (Jest runs one worker here), and a proof row left by a previous run would
    // otherwise be claimed by this batch and make the counts non-deterministic.
    await prisma.notification.deleteMany({
        where: { templateKey: PURCHASE_PROOF_TEMPLATE_KEY },
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
        where: { templateKey: PURCHASE_PROOF_TEMPLATE_KEY },
    });
    await prisma.notification.deleteMany({
        where: { idempotencyKey: { startsWith: PREFIX } },
    });
    await prisma.jobLock.deleteMany({
        where: { name: NOTIFICATION_WORKER_LOCK },
    });
});

describe("invalid recipients are terminally skipped", () => {
    test("a malformed email and phone never reach a transport", async () => {
        const email = await enqueueProof("EMAIL", "not-an-email");
        const whatsapp = await enqueueProof("WHATSAPP", "0212345678");

        const emailSend = jest.fn(async () => ({ simulated: true }) as const);
        const whatsappSend = jest.fn(async () => ({ simulated: true }) as const);

        const emailTransport: EmailTransport = {
            name: "test-email",
            kind: "dry-run",
            send: emailSend,
        };
        const whatsappTransport: WhatsAppTransport = {
            name: "test-whatsapp",
            kind: "dry-run",
            send: whatsappSend,
        };

        const summary = await processNotificationBatch({
            config: { ...ENABLED, batchSize: 10 },
            log: () => undefined,
            transports: { email: emailTransport, whatsapp: whatsappTransport },
            countWhatsAppSends: async () => 0,
            wait: async () => undefined,
        });

        expect(summary.claimed).toBeGreaterThanOrEqual(2);
        expect(summary.sent).toBe(0);
        expect(emailSend).not.toHaveBeenCalled();
        expect(whatsappSend).not.toHaveBeenCalled();

        for (const row of [email, whatsapp]) {
            const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
                where: { id: row.deliveryId },
                select: { status: true, errorCode: true, providerMessageId: true },
            });

            expect(delivery).toEqual({
                status: "SKIPPED",
                errorCode: "INVALID_RECIPIENT",
                providerMessageId: null,
            });
        }
    });
});

describe("conservative WhatsApp policy", () => {
    test("waits before the send and records only a simulation", async () => {
        const order = await enqueueProof("WHATSAPP", "+62 812-3456-7890");
        const events: string[] = [];
        let sentTo = "";

        const transport: WhatsAppTransport = {
            name: "test-whatsapp",
            kind: "dry-run",
            async send(message) {
                sentTo = message.to;
                events.push("send");
                return { simulated: true };
            },
        };

        const summary = await processNotificationBatch({
            config: { ...ENABLED, batchSize: 1, whatsappSendDelayMs: 5_000 },
            log: () => undefined,
            transports: { whatsapp: transport },
            countWhatsAppSends: async () => 0,
            wait: async (ms) => {
                events.push(`wait:${ms}`);
            },
        });

        expect(summary.simulated).toBeGreaterThanOrEqual(1);
        expect(summary.sent).toBe(0);
        expect(events).toEqual(["wait:5000", "send"]);

        const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: order.deliveryId },
            select: {
                status: true,
                errorCode: true,
                provider: true,
            },
        });

        expect(delivery).toMatchObject({
            status: "SKIPPED",
            errorCode: "DRY_RUN_SIMULATED",
            provider: "test-whatsapp",
        });

        const row = await prisma.notification.findUniqueOrThrow({
            where: { id: order.notificationId },
            select: { recipient: true },
        });

        // The transport receives the normalized international form...
        expect(sentTo).toBe("6281234567890");
        // ...while the queue row still carries exactly what was enqueued. The ORDER's contact
        // columns are never rewritten by the worker either.
        expect(row.recipient).toBe("+62 812-3456-7890");
    });

    test("a reached daily cap defers rows without claiming, failing or sending", async () => {
        const first = await enqueueProof("WHATSAPP", "081234567890");
        const second = await enqueueProof("WHATSAPP", "081298765432");

        const send = jest.fn(async () => ({ simulated: true }) as const);
        const transport: WhatsAppTransport = {
            name: "test-whatsapp",
            kind: "dry-run",
            send,
        };
        const capture = logs();

        const summary = await processNotificationBatch({
            config: { ...ENABLED, batchSize: 10, whatsappDailyCap: 1 },
            log: capture.sink,
            transports: { whatsapp: transport },
            countWhatsAppSends: async () => 1,
            wait: async () => undefined,
        });

        expect(summary.sent).toBe(0);
        expect(send).not.toHaveBeenCalled();
        expect(capture.lines.join("\n")).toContain(
            "notification.whatsapp.daily_cap_reached"
        );

        for (const row of [first, second]) {
            const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
                where: { id: row.deliveryId },
                select: { status: true, attemptCount: true },
            });

            expect(delivery).toEqual({ status: "QUEUED", attemptCount: 0 });
        }
    });

    test("a partial allowance claims at most the remaining quota", async () => {
        await enqueueProof("WHATSAPP", "081234567890");
        await enqueueProof("WHATSAPP", "081298765432");

        const send = jest.fn(async () => ({ simulated: true }) as const);
        const transport: WhatsAppTransport = {
            name: "test-whatsapp",
            kind: "dry-run",
            send,
        };

        const summary = await processNotificationBatch({
            config: { ...ENABLED, batchSize: 10, whatsappDailyCap: 5 },
            log: () => undefined,
            transports: { whatsapp: transport },
            // Four already used today → exactly one may be claimed in this batch.
            countWhatsAppSends: async () => 4,
            wait: async () => undefined,
        });

        expect(summary.simulated).toBeGreaterThanOrEqual(1);
        expect(send).toHaveBeenCalledTimes(1);

        const queued = await prisma.notificationDelivery.count({
            where: {
                notification: { idempotencyKey: { startsWith: PREFIX } },
                status: "QUEUED",
            },
        });

        expect(queued).toBe(1);
    });
});

describe("logs carry no message content", () => {
    test("no recipient, body, ticket code or order-level personal data is logged", async () => {
        await enqueueProof("EMAIL", "buyer-p2@example.test");
        const capture = logs();

        await processNotificationBatch({
            config: { ...ENABLED, batchSize: 5 },
            log: capture.sink,
            countWhatsAppSends: async () => 0,
            wait: async () => undefined,
        });

        const joined = capture.lines.join("\n");

        expect(joined).not.toContain("buyer-p2@example.test");
        expect(joined).not.toContain("EVT-7K3M-9A2B");
        expect(joined).not.toContain("Budi Santoso");
        expect(joined).not.toContain("Bukti pembelian");
        expect(joined).not.toContain("DRY_RUN_SIMULATED");
        expect(joined).toContain("notification.dispatch.simulated");
    });
});
