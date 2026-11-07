import type { EmailTransport } from "../types";

/** SMTP adapter. Credentials are read from the worker environment, never the database. */

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
    pass?: string;
};

/**
 * Read SMTP configuration without contacting the provider.
 *
 * Missing host/from is a configuration error, not a reason to guess an identity. Values are
 * Secrets are read only in the worker process and are never returned to the dashboard.
 */
export function readSmtpAdapterConfig(
    env: Record<string, string | undefined> = process.env
): SmtpAdapterConfig | null {
    const host = env.SMTP_HOST?.trim();
    const from = env.EMAIL_FROM?.trim();
    const user = env.SMTP_USER?.trim() || null;
    const pass = env.SMTP_PASS?.trim() || undefined;

    if (!host || !from || (user && !pass) || (!user && pass)) {
        return null;
    }

    const port = Number(env.SMTP_PORT?.trim() || "587");
    const secure = env.SMTP_SECURE?.trim().toLowerCase() === "true";

    return {
        host,
        port: Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : 587,
        secure,
        user,
        from,
        pass,
    };
}

/**
 * Construct a transport only when host and sender settings are present.
 */
export function createSmtpEmailTransport(
    config: SmtpAdapterConfig | null = readSmtpAdapterConfig()
): EmailTransport {
    if (!config) throw new Phase1TransportRefusedError("SMTP_HOST and EMAIL_FROM must be configured.");
    return {
        name: "smtp",
        kind: "smtp",
        async send(message, context) {
            const nodemailer = await import("nodemailer");
            const transporter = nodemailer.createTransport({
                host: config.host,
                port: config.port,
                secure: config.secure,
                auth: config.user ? { user: config.user, pass: config.pass ?? "" } : undefined,
                tls: { rejectUnauthorized: true },
                connectionTimeout: 10_000,
                socketTimeout: 20_000,
                disableFileAccess: true,
                disableUrlAccess: true,
            });
            const result = await transporter.sendMail({ from: config.from, to: message.to, subject: message.subject, text: message.text, headers: { "X-TinggalKlik-Delivery": context.deliveryId } });
            return { simulated: false, providerMessageId: result.messageId };
        },
    };
}
