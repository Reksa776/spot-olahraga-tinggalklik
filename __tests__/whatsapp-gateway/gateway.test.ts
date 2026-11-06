import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import {
    readWhatsAppGatewayLease,
    WHATSAPP_GATEWAY_LEASE_NAME,
} from "@/lib/whatsapp/gateway/lease";
import { LocalProcessLock } from "@/lib/whatsapp/gateway/local-lock";
import { WhatsAppGateway, type Logger } from "@/lib/whatsapp/gateway/gateway";
import type { SocketFactory } from "@/lib/whatsapp/gateway/socket";
import {
    createTempSessionDir,
    FakeSocket,
    gatewayConfig,
    removeTempDir,
    TEST_TOKEN,
    waitFor,
    writeTestSession,
} from "./helpers";

jest.setTimeout(120_000);

const PREFIX = `p2g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let sequence = 0;

const temporaryDirectories: string[] = [];
const gateways: WhatsAppGateway[] = [];

function deliveryId(tag: string): string {
    sequence += 1;
    return `${PREFIX}-${tag}-${sequence}`;
}

async function tempDir(): Promise<string> {
    const directory = await createTempSessionDir();
    temporaryDirectories.push(directory);
    return directory;
}

function makeGateway(
    directory: string,
    socketFactory: SocketFactory,
    overrides: Parameters<typeof gatewayConfig>[1] = {},
    logger?: Logger
): WhatsAppGateway {
    return new WhatsAppGateway(gatewayConfig(directory, overrides), {
        socketFactory,
        logger,
    });
}

function authHeaders(): Record<string, string> {
    return {
        authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": "application/json",
    };
}

async function call(
    gateway: WhatsAppGateway,
    pathname: string,
    init: RequestInit = {}
): Promise<Response> {
    const address = gateway.boundAddress;

    if (!address) {
        throw new Error("gateway has no bound address");
    }

    return fetch(`http://${address.host}:${address.port}${pathname}`, init);
}

function body(tag: string, overrides: Record<string, unknown> = {}) {
    return {
        deliveryId: deliveryId(tag),
        notificationId: 100,
        to: "08123456789",
        text: "Your ticket is ready.",
        ...overrides,
    };
}

beforeEach(async () => {
    await prisma.whatsAppGatewayMessage.deleteMany({
        where: { deliveryId: { startsWith: PREFIX } },
    });
    await prisma.jobLock.deleteMany({
        where: { name: WHATSAPP_GATEWAY_LEASE_NAME },
    });
});

afterEach(async () => {
    for (const gateway of gateways.splice(0)) {
        await gateway.stop();
    }

    await Promise.all(temporaryDirectories.splice(0).map(removeTempDir));
    await prisma.whatsAppGatewayMessage.deleteMany({
        where: { deliveryId: { startsWith: PREFIX } },
    });
    await prisma.jobLock.deleteMany({
        where: { name: WHATSAPP_GATEWAY_LEASE_NAME },
    });
});

afterAll(async () => {
    await prisma.whatsAppGatewayMessage.deleteMany({
        where: { deliveryId: { startsWith: PREFIX } },
    });
    await prisma.jobLock.deleteMany({
        where: { name: WHATSAPP_GATEWAY_LEASE_NAME },
    });
});

describe("lifecycle with no real account", () => {
    test("no encrypted session => PAIRING_REQUIRED, no socket, loopback health only", async () => {
        const directory = await tempDir();
        const fake = new FakeSocket();
        const factory = jest.fn(async () => fake);
        const gateway = makeGateway(directory, factory);

        gateways.push(gateway);

        const snapshot = await gateway.start();

        expect(snapshot).toMatchObject({
            state: "PAIRING_REQUIRED",
            ready: false,
            sessionPresent: false,
        });
        expect(factory).not.toHaveBeenCalled();
        expect(gateway.boundAddress?.host).toBe("127.0.0.1");

        const ready = await call(gateway, "/readyz", {
            headers: authHeaders(),
        });

        expect(ready.status).toBe(503);
        expect(await ready.json()).toMatchObject({
            status: "not_ready",
            state: "PAIRING_REQUIRED",
            sessionPresent: false,
        });
    });

    test("a database owner conflict stops before creating a socket or server", async () => {
        const directory = await tempDir();
        const factory = jest.fn(async () => new FakeSocket());
        const gateway = makeGateway(directory, factory);

        gateways.push(gateway);

        await prisma.jobLock.upsert({
            where: { name: WHATSAPP_GATEWAY_LEASE_NAME },
            create: {
                name: WHATSAPP_GATEWAY_LEASE_NAME,
                lockedBy: "another-gateway",
                lockedUntil: new Date(Date.now() + 60_000),
            },
            update: {
                lockedBy: "another-gateway",
                lockedUntil: new Date(Date.now() + 60_000),
            },
        });

        const snapshot = await gateway.start();

        expect(snapshot.state).toBe("CONFLICT");
        expect(factory).not.toHaveBeenCalled();
        expect(gateway.boundAddress).toBeNull();
    });

    test("a local lock conflict releases the DB lease and stops", async () => {
        const directory = await tempDir();
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });

        const lock = new LocalProcessLock(
            path.join(directory, ".gateway.lock"),
            "other-owner"
        );
        await lock.acquire();

        const factory = jest.fn(async () => new FakeSocket());
        const gateway = makeGateway(directory, factory);

        gateways.push(gateway);

        try {
            const snapshot = await gateway.start();

            expect(snapshot.state).toBe("CONFLICT");
            expect(factory).not.toHaveBeenCalled();
            expect(await readWhatsAppGatewayLease()).toMatchObject({
                lockedBy: null,
                lockedUntil: null,
            });
        } finally {
            await lock.release();
        }
    });
});

