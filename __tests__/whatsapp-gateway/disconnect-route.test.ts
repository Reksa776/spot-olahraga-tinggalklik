import type { NextRequest } from "next/server";

jest.mock("@/lib/csrf", () => ({
    requireSameOrigin: jest.fn(() => ({ error: null })),
}));
jest.mock("@/lib/authz", () => ({
    requirePlatformPermission: jest.fn(),
}));
jest.mock("@/lib/whatsapp/gateway/web-runtime", () => ({
    getWhatsAppGatewayForWeb: jest.fn(async () => null),
}));
jest.mock("@/lib/whatsapp/gateway/config", () => ({
    resolveWhatsAppGatewayConfig: jest.fn(() => ({
        ok: true,
        config: { enabled: true, sessionDir: "/srv/tinggalklik/whatsapp" },
    })),
}));
jest.mock("@/lib/whatsapp/gateway/disconnect-service", () => ({
    disconnectWhatsAppGateway: jest.fn(),
}));

import { POST } from "@/app/api/admin/settings/whatsapp/disconnect/route";
import { AuthzError, AuthzErrorCode } from "@/lib/authz/errors";
import { requirePlatformPermission } from "@/lib/authz";
import { disconnectWhatsAppGateway } from "@/lib/whatsapp/gateway/disconnect-service";

const permissionMock = requirePlatformPermission as jest.Mock;
const disconnectMock = disconnectWhatsAppGateway as jest.Mock;

function request(body: unknown = {}): NextRequest {
    return new Request(
        "http://localhost/api/admin/settings/whatsapp/disconnect",
        {
            method: "POST",
            headers: {
                origin: "http://localhost",
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        }
    ) as unknown as NextRequest;
}

beforeEach(() => {
    jest.clearAllMocks();
    permissionMock.mockResolvedValue({ userId: "admin-1" });
});

describe("disconnect endpoint authorization", () => {
    test("a non-admin is refused with 403 before the gateway is touched", async () => {
        permissionMock.mockRejectedValue(
            new AuthzError(AuthzErrorCode.FORBIDDEN)
        );

        const response = await POST(request());

        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
            success: false,
            code: "FORBIDDEN",
        });
        expect(disconnectMock).not.toHaveBeenCalled();
    });
});

describe("disconnect endpoint outcomes", () => {
    test("an already disconnected gateway returns 200 with alreadyDisconnected", async () => {
        disconnectMock.mockResolvedValue({
            kind: "DISCONNECTED",
            alreadyDisconnected: true,
            deletedSession: false,
            socketClosed: true,
        });

        const response = await POST(request());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data).toMatchObject({
            status: "DISCONNECTED",
            alreadyDisconnected: true,
            deletedSession: false,
        });
        expect(disconnectMock).toHaveBeenCalledWith(
            expect.objectContaining({
                input: { deleteSession: false },
            })
        );
    });

    test("a lock held by another process returns 409 with the holder and pm2 hint", async () => {
        const lockHolder = {
            pid: 4321,
            host: "vps-prod",
            startedAt: "2026-11-09T03:00:00.000Z",
            ownerId: "wa-4321-deadbeef",
            source: "local",
        };

        disconnectMock.mockResolvedValue({ kind: "LOCK_HELD", lockHolder });

        const response = await POST(request());
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.success).toBe(false);
        expect(body.message).toContain("pm2 stop tinggalklik-worker");
        expect(body.details.lockHolder).toMatchObject({
            pid: 4321,
            host: "vps-prod",
        });
    });

    test("a reason longer than 200 characters is rejected before any disconnect", async () => {
        const response = await POST(request({ reason: "x".repeat(201) }));

        expect(response.status).toBe(400);
        expect(disconnectMock).not.toHaveBeenCalled();
    });
});
