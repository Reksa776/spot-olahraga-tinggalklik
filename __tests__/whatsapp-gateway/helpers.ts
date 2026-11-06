import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EnabledWhatsAppGatewayConfig } from "@/lib/whatsapp/gateway/config";
import { EncryptedJsonStore } from "@/lib/whatsapp/gateway/encrypted-store";
import type {
    SocketConnectionEvent,
    WhatsAppSocketLike,
} from "@/lib/whatsapp/gateway/socket";

export const TEST_KEY = Buffer.alloc(32, 0x5a);
export const TEST_TOKEN = "test-gateway-token-0123456789abcdef";

export async function createTempSessionDir(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "tinggalklik-wa-gateway-"));
}

export async function removeTempDir(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
}

export function gatewayConfig(
    sessionDir: string,
    overrides: Partial<EnabledWhatsAppGatewayConfig> = {}
): EnabledWhatsAppGatewayConfig {
    return {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        token: TEST_TOKEN,
        sessionDir,
        sessionKey: TEST_KEY,
        dispatchTimeoutMs: 50,
        shutdownGraceMs: 2_000,
        leaseMs: 60_000,
        leaseRenewMs: 30_000,
        maxBodyBytes: 8_192,
        minSendDelayMs: 0,
        retentionDays: 1,
        reconnectDelaysMs: [10, 20, 50],
        maxReconnectAttempts: 3,
        ...overrides,
    };
}

export async function writeTestSession(directory: string): Promise<void> {
    const store = new EncryptedJsonStore<unknown>({
        directory,
        key: TEST_KEY,
    });

    await store.write({ testSession: true });
}

export type FakeSend = (
    jid: string,
    content: { text: string }
) => Promise<{ messageId: string | null }>;

export class FakeSocket implements WhatsAppSocketLike {
    readonly sent: Array<{ jid: string; content: { text: string } }> = [];
    ended = false;
    sendImplementation: FakeSend | null = null;

    private readonly listeners = new Set<(event: SocketConnectionEvent) => void>();
    private counter = 0;

    onEvent(listener: (event: SocketConnectionEvent) => void): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    async sendMessage(
        jid: string,
        content: { text: string }
    ): Promise<{ messageId: string | null }> {
        this.sent.push({ jid, content });

        if (this.sendImplementation) {
            return this.sendImplementation(jid, content);
        }

        this.counter += 1;

        return { messageId: `fake-message-${this.counter}` };
    }

    async end(): Promise<void> {
        this.ended = true;
    }

    emit(event: SocketConnectionEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}

export async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 2_000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error("Timed out waiting for the gateway condition.");
}

export async function readText(pathname: string): Promise<string> {
    const fs = await import("node:fs/promises");

    return fs.readFile(pathname, "utf8");
}
