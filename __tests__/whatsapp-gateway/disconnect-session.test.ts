import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

jest.mock("@/lib/ticketing/audit-log", () => ({
    writeTicketingAudit: jest.fn(async () => undefined),
}));

import type { AuthzScope } from "@/lib/authz/permissions";
import type { WhatsAppGateway } from "@/lib/whatsapp/gateway/gateway";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";
import { disconnectWhatsAppGateway } from "@/lib/whatsapp/gateway/disconnect-service";
import {
    clearWhatsAppSessionDirectory,
    resolveSessionEntry,
    SessionCleanupError,
    SessionPathError,
} from "@/lib/whatsapp/gateway/session-cleanup";

const actor = {
    userId: "admin-1",
    platformRole: "ADMIN",
} as unknown as AuthzScope;
const request = new Request("http://localhost/api/x", { method: "POST" });

function gatewayReturning(result: unknown): WhatsAppGateway {
    return {
        disconnect: jest.fn(async () => result),
    } as unknown as WhatsAppGateway;
}

const freeLock = {
    held: false,
    holder: null,
    lockHolder: null,
    stale: false,
    heartbeatAgeMs: null,
    localLock: false,
    databaseLease: false,
    leaseOwnerId: null,
    leaseUpdatedAt: null,
};

const auditMock = writeTicketingAudit as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
});

