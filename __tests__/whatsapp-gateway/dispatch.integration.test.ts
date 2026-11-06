import { prisma } from "@/lib/prisma";
import {
    DefiniteSendError,
    WhatsAppGatewayDispatchService,
} from "@/lib/whatsapp/gateway/dispatch";
import type { TextDispatchRequest } from "@/lib/whatsapp/gateway/protocol";
import { TEST_KEY, waitFor } from "./helpers";

jest.setTimeout(120_000);

const PREFIX = `p2d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let sequence = 0;

function id(tag: string): string {
    sequence += 1;
    return `${PREFIX}-${tag}-${sequence}`;
}

function input(tag: string, notificationId = 100): TextDispatchRequest {
    return {
        deliveryId: id(tag),
        notificationId,
        jid: "6281234567890@s.whatsapp.net",
        text: "Your ticket is ready.",
    };
}

const service = new WhatsAppGatewayDispatchService({
    hashKey: TEST_KEY,
    retentionDays: 1,
    dispatchTimeoutMs: 25,
    minSendDelayMs: 0,
});

beforeEach(async () => {
    await prisma.whatsAppGatewayMessage.deleteMany({
        where: { deliveryId: { startsWith: PREFIX } },
    });
    await prisma.notification.deleteMany({
        where: { idempotencyKey: { startsWith: PREFIX } },
    });
});

afterAll(async () => {
    await prisma.whatsAppGatewayMessage.deleteMany({
        where: { deliveryId: { startsWith: PREFIX } },
    });
    await prisma.notification.deleteMany({
        where: { idempotencyKey: { startsWith: PREFIX } },
    });
});

describe("idempotency and durable dispatch", () => {
    test("the first send is SENT/ACCEPTED and a duplicate deliveryId is a replay", async () => {
        const request = input("duplicate");
        const send = jest.fn(async () => ({ messageId: id("message") }));

        const first = await service.dispatch(request, send);
        const second = await service.dispatch(request, send);

        expect(first).toMatchObject({
            status: "SENT",
            ackStatus: "ACCEPTED",
        });
        expect(second).toMatchObject({
            status: "SENT",
            replayed: true,
        });
        expect(send).toHaveBeenCalledTimes(1);

        const row = await prisma.whatsAppGatewayMessage.findUniqueOrThrow({
            where: { deliveryId: request.deliveryId },
        });

        expect(row.state).toBe("SENT");
        expect(row.ackStatus).toBe("ACCEPTED");
        expect(row.deliveredAt).toBeNull();
        expect(row.readAt).toBeNull();
        expect(row.recipientHash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(row)).not.toContain("6281234567890");
        expect(JSON.stringify(row)).not.toContain(request.text);
    });

    test("two concurrent dispatches for one deliveryId reach the socket once", async () => {
        const request = input("concurrent");
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const send = jest.fn(async () => {
            await gate;
            return { messageId: id("concurrent-message") };
        });

        const firstPromise = service.dispatch(request, send);

        await waitFor(() => send.mock.calls.length === 1);

        const second = await service.dispatch(request, send);

        expect(second.status).toBe("IN_PROGRESS");

        release();
        const first = await firstPromise;

        expect(first.status).toBe("SENT");
        expect(send).toHaveBeenCalledTimes(1);
    });

    test("a definite refusal may be retried with the same deliveryId", async () => {
        const request = input("definite-retry");
        let calls = 0;
        const send = jest.fn(async () => {
            calls += 1;

            if (calls === 1) {
                throw new DefiniteSendError("SOCKET_REJECTED");
            }

            return { messageId: id("retry-message") };
        });

        const first = await service.dispatch(request, send);
        const second = await service.dispatch(request, send);

        expect(first).toMatchObject({
            status: "FAILED_BEFORE_SEND",
            errorCode: "SOCKET_REJECTED",
        });
        expect(second.status).toBe("SENT");
        expect(send).toHaveBeenCalledTimes(2);

        const row = await prisma.whatsAppGatewayMessage.findUniqueOrThrow({
            where: { deliveryId: request.deliveryId },
        });

        expect(row.attemptCount).toBe(2);
        expect(row.state).toBe("SENT");
    });

    test("the gateway never changes NotificationDelivery", async () => {
        const notification = await prisma.notification.create({
            data: {
                idempotencyKey: id("notification"),
                channel: "whatsapp",
                recipient: "08123456789",
                category: "SYSTEM",
                deliveries: {
                    create: [{ channel: "WHATSAPP" }],
                },
            },
            include: { deliveries: true },
        });
        const request = input("notification-untouched", notification.id);

        await service.dispatch(request, async () => ({
            messageId: id("notification-message"),
        }));

        const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
            where: { id: notification.deliveries[0].id },
            select: { status: true, attemptCount: true, providerMessageId: true },
        });

        expect(delivery).toEqual({
            status: "QUEUED",
            attemptCount: 0,
            providerMessageId: null,
        });
    });
});

describe("timeout and ambiguous outcomes", () => {
    test("a timeout is AMBIGUOUS, records no DELIVERED claim, and is not retried automatically", async () => {
        const request = input("timeout");
        const send = jest.fn(
            () =>
                new Promise<{ messageId: string | null }>((resolve) => {
                    setTimeout(() => resolve({ messageId: id("late-message") }), 100);
                })
        );

        const first = await service.dispatch(request, send);

        expect(first).toMatchObject({
            status: "AMBIGUOUS",
            errorCode: "DISPATCH_TIMEOUT",
        });

        const row = await prisma.whatsAppGatewayMessage.findUniqueOrThrow({
            where: { deliveryId: request.deliveryId },
        });

        expect(row.state).toBe("AMBIGUOUS");
        expect(row.ackStatus).toBe("NONE");
        expect(row.deliveredAt).toBeNull();

        const second = await service.dispatch(request, send);

        expect(second).toMatchObject({
            status: "AMBIGUOUS",
            replayed: true,
        });
        expect(send).toHaveBeenCalledTimes(1);

        // Let the late socket promise settle. It must not overwrite AMBIGUOUS.
        await new Promise((resolve) => setTimeout(resolve, 120));

        const afterLate = await prisma.whatsAppGatewayMessage.findUniqueOrThrow({
            where: { deliveryId: request.deliveryId },
        });

        expect(afterLate.state).toBe("AMBIGUOUS");
        expect(afterLate.messageId).toBeNull();
        expect(afterLate.ackStatus).toBe("NONE");
    });

    test("an unclassified socket error is ambiguous rather than a blind retry", async () => {
        const request = input("unknown-error");
        const send = jest.fn(async () => {
            throw new Error("the socket disappeared");
        });

        const result = await service.dispatch(request, send);

        expect(result).toMatchObject({
            status: "AMBIGUOUS",
            errorCode: "SEND_OUTCOME_UNKNOWN",
        });

        const row = await prisma.whatsAppGatewayMessage.findUniqueOrThrow({
            where: { deliveryId: request.deliveryId },
        });

        expect(row.state).toBe("AMBIGUOUS");
        expect(row.errorCode).toBe("SEND_OUTCOME_UNKNOWN");
        expect(row.deliveredAt).toBeNull();
    });

    test("a stale SENDING lease becomes AMBIGUOUS without calling the socket", async () => {
        const request = input("stale-lease");

        await prisma.whatsAppGatewayMessage.create({
            data: {
                deliveryId: request.deliveryId,
                notificationId: request.notificationId,
                recipientHash: "a".repeat(64),
                state: "SENDING",
                attemptCount: 1,
                leaseUntil: new Date(Date.now() - 1_000),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const send = jest.fn(async () => ({ messageId: id("stale-message") }));
        const result = await service.dispatch(request, send);

        expect(result).toMatchObject({
            status: "AMBIGUOUS",
            errorCode: "STALE_DISPATCH_LEASE",
        });
        expect(send).not.toHaveBeenCalled();

        const row = await prisma.whatsAppGatewayMessage.findUniqueOrThrow({
            where: { deliveryId: request.deliveryId },
        });

        expect(row.state).toBe("AMBIGUOUS");
    });
});

describe("reconciliation and receipts", () => {
    test("only an explicit reconciliation resolves AMBIGUOUS, and receipts remain monotonic", async () => {
        const request = input("reconcile");
        const send = jest.fn(
            () => new Promise<{ messageId: string | null }>(() => undefined)
        );

        await service.dispatch(request, send);

        const messageId = id("reconciled");

        const reconciled = await service.reconcile(request.deliveryId, {
            state: "SENT",
            messageId,
            note: "operator verified the provider ledger",
        });

        expect(reconciled).toMatchObject({
            status: "RECONCILED",
            state: "SENT",
            messageId,
        });

        let view = await service.get(request.deliveryId);
        expect(view).toMatchObject({
            state: "SENT",
            ackStatus: "ACCEPTED",
            messageId,
        });
        expect(view?.deliveredAt).toBeNull();
        expect(view?.readAt).toBeNull();

        await expect(
            service.recordAckByMessageId(messageId, "delivered")
        ).resolves.toBe(true);
        view = await service.get(request.deliveryId);
        expect(view?.ackStatus).toBe("DELIVERED");
        expect(view?.deliveredAt).not.toBeNull();
        expect(view?.readAt).toBeNull();

        await expect(
            service.recordAckByMessageId(messageId, "read")
        ).resolves.toBe(true);
        view = await service.get(request.deliveryId);
        expect(view?.ackStatus).toBe("READ");
        expect(view?.readAt).not.toBeNull();

        // A late delivery receipt must not move READ backwards.
        await expect(
            service.recordAckByMessageId(messageId, "delivered")
        ).resolves.toBe(false);
        view = await service.get(request.deliveryId);
        expect(view?.ackStatus).toBe("READ");

        await expect(
            service.reconcile(request.deliveryId, {
                state: "SENT",
                messageId: "another",
            })
        ).resolves.toMatchObject({
            status: "NOT_AMBIGUOUS",
            errorCode: "NOT_AMBIGUOUS",
        });
    });

    test("a missing or already-resolved ledger row cannot be reconciled", async () => {
        await expect(
            service.reconcile(id("missing"), {
                state: "FAILED_BEFORE_SEND",
            })
        ).resolves.toMatchObject({ status: "NOT_FOUND" });

        const request = input("resolved");
        await service.dispatch(request, async () => ({
            messageId: id("resolved-message"),
        }));

        await expect(
            service.reconcile(request.deliveryId, {
                state: "FAILED_BEFORE_SEND",
            })
        ).resolves.toMatchObject({ status: "NOT_AMBIGUOUS" });
    });
});
