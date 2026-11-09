import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

jest.mock("@/lib/csrf", () => ({
    requireSameOrigin: jest.fn(),
}));
jest.mock("@/lib/authz", () => ({
    requirePlatformPermission: jest.fn(),
}));
jest.mock("@/lib/whatsapp/gateway/web-runtime", () => ({
    getWhatsAppGatewayForWeb: jest.fn(),
}));
jest.mock("@/lib/whatsapp/manual-disconnect", () => ({
    isWhatsAppManuallyDisconnected: jest.fn(),
    setWhatsAppManualDisconnect: jest.fn(),
}));
jest.mock("@/lib/ticketing/audit-log", () => ({
    writeTicketingAudit: jest.fn(async () => undefined),
}));
jest.mock("@/lib/whatsapp/gateway/lock-inspection", () => ({
    inspectWhatsAppGatewayLock: jest.fn(),
    toWhatsAppGatewayLockStatus: jest.fn((value) => value),
}));

import { POST } from "@/app/api/admin/settings/whatsapp/connect/route";
import { AuthzError, AuthzErrorCode } from "@/lib/authz/errors";
import { requirePlatformPermission } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";
import {
    isWhatsAppManuallyDisconnected,
    setWhatsAppManualDisconnect,
} from "@/lib/whatsapp/manual-disconnect";
import { inspectWhatsAppGatewayLock } from "@/lib/whatsapp/gateway/lock-inspection";
import { getWhatsAppGatewayForWeb } from "@/lib/whatsapp/gateway/web-runtime";

const csrfMock = requireSameOrigin as jest.Mock;
const permissionMock = requirePlatformPermission as jest.Mock;
const runtimeMock = getWhatsAppGatewayForWeb as jest.Mock;
const readLatchMock = isWhatsAppManuallyDisconnected as jest.Mock;
const setLatchMock = setWhatsAppManualDisconnect as jest.Mock;
const auditMock = writeTicketingAudit as jest.Mock;
const inspectMock = inspectWhatsAppGatewayLock as jest.Mock;

