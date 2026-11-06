import fs from "node:fs/promises";
import path from "node:path";
import {
    resolveWhatsAppGatewayConfig,
    parseSessionKey,
} from "@/lib/whatsapp/gateway/config";
import {
    EncryptedJsonStore,
    SessionDecryptionError,
} from "@/lib/whatsapp/gateway/encrypted-store";
import { GatewayLifecycle } from "@/lib/whatsapp/gateway/lifecycle";
import { LocalProcessLock } from "@/lib/whatsapp/gateway/local-lock";
import {
    validateReconciliation,
    validateTextDispatch,
} from "@/lib/whatsapp/gateway/protocol";
import { ReconnectPolicy } from "@/lib/whatsapp/gateway/reconnect";
import {
    sanitizeErrorMessage,
    structuredLog,
} from "@/lib/notifications/logger";
import {
    createTempSessionDir,
    removeTempDir,
    TEST_KEY,
    TEST_TOKEN,
} from "./helpers";

const SESSION_KEY_BASE64 = TEST_KEY.toString("base64");

const temporaryDirectories: string[] = [];

async function tempDir(): Promise<string> {
    const directory = await createTempSessionDir();
    temporaryDirectories.push(directory);
    return directory;
}

afterAll(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(removeTempDir));
});

describe("gateway configuration fails closed", () => {
    test("disabled is the default and needs no other input", () => {
        const result = resolveWhatsAppGatewayConfig({});

        expect(result).toEqual({ ok: true, config: { enabled: false } });
    });

    test("enabled requires a strong token", async () => {
        const dir = await tempDir();
        const base = {
            WA_GATEWAY_ENABLED: "true",
            WA_SESSION_ENCRYPTION_KEY: SESSION_KEY_BASE64,
            WA_AUTH_DIR: dir,
        };

        expect(resolveWhatsAppGatewayConfig(base)).toMatchObject({
            ok: false,
            code: "MISSING_OR_WEAK_TOKEN",
        });
        expect(
            resolveWhatsAppGatewayConfig({ ...base, WA_GATEWAY_TOKEN: "short" })
        ).toMatchObject({ ok: false, code: "MISSING_OR_WEAK_TOKEN" });
    });

    test("the session key must be exactly 32 bytes and the path must be absolute and outside the repo", async () => {
        const dir = await tempDir();

        expect(parseSessionKey(Buffer.alloc(31, 1).toString("base64"))).toBeNull();
        expect(parseSessionKey("not-a-key")).toBeNull();

        const base = {
            WA_GATEWAY_ENABLED: "true",
            WA_GATEWAY_TOKEN: TEST_TOKEN,
            WA_SESSION_ENCRYPTION_KEY: SESSION_KEY_BASE64,
        };

        expect(resolveWhatsAppGatewayConfig(base)).toMatchObject({
            ok: false,
            code: "MISSING_SESSION_DIR",
        });
        expect(
            resolveWhatsAppGatewayConfig({ ...base, WA_AUTH_DIR: "relative/session" })
        ).toMatchObject({ ok: false, code: "RELATIVE_SESSION_DIR" });
        expect(
            resolveWhatsAppGatewayConfig({
                ...base,
                WA_AUTH_DIR: path.join(process.cwd(), "inside-repo-session"),
            })
        ).toMatchObject({ ok: false, code: "UNSAFE_SESSION_DIR" });

        // A host path outside the checkout is accepted.
        expect(
            resolveWhatsAppGatewayConfig(
                { ...base, WA_AUTH_DIR: dir },
                { projectRoot: path.join(process.cwd(), "app") }
            )
        ).toMatchObject({ ok: true, config: { enabled: true, sessionDir: path.resolve(dir) } });
    });

    test("public and wildcard binds are refused before listen", async () => {
        const dir = await tempDir();
        const base = {
            WA_GATEWAY_ENABLED: "true",
            WA_GATEWAY_TOKEN: TEST_TOKEN,
            WA_SESSION_ENCRYPTION_KEY: SESSION_KEY_BASE64,
            WA_AUTH_DIR: dir,
        };

        for (const host of ["0.0.0.0", "::", "localhost", "example.com"]) {
            expect(
                resolveWhatsAppGatewayConfig({ ...base, WA_GATEWAY_HOST: host })
            ).toMatchObject({ ok: false, code: "PUBLIC_BIND_REFUSED" });
        }

        expect(
            resolveWhatsAppGatewayConfig({ ...base, WA_GATEWAY_HOST: "127.0.0.1" })
        ).toMatchObject({ ok: true, config: { host: "127.0.0.1", port: 3100 } });
    });
});

describe("lifecycle and reconnect policy are explicit", () => {
    test("every required state is reachable through a valid transition", () => {
        const lifecycle = new GatewayLifecycle();

        expect(lifecycle.state).toBe("STOPPED");
        lifecycle.transition("STARTING");
        lifecycle.transition("PAIRING_REQUIRED");
        lifecycle.transition("STARTING");
        lifecycle.transition("CONNECTED");
        lifecycle.transition("DISCONNECTED");
        lifecycle.transition("STARTING");
        lifecycle.transition("LOGGED_OUT");
        lifecycle.transition("STOPPED");

        const second = new GatewayLifecycle();
        second.transition("STARTING");
        second.transition("CONFLICT");
        second.transition("STOPPED");

        const third = new GatewayLifecycle();
        third.transition("STARTING");
        third.transition("ERROR");
        third.transition("STOPPED");

        expect(() => lifecycle.transition("CONNECTED")).toThrow(
            /Invalid WhatsApp gateway transition/
        );
    });

    test("reconnect backoff is bounded and resets after a real connection", () => {
        const policy = new ReconnectPolicy([10, 20]);

        expect(policy.next()).toEqual({ attempt: 1, delayMs: 10 });
        expect(policy.next()).toEqual({ attempt: 2, delayMs: 20 });
        expect(policy.next()).toBeNull();

        policy.reset();
        expect(policy.next()).toEqual({ attempt: 1, delayMs: 10 });
    });
});

