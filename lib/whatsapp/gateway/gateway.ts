import { randomBytes } from "node:crypto";
import path from "node:path";
import { structuredLog } from "@/lib/notifications/logger";
import type { EnabledWhatsAppGatewayConfig } from "./config";
import { EncryptedJsonStore } from "./encrypted-store";
import { WhatsAppGatewayDispatchService, DefiniteSendError } from "./dispatch";
import { GatewayLifecycle, type GatewayState } from "./lifecycle";
import {
    acquireWhatsAppGatewayLease,
    releaseWhatsAppGatewayLease,
    renewWhatsAppGatewayLease,
} from "./lease";
import { LocalProcessLock } from "./local-lock";
import type {
    GatewayDeliveryView,
    GatewayDispatchResult,
    GatewayOperations,
    GatewayReconcileResult,
    GatewaySnapshot,
    TextDispatchRequest,
} from "./protocol";
import { ReconnectPolicy } from "./reconnect";
import { GatewayHttpServer } from "./server";
import {
    createBaileysSocket,
    type SocketConnectionEvent,
    type SocketFactory,
    type WhatsAppSocketLike,
} from "./socket";

/**
 * The isolated gateway orchestrator.
 *
 * One instance owns at most one socket. It acquires the DB lease and local lock before it
 * opens the HTTP server or constructs a socket, renews the lease while running, and fences
 * itself (closing the socket and releasing ownership) if the lease is lost or another
 * connection replaces it. The notification worker is never involved in this lifecycle.
 */

export type Logger = (
    level: "info" | "warn" | "error",
    event: string,
    fields?: Record<string, unknown>
) => void;

export type WhatsAppGatewayDependencies = {
    socketFactory?: SocketFactory;
    logger?: Logger;
    now?: () => Date;
};