describe("disconnect idempotency and lock safety", () => {
    test("already disconnected is a 200 outcome", async () => {
        const setManualDisconnect = jest.fn(async () => undefined);
        const inspectLock = jest.fn(async () => freeLock);

        const outcome = await disconnectWhatsAppGateway({
            gateway: gatewayReturning({
                status: "DISCONNECTED",
                alreadyDisconnected: true,
                socketClosed: true,
            }),
            sessionDir: "/srv/tinggalklik/whatsapp",
            input: { deleteSession: false },
            actor,
            request,
            dependencies: { setManualDisconnect, inspectLock },
        });

        expect(outcome).toMatchObject({
            kind: "DISCONNECTED",
            alreadyDisconnected: true,
            deletedSession: false,
        });
        expect(setManualDisconnect).toHaveBeenCalledWith(true);
    });

    test("a lock held by the gateway is returned without touching session files", async () => {
        const clearSession = jest.fn(async () => ({ deletedEntries: 0 }));
        const holder = {
            pid: 999,
            host: "other-host",
            startedAt: null,
            ownerId: "wa-999-abc",
            source: "lease" as const,
        };

        const outcome = await disconnectWhatsAppGateway({
            gateway: gatewayReturning({
                status: "LOCK_HELD",
                lockHolder: holder,
                lock: {
                    held: true,
                    holder,
                    stale: false,
                    heartbeatAgeMs: 1_000,
                },
            }),
            sessionDir: "/srv/tinggalklik/whatsapp",
            input: { deleteSession: true },
            actor,
            request,
            dependencies: {
                setManualDisconnect: jest.fn(async () => undefined),
                clearSession,
            },
        });

        expect(outcome).toMatchObject({
            kind: "LOCK_HELD",
            lockHolder: holder,
        });
        expect(clearSession).not.toHaveBeenCalled();
    });

    test("a lock that reappears after release blocks deleteSession", async () => {
        const clearSession = jest.fn(async () => ({ deletedEntries: 0 }));
        const holder = {
            pid: 777,
            host: "vps-prod",
            startedAt: "2026-11-09T00:00:00.000Z",
            processName: "node gateway.js",
            alive: true,
            ownerId: "wa-777-xyz",
            source: "local" as const,
        };

        const outcome = await disconnectWhatsAppGateway({
            gateway: gatewayReturning({
                status: "DISCONNECTED",
                alreadyDisconnected: false,
                socketClosed: true,
            }),
            sessionDir: "/srv/tinggalklik/whatsapp",
            input: { deleteSession: true },
            actor,
            request,
            dependencies: {
                setManualDisconnect: jest.fn(async () => undefined),
                inspectLock: jest.fn(async () => ({
                    held: true,
                    holder,
                    lockHolder: holder,
                    stale: false,
                    heartbeatAgeMs: 1_000,
                    localLock: true,
                    databaseLease: false,
                    leaseOwnerId: null,
                    leaseUpdatedAt: null,
                })),
                clearSession,
            },
        });

        expect(outcome).toMatchObject({
            kind: "LOCK_HELD",
            lockHolder: holder,
        });
        expect(clearSession).not.toHaveBeenCalled();
    });

    test("deleteSession is refused when the socket close timed out", async () => {
        const clearSession = jest.fn(async () => ({ deletedEntries: 0 }));

        await expect(
            disconnectWhatsAppGateway({
                gateway: gatewayReturning({
                    status: "DISCONNECTED",
                    alreadyDisconnected: false,
                    socketClosed: false,
                }),
                sessionDir: "/srv/tinggalklik/whatsapp",
                input: { deleteSession: true },
                actor,
                request,
                dependencies: {
                    setManualDisconnect: jest.fn(async () => undefined),
                    inspectLock: jest.fn(async () => freeLock),
                    clearSession,
                },
            })
        ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });

        expect(clearSession).not.toHaveBeenCalled();
    });

    test("deleteSession deletes only after the lock is free", async () => {
        const clearSession = jest.fn(async () => ({ deletedEntries: 3 }));

        const outcome = await disconnectWhatsAppGateway({
            gateway: gatewayReturning({
                status: "DISCONNECTED",
                alreadyDisconnected: false,
                socketClosed: true,
            }),
            sessionDir: "/srv/tinggalklik/whatsapp",
            input: { deleteSession: true, reason: "ganti nomor" },
            actor,
            request,
            dependencies: {
                setManualDisconnect: jest.fn(async () => undefined),
                inspectLock: jest.fn(async () => freeLock),
                clearSession,
            },
        });

        expect(outcome).toMatchObject({
            kind: "DISCONNECTED",
            deletedSession: true,
        });
        expect(clearSession).toHaveBeenCalledWith(
            "/srv/tinggalklik/whatsapp"
        );
        expect(auditMock).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "whatsapp.disconnect",
                afterState: expect.objectContaining({
                    deleteSession: true,
                    deletedSession: true,
                }),
            })
        );
    });

    test("a cleanup failure returns the failed entry list instead of success", async () => {
        const clearSession = jest.fn(async () => {
            throw new SessionCleanupError([
                { entry: "auth.enc", code: "EACCES" },
            ]);
        });

        await expect(
            disconnectWhatsAppGateway({
                gateway: gatewayReturning({
                    status: "DISCONNECTED",
                    alreadyDisconnected: false,
                    socketClosed: true,
                }),
                sessionDir: "/srv/tinggalklik/whatsapp",
                input: { deleteSession: true },
                actor,
                request,
                dependencies: {
                    setManualDisconnect: jest.fn(async () => undefined),
                    inspectLock: jest.fn(async () => freeLock),
                    clearSession,
                },
            })
        ).rejects.toMatchObject({
            code: "INTERNAL_ERROR",
            details: {
                failedEntries: [{ entry: "auth.enc", code: "EACCES" }],
            },
        });
    });

    test("forceReleaseStale releases a stale lock and audits the holder", async () => {
        const holder = {
            pid: 999,
            host: "vps-prod",
            startedAt: "2026-11-09T00:00:00.000Z",
            processName: "node gateway.js",
            alive: false,
            ownerId: "wa-999-abc",
            source: "local" as const,
        };
        const staleLock = {
            held: true,
            holder,
            lockHolder: holder,
            stale: true,
            heartbeatAgeMs: 1_200_000,
            localLock: true,
            databaseLease: false,
            leaseOwnerId: null,
            leaseUpdatedAt: null,
        };
        const inspectLock = jest
            .fn()
            .mockResolvedValueOnce(staleLock)
            .mockResolvedValueOnce(freeLock);
        const forceReleaseStaleLock = jest.fn(async () => true);
        const clearSession = jest.fn(async () => ({ deletedEntries: 0 }));

        const outcome = await disconnectWhatsAppGateway({
            gateway: gatewayReturning({
                status: "DISCONNECTED",
                alreadyDisconnected: false,
                socketClosed: true,
            }),
            sessionDir: "/srv/tinggalklik/whatsapp",
            input: {
                deleteSession: false,
                forceReleaseStale: true,
                reason: "proses gateway mati",
            },
            actor,
            request,
            dependencies: {
                setManualDisconnect: jest.fn(async () => undefined),
                inspectLock,
                forceReleaseStaleLock,
                clearSession,
            },
        });

        expect(outcome).toMatchObject({
            kind: "DISCONNECTED",
            forceReleased: true,
        });
        expect(forceReleaseStaleLock).toHaveBeenCalledWith(
            "/srv/tinggalklik/whatsapp"
        );
        expect(clearSession).not.toHaveBeenCalled();
        expect(auditMock).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "whatsapp.disconnect",
                afterState: expect.objectContaining({
                    deleteSession: false,
                    deletedSession: false,
                }),
            })
        );
        expect(auditMock).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "whatsapp.lock.force_release",
                actor,
                reason: "proses gateway mati",
                beforeState: expect.objectContaining({
                    holder: expect.objectContaining({
                        pid: 999,
                        host: "vps-prod",
                    }),
                }),
            })
        );
    });

    test("forceReleaseStale refuses a live lock before touching the gateway", async () => {
        const holder = {
            pid: 4321,
            host: "vps-prod",
            startedAt: "2026-11-09T03:00:00.000Z",
            processName: "node gateway.js",
            alive: true,
            ownerId: "wa-4321-live",
            source: "local" as const,
        };
        const liveLock = {
            held: true,
            holder,
            lockHolder: holder,
            stale: false,
            heartbeatAgeMs: 500,
            localLock: true,
            databaseLease: true,
            leaseOwnerId: holder.ownerId,
            leaseUpdatedAt: "2026-11-09T03:00:00.000Z",
        };
        const forceReleaseStaleLock = jest.fn(async () => true);
        const disconnect = jest.fn();

        const outcome = await disconnectWhatsAppGateway({
            gateway: { disconnect } as unknown as WhatsAppGateway,
            sessionDir: "/srv/tinggalklik/whatsapp",
            input: {
                deleteSession: false,
                forceReleaseStale: true,
            },
            actor,
            request,
            dependencies: {
                setManualDisconnect: jest.fn(async () => undefined),
                inspectLock: jest.fn(async () => liveLock),
                forceReleaseStaleLock,
            },
        });

        expect(outcome).toMatchObject({
            kind: "LOCK_HELD",
            lock: {
                held: true,
                stale: false,
            },
        });
        expect(forceReleaseStaleLock).not.toHaveBeenCalled();
        expect(disconnect).not.toHaveBeenCalled();
        expect(auditMock).not.toHaveBeenCalledWith(
            expect.objectContaining({
                action: "whatsapp.lock.force_release",
            })
        );
    });
});

