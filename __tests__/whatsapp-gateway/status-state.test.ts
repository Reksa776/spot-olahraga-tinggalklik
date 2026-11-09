import fs from "node:fs/promises";

jest.mock("@/lib/whatsapp/manual-disconnect", () => ({
    isWhatsAppManuallyDisconnected: jest.fn(),
}));
jest.mock("@/lib/whatsapp/gateway/web-runtime", () => ({
    getWhatsAppGatewayForWeb: jest.fn(),
}));
jest.mock("@/lib/whatsapp/gateway/config", () => ({
    resolveWhatsAppGatewayConfig: jest.fn(() => ({
        ok: true,
        config: { enabled: true, sessionDir: "/srv/tinggalklik/whatsapp" },
    })),
}));
jest.mock("@/lib/whatsapp/gateway/lock-inspection", () => ({
    inspectWhatsAppGatewayLock: jest.fn(),
    toWhatsAppGatewayLockStatus: jest.fn((value) => value),
}));
jest.mock("@/lib/notifications/transports/smtp", () => ({
    readSmtpAdapterConfig: jest.fn(() => null),
}));

import { getWhatsAppGatewayStatus } from "@/lib/whatsapp/gateway/status";
import { inspectWhatsAppGatewayLock } from "@/lib/whatsapp/gateway/lock-inspection";
import { isWhatsAppManuallyDisconnected } from "@/lib/whatsapp/manual-disconnect";
import { getWhatsAppGatewayForWeb } from "@/lib/whatsapp/gateway/web-runtime";

const manualMock = isWhatsAppManuallyDisconnected as jest.Mock;
const runtimeMock = getWhatsAppGatewayForWeb as jest.Mock;
const inspectMock = inspectWhatsAppGatewayLock as jest.Mock;

function gateway(state: string, overrides: Record<string, unknown> = {}) {
    return {
        snapshot: jest.fn(() => ({
            state,
            connected: state === "CONNECTED",
            ready: state === "CONNECTED",
            ownershipHeld: state !== "CONFLICT",
            sessionPresent: true,
            lastErrorCode: state === "CONFLICT" ? "LOCAL_LOCK_HELD" : null,
            manualDisconnect: false,
        })),
        pairingStatus: jest.fn(() => ({
            qr: state === "STARTING" ? "qr-data" : null,
            expiresAt: null,
        })),
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(fs, "access").mockResolvedValue(undefined);
    inspectMock.mockResolvedValue({
        held: false,
        holder: null,
        stale: false,
        heartbeatAgeMs: null,
    });
});

afterEach(() => {
    jest.restoreAllMocks();
});

test("the persisted latch wins over a stale connected snapshot", async () => {
    manualMock.mockResolvedValue(true);
    runtimeMock.mockResolvedValue(gateway("CONNECTED"));

    const status = await getWhatsAppGatewayStatus();

    expect(status).toMatchObject({
        state: "MANUAL_DISCONNECT",
        manualDisconnect: true,
        connected: false,
        ready: false,
        ownershipHeld: false,
        sessionPresent: true,
        sessionExists: true,
        qr: null,
    });
});

test("latch=false and a disconnected snapshot reports DISCONNECTED", async () => {
    manualMock.mockResolvedValue(false);
    runtimeMock.mockResolvedValue(gateway("DISCONNECTED"));

    const status = await getWhatsAppGatewayStatus();

    expect(status).toMatchObject({
        state: "DISCONNECTED",
        manualDisconnect: false,
        connected: false,
        sessionPresent: true,
    });
});

test("a competing owner reports CONFLICT with the lock holder", async () => {
    const holder = {
        pid: 4321,
        host: "vps-prod",
        startedAt: "2026-11-09T03:00:00.000Z",
        processName: "node gateway.js",
        alive: true,
        ownerId: "wa-4321-live",
        source: "local",
    };
    manualMock.mockResolvedValue(false);
    runtimeMock.mockResolvedValue(gateway("CONFLICT"));
    inspectMock.mockResolvedValue({
        held: true,
        holder,
        stale: false,
        heartbeatAgeMs: 500,
    });

    const status = await getWhatsAppGatewayStatus();

    expect(status).toMatchObject({
        state: "CONFLICT",
        manualDisconnect: false,
        lock: {
            held: true,
            stale: false,
            heartbeatAgeMs: 500,
            holder: { pid: 4321, host: "vps-prod" },
        },
    });
});