describe("encrypted session storage", () => {
    test("writes only ciphertext, restores the value, and enforces 0700/0600", async () => {
        const directory = await tempDir();
        const store = new EncryptedJsonStore<{ value: string }>({
            directory,
            key: TEST_KEY,
        });

        await store.write({ value: "session-secret-material" });

        const file = path.join(directory, "auth.enc");
        const raw = await fs.readFile(file, "utf8");

        expect(raw).not.toContain("session-secret-material");
        expect(raw).not.toContain(TEST_KEY.toString("base64"));
        await expect(store.read()).resolves.toEqual({
            value: "session-secret-material",
        });

        const dirStat = await fs.stat(directory);
        const fileStat = await fs.stat(file);

        expect(dirStat.mode & 0o777).toBe(0o700);
        expect(fileStat.mode & 0o777).toBe(0o600);
    });

    test("a wrong key or tampered ciphertext is refused", async () => {
        const directory = await tempDir();
        const store = new EncryptedJsonStore<{ value: string }>({
            directory,
            key: TEST_KEY,
        });

        await store.write({ value: "do-not-leak" });

        const wrongKey = new EncryptedJsonStore<{ value: string }>({
            directory,
            key: Buffer.alloc(32, 0x11),
        });

        await expect(wrongKey.read()).rejects.toBeInstanceOf(SessionDecryptionError);

        const file = path.join(directory, "auth.enc");
        const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
            data: string;
        };
        parsed.data = Buffer.from("tampered").toString("base64");
        await fs.writeFile(file, JSON.stringify(parsed), "utf8");

        await expect(store.read()).rejects.toBeInstanceOf(SessionDecryptionError);
    });

    test("the local process lock is exclusive and only its owner can release it", async () => {
        const directory = await tempDir();
        const lockPath = path.join(directory, ".gateway.lock");
        const first = new LocalProcessLock(lockPath, "owner-one");
        const second = new LocalProcessLock(lockPath, "owner-two");

        await expect(first.acquire()).resolves.toBe(true);
        await expect(second.acquire()).resolves.toBe(false);

        await second.release();
        await expect(second.acquire()).resolves.toBe(false);

        await first.release();
        await expect(second.acquire()).resolves.toBe(true);
        await second.release();
    });
});

describe("payload validation never reaches a socket", () => {
    test("a valid Indonesian number becomes a user JID", () => {
        const result = validateTextDispatch({
            deliveryId: "delivery-1",
            notificationId: 12,
            to: "+62 812-3456-7890",
            text: "Your ticket is ready.",
        });

        expect(result).toMatchObject({
            ok: true,
            value: {
                deliveryId: "delivery-1",
                notificationId: 12,
                jid: "6281234567890@s.whatsapp.net",
            },
        });
    });

    test("group JIDs, missing ids, empty text and malformed reconciliation are refused", () => {
        expect(
            validateTextDispatch({
                deliveryId: "delivery-1",
                notificationId: 1,
                to: "123456@g.us",
                text: "group",
            })
        ).toMatchObject({ ok: false, code: "INVALID_RECIPIENT" });

        expect(
            validateTextDispatch({
                deliveryId: "",
                notificationId: 1,
                to: "08123456789",
                text: "hello",
            })
        ).toMatchObject({ ok: false, code: "INVALID_DELIVERY_ID" });

        expect(
            validateTextDispatch({
                deliveryId: "delivery-1",
                notificationId: 1,
                to: "08123456789",
                text: "   ",
            })
        ).toMatchObject({ ok: false, code: "INVALID_TEXT" });

        expect(validateReconciliation({ state: "SENT" })).toMatchObject({
            ok: false,
            code: "MESSAGE_ID_REQUIRED",
        });
        expect(
            validateReconciliation({ state: "AMBIGUOUS", messageId: "m" })
        ).toMatchObject({ ok: false, code: "INVALID_RECONCILIATION_STATE" });
    });
});

describe("log redaction", () => {
    test("tokens, phone numbers and email recipients never reach a log line", () => {
        const lines: string[] = [];

        structuredLog(
            "info",
            "gateway.test",
            {
                token: "super-secret-token",
                phone: "6281234567890",
                recipient: "buyer@example.test",
                note: "smtp://user:password@example.test failed for 6281234567890",
            },
            (line) => lines.push(line)
        );

        const joined = lines.join("\n");

        expect(joined).not.toContain("super-secret-token");
        expect(joined).not.toContain("6281234567890");
        expect(joined).not.toContain("buyer@example.test");
        expect(joined).not.toContain("user:password");
    });

    test("sanitized provider errors cannot echo credentials, phones or emails", () => {
        const message = sanitizeErrorMessage(
            new Error(
                "connect smtp://mailer:super-secret-password@smtp.example.test:587 failed for 6281234567890 and buyer@example.test"
            )
        );

        expect(message).not.toContain("super-secret-password");
        expect(message).not.toContain("6281234567890");
        expect(message).not.toContain("buyer@example.test");
    });
});
