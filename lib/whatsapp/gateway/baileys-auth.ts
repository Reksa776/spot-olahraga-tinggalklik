import type {
    AuthenticationCreds,
    AuthenticationState,
} from "@whiskeysockets/baileys";
import type { EncryptedJsonStore } from "./encrypted-store";

/**
 * Maps Baileys' AuthenticationState onto the encrypted JSON store.
 *
 * Baileys mutates `creds` and calls `saveCreds()` when it changes; signal keys are read and
 * written through `keys.get` / `keys.set`. We keep the working copy in memory and flush the
 * whole encrypted envelope after every key mutation. Nothing is ever written as plaintext.
 *
 * This module is only used by the real socket factory. Tests inject a fake socket and never
 * import Baileys at runtime.
 */

export type StoredBaileysAuth = {
    creds: AuthenticationCreds;
    keys: Record<string, Record<string, unknown>>;
};

export type BaileysAuthRuntime = {
    BufferJSON: {
        replacer: (key: string, value: unknown) => unknown;
        reviver: (key: string, value: unknown) => unknown;
    };
    initAuthCreds: () => AuthenticationCreds;
};

export class MissingBaileysSessionError extends Error {
    constructor() {
        super("No encrypted WhatsApp session exists.");
        this.name = "MissingBaileysSessionError";
    }
}

export async function openEncryptedBaileysAuthState(
    store: EncryptedJsonStore<StoredBaileysAuth>,
    runtime: BaileysAuthRuntime
): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
}> {
    const stored = await store.read();

    if (!stored) {
        // P2 never creates a fresh credential set: pairing is an explicit, host-only act in
        // P3. Starting from `initAuthCreds()` here would silently begin a new pairing.
        throw new MissingBaileysSessionError();
    }

    const creds = stored.creds;
    const keys = stored.keys ?? {};

    const persist = async (): Promise<void> => {
        await store.write({ creds, keys });
    };

    const state = {
        creds,
        keys: {
            get: async (type: string, ids: string[]) => {
                const bucket = keys[type] ?? {};
                const result: Record<string, unknown> = {};

                for (const id of ids) {
                    if (bucket[id] !== undefined && bucket[id] !== null) {
                        result[id] = bucket[id];
                    }
                }

                return result;
            },
            set: async (data: Record<string, Record<string, unknown> | undefined>) => {
                for (const [type, values] of Object.entries(data)) {
                    if (!values) {
                        continue;
                    }

                    const bucket = (keys[type] ??= {});

                    for (const [id, value] of Object.entries(values)) {
                        if (value === null) {
                            delete bucket[id];
                        } else {
                            bucket[id] = value;
                        }
                    }
                }

                await persist();
            },
        },
    } as unknown as AuthenticationState;

    return { state, saveCreds: persist };
}
