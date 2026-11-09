import { GatewayHttpServer } from "@/lib/whatsapp/gateway/server";
import type {
    GatewayDeliveryView,
    GatewayDispatchResult,
    GatewayOperations,
    GatewayReconcileResult,
    GatewaySnapshot,
} from "@/lib/whatsapp/gateway/protocol";
import { TEST_TOKEN } from "./helpers";

const TOKEN = TEST_TOKEN;

function snapshot(overrides: Partial<GatewaySnapshot> = {}): GatewaySnapshot {
    return {
        state: "CONNECTED",
        ready: true,
        ownershipHeld: true,
        connected: true,
        sessionPresent: true,
        lastErrorCode: null,
        manualDisconnect: false,
        ...overrides,
    };
}

function makeOperations() {
    const dispatchText = jest.fn<
        Promise<GatewayDispatchResult>,
        [Parameters<GatewayOperations["dispatchText"]>[0]]
    >(async (input) => ({
        status: "SENT",
        deliveryId: input.deliveryId,
        messageId: "message-1",
        ackStatus: "ACCEPTED",
    }));
    const getDelivery = jest.fn<
        Promise<GatewayDeliveryView | null>,
        [string]
    >(async (deliveryId) => ({
        deliveryId,
        state: "SENT",
        ackStatus: "ACCEPTED",
        messageId: "message-1",
        errorCode: null,
        attemptCount: 1,
        acceptedAt: new Date().toISOString(),
        deliveredAt: null,
        readAt: null,
    }));
    const reconcileDelivery = jest.fn<
        Promise<GatewayReconcileResult>,
        [string, Parameters<GatewayOperations["reconcileDelivery"]>[1]]
    >(async (deliveryId) => ({
        status: "RECONCILED",
        deliveryId,
        state: "SENT",
        messageId: "reconciled-1",
    }));

    const operations: GatewayOperations = {
        snapshot: () => snapshot(),
        dispatchText,
        getDelivery,
        reconcileDelivery,
    };

    return { operations, dispatchText, getDelivery, reconcileDelivery };
}

async function startServer(operations: GatewayOperations, maxBodyBytes = 8_192) {
    const server = new GatewayHttpServer(operations, TOKEN, maxBodyBytes);
    await server.start(0, "127.0.0.1");
    const address = server.address;

    if (!address) {
        throw new Error("test server did not expose an address");
    }

    return { server, base: `http://${address.host}:${address.port}` };
}

function authHeaders(extra: Record<string, string> = {}) {
    return {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        ...extra,
    };
}

describe("the internal HTTP surface is authenticated and loopback-only", () => {
    test("refuses a non-loopback bind", async () => {
        const { operations } = makeOperations();
        const server = new GatewayHttpServer(operations, TOKEN, 8_192);

        await expect(server.start(0, "0.0.0.0")).rejects.toThrow(
            /refuses to bind a non-loopback address/
        );
    });

    test("rejects missing and wrong bearer tokens", async () => {
        const { operations } = makeOperations();
        const { server, base } = await startServer(operations);

        try {
            expect((await fetch(`${base}/healthz`)).status).toBe(401);
            expect(
                (
                    await fetch(`${base}/healthz`, {
                        headers: { authorization: "Bearer wrong-token" },
                    })
                ).status
            ).toBe(401);
        } finally {
            await server.close();
        }
    });

    test("health exposes state but never a token, phone or session path", async () => {
        const { operations } = makeOperations();
        const { server, base } = await startServer(operations);

        try {
            const response = await fetch(`${base}/healthz`, {
                headers: authHeaders(),
            });
            const text = await response.text();

            expect(response.status).toBe(200);
            expect(JSON.parse(text)).toMatchObject({
                status: "ok",
                state: "CONNECTED",
            });
            expect(text).not.toContain(TOKEN);
            expect(text).not.toContain("628");
            expect(text).not.toContain("session");
        } finally {
            await server.close();
        }
    });

    test("a malformed payload is rejected before dispatch", async () => {
        const { operations, dispatchText } = makeOperations();
        const { server, base } = await startServer(operations);

        try {
            const response = await fetch(`${base}/v1/messages/text`, {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify({
                    deliveryId: "delivery-1",
                    notificationId: 1,
                    to: "123456@g.us",
                    text: "group message",
                }),
            });

            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({
                error: "INVALID_RECIPIENT",
            });
            expect(dispatchText).not.toHaveBeenCalled();
        } finally {
            await server.close();
        }
    });

    test("accepts a valid text dispatch and forwards the normalized JID", async () => {
        const { operations, dispatchText } = makeOperations();
        const { server, base } = await startServer(operations);

        try {
            const response = await fetch(`${base}/v1/messages/text`, {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify({
                    deliveryId: "delivery-1",
                    notificationId: 9,
                    to: "0812-3456-7890",
                    text: "hello",
                }),
            });

            expect(response.status).toBe(200);
            expect(dispatchText).toHaveBeenCalledWith({
                deliveryId: "delivery-1",
                notificationId: 9,
                jid: "6281234567890@s.whatsapp.net",
                text: "hello",
            });
        } finally {
            await server.close();
        }
    });

    test("caps the body and refuses non-JSON content", async () => {
        const { operations } = makeOperations();
        const { server, base } = await startServer(operations, 1_024);

        try {
            const tooLarge = await fetch(`${base}/v1/messages/text`, {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify({
                    deliveryId: "delivery-1",
                    notificationId: 1,
                    to: "08123456789",
                    text: "x".repeat(2_000),
                }),
            });
            expect(tooLarge.status).toBe(413);

            const wrongType = await fetch(`${base}/v1/messages/text`, {
                method: "POST",
                headers: { authorization: `Bearer ${TOKEN}` },
                body: "{}",
            });
            expect(wrongType.status).toBe(415);
        } finally {
            await server.close();
        }
    });

    test("has no QR route and supports delivery lookup/reconciliation", async () => {
        const { operations, getDelivery, reconcileDelivery } = makeOperations();
        const { server, base } = await startServer(operations);

        try {
            expect(
                (
                    await fetch(`${base}/qr`, {
                        headers: authHeaders(),
                    })
                ).status
            ).toBe(404);

            const lookup = await fetch(`${base}/v1/messages/delivery-1`, {
                headers: authHeaders(),
            });
            expect(lookup.status).toBe(200);
            expect(getDelivery).toHaveBeenCalledWith("delivery-1");

            const reconciled = await fetch(
                `${base}/v1/messages/delivery-1/reconcile`,
                {
                    method: "POST",
                    headers: authHeaders(),
                    body: JSON.stringify({
                        state: "SENT",
                        messageId: "reconciled-1",
                    }),
                }
            );
            expect(reconciled.status).toBe(200);
            expect(reconcileDelivery).toHaveBeenCalledWith("delivery-1", {
                state: "SENT",
                messageId: "reconciled-1",
            });

            const wrongMethod = await fetch(`${base}/v1/messages/text`, {
                headers: authHeaders(),
            });
            expect(wrongMethod.status).toBe(405);
        } finally {
            await server.close();
        }
    });
});
