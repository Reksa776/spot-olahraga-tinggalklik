import path from "node:path";

/**
 * ==========================================
 * WHATSAPP GATEWAY CONFIGURATION (PHASE P2)
 * ==========================================
 *
 * The gateway is DISABLED unless `WA_GATEWAY_ENABLED=true`. Disabled is a valid, complete
 * configuration: no token, key or session directory is read, and the process exits cleanly.
 *
 * When enabled, every safety input is mandatory and fail-closed:
 *
 *   - the bearer token is at least 32 characters;
 *   - the session key is exactly 32 bytes (base64 or hex);
 *   - the session directory is ABSOLUTE and OUTSIDE this repository;
 *   - the bind address is loopback only.
 *
 * Nothing in this module logs. Callers must never print the token, key, session directory or
 * a derived value from them.
 */

export type GatewayHost = "127.0.0.1" | "::1";

export type EnabledWhatsAppGatewayConfig = {
    enabled: true;
    host: GatewayHost;
    port: number;
    token: string;
    sessionDir: string;
    sessionKey: Buffer;
    dispatchTimeoutMs: number;
    shutdownGraceMs: number;
    leaseMs: number;
    leaseRenewMs: number;
    maxBodyBytes: number;
    minSendDelayMs: number;
    retentionDays: number;
    reconnectDelaysMs: readonly number[];
    maxReconnectAttempts: number;
};

export type WhatsAppGatewayConfig =
    | { enabled: false }
    | EnabledWhatsAppGatewayConfig;

export type ConfigResult =
    | { ok: true; config: WhatsAppGatewayConfig }
    | { ok: false; code: string; message: string };

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS: readonly GatewayHost[] = ["127.0.0.1", "::1"];

const DEFAULTS = {
    port: 3100,
    dispatchTimeoutMs: 10_000,
    shutdownGraceMs: 10_000,
    leaseMs: 90_000,
    leaseRenewMs: 30_000,
    maxBodyBytes: 8_192,
    minSendDelayMs: 5_000,
    retentionDays: 30,
    reconnectDelaysMs: [1_000, 5_000, 15_000, 30_000, 60_000, 300_000],
    maxReconnectAttempts: 6,
} as const;

function isTrue(value: string | undefined): boolean {
    return value?.trim().toLowerCase() === "true";
}

function readInteger(
    env: Env,
    key: string,
    fallback: number,
    min: number,
    max: number
): number | null {
    const raw = env[key]?.trim();

    if (raw === undefined || raw === "") {
        return fallback;
    }

    if (!/^\d+$/.test(raw)) {
        return null;
    }

    const parsed = Number(raw);

    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
        ? parsed
        : null;
}

/**
 * Parse a 32-byte key supplied as base64 (44 chars) or hex (64 chars).
 * Returns `null` for anything else. Never include the raw value in an error.
 */
export function parseSessionKey(raw: string | undefined): Buffer | null {
    const value = raw?.trim();

    if (!value) {
        return null;
    }

    let key: Buffer;

    if (/^[0-9a-fA-F]{64}$/.test(value)) {
        key = Buffer.from(value, "hex");
    } else {
        key = Buffer.from(value, "base64");
    }

    return key.length === 32 ? key : null;
}

export function isLoopbackGatewayHost(host: string): host is GatewayHost {
    return LOOPBACK_HOSTS.includes(host as GatewayHost);
}

function isInsideDirectory(parent: string, candidate: string): boolean {
    const relative = path.relative(parent, candidate);

    return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) &&
            relative !== ".." &&
            !path.isAbsolute(relative))
    );
}

/**
 * Resolve the process configuration. `projectRoot` is injectable so tests can prove that a
 * repository-relative session directory is rejected without creating one.
 */
