/**
 * ==========================================
 * PHASE 1 — DELIVERY QUEUE AGAINST THE REAL DATABASE
 * ==========================================
 *
 * The properties that make the queue safe are all database properties: a unique
 * `idempotencyKey`, `UNIQUE(notificationId, channel)`, a CAS claim, a retry gate and a stale
 * lease. Mocking Prisma would test the mock, so these run on the isolated test schema.
 *
 * Every row this suite creates is namespaced by `PREFIX` and removed afterwards. The 44 legacy
 * notifications in the application database are never read, written or deleted — the suite
 * proves separately that rows without a category are invisible to the claim query.
 */

import fs from "node:fs";
import path from "node:path";

import { prisma } from "@/lib/prisma";
import { enqueueNotification } from "@/lib/notifications/enqueue";
import {
    AMBIGUOUS_DELIVERY_CODE,
    claimDueDeliveries,
    computeRetryDelayMs,
    markDeliverySimulated,
    recordDeliveryFailure,
    recoverExpiredDeliveryLeases,
} from "@/lib/notifications/queue";
import { PHASE_1_DRY_RUN_TEMPLATE_KEY } from "@/lib/notifications/templates";

jest.setTimeout(120_000);

const PREFIX = `p1q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let sequence = 0;

function key(tag: string): string {
    sequence += 1;

    return `${PREFIX}-${tag}-${sequence}`;
}

async function enqueueEmail(tag: string) {
    return enqueueNotification({
        idempotencyKey: key(tag),
        channel: "EMAIL",
        recipient: `buyer-${sequence}@example.test`,
        category: "SYSTEM",
        templateKey: PHASE_1_DRY_RUN_TEMPLATE_KEY,
        payload: { reference: "phase-1" },
    });
}

beforeEach(async () => {
    await prisma.notification.deleteMany({
        where: { idempotencyKey: { startsWith: PREFIX } },
    });
});

afterAll(async () => {
    await prisma.notification.deleteMany({
        where: { idempotencyKey: { startsWith: PREFIX } },
    });
});

describe("enqueue is idempotent", () => {
    test("the same key returns the same notification and delivery, and creates one row", async () => {
        const idempotencyKey = key("dup");

        const input = {
            idempotencyKey,
            channel: "EMAIL" as const,
            recipient: "buyer@example.test",
            category: "SYSTEM" as const,
            templateKey: PHASE_1_DRY_RUN_TEMPLATE_KEY,
        };

        const first = await enqueueNotification(input);
        const second = await enqueueNotification(input);

        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.notificationId).toBe(first.notificationId);
        expect(second.deliveryId).toBe(first.deliveryId);

        expect(
            await prisma.notification.count({ where: { idempotencyKey } })
        ).toBe(1);
        expect(
            await prisma.notificationDelivery.count({
                where: { notificationId: first.notificationId },
            })
        ).toBe(1);
    });

    test("the channel write to both columns agrees", async () => {
        const result = await enqueueEmail("channel");

        const notification = await prisma.notification.findUniqueOrThrow({
            where: { id: result.notificationId },
            select: { channel: true, category: true, templateKey: true },
        });

        expect(notification.channel).toBe("email");
        expect(notification.category).toBe("SYSTEM");
        expect(notification.templateKey).toBe(PHASE_1_DRY_RUN_TEMPLATE_KEY);
    });

    test("an unregistered template is refused before any row is written", async () => {
        const idempotencyKey = key("unknown-template");

        await expect(
            enqueueNotification({
                idempotencyKey,
                channel: "EMAIL",
                recipient: "buyer@example.test",
                category: "SYSTEM",
                // Phase 2 registered `purchase-proof.v1`, so this test needs a key that is
                // genuinely unknown. The property under test — refuse BEFORE writing — is
                // unchanged.
                templateKey: "purchase-proof.unregistered.v1",
            })
        ).rejects.toMatchObject({ code: "UNKNOWN_TEMPLATE" });

        expect(
            await prisma.notification.count({ where: { idempotencyKey } })
        ).toBe(0);
    });

    test("IN_APP is not a Phase 1 channel", async () => {
        await expect(
            enqueueNotification({
                idempotencyKey: key("in-app"),
                channel: "IN_APP" as never,
                recipient: "buyer@example.test",
                category: "SYSTEM",
                templateKey: PHASE_1_DRY_RUN_TEMPLATE_KEY,
            })
        ).rejects.toMatchObject({ code: "INVALID_CHANNEL" });
    });
});

describe("a duplicate delivery is rejected by the database", () => {
    test("UNIQUE(notificationId, channel) refuses a second delivery for the same channel", async () => {
        const result = await enqueueEmail("duplicate-delivery");

        await expect(
            prisma.notificationDelivery.create({
                data: {
                    notificationId: result.notificationId,
                    channel: "EMAIL",
                },
            })
        ).rejects.toMatchObject({ code: "P2002" });
    });
});

describe("legacy rows are invisible to the queue", () => {
    test("a notification with category NULL is never claimed, even with a QUEUED delivery", async () => {
        const legacyKey = key("legacy");

        const legacy = await prisma.notification.create({
            data: {
                idempotencyKey: legacyKey,
                channel: "whatsapp",
                recipient: "08123456789",
                // category and templateKey omitted — exactly the shape of the 44 legacy rows.
                deliveries: {
                    create: [{ channel: "WHATSAPP" }],
                },
            },
            select: { id: true, deliveries: { select: { id: true } } },
        });

        const claimed = await claimDueDeliveries({
            now: new Date(),
            limit: 100,
            channels: ["WHATSAPP"],
        });

        expect(claimed.map((row) => row.id)).not.toContain(
            legacy.deliveries[0].id
        );

        const untouched = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: legacy.deliveries[0].id },
            select: { status: true, attemptCount: true },
        });

        expect(untouched).toEqual({ status: "QUEUED", attemptCount: 0 });
    });
});

describe("the claim is a compare-and-set", () => {
    test("two concurrent claims produce exactly one claim", async () => {
        const result = await enqueueEmail("cas");

        const now = new Date();

        const [left, right] = await Promise.all([
            claimDueDeliveries({ now, limit: 50 }),
            claimDueDeliveries({ now, limit: 50 }),
        ]);

        const claims = [...left, ...right].filter(
            (row) => row.id === result.deliveryId
        );

        expect(claims).toHaveLength(1);

        const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: result.deliveryId },
            select: { status: true, attemptCount: true },
        });

        expect(delivery.status).toBe("SENDING");
        expect(delivery.attemptCount).toBe(1);
    });

    test("a claimed row is not claimed again while its lease is live", async () => {
        const result = await enqueueEmail("lease-live");
        const now = new Date();

        const first = await claimDueDeliveries({ now, limit: 50 });
        expect(first.map((row) => row.id)).toContain(result.deliveryId);

        const second = await claimDueDeliveries({
            now: new Date(now.getTime() + 1_000),
            limit: 50,
        });

        expect(second.map((row) => row.id)).not.toContain(result.deliveryId);
    });
});

describe("retry respects nextRetryAt", () => {
    test("a retried delivery is not claimable before its backoff instant", async () => {
        const result = await enqueueEmail("retry");
        const now = new Date("2026-11-04T10:00:00.000Z");

        await claimDueDeliveries({ now, limit: 50 });

        const outcome = await recordDeliveryFailure(result.deliveryId, {
            attemptCount: 1,
            maxAttempts: 3,
            errorCode: "TRANSPORT_ERROR",
            errorMessage: "temporary",
            now,
            random: () => 0.5,
        });

        expect(outcome).toBe("retry-scheduled");

        const early = await claimDueDeliveries({
            now: new Date(now.getTime() + 1_000),
            limit: 50,
        });
        expect(early.map((row) => row.id)).not.toContain(result.deliveryId);

        const due = await claimDueDeliveries({
            now: new Date(now.getTime() + 61_000),
            limit: 50,
        });
        const claimed = due.find((row) => row.id === result.deliveryId);

        expect(claimed).toBeDefined();
        expect(claimed?.attemptCount).toBe(2);
    });

    test("the last attempt is terminal", async () => {
        const result = await enqueueEmail("terminal");

        await claimDueDeliveries({ now: new Date(), limit: 50 });

        const outcome = await recordDeliveryFailure(result.deliveryId, {
            attemptCount: 3,
            maxAttempts: 3,
            errorCode: "TRANSPORT_ERROR",
            errorMessage: "permanent",
            random: () => 0.5,
        });

        expect(outcome).toBe("failed");

        const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: result.deliveryId },
            select: { status: true, nextRetryAt: true, errorCode: true },
        });

        expect(delivery.status).toBe("FAILED");
        expect(delivery.nextRetryAt).toBeNull();
    });

    test("the backoff schedule and its ±20 % jitter are deterministic", () => {
        expect(computeRetryDelayMs(1, () => 0.5)).toBe(60_000);
        expect(computeRetryDelayMs(1, () => 0)).toBe(48_000);
        expect(computeRetryDelayMs(1, () => 1)).toBe(72_000);
        expect(computeRetryDelayMs(2, () => 0.5)).toBe(300_000);
        expect(computeRetryDelayMs(3, () => 0.5)).toBeNull();
        expect(computeRetryDelayMs(0, () => 0.5)).toBeNull();
    });
});

describe("an expired lease is recovered without a blind resend", () => {
    test("recovery marks AMBIGUOUS_DELIVERY and the row is never claimed again", async () => {
        const result = await enqueueEmail("ambiguous");
        const now = new Date("2026-11-04T12:00:00.000Z");

        await claimDueDeliveries({ now, limit: 50, leaseMs: 1_000 });

        // Lease still live.
        expect(
            await recoverExpiredDeliveryLeases({
                now: new Date(now.getTime() + 500),
            })
        ).toBe(0);

        // Lease expired: recovered to a terminal, non-retryable state.
        expect(
            await recoverExpiredDeliveryLeases({
                now: new Date(now.getTime() + 2_000),
            })
        ).toBe(1);

        const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: result.deliveryId },
            select: {
                status: true,
                errorCode: true,
                nextRetryAt: true,
                attemptCount: true,
            },
        });

        expect(delivery.status).toBe("FAILED");
        expect(delivery.errorCode).toBe(AMBIGUOUS_DELIVERY_CODE);
        expect(delivery.nextRetryAt).toBeNull();

        const later = await claimDueDeliveries({
            now: new Date(now.getTime() + 24 * 60 * 60_000),
            limit: 50,
        });

        expect(later.map((row) => row.id)).not.toContain(result.deliveryId);
    });

    test("a simulated delivery is SKIPPED, never SENT", async () => {
        const result = await enqueueEmail("simulated");

        const [claimed] = await claimDueDeliveries({
            now: new Date(),
            limit: 1,
            channels: ["EMAIL"],
        });
        expect(claimed.id).toBe(result.deliveryId);

        await markDeliverySimulated(result.deliveryId, {
            provider: "dry-run-email",
            code: "DRY_RUN_SIMULATED",
            message: "simulation",
        });

        const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: result.deliveryId },
            select: {
                status: true,
                provider: true,
                sentAt: true,
                providerMessageId: true,
                errorCode: true,
            },
        });

        expect(delivery.status).toBe("SKIPPED");
        expect(delivery.sentAt).toBeNull();
        expect(delivery.providerMessageId).toBeNull();
        expect(delivery.errorCode).toBe("DRY_RUN_SIMULATED");
    });
});

describe("the Prisma constraint this suite relies on exists", () => {
    test("the delivery model still declares UNIQUE(notificationId, channel)", () => {
        // Guards the guard: the duplicate-delivery test above is only meaningful while the
        // constraint is present, and a schema edit removing it must fail here.
        const schema = fs.readFileSync(
            path.join(process.cwd(), "prisma", "schema.prisma"),
            "utf8"
        );
        const deliveryModel = schema
            .split("model NotificationDelivery {")[1]
            .split("\n}")[0];

        expect(deliveryModel).toMatch(/@@unique\(\[notificationId, channel\]\)/);
        expect(deliveryModel).toMatch(/@@index\(\[status, nextRetryAt\]\)/);
        expect(deliveryModel).toMatch(/nextRetryAt\s+DateTime\?/);
    });

    test("the legacy filter columns are still nullable on Notification", () => {
        const schema = fs.readFileSync(
            path.join(process.cwd(), "prisma", "schema.prisma"),
            "utf8"
        );
        const notificationModel = schema
            .split("model Notification {")[1]
            .split("\n}")[0];

        expect(notificationModel).toMatch(/category\s+NotificationCategory\?/);
        expect(notificationModel).toMatch(/templateKey\s+String\?/);
        expect(notificationModel).toMatch(/idempotencyKey\s+String\s+@unique/);
    });
});
