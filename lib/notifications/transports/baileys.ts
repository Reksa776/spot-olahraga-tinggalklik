import type { WhatsAppTransport } from "../types";

/**
 * ==========================================
 * WHATSAPP / BAILEYS ADAPTER — STRUCTURE ONLY, ALWAYS REFUSES (PHASE 1)
 * ==========================================
 *
 * Baileys is an UNOFFICIAL WhatsApp client: a pairing is full control of the account, and an
 * automated fault can get the number banned. Phase 1 is therefore allowed to prepare the adapter
 * shape and nothing else:
 *
 *   ✗ no `@whiskeysockets/baileys` import (not on the worker's import graph at all)
 *   ✗ no socket, no reconnect loop, no `makeWASocket`
 *   ✗ no QR / pairing code, no `useMultiFileAuthState`, no session directory
 *   ✗ no send, no presence update, no history sync
 *
 * The Phase 2+ contract, documented here so the shape is not invented later:
 *
 *   • one socket per session, serialised by a `joblock` row (two sockets on one
 *     credential disconnect each other);
 *   • auth state under `WA_AUTH_DIR`, outside the checkout, mode 0700, file mode 0600,
 *     included in the encrypted backup;
 *   • `DisconnectReason.loggedOut` stops the worker and asks for a NEW pairing instead of
 *     reconnecting in a loop;
 *   • one message at a time, with a deliberate delay, never a concurrent broadcast.
 *
 * Pairing is performed by an operator on the host, never through a web route: a QR rendered in
 * the browser is an account-takeover primitive.
 */

export class Phase1WhatsAppRefusedError extends Error {
    readonly code = "PHASE_1_WHATSAPP_REFUSED";

    constructor(message: string) {
        super(message);
        this.name = "Phase1WhatsAppRefusedError";
    }
}

/**
 * Phase 1: refuse to construct a WhatsApp transport.
 *
 * No session directory is created, read or required. `WA_AUTH_DIR` is intentionally not touched
 * by this module: creating the directory is the first step of pairing, and Phase 1 does not
 * start it.
 */
export function createBaileysWhatsAppTransport(
    _options: { authDir?: string; logger?: unknown } = {}
): WhatsAppTransport {
    throw new Phase1WhatsAppRefusedError(
        "Baileys is not active in Phase 1: no pairing, session, socket or send is permitted."
    );
}