function request(body: unknown = {}): NextRequest {
    return new Request("http://localhost/api/admin/settings/whatsapp/connect", {
        method: "POST",
        headers: {
            origin: "http://localhost",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    }) as unknown as NextRequest;
}

function gateway(overrides: Record<string, unknown> = {}) {
    return {
        sessionDirectory: "/srv/tinggalklik/whatsapp",
        beginPairing: jest.fn(async () => ({ started: true })),
        snapshot: jest.fn(() => ({
            state: "STARTING",
            connected: false,
            ready: false,
            ownershipHeld: true,
            sessionPresent: true,
            lastErrorCode: null,
            manualDisconnect: false,
        })),
        pairingStatus: jest.fn(() => ({
            qr: "qr-data",
            expiresAt: "2026-11-09T12:00:00.000Z",
        })),
        disconnect: jest.fn(async () => ({
            status: "DISCONNECTED",
            alreadyDisconnected: false,
            socketClosed: true,
        })),
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    csrfMock.mockReturnValue({ error: null });
    permissionMock.mockResolvedValue({ userId: "admin-1" });
    readLatchMock.mockResolvedValue(false);
    setLatchMock.mockResolvedValue(undefined);
    auditMock.mockResolvedValue(undefined);
    inspectMock.mockResolvedValue({
        held: false,
        holder: null,
        stale: false,
        heartbeatAgeMs: null,
    });
});

describe("POST /connect authorization and validation", () => {
    test("a non-admin is refused with 403 before the gateway is touched", async () => {
        permissionMock.mockRejectedValue(
            new AuthzError(AuthzErrorCode.FORBIDDEN)
        );

        const response = await POST(request());

        expect(response.status).toBe(403);
        expect(runtimeMock).not.toHaveBeenCalled();
        expect(setLatchMock).not.toHaveBeenCalled();
        expect(auditMock).not.toHaveBeenCalled();
    });

    test("a request without a same-origin header is refused with 403", async () => {
        csrfMock.mockReturnValue({
            error: NextResponse.json(
                {
                    success: false,
                    code: "FORBIDDEN",
                    message: "Akses ditolak.",
                },
                { status: 403 }
            ),
        });

        const response = await POST(request());

        expect(response.status).toBe(403);
        expect(permissionMock).not.toHaveBeenCalled();
        expect(runtimeMock).not.toHaveBeenCalled();
    });

    test("a non-boolean force value is rejected by Zod before connect", async () => {
        const response = await POST(request({ force: "yes" }));

        expect(response.status).toBe(400);
        expect(runtimeMock).not.toHaveBeenCalled();
        expect(setLatchMock).not.toHaveBeenCalled();
    });
});

describe("POST /connect latch and pairing", () => {
    test("latch=true is cleared, pairing starts, and the previous latch is audited", async () => {
        readLatchMock.mockResolvedValue(true);
        const gatewayMock = gateway();
        runtimeMock.mockResolvedValue(gatewayMock);

        const response = await POST(request());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data).toMatchObject({
            status: "PAIRING_STARTED",
            pairingStarted: true,
            manualDisconnect: false,
            qr: "qr-data",
        });
        expect(setLatchMock).toHaveBeenCalledWith(false);
        expect(auditMock).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "whatsapp.connect",
                beforeState: { manualDisconnect: true },
                afterState: {
                    manualDisconnect: false,
                    source: "connect",
                },
            })
        );
        expect(gatewayMock.beginPairing).toHaveBeenCalledTimes(1);
    });

    test("latch=false is idempotent and still starts pairing", async () => {
        readLatchMock.mockResolvedValue(false);
        const gatewayMock = gateway();
        runtimeMock.mockResolvedValue(gatewayMock);

        const response = await POST(request());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.status).toBe("PAIRING_STARTED");
        expect(setLatchMock).toHaveBeenCalledWith(false);
        expect(auditMock).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "whatsapp.connect",
                beforeState: { manualDisconnect: false },
            })
        );
    });

    test("an already connected gateway returns CONNECTED without a QR flow", async () => {
        const gatewayMock = gateway({
            beginPairing: jest.fn(async () => ({ started: false })),
            snapshot: jest.fn(() => ({
                state: "CONNECTED",
                connected: true,
                ready: true,
                ownershipHeld: true,
                sessionPresent: true,
                lastErrorCode: null,
                manualDisconnect: false,
            })),
        });
        runtimeMock.mockResolvedValue(gatewayMock);

        const response = await POST(request());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data).toMatchObject({
            status: "CONNECTED",
            pairingStarted: false,
            manualDisconnect: false,
        });
    });

    test("a live lock conflict returns 409 details and does not restore the latch", async () => {
        readLatchMock.mockResolvedValue(true);
        const holder = {
            pid: 4321,
            host: "vps-prod",
            startedAt: "2026-11-09T03:00:00.000Z",
            processName: "node gateway.js",
            alive: true,
            ownerId: "wa-4321-live",
            source: "local",
        };
        inspectMock.mockResolvedValue({
            held: true,
            holder,
            stale: false,
            heartbeatAgeMs: 500,
        });
        const gatewayMock = gateway({
            beginPairing: jest.fn(async () => ({ started: false })),
            snapshot: jest.fn(() => ({
                state: "CONFLICT",
                connected: false,
                ready: false,
                ownershipHeld: false,
                sessionPresent: true,
                lastErrorCode: "LOCAL_LOCK_HELD",
                manualDisconnect: false,
            })),
        });
        runtimeMock.mockResolvedValue(gatewayMock);

        const response = await POST(request());
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.details.lock).toMatchObject({
            held: true,
            stale: false,
            holder: { pid: 4321, host: "vps-prod" },
        });
        expect(setLatchMock.mock.calls).toEqual([[false]]);
        expect(gatewayMock.disconnect).toHaveBeenCalled();
    });

    test("a pairing exception leaves the latch false for a retry", async () => {
        readLatchMock.mockResolvedValue(true);
        const gatewayMock = gateway({
            beginPairing: jest.fn(async () => {
                throw new Error("socket start failed");
            }),
        });
        runtimeMock.mockResolvedValue(gatewayMock);

        const response = await POST(request());

        expect(response.status).toBe(500);
        expect(setLatchMock.mock.calls).toEqual([[false]]);
        expect(setLatchMock).not.toHaveBeenCalledWith(true);
        expect(gatewayMock.disconnect).toHaveBeenCalled();
        expect(auditMock).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "whatsapp.connect",
                beforeState: { manualDisconnect: true },
            })
        );
    });
});
