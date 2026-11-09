import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

jest.mock("@/lib/prisma", () => ({
    prisma: {
        platformSetting: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
    },
}));

import { prisma } from "@/lib/prisma";
import {
    isWhatsAppManuallyDisconnected,
    setWhatsAppManualDisconnect,
} from "@/lib/whatsapp/manual-disconnect";
import { resolveWhatsAppGatewayConfig } from "@/lib/whatsapp/gateway/config";
import { checkSessionDirIsolation } from "@/lib/whatsapp/gateway/session-dir";
import { ensureWhatsAppSessionKey } from "@/lib/whatsapp/gateway/session-key";
import {
    clearWhatsAppSessionDirectory,
    SessionPathError,
} from "@/lib/whatsapp/gateway/session-cleanup";
import { TEST_TOKEN } from "./helpers";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTH SESSION vs WHATSAPP SESSION — THE ISOLATION CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The application session is a JWT in a cookie, signed and encrypted with
 * `AUTH_SECRET` from the process environment. The WhatsApp session is an encrypted file
 * tree under `WA_AUTH_DIR`. Disconnect with `deleteSession: true` empties that tree.
 *
 * These tests pin the boundary between the two, because the failure mode is catastrophic
 * and silent: if `WA_AUTH_DIR` resolves to the project root (or an ancestor), the cleanup
 * deletes `.env` — and the next process start has no `AUTH_SECRET`, so every login fails
 * or loops through /login. Each test below asserts that the auth side is either
 * structurally unreachable or byte-for-byte unchanged.
 */

const temporaryDirectories: string[] = [];

async function tempDir(prefix: string): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);

    return directory;
}

afterAll(async () => {
    await Promise.all(
        temporaryDirectories.map((directory) =>
            fs.rm(directory, { recursive: true, force: true })
        )
    );
});

describe("session directory never reaches the application tree", () => {
    test("the project root and its ancestors are refused", () => {
        expect(checkSessionDirIsolation(process.cwd())).toMatchObject({
            ok: false,
            code: "PROJECT_ROOT_OR_ANCESTOR",
        });
        expect(
            checkSessionDirIsolation(path.dirname(process.cwd()))
        ).toMatchObject({ ok: false, code: "PROJECT_ROOT_OR_ANCESTOR" });
        expect(checkSessionDirIsolation(path.parse(process.cwd()).root)).toMatchObject({
            ok: false,
            code: "FILESYSTEM_ROOT",
        });

        // The default and an absolute host path remain valid.
        expect(
            checkSessionDirIsolation(
                path.join(process.cwd(), "storage", "whatsapp-gateway")
            )
        ).toMatchObject({ ok: true });
        expect(
            checkSessionDirIsolation("/var/lib/tinggalklik/whatsapp-auth", {
                projectRoot: "/var/www/tinggalklik",
            })
        ).toMatchObject({ ok: true });
    });

    test("cleanup refuses the project root without touching a single file", async () => {
        await expect(
            clearWhatsAppSessionDirectory(process.cwd())
        ).rejects.toBeInstanceOf(SessionPathError);

        // Both live next to the project root and must still exist afterwards.
        await expect(fs.stat(path.join(process.cwd(), ".env.example"))).resolves.toBeTruthy();
        await expect(fs.stat(path.join(process.cwd(), "package.json"))).resolves.toBeTruthy();
    });

    test("a session directory holding .env is refused before the first deletion", async () => {
        const root = await tempDir("wa-auth-env-");

        await fs.writeFile(
            path.join(root, ".env"),
            "AUTH_SECRET=do-not-delete-me\n",
            "utf8"
        );
        await fs.writeFile(path.join(root, "auth.enc"), "encrypted", "utf8");

        await expect(clearWhatsAppSessionDirectory(root)).rejects.toThrow(
            /application files/
        );

        expect(
            await fs.readFile(path.join(root, ".env"), "utf8")
        ).toBe("AUTH_SECRET=do-not-delete-me\n");
        // Refusal happens before ANY deletion, so no half-cleared session is left behind.
        expect(await fs.readdir(root)).toEqual(
            expect.arrayContaining([".env", "auth.enc"])
        );
    });

    test("config refuses WA_AUTH_DIR=. and never falls back to AUTH_SECRET as the key", async () => {
        const base = {
            WA_GATEWAY_ENABLED: "true",
            WA_GATEWAY_TOKEN: TEST_TOKEN,
            WA_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 0x42).toString(
                "base64"
            ),
        };

        expect(
            resolveWhatsAppGatewayConfig({ ...base, WA_AUTH_DIR: "." })
        ).toMatchObject({ ok: false, code: "UNSAFE_SESSION_DIR" });
        expect(
            resolveWhatsAppGatewayConfig({ ...base, WA_AUTH_DIR: ".." })
        ).toMatchObject({ ok: false, code: "UNSAFE_SESSION_DIR" });

        // AUTH_SECRET cannot stand in for WA_SESSION_ENCRYPTION_KEY.
        expect(
            resolveWhatsAppGatewayConfig({
                WA_GATEWAY_ENABLED: "true",
                WA_GATEWAY_TOKEN: TEST_TOKEN,
                WA_AUTH_DIR: "storage/whatsapp-gateway",
                AUTH_SECRET: Buffer.alloc(32, 0x42).toString("base64"),
            })
        ).toMatchObject({ ok: false, code: "INVALID_SESSION_KEY" });
    });
});