describe("mocked socket dispatch and shutdown", () => {
    test("a connected dispatch is SENT/ACCEPTED, replay-safe and returns no credentials", async () => {
        const directory = await tempDir();
        await writeTestSession(directory);

        const fake = new FakeSocket();
        const gateway = makeGateway(directory, async () => fake);

        gateways.push(gateway);

        await gateway.start();
        fake.emit({ type: "connection", status: "open" });
        await waitFor(() => gateway.state === "CONNECTED");

        const request = body("connected");
        const first = await call(gateway, "/v1/messages/text", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(request),
        });

        expect(first.status).toBe(200);
        expect(await first.json()).toMatchObject({
            status: "SENT",
            deliveryId: request.deliveryId,
            ackStatus: "ACCEPTED",
        });

        const second = await call(gateway, "/v1/messages/text", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(request),
        });

        expect(second.status).toBe(200);
        expect(await second.json()).toMatchObject({
            status: "SENT",
            replayed: true,
        });
        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0].jid).toBe("628123456789@s.whatsapp.net");

        const row = await prisma.whatsAppGatewayMessage.findUniqueOrThrow({
            where: { deliveryId: request.deliveryId },
        });

        expect(row.state).toBe("SENT");
        expect(row.ackStatus).toBe("ACCEPTED");
        expect(row.deliveredAt).toBeNull();

        const health = await call(gateway, "/healthz", {
            headers: authHeaders(),
        });
        const healthText = await health.text();

        expect(health.status).toBe(200);
        expect(healthText).not.toContain(TEST_TOKEN);
        expect(healthText).not.toContain(directory);
        expect(healthText).not.toContain("628");
    });

    test("malformed payload creates no ledger row and never reaches the socket", async () => {
        const directory = await tempDir();
        await writeTestSession(directory);

        const fake = new FakeSocket();
        const gateway = makeGateway(directory, async () => fake);

        gateways.push(gateway);

        await gateway.start();
        fake.emit({ type: "connection", status: "open" });
        await waitFor(() => gateway.state === "CONNECTED");

        const request = body("malformed", { to: "123456@g.us" });
        const response = await call(gateway, "/v1/messages/text", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(request),
        });

        expect(response.status).toBe(400);
        expect(fake.sent).toHaveLength(0);
        expect(
            await prisma.whatsAppGatewayMessage.count({
                where: { deliveryId: request.deliveryId },
            })
        ).toBe(0);
    });

    test("a timeout stays AMBIGUOUS and the duplicate is not sent again", async () => {
        const directory = await tempDir();
        await writeTestSession(directory);

        const fake = new FakeSocket();
        fake.sendImplementation = () =>
            new Promise((resolve) => {
                setTimeout(
                    () => resolve({ messageId: `${PREFIX}-late` }),
                    100
                );
            });

        const gateway = makeGateway(directory, async () => fake, {
            dispatchTimeoutMs: 20,
        });

        gateways.push(gateway);

        await gateway.start();
        fake.emit({ type: "connection", status: "open" });
        await waitFor(() => gateway.state === "CONNECTED");

        const request = body("timeout");
        const first = await call(gateway, "/v1/messages/text", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(request),
        });

        expect(first.status).toBe(409);
        expect(await first.json()).toMatchObject({
            status: "AMBIGUOUS",
            errorCode: "DISPATCH_TIMEOUT",
        });

        const second = await call(gateway, "/v1/messages/text", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(request),
        });

        expect(second.status).toBe(409);
        expect(await second.json()).toMatchObject({ status: "AMBIGUOUS" });
        expect(fake.sent).toHaveLength(1);

        const row = await prisma.whatsAppGatewayMessage.findUniqueOrThrow({
            where: { deliveryId: request.deliveryId },
        });

        expect(row.state).toBe("AMBIGUOUS");
        expect(row.ackStatus).toBe("NONE");

        // Let the late promise settle before the next test.
        await new Promise((resolve) => setTimeout(resolve, 120));
    });

    test("graceful shutdown finishes an in-flight dispatch, then releases ownership", async () => {
        const directory = await tempDir();
        await writeTestSession(directory);

        const fake = new FakeSocket();
        let startedResolve: () => void = () => undefined;
        const started = new Promise<void>((resolve) => {
            startedResolve = resolve;
        });
        let releaseResolve: () => void = () => undefined;
        const release = new Promise<void>((resolve) => {
            releaseResolve = resolve;
        });

        fake.sendImplementation = async () => {
            startedResolve();
            await release;
            return { messageId: `${PREFIX}-shutdown` };
        };

        const gateway = makeGateway(directory, async () => fake);

        gateways.push(gateway);

        await gateway.start();
        fake.emit({ type: "connection", status: "open" });
        await waitFor(() => gateway.state === "CONNECTED");

        const request = body("shutdown");
        const requestPromise = call(gateway, "/v1/messages/text", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(request),
        });

        await started;
        const stopping = gateway.stop();
        releaseResolve();

        const response = await requestPromise;
        await stopping;

        expect(response.status).toBe(200);
        expect(gateway.state).toBe("STOPPED");
        expect(fake.ended).toBe(true);
        expect(await readWhatsAppGatewayLease()).toMatchObject({
            lockedBy: null,
            lockedUntil: null,
        });
        await expect(
            fs.access(path.join(directory, ".gateway.lock"))
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
});