export function resolveWhatsAppGatewayConfig(
    env: Env = process.env,
    options: { projectRoot?: string } = {}
): ConfigResult {
    if (!isTrue(env.WA_GATEWAY_ENABLED)) {
        return { ok: true, config: { enabled: false } };
    }

    const token = env.WA_GATEWAY_TOKEN?.trim();

    if (!token || token.length < 32) {
        return {
            ok: false,
            code: "MISSING_OR_WEAK_TOKEN",
            message:
                "WA_GATEWAY_TOKEN must be set to at least 32 characters when the gateway is enabled.",
        };
    }

    const sessionKey = parseSessionKey(env.WA_SESSION_ENCRYPTION_KEY);

    if (!sessionKey) {
        return {
            ok: false,
            code: "INVALID_SESSION_KEY",
            message:
                "WA_SESSION_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64 or hex.",
        };
    }

    const rawSessionDir = env.WA_AUTH_DIR?.trim();

    if (!rawSessionDir) {
        return {
            ok: false,
            code: "MISSING_SESSION_DIR",
            message: "WA_AUTH_DIR must be an absolute path outside the repository.",
        };
    }

    if (!path.isAbsolute(rawSessionDir)) {
        return {
            ok: false,
            code: "RELATIVE_SESSION_DIR",
            message: "WA_AUTH_DIR must be an absolute path outside the repository.",
        };
    }

    const sessionDir = path.resolve(rawSessionDir);
    const projectRoot = path.resolve(options.projectRoot ?? process.cwd());

    if (isInsideDirectory(projectRoot, sessionDir)) {
        return {
            ok: false,
            code: "UNSAFE_SESSION_DIR",
            message:
                "WA_AUTH_DIR must be outside the repository and web root; use a host path such as /var/lib/tinggalklik/whatsapp-auth.",
        };
    }

    const host = (env.WA_GATEWAY_HOST?.trim() || "127.0.0.1") as string;

    if (!isLoopbackGatewayHost(host)) {
        return {
            ok: false,
            code: "PUBLIC_BIND_REFUSED",
            message: "WA_GATEWAY_HOST must be 127.0.0.1 or ::1; public binding is refused.",
        };
    }

    const port = readInteger(env, "WA_GATEWAY_PORT", DEFAULTS.port, 1, 65_535);

    if (port === null) {
        return {
            ok: false,
            code: "INVALID_PORT",
            message: "WA_GATEWAY_PORT must be an integer from 1 to 65535.",
        };
    }

    const dispatchTimeoutMs = readInteger(
        env,
        "WA_GATEWAY_DISPATCH_TIMEOUT_MS",
        DEFAULTS.dispatchTimeoutMs,
        500,
        120_000
    );

    if (dispatchTimeoutMs === null) {
        return {
            ok: false,
            code: "INVALID_DISPATCH_TIMEOUT",
            message: "WA_GATEWAY_DISPATCH_TIMEOUT_MS must be between 500 and 120000.",
        };
    }

    const shutdownGraceMs = readInteger(
        env,
        "WA_GATEWAY_SHUTDOWN_GRACE_MS",
        DEFAULTS.shutdownGraceMs,
        1_000,
        60_000
    );

    if (shutdownGraceMs === null) {
        return {
            ok: false,
            code: "INVALID_SHUTDOWN_GRACE",
            message: "WA_GATEWAY_SHUTDOWN_GRACE_MS must be between 1000 and 60000.",
        };
    }

    const leaseMs = readInteger(
        env,
        "WA_GATEWAY_LEASE_MS",
        DEFAULTS.leaseMs,
        5_000,
        600_000
    );

    const leaseRenewMs = readInteger(
        env,
        "WA_GATEWAY_LEASE_RENEW_MS",
        DEFAULTS.leaseRenewMs,
        1_000,
        300_000
    );

    if (
        leaseMs === null ||
        leaseRenewMs === null ||
        leaseRenewMs >= leaseMs
    ) {
        return {
            ok: false,
            code: "INVALID_LEASE",
            message:
                "WA_GATEWAY_LEASE_MS and WA_GATEWAY_LEASE_RENEW_MS must be valid, with renew < lease.",
        };
    }

    const maxBodyBytes = readInteger(
        env,
        "WA_GATEWAY_BODY_LIMIT_BYTES",
        DEFAULTS.maxBodyBytes,
        1_024,
        65_536
    );

    if (maxBodyBytes === null) {
        return {
            ok: false,
            code: "INVALID_BODY_LIMIT",
            message: "WA_GATEWAY_BODY_LIMIT_BYTES must be between 1024 and 65536.",
        };
    }

    const minSendDelayMs = readInteger(
        env,
        "WA_GATEWAY_MIN_SEND_DELAY_MS",
        DEFAULTS.minSendDelayMs,
        0,
        60_000
    );

    if (minSendDelayMs === null) {
        return {
            ok: false,
            code: "INVALID_SEND_DELAY",
            message: "WA_GATEWAY_MIN_SEND_DELAY_MS must be between 0 and 60000.",
        };
    }

    const retentionDays = readInteger(
        env,
        "WA_GATEWAY_RETENTION_DAYS",
        DEFAULTS.retentionDays,
        1,
        365
    );

    if (retentionDays === null) {
        return {
            ok: false,
            code: "INVALID_RETENTION",
            message: "WA_GATEWAY_RETENTION_DAYS must be between 1 and 365.",
        };
    }

    return {
        ok: true,
        config: {
            enabled: true,
            host,
            port,
            token,
            sessionDir,
            sessionKey,
            dispatchTimeoutMs,
            shutdownGraceMs,
            leaseMs,
            leaseRenewMs,
            maxBodyBytes,
            minSendDelayMs,
            retentionDays,
            reconnectDelaysMs: DEFAULTS.reconnectDelaysMs,
            maxReconnectAttempts: DEFAULTS.maxReconnectAttempts,
        },
    };
}