describe("deletion is contained and preserves key/ownership evidence", () => {
    test("only entries inside the session root are deleted", async () => {
        const root = await tempDir("wa-contained-root-");
        const outside = await tempDir("wa-contained-outside-");

        await fs.writeFile(path.join(root, "auth.enc"), "encrypted", "utf8");
        await fs.mkdir(path.join(root, "nested"));
        await fs.writeFile(path.join(root, "nested", "creds"), "creds", "utf8");
        await fs.writeFile(path.join(root, ".gateway.lock"), "{}", "utf8");
        await fs.writeFile(path.join(root, ".session-key"), "k".repeat(32), "utf8");
        await fs.writeFile(path.join(outside, "keep.txt"), "keep", "utf8");

        const realRm = fs.rm.bind(fs);
        const removed: string[] = [];
        const spy = jest
            .spyOn(fs, "rm")
            .mockImplementation((async (
                target: string,
                options: Record<string, unknown>
            ) => {
                removed.push(path.resolve(target));
                return realRm(
                    target as unknown as Parameters<typeof realRm>[0],
                    options as unknown as Parameters<typeof realRm>[1]
                );
            }) as unknown as typeof fs.rm);

        try {
            const result = await clearWhatsAppSessionDirectory(root);

            expect(result.deletedEntries).toBe(2);
        } finally {
            spy.mockRestore();
        }

        const rootPrefix = path.resolve(root) + path.sep;

        expect(removed.length).toBe(2);
        for (const target of removed) {
            expect(target.startsWith(rootPrefix)).toBe(true);
        }

        expect((await fs.readdir(root)).sort()).toEqual([
            ".gateway.lock",
            ".session-key",
        ]);
        expect((await fs.stat(root)).isDirectory()).toBe(true);
        expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe(
            "keep"
        );
    });

    test("a disconnect leaves AUTH_SECRET and the application .env untouched", async () => {
        const deployment = await tempDir("wa-deployment-");
        const applicationDir = path.join(deployment, "app");
        const sessionDir = path.join(
            applicationDir,
            "storage",
            "whatsapp-gateway"
        );
        const envBody = "AUTH_SECRET=auth-secret-under-test\nDATABASE_URL=mysql://x\n";

        await fs.mkdir(sessionDir, { recursive: true });
        await fs.writeFile(path.join(applicationDir, ".env"), envBody, "utf8");
        await fs.writeFile(path.join(sessionDir, "auth.enc"), "encrypted", "utf8");
        await fs.writeFile(
            path.join(sessionDir, ".session-key"),
            "k".repeat(32),
            "utf8"
        );

        const previousSecret = process.env.AUTH_SECRET;
        process.env.AUTH_SECRET = "auth-secret-under-test";

        try {
            // The WhatsApp session is removed…
            await clearWhatsAppSessionDirectory(sessionDir);

            // …and the application's sign-in material is byte-for-byte unchanged.
            expect(
                await fs.readFile(path.join(applicationDir, ".env"), "utf8")
            ).toBe(envBody);
            expect(process.env.AUTH_SECRET).toBe("auth-secret-under-test");
            expect((await fs.readdir(sessionDir)).sort()).toEqual([
                ".session-key",
            ]);

            // A second click is idempotent and still leaves auth material alone.
            await expect(
                clearWhatsAppSessionDirectory(sessionDir)
            ).resolves.toEqual({ deletedEntries: 0 });
            expect(
                await fs.readFile(path.join(applicationDir, ".env"), "utf8")
            ).toBe(envBody);
        } finally {
            if (previousSecret === undefined) {
                delete process.env.AUTH_SECRET;
            } else {
                process.env.AUTH_SECRET = previousSecret;
            }
        }
    });

    test("key creation writes only into the session directory and never reads AUTH_SECRET", async () => {
        const sessionDir = await tempDir("wa-key-");
        const previousEnabled = process.env.WA_GATEWAY_ENABLED;
        const previousAuthDir = process.env.WA_AUTH_DIR;
        const previousKey = process.env.WA_SESSION_ENCRYPTION_KEY;
        const previousSecret = process.env.AUTH_SECRET;

        process.env.WA_GATEWAY_ENABLED = "true";
        process.env.WA_AUTH_DIR = sessionDir;
        process.env.AUTH_SECRET = "auth-secret-marker";
        delete process.env.WA_SESSION_ENCRYPTION_KEY;

        try {
            await ensureWhatsAppSessionKey();

            const entries = await fs.readdir(sessionDir);

            expect(entries).toEqual([".session-key"]);
            expect(
                (await fs.readFile(path.join(sessionDir, ".session-key")))
                    .length
            ).toBe(32);
            expect(process.env.AUTH_SECRET).toBe("auth-secret-marker");
            expect(
                Buffer.from(
                    process.env.WA_SESSION_ENCRYPTION_KEY ?? "",
                    "base64"
                ).length
            ).toBe(32);
        } finally {
            if (previousEnabled === undefined) delete process.env.WA_GATEWAY_ENABLED;
            else process.env.WA_GATEWAY_ENABLED = previousEnabled;

            if (previousAuthDir === undefined) delete process.env.WA_AUTH_DIR;
            else process.env.WA_AUTH_DIR = previousAuthDir;

            if (previousKey === undefined) delete process.env.WA_SESSION_ENCRYPTION_KEY;
            else process.env.WA_SESSION_ENCRYPTION_KEY = previousKey;

            if (previousSecret === undefined) delete process.env.AUTH_SECRET;
            else process.env.AUTH_SECRET = previousSecret;
        }
    });
});

