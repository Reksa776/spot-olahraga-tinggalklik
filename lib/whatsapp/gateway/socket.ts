import type { AuthenticationCreds, AuthenticationState } from "@whiskeysockets/baileys";
import { openEncryptedBaileysAuthState, type StoredBaileysAuth } from "./baileys-auth";
import { EncryptedJsonStore } from "./encrypted-store";

/**
 * The Baileys boundary.
 *
 * Everything above this file talks to `WhatsAppSocketLike`, which is easy to fake. The only
 * code that imports Baileys at runtime is `createBaileysSocket`, and it uses a dynamic import
 * so the mocked tests never load the real socket library.
 *
 * QR payloads stay in memory and are passed to the gateway orchestrator for the short-lived,
 * authenticated dashboard pairing flow. They are never written to logs or session storage.
 */

export type SocketConnectionEvent =
    | { type: "connection"; status: "connecting" | "open" }
    | {
          type: "connection";
          status: "close";
          reason:
              | "logged-out"
              | "replaced"
              | "restart-required"
              | "network"
              | "bad-session";
      }
    | { type: "qr"; value: string }
    | { type: "creds" }
    | { type: "receipt"; messageId: string; ack: "delivered" | "read" | "failed" };

export type WhatsAppSocketLike = {
    onEvent(listener: (event: SocketConnectionEvent) => void): () => void;
    sendMessage(jid: string, content: { text: string }): Promise<{ messageId: string | null }>;
    end(): Promise<void>;
};

export type SocketFactory = (options: {
    sessionDir: string;
    sessionKey: Buffer;
    allowPairing?: boolean;
}) => Promise<WhatsAppSocketLike>;

function disconnectReason(code: number | undefined): "logged-out" | "replaced" | "restart-required" | "network" | "bad-session" {
    switch (code) {
        case 401:
        case 403:
            return "logged-out";
        case 440:
            return "replaced";
        case 500:
            return "bad-session";
        case 515:
            return "restart-required";
        default:
            return "network";
    }
}

const silentLogger = {
    level: "silent",
    child() {
        return this;
    },
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
};

export async function createBaileysSocket(options: {
    sessionDir: string;
    sessionKey: Buffer;
    allowPairing?: boolean;
}): Promise<WhatsAppSocketLike> {
    const baileys = await import("@whiskeysockets/baileys");

    const store = new EncryptedJsonStore<StoredBaileysAuth>({
        directory: options.sessionDir,
        key: options.sessionKey,
        serialize: (value) => JSON.stringify(value, baileys.BufferJSON.replacer),
        deserialize: (raw) => JSON.parse(raw, baileys.BufferJSON.reviver) as StoredBaileysAuth,
    });

    const { state, saveCreds } = await openEncryptedBaileysAuthState(store, {
        BufferJSON: baileys.BufferJSON,
        initAuthCreds: baileys.initAuthCreds,
    }, { allowPairing: options.allowPairing });

    const listeners = new Set<(event: SocketConnectionEvent) => void>();
    let pendingCredentialSave: Promise<void> = Promise.resolve();
    const emit = (event: SocketConnectionEvent) => {
        for (const listener of listeners) {
            listener(event);
        }
    };

    const sock = baileys.default({
        auth: state as AuthenticationState,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        logger: silentLogger as never,
    });

    sock.ev.on("connection.update", (update) => {
        if (update.connection === "connecting") {
            emit({ type: "connection", status: "connecting" });
        } else if (update.connection === "open") {
            emit({ type: "connection", status: "open" });
        } else if (update.connection === "close") {
            const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
                ?.output?.statusCode;
            emit({
                type: "connection",
                status: "close",
                reason: disconnectReason(code),
            });
        } else if (update.qr) {
            // The QR itself never leaves this function and is never logged.
            emit({ type: "qr", value: update.qr });
        }
    });

    sock.ev.on("creds.update", () => {
        pendingCredentialSave = pendingCredentialSave
            .then(() => saveCreds())
            .then(() => emit({ type: "creds" }))
            .catch(() => undefined);
    });

    sock.ev.on("messages.update", (updates) => {
        for (const update of updates) {
            const messageId = update.key?.id;
            const status = update.update?.status;

            if (!messageId || typeof status !== "number") {
                continue;
            }

            if (status === 3) {
                emit({ type: "receipt", messageId, ack: "delivered" });
            } else if (status === 4 || status === 5) {
                emit({ type: "receipt", messageId, ack: "read" });
            } else if (status === 0) {
                emit({ type: "receipt", messageId, ack: "failed" });
            }
        }
    });

    return {
        onEvent(listener) {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
        async sendMessage(jid, content) {
            const result = await sock.sendMessage(jid, content);

            return { messageId: result?.key?.id ?? null };
        },
        async end() {
            // QR pairing can immediately produce a 515 restart-required close. Flush the
            // credentials emitted during linking before the gateway opens the replacement
            // socket, or the new socket may incorrectly behave as unpaired.
            await pendingCredentialSave;
            try {
                sock.end(undefined);
            } catch {
                // Shutdown must not surface a socket error as a new failure.
            }
        },
    };
}

export type { AuthenticationCreds };
