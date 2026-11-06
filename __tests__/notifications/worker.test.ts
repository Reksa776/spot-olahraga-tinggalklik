/**
 * ==========================================
 * PHASE 1 — THE WORKER (DRY RUN, CONCURRENCY, SHUTDOWN, LOGS)
 * ==========================================
 *
 * These tests run the real worker against the real queue in the isolated test database. The
 * transport is the real dry-run transport except where a test injects a controllable one to
 * observe shutdown and failure paths.
 *
 * What they prove, in the owner's terms:
 *   • the worker polls the database and processes a batch;
 *   • a batch is dry-run: delivery ends SKIPPED / DRY_RUN_SIMULATED, not SENT;
 *   • the kill switch OFF claims nothing;
 *   • two worker instances do not process the same delivery twice;
 *   • graceful shutdown finishes the in-flight delivery and claims no more;
 *   • no credential or recipient reaches the structured log.
 */

import { prisma } from "@/lib/prisma";
import { resolveNotificationConfig } from "@/lib/notifications/config";
import { enqueueNotification } from "@/lib/notifications/enqueue";
import { PHASE_1_DRY_RUN_TEMPLATE_KEY } from "@/lib/notifications/templates";
import {
    createNotificationWorker,
    processNotificationBatch,
} from "@/lib/notifications/worker";
import {
    NOTIFICATION_WORKER_LOCK,
    readNotificationWorkerLease,
} from "@/lib/notifications/worker-lock";
import type { EmailTransport } from "@/lib/notifications/types";

jest.setTimeout(120_000);