describe("the WhatsApp latch cannot influence authentication", () => {
    const upsert = prisma.platformSetting.upsert as jest.Mock;
    const findUnique = prisma.platformSetting.findUnique as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        upsert.mockResolvedValue({});
        findUnique.mockResolvedValue({ whatsappManualDisconnect: true });
    });

    test("writing the latch touches exactly one column", async () => {
        await setWhatsAppManualDisconnect(true);

        expect(upsert).toHaveBeenCalledTimes(1);

        const args = upsert.mock.calls[0][0] as {
            where: { id: number };
            create: Record<string, unknown>;
            update: Record<string, unknown>;
        };

        expect(args.where).toEqual({ id: 1 });
        expect(Object.keys(args.update)).toEqual(["whatsappManualDisconnect"]);
        expect(Object.keys(args.create).sort()).toEqual([
            "id",
            "whatsappManualDisconnect",
        ]);
        expect(args.create).not.toHaveProperty("maintenanceMode");
        expect(args.update).not.toHaveProperty("maintenanceMode");
    });

    test("reading the latch selects only that column", async () => {
        await expect(isWhatsAppManuallyDisconnected()).resolves.toBe(true);

        expect(findUnique).toHaveBeenCalledWith({
            where: { id: 1 },
            select: { whatsappManualDisconnect: true },
        });
    });

    test("auth entry points never read the latch or any WhatsApp secret", async () => {
        const files = ["auth.ts", "proxy.ts", "app/layout.tsx"];

        for (const file of files) {
            const source = await fs.readFile(
                path.join(process.cwd(), file),
                "utf8"
            );

            expect(source).not.toMatch(/whatsappManualDisconnect/);
            expect(source).not.toMatch(/manual-disconnect/);
            expect(source).not.toMatch(/WA_SESSION_ENCRYPTION_KEY/);
            expect(source).not.toMatch(/WA_AUTH_DIR/);
            expect(source).not.toMatch(/storage\/whatsapp-gateway/);
        }
    });
});
