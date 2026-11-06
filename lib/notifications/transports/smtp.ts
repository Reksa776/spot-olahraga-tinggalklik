import type { EmailTransport } from "../types";

/**
 * ==========================================
 * SMTP ADAPTER — STRUCTURE ONLY, ALWAYS REFUSES (PHASE 1)
 * ==========================================
 *
 * The owner approved SMTP as the production target. Phase 1's obligation is to prepare the
 * adapter's SHAPE without activating it, and the security constraint is absolute: no connection,
 * no authentication, no send.
 *
 * This file therefore contains NO `nodemailer` import. That is not an oversight and not a stub
 * waiting for a commented-out call: importing the library here would put a vulnerable parser
 * (audit B1: nodemailer 8.0.11 has four High advisories) on the worker's import graph for no
 * Phase 1 benefit. The documented Phase 2 contract is:
 *
 *   nodemailer.createTransport({
 *     host, port, secure,
 *     auth: { user, pass },                 // from the host environment, never the database
 *     tls: { rejectUnauthorized: true },
 *     connectionTimeout: 10_000,
 *     socketTimeout: 20_000,
 *     disableFileAccess: true,              // no `file:` content
 *     disableUrlAccess: true,               // no SSRF via URL content
 *   })
 *
 * with `from` fixed from configuration, plain text only, no `raw`, no attachments, recipient
 * taken from the queue row rather than a request. Activation also requires an owner decision on
 * the nodemailer path (audit §2.4) — it is not an implementation choice.
 *
 * Every factory below THROWS. There is no flag, environment variable or argument that makes this
 * module return a usable transport in Phase 1.
 */

export class Phase1TransportRefusedError extends Error {
    readonly code = "PHASE_1_TRANSPORT_REFUSED";

    constructor(message: string) {
        super(message);
        this.name = "Phase1TransportRefusedError";
    }
}

export type SmtpAdapterConfig = {
    host: string;
    port: number;
    secure: boolean;
    user: string | null;
    from: string;
};

/**
 * Read the SMTP configuration WITHOUT contacting anything.
 *
 * Missing host/from is a configuration error, not a reason to guess an identity. Values are
 * returned only so a later phase can validate them; Phase 1 never logs them and never uses them
 * to connect. The password is deliberately NOT part of this type: only the adapter that actually
 * authenticates should be able to read it.
 */
export function readSmtpAdapterConfig(
    env: Record<string, string | undefined> = process.env
): SmtpAdapterConfig | null {
    const host = env.SMTP_HOST?.trim();
    const from = env.EMAIL_FROM?.trim();

    if (!host || !from) {
        return null;
    }

    const port = Number(env.SMTP_PORT?.trim() || "587");
    const secure = env.SMTP_SECURE?.trim().toLowerCase() === "true";

    return {
        host,
        port: Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : 587,
        secure,
        user: env.SMTP_USER?.trim() || null,
        from,
    };
}

/**
 * Phase 1: refuse to construct an SMTP transport.
 *
 * Throwing rather than returning a disabled object is intentional: a disabled object can be
 * handed to a future caller and quietly accepted, while a throw cannot be ignored. The worker
 * never calls this function, and the config resolver can never select the smtp transport, but
 * the guard exists so a future edit that tries to wire it fails loudly during Phase 1.
 */
export function createSmtpEmailTransport(
    _config: SmtpAdapterConfig | null = readSmtpAdapterConfig()
): EmailTransport {
    throw new Phase1TransportRefusedError(
        "SMTP is not active in Phase 1: no connection, authentication or send is permitted."
    );
}
