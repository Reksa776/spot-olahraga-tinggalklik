import { createHmac } from "node:crypto";
import {
    DeliveryAcknowledgementStatus,
    Prisma,
    type PrismaClient,
    type WhatsAppGatewayMessage,
    WhatsAppGatewayMessageState,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
    DispatchMedia,
    GatewayDeliveryView,
    GatewayDispatchResult,
    GatewayReconcileResult,
    TextDispatchRequest,
} from "./protocol";

/**
 * The durable dispatch ledger.
 *
 * NotificationDelivery remains the source of truth for the notification pipeline. This table
 * answers one question — "has this deliveryId already reached the socket?" — and records an
 * ambiguous outcome without ever retrying it automatically.
 *
 * Ownership rules:
 *   - `SENT` is a replay: no second send.
 *   - `AMBIGUOUS` is terminal for automatic work: only POST /reconcile can resolve it.
 *   - `SENDING` with a live lease is in progress; a stale lease becomes AMBIGUOUS.
 *   - `FAILED_BEFORE_SEND` may be retried because the socket never accepted the send.
 */

export const DISPATCH_LEASE_MS = 60_000;

type DispatchDb = Pick<PrismaClient, "whatsAppGatewayMessage">;

export type SendText = (
    jid: string,
    text: string,
    media?: readonly DispatchMedia[]
) => Promise<{ messageId: string | null }>;

export class DefiniteSendError extends Error {
    constructor(
        public readonly code: string,
        message = "The socket refused the send before accepting it."
    ) {
        super(message);
        this.name = "DefiniteSendError";
    }
}

