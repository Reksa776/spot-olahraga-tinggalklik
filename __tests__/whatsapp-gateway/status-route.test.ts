import fs from "node:fs/promises";

jest.mock("@/lib/authz", () => ({
    requirePlatformPermission: jest.fn(),
}));
jest.mock("@/lib/whatsapp/gateway/status", () => ({
    getWhatsAppGatewayStatus: jest.fn(),
}));
jest.mock("@/lib/whatsapp/gateway/lease", () => ({
    readWhatsAppGatewayLease: jest.fn(async () => null),
    releaseStaleWhatsAppGatewayLease: jest.fn(async () => true),
}));

import { GET } from "@/app/api/admin/settings/whatsapp/status/route";
import { requirePlatformPermission } from "@/lib/authz";
import { getWhatsAppGatewayStatus } from "@/lib/whatsapp/gateway/status";
import { readProcessNameFromProc } from "@/lib/whatsapp/gateway/lock-inspection";

const permissionMock = requirePlatformPermission as jest.Mock;
const statusMock = getWhatsAppGatewayStatus as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    permissionMock.mockResolvedValue({ userId: "admin-1" });
    jest.restoreAllMocks();
});

afterAll(() => {
    jest.restoreAllMocks();
});

test("status returns holder, stale, heartbeatAgeMs and the flat compatibility field", async () => {
    const holder = {
        pid: 4321,
        host: "vps-prod",
        startedAt: "2026-11-09T03:00:00.000Z",
        processName: "node gateway.js",
        alive: false,
        ownerId: "wa-4321-dead",
        source: "local",
    };

    statusMock.mockResolvedValue({
        state: "CONFLICT",
        connected: false,
        ready: false,
        ownershipHeld: false,
        sessionPresent: true,
        sessionExists: true,
        manualDisconnect: false,
        lastErrorCode: "LOCAL_LOCK_HELD",
        qr: null,
        expiresAt: null,
        lock: {
            held: true,
            holder,
            stale: true,
            heartbeatAgeMs: 1_200_000,
        },
        lockHolder: holder,
        smtp: { configured: false, secure: false, from: null },
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.lock).toMatchObject({
        held: true,
        stale: true,
        heartbeatAgeMs: 1_200_000,
        holder,
    });
    expect(body.data.lockHolder).toEqual(holder);
});

test("diagnostics never throw when /proc cannot be read", async () => {
    jest.spyOn(fs, "readFile").mockRejectedValueOnce(
        Object.assign(new Error("not found"), { code: "ENOENT" })
    );

    await expect(readProcessNameFromProc(4321)).resolves.toBeNull();
});