describe("reconnect, replacement and logout", () => {
    test("a lost connection reconnects with a new socket and only that socket is live", async () => {
        const directory = await tempDir();
        await writeTestSession(directory);

        const sockets: FakeSocket[] = [];
        const gateway = makeGateway(
            directory,
            async () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket;
            },
            { reconnectDelaysMs: [10, 20, 50] }
        );

        gateways.push(gateway);

        await gateway.start();
        expect(sockets).toHaveLength(1);

        sockets[0].emit({ type: "connection", status: "open" });
        await waitFor(() => gateway.state === "CONNECTED");

        sockets[0].emit({
            type: "connection",
            status: "close",
            reason: "network",
        });
        await waitFor(() => gateway.state === "DISCONNECTED");
        expect(sockets[0].ended).toBe(true);

        await waitFor(() => sockets.length === 2);
        sockets[1].emit({ type: "connection", status: "open" });
        await waitFor(() => gateway.state === "CONNECTED");
        expect(gateway.snapshot().connected).toBe(true);
    });

    test("logout is terminal and does not reconnect", async () => {
        const directory = await tempDir();
        await writeTestSession(directory);

        const sockets: FakeSocket[] = [];
        const gateway = makeGateway(
            directory,
            async () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket;
            },
            { reconnectDelaysMs: [10, 20] }
        );

        gateways.push(gateway);

        await gateway.start();
        sockets[0].emit({ type: "connection", status: "open" });
        await waitFor(() => gateway.state === "CONNECTED");

        sockets[0].emit({
            type: "connection",
            status: "close",
            reason: "logged-out",
        });
        await waitFor(() => gateway.state === "LOGGED_OUT");

        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(sockets).toHaveLength(1);
        expect(gateway.snapshot().ready).toBe(false);
    });

    test("a replaced connection fences ownership and closes the server", async () => {
        const directory = await tempDir();
        await writeTestSession(directory);

        const fake = new FakeSocket();
        const gateway = makeGateway(directory, async () => fake);

        gateways.push(gateway);

        await gateway.start();
        fake.emit({ type: "connection", status: "open" });
        await waitFor(() => gateway.state === "CONNECTED");

        fake.emit({
            type: "connection",
            status: "close",
            reason: "replaced",
        });
        await waitFor(() => gateway.state === "CONFLICT");

        expect(fake.ended).toBe(true);
        expect(gateway.boundAddress).toBeNull();
        expect(gateway.snapshot().ownershipHeld).toBe(false);
    });
});

describe("gateway logs carry no secrets", () => {
    test("a socket startup error cannot leak the token, phone number or session path", async () => {
        const directory = await tempDir();
        await writeTestSession(directory);
        const lines: string[] = [];
        const logger = (
            _level: string,
            event: string,
            fields?: Record<string, unknown>
        ) => {
            lines.push(JSON.stringify({ event, ...fields }));
        };
        const gateway = makeGateway(
            directory,
            async () => {
                throw new Error(
                    `token=${TEST_TOKEN} phone=6281234567890 dir=${directory}`
                );
            },
            {},
            logger as never
        );

        gateways.push(gateway);

        const snapshot = await gateway.start();

        expect(snapshot.state).toBe("DISCONNECTED");

        const joined = lines.join("\n");

        expect(joined).not.toContain(TEST_TOKEN);
        expect(joined).not.toContain("6281234567890");
        expect(joined).not.toContain(directory);
        expect(joined).not.toContain("qr");
    });
});