const PREFIX = `p1w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let sequence = 0;

const ENABLED = {
    ...resolveNotificationConfig({ NOTIFICATIONS_ENABLED: "true" }),
};

async function enqueueEmail(tag: string) {
    sequence += 1;

    const recipient = `worker-buyer-${sequence}@example.test`;

    const result = await enqueueNotification({
        idempotencyKey: `${PREFIX}-${tag}-${sequence}`,
        channel: "EMAIL",
        recipient,
        category: "SYSTEM",
        templateKey: PHASE_1_DRY_RUN_TEMPLATE_KEY,
        payload: { reference: "phase-1-worker" },
    });

    return { ...result, recipient };
}

function collectLog(): { lines: string[]; sink: (line: string) => void } {
    const lines: string[] = [];

    return { lines, sink: (line: string) => lines.push(line) };
}

beforeEach(async () => {
    await prisma.notification.deleteMany({
        where: { idempotencyKey: { startsWith: PREFIX } },
    });
    await prisma.jobLock.deleteMany({
        where: { name: NOTIFICATION_WORKER_LOCK },
    });
});

afterAll(async () => {
    await prisma.notification.deleteMany({
        where: { idempotencyKey: { startsWith: PREFIX } },
    });
    await prisma.jobLock.deleteMany({
        where: { name: NOTIFICATION_WORKER_LOCK },
    });
});

describe("the kill switch performs no work at all", () => {
    test("NOTIFICATIONS_ENABLED=false claims nothing and leaves the delivery QUEUED", async () => {
        const { deliveryId } = await enqueueEmail("disabled");
        const logs = collectLog();

        const summary = await processNotificationBatch({
            config: resolveNotificationConfig({}),
            log: logs.sink,
        });

        expect(summary).toMatchObject({
            ran: false,
            reason: "DISABLED",
            claimed: 0,
        });

        const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: deliveryId },
            select: { status: true, attemptCount: true },
        });

        expect(delivery).toEqual({ status: "QUEUED", attemptCount: 0 });

        // No lease row is created either: a disabled worker does not touch the database.
        expect(await readNotificationWorkerLease()).toBeNull();
        // And nothing is logged that could be mistaken for a send.
        expect(logs.lines.join("\n")).not.toMatch(/"sent":/);
    });
});

describe("a batch is processed as a dry run", () => {
    test("the delivery ends SKIPPED / DRY_RUN_SIMULATED with no provider message", async () => {
        const { deliveryId } = await enqueueEmail("dry-run");
        const logs = collectLog();

        const summary = await processNotificationBatch({
            config: ENABLED,
            log: logs.sink,
            now: () => new Date(),
        });

        expect(summary.ran).toBe(true);
        expect(summary.claimed).toBeGreaterThanOrEqual(1);
        expect(summary.simulated).toBeGreaterThanOrEqual(1);
        expect(summary.sent).toBe(0);

        const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: deliveryId },
            select: {
                status: true,
                provider: true,
                errorCode: true,
                sentAt: true,
                providerMessageId: true,
            },
        });

        expect(delivery).toEqual({
            status: "SKIPPED",
            provider: "dry-run-email",
            errorCode: "DRY_RUN_SIMULATED",
            sentAt: null,
            providerMessageId: null,
        });

        const joined = logs.lines.join("\n");

        expect(joined).toContain("notification.dispatch.simulated");
        expect(joined).toContain('"outcome":"simulated"');
        expect(joined).not.toContain("notification.dispatch.sent");
        // The recipient is personal data; the log must not carry it.
        expect(joined).not.toContain("@example.test");
    });

    test("the worker lease is released and its heartbeat recorded", async () => {
        await enqueueEmail("heartbeat");

        await processNotificationBatch({
            config: ENABLED,
            log: () => undefined,
        });

        const lease = await readNotificationWorkerLease();

        expect(lease).not.toBeNull();
        expect(lease?.lockedUntil).toBeNull();
        expect(lease?.lockedBy).toBeNull();
        expect(lease?.lastRunAt).toBeInstanceOf(Date);
        expect(lease?.lastStatus).toBe("OK");
    });
});

describe("two workers are safe at the same time", () => {
    test("one delivery is claimed and processed exactly once", async () => {
        const { deliveryId } = await enqueueEmail("two-workers");
        const silent = () => undefined;

        const [first, second] = await Promise.all([
            processNotificationBatch({
                config: ENABLED,
                log: silent,
                workerId: `${PREFIX}-a`,
            }),
            processNotificationBatch({
                config: ENABLED,
                log: silent,
                workerId: `${PREFIX}-b`,
            }),
        ]);

        expect(first.claimed + second.claimed).toBe(1);
        expect(first.simulated + second.simulated).toBe(1);

        const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: deliveryId },
            select: { status: true, attemptCount: true },
        });

        expect(delivery).toEqual({ status: "SKIPPED", attemptCount: 1 });
    });

    test("a second batch while the lease is held is a no-op", async () => {
        await enqueueEmail("lease-held");

        // Hold the lease as if another process had claimed it.
        await prisma.jobLock.upsert({
            where: { name: NOTIFICATION_WORKER_LOCK },
            create: {
                name: NOTIFICATION_WORKER_LOCK,
                lockedUntil: new Date(Date.now() + 60_000),
                lockedBy: "other-process",
            },
            update: {
                lockedUntil: new Date(Date.now() + 60_000),
                lockedBy: "other-process",
            },
        });

        const summary = await processNotificationBatch({
            config: ENABLED,
            log: () => undefined,
        });

        expect(summary).toMatchObject({
            ran: false,
            reason: "LEASE_HELD",
            claimed: 0,
        });
    });
});

describe("graceful shutdown", () => {
    test("stop() finishes the in-flight delivery and claims no further work", async () => {
        const first = await enqueueEmail("shutdown-1");
        const second = await enqueueEmail("shutdown-2");

        let startedResolve: () => void = () => undefined;
        const started = new Promise<void>((resolve) => {
            startedResolve = resolve;
        });

        let releaseResolve: () => void = () => undefined;
        const release = new Promise<void>((resolve) => {
            releaseResolve = resolve;
        });

        const email: EmailTransport = {
            name: "test-deferred",
            kind: "dry-run",
            async send() {
                startedResolve();
                await release;

                return { simulated: true };
            },
        };

        const worker = createNotificationWorker({
            // One row per batch, so the second delivery must wait for a later poll.
            config: { ...ENABLED, batchSize: 1 },
            log: () => undefined,
            transports: { email },
        });

        const loop = worker.start();

        await started;

        const stopping = worker.stop();
        releaseResolve();

        await stopping;
        await loop;

        const firstRow = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: first.deliveryId },
            select: { status: true, errorCode: true },
        });
        const secondRow = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: second.deliveryId },
            select: { status: true, attemptCount: true },
        });

        expect(firstRow).toEqual({
            status: "SKIPPED",
            errorCode: "DRY_RUN_SIMULATED",
        });
        // Never claimed: shutdown did not start new work.
        expect(secondRow).toEqual({ status: "QUEUED", attemptCount: 0 });

        // runOnce after stop is a no-op, not another batch.
        await expect(worker.runOnce()).resolves.toMatchObject({
            ran: false,
            reason: "STOPPING",
        });
    });
});

describe("logs carry no secrets", () => {
    test("a provider error with embedded credentials is sanitised before storage and logging", async () => {
        const { deliveryId } = await enqueueEmail("secret-log");
        const logs = collectLog();

        const email: EmailTransport = {
            name: "test-failing",
            kind: "dry-run",
            async send() {
                throw new Error(
                    "connect smtp://mailer:super-secret-password@smtp.example.test:587 failed for buyer@example.test"
                );
            },
        };

        const summary = await processNotificationBatch({
            config: { ...ENABLED, batchSize: 1 },
            log: logs.sink,
            transports: { email },
            random: () => 0.5,
        });

        expect(summary.retried).toBe(1);

        const joined = logs.lines.join("\n");

        expect(joined).not.toContain("super-secret-password");
        expect(joined).not.toContain("buyer@example.test");
        expect(joined).toContain("notification.dispatch.failed");

        const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: deliveryId },
            select: { status: true, errorMessage: true, errorCode: true },
        });

        expect(delivery.status).toBe("QUEUED");
        expect(delivery.errorCode).toBe("TRANSPORT_ERROR");
        expect(delivery.errorMessage ?? "").not.toContain("super-secret-password");
        expect(delivery.errorMessage ?? "").not.toContain("buyer@example.test");
    });
});

describe("live transports are refused by the worker", () => {
    test("an injected SMTP transport aborts the batch instead of sending", async () => {
        const { deliveryId } = await enqueueEmail("live-refused");

        const email: EmailTransport = {
            name: "smtp",
            kind: "smtp",
            async send() {
                throw new Error("must never be called");
            },
        };

        await expect(
            processNotificationBatch({
                config: ENABLED,
                log: () => undefined,
                transports: { email },
            })
        ).rejects.toThrow(/refuses to run with a live SMTP or Baileys transport/);

        const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: deliveryId },
            select: { status: true, attemptCount: true },
        });

        expect(delivery).toEqual({ status: "QUEUED", attemptCount: 0 });
    });
});
