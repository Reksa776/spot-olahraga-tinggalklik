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
        userMessage: "WhatsApp terputus",
        userMessageLevel: "info",
        userMessageDetail:
            "Klik 'Hubungkan WhatsApp' untuk scan QR dan mengaktifkan kembali.",
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
        userMessage: "WhatsApp tidak terhubung",
        userMessageLevel: "warning",
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
        userMessage: "Koneksi sedang dipakai proses lain",
        userMessageLevel: "warning",
        manualDisconnect: false,
        lock: {
            held: true,
            stale: false,
            heartbeatAgeMs: 500,
            holder: { pid: 4321, host: "vps-prod" },
        },
    });
});

test("a connected snapshot returns the success copy", async () => {
    manualMock.mockResolvedValue(false);
    runtimeMock.mockResolvedValue(gateway("CONNECTED"));

    const status = await getWhatsAppGatewayStatus();

    expect(status).toMatchObject({
        state: "CONNECTED",
        userMessage: "WhatsApp terhubung",
        userMessageLevel: "success",
        userMessageDetail: "Pesan otomatis aktif.",
        connected: true,
    });
});

test("starting and pairing states return the waiting copy", async () => {
    manualMock.mockResolvedValue(false);
    runtimeMock.mockResolvedValue(gateway("STARTING"));

    const status = await getWhatsAppGatewayStatus();

    expect(status).toMatchObject({
        state: "STARTING",
        userMessage: "Menghubungkan…",
        userMessageLevel: "info",
        userMessageDetail:
            "Menyiapkan koneksi WhatsApp, tunggu sebentar.",
    });
});

test("a stale conflict returns the repair copy with error level", async () => {
    const holder = {
        pid: 4321,
        host: "vps-prod",
        startedAt: "2026-11-09T03:00:00.000Z",
        processName: "node gateway.js",
        alive: false,
        ownerId: "wa-4321-dead",
        source: "local",
    };
    manualMock.mockResolvedValue(false);
    runtimeMock.mockResolvedValue(gateway("CONFLICT"));
    inspectMock.mockResolvedValue({
        held: true,
        holder,
        stale: true,
        heartbeatAgeMs: 1_200_000,
    });

    const status = await getWhatsAppGatewayStatus();

    expect(status).toMatchObject({
        state: "CONFLICT",
        userMessageLevel: "error",
        userMessageDetail: "Klik 'Perbaiki koneksi' untuk membersihkan.",
    });
    expect(status.userMessage).toContain("tersangkut");
});

test("an error snapshot asks the operator to scan again", async () => {
    manualMock.mockResolvedValue(false);
    runtimeMock.mockResolvedValue(gateway("ERROR"));

    const status = await getWhatsAppGatewayStatus();

    expect(status).toMatchObject({
        state: "ERROR",
        userMessage: "WhatsApp butuh perhatian",
        userMessageLevel: "error",
        userMessageDetail:
            "Terjadi masalah pada koneksi WhatsApp. Klik 'Hubungkan WhatsApp' untuk scan ulang QR.",
    });
});
