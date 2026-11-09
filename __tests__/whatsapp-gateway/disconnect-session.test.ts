import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

jest.mock("@/lib/ticketing/audit-log", () => ({
    writeTicketingAudit: jest.fn(async () => undefined),
}));

import type { AuthzScope } from "@/lib/authz/permissions";
import type { WhatsAppGateway } from "@/lib/whatsapp/gateway/gateway";
import { disconnectWhatsAppGateway } from "@/lib/whatsapp/gateway/disconnect-service";
import {
    clearWhatsAppSessionDirectory,
    resolveSessionEntry,
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
    lockHolder: null,
    localLock: false,
    databaseLease: false,
};

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

        expect(outcome).toEqual({ kind: "LOCK_HELD", lockHolder: holder });
        expect(clearSession).not.toHaveBeenCalled();
    });

    test("a lock that reappears after release blocks deleteSession", async () => {
        const clearSession = jest.fn(async () => ({ deletedEntries: 0 }));
        const holder = {
            pid: 777,
            host: "vps-prod",
            startedAt: "2026-11-09T00:00:00.000Z",
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
                    lockHolder: holder,
                    localLock: true,
                    databaseLease: false,
                })),
                clearSession,
            },
        });

        expect(outcome).toEqual({ kind: "LOCK_HELD", lockHolder: holder });
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