describe("session path safety", () => {
    const temporaryDirectories: string[] = [];

    afterAll(async () => {
        await Promise.all(
            temporaryDirectories.map((directory) =>
                fs.rm(directory, { recursive: true, force: true })
            )
        );
    });

    test.each(["../escape", "..", "nested/auth.enc", "/etc/passwd", "a\\b"])(
        "the entry %s is rejected as path traversal",
        (entry) => {
            expect(() => resolveSessionEntry("/srv/session", entry)).toThrow(
                SessionPathError
            );
        }
    );

    test("an empty session directory is already clean", async () => {
        const root = await fs.mkdtemp(
            path.join(os.tmpdir(), "wa-session-empty-")
        );
        temporaryDirectories.push(root);

        await expect(clearWhatsAppSessionDirectory(root)).resolves.toEqual({
            deletedEntries: 0,
        });
        expect((await fs.stat(root)).isDirectory()).toBe(true);
    });

    test("a symlink inside the session is rejected before deletion", async () => {
        const root = await fs.mkdtemp(
            path.join(os.tmpdir(), "wa-session-symlink-")
        );
        const outside = await fs.mkdtemp(
            path.join(os.tmpdir(), "wa-session-outside-link-")
        );
        temporaryDirectories.push(root, outside);

        await fs.writeFile(path.join(outside, "keep.txt"), "keep");
        await fs.symlink(
            path.join(outside, "keep.txt"),
            path.join(root, "linked-auth")
        );

        await expect(clearWhatsAppSessionDirectory(root)).rejects.toThrow(
            SessionPathError
        );
        expect(
            await fs.readFile(path.join(outside, "keep.txt"), "utf8")
        ).toBe("keep");
    });

    test("a failed entry is reported instead of being silently ignored", async () => {
        const root = await fs.mkdtemp(
            path.join(os.tmpdir(), "wa-session-failure-")
        );
        temporaryDirectories.push(root);

        await fs.writeFile(path.join(root, "auth.enc"), "encrypted");
        await fs.writeFile(path.join(root, "creds.json"), "{}");

        const rm = jest
            .spyOn(fs, "rm")
            .mockRejectedValueOnce(
                Object.assign(new Error("denied"), { code: "EACCES" })
            );

        await expect(clearWhatsAppSessionDirectory(root)).rejects.toMatchObject(
            {
                name: "SessionCleanupError",
                failedEntries: [{ entry: "auth.enc", code: "EACCES" }],
            }
        );

        rm.mockRestore();
    });

    test("clear removes contents, preserves the lock file and never deletes the root", async () => {
        const root = await fs.mkdtemp(
            path.join(os.tmpdir(), "wa-session-root-")
        );
        const outside = await fs.mkdtemp(
            path.join(os.tmpdir(), "wa-session-outside-")
        );
        temporaryDirectories.push(root, outside);

        await fs.writeFile(path.join(root, "auth.enc"), "encrypted");
        await fs.mkdir(path.join(root, "nested"));
        await fs.writeFile(path.join(root, "nested", "creds"), "creds");
        await fs.writeFile(path.join(root, ".gateway.lock"), "{}");
        await fs.writeFile(path.join(outside, "keep.txt"), "keep");

        const result = await clearWhatsAppSessionDirectory(root);

        expect(result.deletedEntries).toBe(2);
        expect((await fs.stat(root)).isDirectory()).toBe(true);
        expect(await fs.readdir(root)).toEqual([".gateway.lock"]);
        expect(
            await fs.readFile(path.join(outside, "keep.txt"), "utf8")
        ).toBe("keep");
    });
});
