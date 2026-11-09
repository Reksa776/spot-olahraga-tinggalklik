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
            processName: "node gateway.js",
            alive: true,
            ownerId: "wa-4321-deadbeef",
            source: "local",
        };
        const lock = {
            held: true,
            holder: lockHolder,
            stale: false,
            heartbeatAgeMs: 1_500,
        };

        disconnectMock.mockResolvedValue({
            kind: "LOCK_HELD",
            lockHolder,
            lock,
        });

        const response = await POST(request());
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.success).toBe(false);
        expect(body.message).toContain("Gateway lain masih memegang koneksi");
        expect(body.message).not.toContain("tinggalklik-worker");
        expect(body.details.lockHolder).toMatchObject({
            pid: 4321,
            host: "vps-prod",
        });
    });

    test("deleteSession true is forwarded and reported", async () => {
        disconnectMock.mockResolvedValue({
            kind: "DISCONNECTED",
            alreadyDisconnected: false,
            deletedSession: true,
            socketClosed: true,
            forceReleased: false,
        });

        const response = await POST(
            request({ deleteSession: true, reason: "user_disconnect" })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data).toMatchObject({
            status: "DISCONNECTED",
            deletedSession: true,
        });
        expect(disconnectMock).toHaveBeenCalledWith(
            expect.objectContaining({
                input: {
                    deleteSession: true,
                    reason: "user_disconnect",
                },
            })
        );
    });

    test("a reason longer than 200 characters is rejected before any disconnect", async () => {
        const response = await POST(request({ reason: "x".repeat(201) }));

        expect(response.status).toBe(400);
        expect(disconnectMock).not.toHaveBeenCalled();
    });

    test("stale repair forwards forceReleaseStale without deleting the session", async () => {
        disconnectMock.mockResolvedValue({
            kind: "DISCONNECTED",
            alreadyDisconnected: false,
            deletedSession: false,
            socketClosed: true,
            forceReleased: true,
        });

        const response = await POST(
            request({
                forceReleaseStale: true,
                deleteSession: false,
                reason: "force_release_stale",
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data).toMatchObject({
            status: "DISCONNECTED",
            forceReleased: true,
            deletedSession: false,
        });
        expect(disconnectMock).toHaveBeenCalledWith(
            expect.objectContaining({
                input: {
                    forceReleaseStale: true,
                    deleteSession: false,
                    reason: "force_release_stale",
                },
            })
        );
    });

    test("forceReleaseStale against a live lock returns 409 and the exact holder", async () => {
        const lockHolder = {
            pid: 4321,
            host: "vps-prod",
            startedAt: "2026-11-09T03:00:00.000Z",
            processName: "node gateway.js",
            alive: true,
            ownerId: "wa-4321-live",
            source: "local",
        };
        const lock = {
            held: true,
            holder: lockHolder,
            stale: false,
            heartbeatAgeMs: 500,
        };

        disconnectMock.mockResolvedValue({
            kind: "LOCK_HELD",
            lockHolder,
            lock,
        });

        const response = await POST(
            request({ forceReleaseStale: true })
        );
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.message).toBe(
            "Lock masih dipegang proses hidup. Hentikan proses 4321 di vps-prod dulu."
        );
        expect(body.details.lock).toMatchObject({
            held: true,
            stale: false,
            heartbeatAgeMs: 500,
            holder: {
                pid: 4321,
                host: "vps-prod",
                processName: "node gateway.js",
            },
        });
        expect(disconnectMock).toHaveBeenCalledWith(
            expect.objectContaining({
                input: {
                    deleteSession: false,
                    forceReleaseStale: true,
                },
            })
        );
    });

    test("forceReleaseStale on a stale lock completes the disconnect", async () => {
        disconnectMock.mockResolvedValue({
            kind: "DISCONNECTED",
            alreadyDisconnected: false,
            deletedSession: false,
            socketClosed: true,
            forceReleased: true,
        });

        const response = await POST(
            request({
                forceReleaseStale: true,
                reason: "proses gateway mati",
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data).toMatchObject({
            status: "DISCONNECTED",
            forceReleased: true,
        });
        expect(disconnectMock).toHaveBeenCalledWith(
            expect.objectContaining({
                input: {
                    deleteSession: false,
                    forceReleaseStale: true,
                    reason: "proses gateway mati",
                },
            })
        );
    });
});