function defaultLogger(
    level: "info" | "warn" | "error",
    event: string,
    fields?: Record<string, unknown>
): void {
    structuredLog(level, event, fields);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

export class WhatsAppGateway implements GatewayOperations {
    private readonly lifecycle = new GatewayLifecycle();
    private readonly socketFactory: SocketFactory;
    private readonly logger: Logger;
    private readonly now: () => Date;
    private readonly sessionStore: EncryptedJsonStore<unknown>;
    private readonly dispatchService: WhatsAppGatewayDispatchService;
    private readonly reconnectPolicy: ReconnectPolicy;

    private ownerId: string | null = null;
    private localLock: LocalProcessLock | null = null;
    private leaseHeld = false;
    private localLockHeld = false;
    private ownershipHeld = false;
    private sessionPresent = false;
    private lastErrorCode: string | null = null;
    private server: GatewayHttpServer | null = null;
    private socket: WhatsAppSocketLike | null = null;
    private unsubscribeSocket: (() => void) | null = null;
    private leaseTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private lastSentAt = 0;
    private started = false;
    private stopping = false;

    constructor(
        private readonly config: EnabledWhatsAppGatewayConfig,
        dependencies: WhatsAppGatewayDependencies = {}
    ) {
        this.socketFactory = dependencies.socketFactory ?? createBaileysSocket;
        this.logger = dependencies.logger ?? defaultLogger;
        this.now = dependencies.now ?? (() => new Date());
        this.sessionStore = new EncryptedJsonStore<unknown>({
            directory: config.sessionDir,
            key: config.sessionKey,
        });
        this.dispatchService = new WhatsAppGatewayDispatchService({
            now: this.now,
            hashKey: config.sessionKey,
            retentionDays: config.retentionDays,
            dispatchTimeoutMs: config.dispatchTimeoutMs,
            minSendDelayMs: config.minSendDelayMs,
        });
        this.reconnectPolicy = new ReconnectPolicy(config.reconnectDelaysMs);
    }

    get state(): GatewayState {
        return this.lifecycle.state;
    }

    /** Loopback bind address, for operator tooling and tests. It contains no secret. */
    get boundAddress(): { host: string; port: number } | null {
        return this.server?.address ?? null;
    }

    snapshot(): GatewaySnapshot {
        return {
            state: this.lifecycle.state,
            ready:
                this.lifecycle.state === "CONNECTED" &&
                this.socket !== null &&
                this.ownershipHeld,
            ownershipHeld: this.ownershipHeld,
            connected: this.lifecycle.state === "CONNECTED" && this.socket !== null,
            sessionPresent: this.sessionPresent,
            lastErrorCode: this.lastErrorCode,
        };
    }

    async start(): Promise<GatewaySnapshot> {
        if (this.started) {
            return this.snapshot();
        }

        this.started = true;
        this.stopping = false;
        this.lifecycle.transition("STARTING");

        const ownerId = `wa-${process.pid}-${randomBytes(8).toString("hex")}`;
        this.ownerId = ownerId;

        try {
            const claimed = await acquireWhatsAppGatewayLease({
                lockedBy: ownerId,
                now: this.now(),
                leaseMs: this.config.leaseMs,
            });

            if (!claimed) {
                this.lastErrorCode = "LEASE_HELD";
                this.lifecycle.transition("CONFLICT", "LEASE_HELD");
                this.logger("warn", "whatsapp_gateway_owner_conflict", {
                    reason: "LEASE_HELD",
                });
                return this.snapshot();
            }

            this.leaseHeld = true;

            const localLock = new LocalProcessLock(
                path.join(this.config.sessionDir, ".gateway.lock"),
                ownerId
            );

            if (!(await localLock.acquire())) {
                await this.releaseOwnership("CONFLICT");
                this.lastErrorCode = "LOCAL_LOCK_HELD";
                this.lifecycle.transition("CONFLICT", "LOCAL_LOCK_HELD");
                this.logger("warn", "whatsapp_gateway_owner_conflict", {
                    reason: "LOCAL_LOCK_HELD",
                });
                return this.snapshot();
            }

            this.localLock = localLock;
            this.localLockHeld = true;
            this.ownershipHeld = true;

            this.sessionPresent = await this.sessionStore.exists();

            const server = new GatewayHttpServer(
                this,
                this.config.token,
                this.config.maxBodyBytes
            );
            await server.start(this.config.port, this.config.host);
            this.server = server;

            this.leaseTimer = setInterval(() => {
                void this.renewLease().catch(() =>
                    this.fence("LEASE_RENEW_FAILED").catch(() => undefined)
                );
            }, this.config.leaseRenewMs);
            this.leaseTimer.unref?.();

            this.logger("info", "whatsapp_gateway_started", {
                port: this.config.port,
                sessionPresent: this.sessionPresent,
            });

            if (!this.sessionPresent) {
                this.lifecycle.transition("PAIRING_REQUIRED", "NO_SESSION");
                this.logger("warn", "whatsapp_gateway_pairing_required", {
                    // No directory, JID, QR or credential is ever logged.
                    action: "operator pairing is deferred to a later phase",
                });
                return this.snapshot();
            }

            await this.connect();
            return this.snapshot();
        } catch {
            this.lastErrorCode = "START_FAILED";
            // Do not log the raw exception: a socket/config error can contain a token, a
            // phone number, a JID or a session path. The code is enough to investigate.
            this.logger("error", "whatsapp_gateway_start_failed", {
                code: this.lastErrorCode,
            });
            this.clearTimers();
            await this.closeSocket();
            await this.releaseOwnership("FAILED");
            await this.closeServer();
            this.lifecycle.transition("ERROR", "START_FAILED");
            return this.snapshot();
        }
    }

    async stop(): Promise<void> {
        if (this.stopping) {
            return;
        }

        this.stopping = true;
        this.clearTimers();

        // Stop accepting new work first, but do not wait for the active HTTP connection
        // before allowing its in-flight dispatch to finish: those two waits would deadlock.
        const serverClose = this.closeServer();
        await this.dispatchService.waitForIdle(this.config.shutdownGraceMs);
        await serverClose;
        await this.closeSocket();
        await this.releaseOwnership("OK");

        if (this.lifecycle.state !== "STOPPED") {
            this.lifecycle.transition("STOPPED", "SHUTDOWN");
        }

        this.logger("info", "whatsapp_gateway_stopped", {});
    }

    async dispatchText(input: TextDispatchRequest): Promise<GatewayDispatchResult> {
        if (this.stopping) {
            return {
                status: "NOT_READY",
                deliveryId: input.deliveryId,
                errorCode: "SHUTTING_DOWN",
            };
        }

        const replay = await this.dispatchService.peek(input.deliveryId);

        if (replay) {
            return replay;
        }

        if (!this.snapshot().ready) {
            return {
                status: "NOT_READY",
                deliveryId: input.deliveryId,
                errorCode: "GATEWAY_NOT_READY",
            };
        }

        return this.dispatchService.dispatch(input, (jid, text) =>
            this.sendText(jid, text)
        );
    }

    async getDelivery(deliveryId: string): Promise<GatewayDeliveryView | null> {
        return this.dispatchService.get(deliveryId);
    }

    async reconcileDelivery(
        deliveryId: string,
        input: { state: "SENT" | "FAILED_BEFORE_SEND"; messageId?: string; note?: string }
    ): Promise<GatewayReconcileResult> {
        return this.dispatchService.reconcile(deliveryId, input);
    }

    private async sendText(
        jid: string,
        text: string
    ): Promise<{ messageId: string | null }> {
        if (!this.snapshot().ready || !this.socket) {
            throw new DefiniteSendError("SOCKET_NOT_CONNECTED");
        }

        const waitMs =
            this.config.minSendDelayMs - (this.now().getTime() - this.lastSentAt);

        if (this.lastSentAt > 0 && waitMs > 0) {
            await sleep(waitMs);
        }

        this.lastSentAt = this.now().getTime();

        const result = await this.socket.sendMessage(jid, { text });

        return { messageId: result.messageId };
    }

    private async connect(): Promise<void> {
        if (this.stopping || !this.ownershipHeld) {
            return;
        }

        await this.closeSocket();

        try {
            const socket = await this.socketFactory({
                sessionDir: this.config.sessionDir,
                sessionKey: this.config.sessionKey,
            });
            this.socket = socket;
            this.sessionPresent = true;
            this.unsubscribeSocket = socket.onEvent((event) => {
                void this.onSocketEvent(event).catch(() => {
                    this.logger("error", "whatsapp_gateway_event_failed", {
                        code: "EVENT_HANDLING_FAILED",
                    });
                });
            });
        } catch {
            this.lastErrorCode = "SOCKET_START_FAILED";
            this.logger("error", "whatsapp_gateway_socket_start_failed", {
                code: this.lastErrorCode,
            });
            this.lifecycle.transition("DISCONNECTED", "SOCKET_START_FAILED");
            this.scheduleReconnect();
        }
    }

    private async onSocketEvent(event: SocketConnectionEvent): Promise<void> {
        if (this.stopping) {
            return;
        }

        if (event.type === "connection" && event.status === "open") {
            if (this.lifecycle.state !== "CONNECTED") {
                this.lifecycle.transition("CONNECTED", "SOCKET_OPEN");
            }
            this.reconnectPolicy.reset();
            this.lastErrorCode = null;
            this.logger("info", "whatsapp_gateway_connected", {});
            return;
        }

        if (event.type === "connection" && event.status === "connecting") {
            return;
        }

        if (event.type === "qr") {
            if (this.lifecycle.state !== "PAIRING_REQUIRED") {
                this.lifecycle.transition("PAIRING_REQUIRED", "QR_RECEIVED");
            }
            this.logger("warn", "whatsapp_gateway_pairing_required", {
                action: "QR discarded; pairing is deferred",
            });
            await this.closeSocket();
            return;
        }

        if (event.type === "creds") {
            this.sessionPresent = true;
            return;
        }

        if (event.type === "receipt") {
            await this.dispatchService.recordAckByMessageId(
                event.messageId,
                event.ack
            );
            return;
        }

        if (event.type === "connection" && event.status === "close") {
            await this.closeSocket();

            if (event.reason === "logged-out") {
                this.lastErrorCode = "LOGGED_OUT";
                this.reconnectPolicy.reset();
                this.lifecycle.transition("LOGGED_OUT", "LOGGED_OUT");
                this.logger("warn", "whatsapp_gateway_logged_out", {});
                return;
            }

            if (event.reason === "replaced") {
                await this.fence("CONNECTION_REPLACED");
                return;
            }

            if (event.reason === "bad-session") {
                this.lastErrorCode = "BAD_SESSION";
                this.reconnectPolicy.reset();
                this.lifecycle.transition("ERROR", "BAD_SESSION");
                this.logger("error", "whatsapp_gateway_bad_session", {
                    code: this.lastErrorCode,
                });
                return;
            }

            this.lastErrorCode = event.reason === "restart-required"
                ? "RESTART_REQUIRED"
                : "CONNECTION_LOST";
            this.lifecycle.transition("DISCONNECTED", this.lastErrorCode);
            this.logger("warn", "whatsapp_gateway_disconnected", {
                code: this.lastErrorCode,
            });
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (this.stopping || this.reconnectTimer) {
            return;
        }

        const plan = this.reconnectPolicy.next();

        if (!plan) {
            this.lastErrorCode = "RECONNECT_EXHAUSTED";
            this.lifecycle.transition("ERROR", "RECONNECT_EXHAUSTED");
            this.logger("error", "whatsapp_gateway_reconnect_exhausted", {
                code: this.lastErrorCode,
            });
            return;
        }

        this.logger("info", "whatsapp_gateway_reconnect_scheduled", {
            attempt: plan.attempt,
            delayMs: plan.delayMs,
        });

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;

            if (this.stopping || this.lifecycle.state !== "DISCONNECTED") {
                return;
            }

            this.lifecycle.transition("STARTING", "RECONNECTING");
            void this.connect();
        }, plan.delayMs);
        this.reconnectTimer.unref?.();
    }

    private async renewLease(): Promise<void> {
        if (!this.leaseHeld || !this.ownerId || this.stopping) {
            return;
        }

        const renewed = await renewWhatsAppGatewayLease({
            lockedBy: this.ownerId,
            now: this.now(),
            leaseMs: this.config.leaseMs,
        });

        if (!renewed) {
            await this.fence("LEASE_LOST");
        }
    }

    private async fence(reason: string): Promise<void> {
        if (this.stopping) {
            return;
        }

        this.stopping = true;
        this.lastErrorCode = reason;
        this.clearTimers();
        await this.closeSocket();
        await this.releaseOwnership("CONFLICT");
        await this.closeServer();

        if (this.lifecycle.state !== "CONFLICT") {
            this.lifecycle.transition("CONFLICT", reason);
        }

        this.logger("error", "whatsapp_gateway_fenced", { code: reason });
    }

    private async closeSocket(): Promise<void> {
        this.unsubscribeSocket?.();
        this.unsubscribeSocket = null;

        const socket = this.socket;
        this.socket = null;

        if (socket) {
            try {
                await socket.end();
            } catch {
                this.lastErrorCode = this.lastErrorCode ?? "SOCKET_CLOSE_FAILED";
            }
        }
    }

    private async closeServer(): Promise<void> {
        const server = this.server;
        this.server = null;

        if (server) {
            await server.close();
        }
    }

    private async releaseOwnership(
        status: "OK" | "FAILED" | "CONFLICT"
    ): Promise<void> {
        if (this.leaseTimer) {
            clearInterval(this.leaseTimer);
            this.leaseTimer = null;
        }

        if (this.leaseHeld && this.ownerId) {
            try {
                await releaseWhatsAppGatewayLease({
                    lockedBy: this.ownerId,
                    status,
                    now: this.now(),
                });
            } catch {
                // A database outage must not stop the local lock from being released.
            }
        }

        this.leaseHeld = false;

        if (this.localLock && this.localLockHeld) {
            try {
                await this.localLock.release();
            } catch {
                // Leave a corrupt lock for an operator rather than hiding the failure or
                // deleting a lock that might belong to a replacement owner.
                this.lastErrorCode = this.lastErrorCode ?? "LOCAL_LOCK_RELEASE_FAILED";
            }
        }

        this.localLock = null;
        this.localLockHeld = false;
        this.ownershipHeld = false;
    }

    private clearTimers(): void {
        if (this.leaseTimer) {
            clearInterval(this.leaseTimer);
            this.leaseTimer = null;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