class DispatchTimeoutError extends Error {
    constructor() {
        super("The dispatch timed out.");
        this.name = "DispatchTimeoutError";
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

function isUniqueConstraint(error: unknown): boolean {
    return (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
    );
}

function deliveryView(record: WhatsAppGatewayMessage): GatewayDeliveryView {
    return {
        deliveryId: record.deliveryId,
        state: record.state,
        ackStatus: record.ackStatus,
        messageId: record.messageId,
        errorCode: record.errorCode,
        attemptCount: record.attemptCount,
        acceptedAt: record.ackAt?.toISOString() ?? null,
        deliveredAt: record.deliveredAt?.toISOString() ?? null,
        readAt: record.readAt?.toISOString() ?? null,
    };
}

function replayResult(record: WhatsAppGatewayMessage): GatewayDispatchResult {
    if (record.state === WhatsAppGatewayMessageState.SENT) {
        return {
            status: "SENT",
            deliveryId: record.deliveryId,
            messageId: record.messageId,
            ackStatus: record.ackStatus,
            errorCode: null,
            replayed: true,
        };
    }

    if (record.state === WhatsAppGatewayMessageState.AMBIGUOUS) {
        return {
            status: "AMBIGUOUS",
            deliveryId: record.deliveryId,
            messageId: record.messageId,
            ackStatus: record.ackStatus,
            errorCode: record.errorCode ?? "AMBIGUOUS_SEND",
            replayed: true,
        };
    }

    if (record.state === WhatsAppGatewayMessageState.FAILED_BEFORE_SEND) {
        return {
            status: "FAILED_BEFORE_SEND",
            deliveryId: record.deliveryId,
            messageId: null,
            ackStatus: record.ackStatus,
            errorCode: record.errorCode,
            replayed: true,
        };
    }

    return {
        status: "IN_PROGRESS",
        deliveryId: record.deliveryId,
        messageId: record.messageId,
        ackStatus: record.ackStatus,
        replayed: true,
    };
}

function ackRank(status: DeliveryAcknowledgementStatus): number {
    switch (status) {
        case DeliveryAcknowledgementStatus.NONE:
            return 0;
        case DeliveryAcknowledgementStatus.ACCEPTED:
            return 1;
        case DeliveryAcknowledgementStatus.DELIVERED:
            return 2;
        case DeliveryAcknowledgementStatus.READ:
            return 3;
        case DeliveryAcknowledgementStatus.FAILED:
            return 2;
        default:
            return 0;
    }
}

function nextAck(
    current: DeliveryAcknowledgementStatus,
    next: DeliveryAcknowledgementStatus
): DeliveryAcknowledgementStatus | null {
    if (current === DeliveryAcknowledgementStatus.READ) {
        return null;
    }

    if (current === DeliveryAcknowledgementStatus.FAILED) {
        return null;
    }

    if (current === DeliveryAcknowledgementStatus.DELIVERED) {
        return next === DeliveryAcknowledgementStatus.READ ? next : null;
    }

    if (current === DeliveryAcknowledgementStatus.ACCEPTED) {
        return next === DeliveryAcknowledgementStatus.DELIVERED ||
            next === DeliveryAcknowledgementStatus.READ ||
            next === DeliveryAcknowledgementStatus.FAILED
            ? next
            : null;
    }

    return next;
}

export class WhatsAppGatewayDispatchService {
    private readonly db: DispatchDb;
    private readonly now: () => Date;
    private readonly hashKey: Buffer | string;
    private readonly retentionDays: number;
    private readonly dispatchTimeoutMs: number;
    private readonly minSendDelayMs: number;

    private sendTail: Promise<void> = Promise.resolve();
    private lastSentAt = 0;
    private active = 0;
    private idleWaiters: Array<() => void> = [];

    constructor(options: {
        db?: DispatchDb;
        now?: () => Date;
        hashKey: Buffer | string;
        retentionDays: number;
        dispatchTimeoutMs: number;
        minSendDelayMs: number;
    }) {
        this.db = options.db ?? prisma;
        this.now = options.now ?? (() => new Date());
        this.hashKey = options.hashKey;
        this.retentionDays = options.retentionDays;
        this.dispatchTimeoutMs = options.dispatchTimeoutMs;
        this.minSendDelayMs = options.minSendDelayMs;
    }

    private recipientHash(jid: string): string {
        return createHmac("sha256", this.hashKey).update(jid).digest("hex");
    }

    private expiry(now: Date): Date {
        return new Date(now.getTime() + this.retentionDays * 24 * 60 * 60 * 1_000);
    }

    async get(deliveryId: string): Promise<GatewayDeliveryView | null> {
        const record = await this.db.whatsAppGatewayMessage.findUnique({
            where: { deliveryId },
        });

        return record ? deliveryView(record) : null;
    }

    /**
     * A cheap terminal-state lookup used before readiness checks. It does not write.
     */
    async peek(deliveryId: string): Promise<GatewayDispatchResult | null> {
        const record = await this.db.whatsAppGatewayMessage.findUnique({
            where: { deliveryId },
        });

        if (!record) {
            return null;
        }

        if (
            record.state === WhatsAppGatewayMessageState.SENT ||
            record.state === WhatsAppGatewayMessageState.AMBIGUOUS
        ) {
            return replayResult(record);
        }

        // FAILED_BEFORE_SEND is deliberately absent: the socket definitively refused the
        // send, so the same deliveryId may be retried and reclaimed below.

        if (
            record.state === WhatsAppGatewayMessageState.SENDING &&
            record.leaseUntil &&
            record.leaseUntil > this.now()
        ) {
            return replayResult(record);
        }

        return null;
    }

    async dispatch(
        input: TextDispatchRequest,
        send: SendText
    ): Promise<GatewayDispatchResult> {
        this.active += 1;

        try {
            return await this.dispatchInternal(input, send);
        } finally {
            this.active -= 1;

            if (this.active === 0) {
                const waiters = this.idleWaiters.splice(0);
                for (const waiter of waiters) {
                    waiter();
                }
            }
        }
    }

    private async dispatchInternal(
        input: TextDispatchRequest,
        send: SendText
    ): Promise<GatewayDispatchResult> {
        const now = this.now();
        let record: WhatsAppGatewayMessage | null = null;
        let claimed = false;

        try {
            record = await this.db.whatsAppGatewayMessage.create({
                data: {
                    deliveryId: input.deliveryId,
                    notificationId: input.notificationId,
                    recipientHash: this.recipientHash(input.jid),
                    state: WhatsAppGatewayMessageState.SENDING,
                    ackStatus: DeliveryAcknowledgementStatus.NONE,
                    attemptCount: 1,
                    leaseUntil: new Date(now.getTime() + DISPATCH_LEASE_MS),
                    expiresAt: this.expiry(now),
                },
            });
            claimed = true;
        } catch (error) {
            if (!isUniqueConstraint(error)) {
                throw error;
            }

            record = await this.db.whatsAppGatewayMessage.findUnique({
                where: { deliveryId: input.deliveryId },
            });
        }

        if (!record) {
            // A unique conflict whose row disappeared is not safe to guess about.
            return {
                status: "AMBIGUOUS",
                deliveryId: input.deliveryId,
                errorCode: "LEDGER_CONFLICT",
                replayed: false,
            };
        }

        if (!claimed) {
            if (record.state === WhatsAppGatewayMessageState.SENT) {
                return replayResult(record);
            }

            if (record.state === WhatsAppGatewayMessageState.AMBIGUOUS) {
                return replayResult(record);
            }

            if (
                record.state === WhatsAppGatewayMessageState.SENDING &&
                record.leaseUntil &&
                record.leaseUntil > now
            ) {
                return replayResult(record);
            }

            if (record.state === WhatsAppGatewayMessageState.SENDING) {
                await this.markAmbiguous(
                    record.deliveryId,
                    "STALE_DISPATCH_LEASE"
                );
                return {
                    status: "AMBIGUOUS",
                    deliveryId: record.deliveryId,
                    errorCode: "STALE_DISPATCH_LEASE",
                    replayed: false,
                };
            }

            if (record.state === WhatsAppGatewayMessageState.FAILED_BEFORE_SEND) {
                const reclaimed = await this.db.whatsAppGatewayMessage.updateMany({
                    where: {
                        deliveryId: record.deliveryId,
                        state: WhatsAppGatewayMessageState.FAILED_BEFORE_SEND,
                    },
                    data: {
                        state: WhatsAppGatewayMessageState.SENDING,
                        attemptCount: { increment: 1 },
                        leaseUntil: new Date(now.getTime() + DISPATCH_LEASE_MS),
                        ackStatus: DeliveryAcknowledgementStatus.NONE,
                        errorCode: null,
                        errorMessage: null,
                    },
                });

                if (reclaimed.count === 0) {
                    const current = await this.db.whatsAppGatewayMessage.findUnique({
                        where: { deliveryId: input.deliveryId },
                    });

                    return current
                        ? replayResult(current)
                        : {
                              status: "AMBIGUOUS",
                              deliveryId: input.deliveryId,
                              errorCode: "LEDGER_CONFLICT",
                          };
                }

                claimed = true;
            }
        }

        if (!claimed) {
            const current = await this.db.whatsAppGatewayMessage.findUnique({
                where: { deliveryId: input.deliveryId },
            });

            return current
                ? replayResult(current)
                : {
                      status: "AMBIGUOUS",
                      deliveryId: input.deliveryId,
                      errorCode: "LEDGER_CONFLICT",
                  };
        }

        return this.sendOnce(input, send);
    }

    private async sendOnce(
        input: TextDispatchRequest,
        send: SendText
    ): Promise<GatewayDispatchResult> {
        return this.withSendSlot(async () => {
            const waitMs = this.minSendDelayMs - (this.now().getTime() - this.lastSentAt);

            if (this.lastSentAt > 0 && waitMs > 0) {
                await sleep(waitMs);
            }

            this.lastSentAt = this.now().getTime();

            let sent: { messageId: string | null };

            try {
                sent = await this.withTimeout(
                    send(input.jid, input.text, input.media)
                );
            } catch (error) {
                if (error instanceof DispatchTimeoutError) {
                    await this.markAmbiguous(
                        input.deliveryId,
                        "DISPATCH_TIMEOUT"
                    );
                    return {
                        status: "AMBIGUOUS",
                        deliveryId: input.deliveryId,
                        errorCode: "DISPATCH_TIMEOUT",
                    };
                }

                if (error instanceof DefiniteSendError) {
                    await this.markFailedBeforeSend(
                        input.deliveryId,
                        error.code
                    );
                    return {
                        status: "FAILED_BEFORE_SEND",
                        deliveryId: input.deliveryId,
                        errorCode: error.code,
                    };
                }

                // An unclassified socket error may have happened after the message left the
                // process. Never retry it automatically.
                await this.markAmbiguous(
                    input.deliveryId,
                    "SEND_OUTCOME_UNKNOWN"
                );
                return {
                    status: "AMBIGUOUS",
                    deliveryId: input.deliveryId,
                    errorCode: "SEND_OUTCOME_UNKNOWN",
                };
            }

            if (!sent.messageId) {
                await this.markAmbiguous(
                    input.deliveryId,
                    "MISSING_MESSAGE_ID"
                );
                return {
                    status: "AMBIGUOUS",
                    deliveryId: input.deliveryId,
                    errorCode: "MISSING_MESSAGE_ID",
                };
            }

            const updated = await this.db.whatsAppGatewayMessage.updateMany({
                where: {
                    deliveryId: input.deliveryId,
                    state: WhatsAppGatewayMessageState.SENDING,
                },
                data: {
                    state: WhatsAppGatewayMessageState.SENT,
                    messageId: sent.messageId,
                    ackStatus: DeliveryAcknowledgementStatus.ACCEPTED,
                    ackAt: this.now(),
                    leaseUntil: null,
                    errorCode: null,
                    errorMessage: null,
                },
            });

            if (updated.count === 0) {
                const current = await this.db.whatsAppGatewayMessage.findUnique({
                    where: { deliveryId: input.deliveryId },
                });

                return current
                    ? replayResult(current)
                    : {
                          status: "AMBIGUOUS",
                          deliveryId: input.deliveryId,
                          errorCode: "LEDGER_CONFLICT",
                      };
            }

            return {
                status: "SENT",
                deliveryId: input.deliveryId,
                messageId: sent.messageId,
                ackStatus: DeliveryAcknowledgementStatus.ACCEPTED,
            };
        });
    }

    private withSendSlot<T>(work: () => Promise<T>): Promise<T> {
        const run = this.sendTail.then(work, work);
        this.sendTail = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    private async withTimeout<T>(work: Promise<T>): Promise<T> {
        let timer: NodeJS.Timeout | undefined;

        try {
            return await Promise.race([
                work,
                new Promise<T>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new DispatchTimeoutError()),
                        this.dispatchTimeoutMs
                    );
                    timer.unref?.();
                }),
            ]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    private async markAmbiguous(
        deliveryId: string,
        code: string
    ): Promise<void> {
        await this.db.whatsAppGatewayMessage.updateMany({
            where: {
                deliveryId,
                state: {
                    in: [
                        WhatsAppGatewayMessageState.PENDING,
                        WhatsAppGatewayMessageState.SENDING,
                    ],
                },
            },
            data: {
                state: WhatsAppGatewayMessageState.AMBIGUOUS,
                leaseUntil: null,
                errorCode: code,
                errorMessage: null,
            },
        });
    }

    private async markFailedBeforeSend(
        deliveryId: string,
        code: string
    ): Promise<void> {
        await this.db.whatsAppGatewayMessage.updateMany({
            where: {
                deliveryId,
                state: WhatsAppGatewayMessageState.SENDING,
            },
            data: {
                state: WhatsAppGatewayMessageState.FAILED_BEFORE_SEND,
                leaseUntil: null,
                ackStatus: DeliveryAcknowledgementStatus.NONE,
                errorCode: code,
                errorMessage: null,
            },
        });
    }

    /**
     * WhatsApp receipt handling. Receipts only ever move the acknowledgement forward; they
     * never turn gateway acceptance into a claim of delivery without a real receipt.
     */
    async recordAckByMessageId(
        messageId: string,
        ack: "delivered" | "read" | "failed"
    ): Promise<boolean> {
        const record = await this.db.whatsAppGatewayMessage.findUnique({
            where: { messageId },
        });

        if (!record || record.state !== WhatsAppGatewayMessageState.SENT) {
            return false;
        }

        const target =
            ack === "delivered"
                ? DeliveryAcknowledgementStatus.DELIVERED
                : ack === "read"
                  ? DeliveryAcknowledgementStatus.READ
                  : DeliveryAcknowledgementStatus.FAILED;
        const next = nextAck(record.ackStatus, target);

        if (!next || ackRank(next) < ackRank(record.ackStatus)) {
            return false;
        }

        const now = this.now();

        const updated = await this.db.whatsAppGatewayMessage.updateMany({
            where: {
                messageId,
                ackStatus: record.ackStatus,
                state: WhatsAppGatewayMessageState.SENT,
            },
            data: {
                ackStatus: next,
                ackAt: now,
                ...(next === DeliveryAcknowledgementStatus.DELIVERED ||
                next === DeliveryAcknowledgementStatus.READ
                    ? { deliveredAt: record.deliveredAt ?? now }
                    : {}),
                ...(next === DeliveryAcknowledgementStatus.READ
                    ? { readAt: now }
                    : {}),
            },
        });

        return updated.count === 1;
    }

    async reconcile(
        deliveryId: string,
        input: { state: "SENT" | "FAILED_BEFORE_SEND"; messageId?: string; note?: string }
    ): Promise<GatewayReconcileResult> {
        const record = await this.db.whatsAppGatewayMessage.findUnique({
            where: { deliveryId },
        });

        if (!record) {
            return {
                status: "NOT_FOUND",
                deliveryId,
                errorCode: "NOT_FOUND",
            };
        }

        if (record.state !== WhatsAppGatewayMessageState.AMBIGUOUS) {
            return {
                status: "NOT_AMBIGUOUS",
                deliveryId,
                errorCode: "NOT_AMBIGUOUS",
            };
        }

        if (input.state === "SENT" && !input.messageId) {
            return {
                status: "INVALID_RECONCILIATION",
                deliveryId,
                errorCode: "MESSAGE_ID_REQUIRED",
            };
        }

        const now = this.now();
        const updated = await this.db.whatsAppGatewayMessage.updateMany({
            where: {
                deliveryId,
                state: WhatsAppGatewayMessageState.AMBIGUOUS,
            },
            data:
                input.state === "SENT"
                    ? {
                          state: WhatsAppGatewayMessageState.SENT,
                          messageId: input.messageId,
                          ackStatus: DeliveryAcknowledgementStatus.ACCEPTED,
                          ackAt: now,
                          leaseUntil: null,
                          errorCode: null,
                          errorMessage: null,
                          reconciledAt: now,
                          reconciliationNote: input.note ?? null,
                      }
                    : {
                          state: WhatsAppGatewayMessageState.FAILED_BEFORE_SEND,
                          leaseUntil: null,
                          errorCode: "RECONCILED_FAILED_BEFORE_SEND",
                          errorMessage: null,
                          reconciledAt: now,
                          reconciliationNote: input.note ?? null,
                      },
        });

        if (updated.count === 0) {
            return {
                status: "NOT_AMBIGUOUS",
                deliveryId,
                errorCode: "NOT_AMBIGUOUS",
            };
        }

        return {
            status: "RECONCILED",
            deliveryId,
            state: input.state,
            messageId: input.state === "SENT" ? (input.messageId ?? null) : null,
        };
    }

    async waitForIdle(timeoutMs: number): Promise<boolean> {
        if (this.active === 0) {
            return true;
        }

        return new Promise<boolean>((resolve) => {
            const waiter = () => {
                clearTimeout(timer);
                resolve(true);
            };
            const timer = setTimeout(() => {
                this.idleWaiters = this.idleWaiters.filter((item) => item !== waiter);
                resolve(false);
            }, timeoutMs);

            timer.unref?.();
            this.idleWaiters.push(waiter);
        });
    }
}
