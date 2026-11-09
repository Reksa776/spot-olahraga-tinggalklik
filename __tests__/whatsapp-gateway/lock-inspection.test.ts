import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

jest.mock("@/lib/whatsapp/gateway/lease", () => ({
    readWhatsAppGatewayLease: jest.fn(async () => null),
    releaseStaleWhatsAppGatewayLease: jest.fn(async () => true),
}));

import { readWhatsAppGatewayLease } from "@/lib/whatsapp/gateway/lease";
import {
    inspectWhatsAppGatewayLock,
    readProcessNameFromProc,
} from "@/lib/whatsapp/gateway/lock-inspection";

const leaseMock = readWhatsAppGatewayLease as jest.Mock;
const temporaryDirectories: string[] = [];

async function tempDir(): Promise<string> {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "wa-lock-inspection-")
    );
    temporaryDirectories.push(directory);
    return directory;
}

async function writeLock(
    directory: string,
    record: Record<string, unknown>
): Promise<void> {
    await fs.writeFile(
        path.join(directory, ".gateway.lock"),
        JSON.stringify(record),
        "utf8"
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    leaseMock.mockResolvedValue(null);
});

afterEach(() => {
    jest.restoreAllMocks();
});

afterAll(async () => {
    await Promise.all(
        temporaryDirectories.map((directory) =>
            fs.rm(directory, { recursive: true, force: true })
        )
    );
});

describe("WhatsApp gateway lock inspection", () => {
    test("held=false when neither the file nor the lease exists", async () => {
        const inspection = await inspectWhatsAppGatewayLock(await tempDir());

        expect(inspection).toMatchObject({
            held: false,
            holder: null,
            stale: false,
            heartbeatAgeMs: null,
            localLock: false,
            databaseLease: false,
        });
    });

    test("a dead pid is held, not alive, and stale", async () => {
        const directory = await tempDir();
        const acquiredAt = new Date().toISOString();

        await writeLock(directory, {
            pid: 4321,
            ownerId: "wa-4321-dead",
            acquiredAt,
            host: os.hostname(),
            heartbeatAt: acquiredAt,
        });

        jest.spyOn(process, "kill").mockImplementation((() => {
            const error = Object.assign(new Error("no such process"), {
                code: "ESRCH",
            });
            throw error;
        }) as typeof process.kill);

        const inspection = await inspectWhatsAppGatewayLock(directory);

        expect(inspection.held).toBe(true);
        expect(inspection.holder).toMatchObject({
            pid: 4321,
            host: os.hostname(),
            alive: false,
        });
        expect(inspection.stale).toBe(true);
    });

    test("a live pid is alive and not stale", async () => {
        const directory = await tempDir();
        const acquiredAt = new Date().toISOString();

        await writeLock(directory, {
            pid: 4321,
            ownerId: "wa-4321-live",
            acquiredAt,
            host: os.hostname(),
            heartbeatAt: acquiredAt,
        });

        jest.spyOn(process, "kill").mockReturnValue(true);

        const inspection = await inspectWhatsAppGatewayLock(directory);

        expect(inspection.held).toBe(true);
        expect(inspection.holder).toMatchObject({
            pid: 4321,
            alive: true,
        });
        expect(inspection.stale).toBe(false);
    });

    test("a different host with an old heartbeat is stale", async () => {
        const directory = await tempDir();
        const now = new Date("2026-11-09T12:00:00.000Z");

        await writeLock(directory, {
            pid: 4321,
            ownerId: "wa-4321-remote",
            acquiredAt: "2026-11-09T11:49:00.000Z",
            host: "other-host",
            heartbeatAt: "2026-11-09T11:49:00.000Z",
        });

        const killSpy = jest.spyOn(process, "kill");

        const inspection = await inspectWhatsAppGatewayLock(directory, now, {
            staleMs: 10 * 60 * 1000,
        });

        expect(killSpy).not.toHaveBeenCalled();
        expect(inspection.holder).toMatchObject({
            host: "other-host",
            alive: false,
        });
        expect(inspection.heartbeatAgeMs).toBe(11 * 60 * 1000);
        expect(inspection.stale).toBe(true);
    });

    test("a different host with a fresh heartbeat is not stale", async () => {
        const directory = await tempDir();
        const now = new Date("2026-11-09T12:00:00.000Z");

        await writeLock(directory, {
            pid: 4321,
            ownerId: "wa-4321-remote",
            acquiredAt: "2026-11-09T11:59:00.000Z",
            host: "other-host",
            heartbeatAt: "2026-11-09T11:59:00.000Z",
        });

        const killSpy = jest.spyOn(process, "kill");

        const inspection = await inspectWhatsAppGatewayLock(directory, now, {
            staleMs: 10 * 60 * 1000,
        });

        expect(killSpy).not.toHaveBeenCalled();
        expect(inspection.holder).toMatchObject({
            host: "other-host",
            alive: true,
        });
        expect(inspection.heartbeatAgeMs).toBe(60 * 1000);
        expect(inspection.stale).toBe(false);
    });

    test("an unreadable /proc entry yields processName=null without throwing", async () => {
        jest.spyOn(fs, "readFile").mockRejectedValueOnce(
            Object.assign(new Error("permission denied"), {
                code: "EPERM",
            })
        );

        await expect(readProcessNameFromProc(123)).resolves.toBeNull();
    });
});
