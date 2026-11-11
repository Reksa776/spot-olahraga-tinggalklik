import {
    describeNotificationConfig,
    resolveNotificationConfig,
    type NotificationConfig,
} from "./config";
import { structuredLog, sanitizeErrorMessage } from "./logger";
import { normalizeRecipient } from "./contacts";
import {
    claimDueDeliveries,
    computeRetryDelayMs,
    countWhatsAppSendsToday,
    markDeliverySent,
    markDeliverySkipped,
    markDeliverySimulated,
    recoverExpiredDeliveryLeases,
    recordDeliveryFailure,
    type ClaimedDelivery,
} from "./queue";
import { classifyDeliveryError } from "./retry-policy";
import { buildWhatsAppMedia } from "./whatsapp-media";
import { renderNotification, TemplatePayloadInvalidError } from "./templates";
import { TICKET_ISSUED_TEMPLATE_KEY } from "./ticket-issued-template";
import {
    createDryRunEmailTransport,
    createDryRunWhatsAppTransport,
} from "./transports/dry-run";
import { createSmtpEmailTransport } from "./transports/smtp";
import { createBaileysWhatsAppTransport } from "./transports/baileys";
import type { EmailTransport, WhatsAppTransport } from "./types";
import {
    acquireNotificationWorkerLease,
    NOTIFICATION_WORKER_LOCK,
    releaseNotificationWorkerLease,
    renewNotificationWorkerLease,
} from "./worker-lock";
import {
    isWhatsAppManuallyDisconnected,
    MANUAL_DISCONNECT_SKIP_CODE,
    MANUAL_DISCONNECT_SKIP_MESSAGE,
} from "@/lib/whatsapp/manual-disconnect";

/**
 * ==========================================
 * NOTIFICATION WORKER (PHASE 1 — DRY RUN ONLY)
 * ==========================================
 *
 * A SEPARATE PROCESS from Next.js. It is started by `scripts/notification-worker.ts`, polls the
 * database on its own clock, and never waits for an HTTP request. It does not replace the
 * `event-lifecycle` / `reservation-reaper` tick: those stay in the tick route.
 *
 * ── SHAPE OF ONE BATCH ───────────────────────────────────────────────────────────────
 *
 *   1. kill switch OFF?                        → do nothing at all (no writes)
 *   2. acquire `joblock: notification-dispatch` → held by another instance? skip the batch
 *   3. recover expired SENDING leases           → FAILED/AMBIGUOUS_DELIVERY (never resent)
 *   4. claim EMAIL rows with CAS                → configured adapter, concurrency 3
 *   5. claim WHATSAPP rows with CAS             → configured gateway, concurrency 1
 *   6. release lease with OK/FAILED             → heartbeat updated
 *
 * ── WHY EMAIL 3 AND WHATSAPP 1 ───────────────────────────────────────────────────────
 * Email providers tolerate a few parallel handshakes. One WhatsApp session does not: parallel
 * sends on one socket are exactly the pattern that triggers rate limits and bans. The limit is
 * expressed in `config.ts` and applied here, not left to the transport to remember.
 *
 * ── THE DRY-RUN RULE ─────────────────────────────────────────────────────────────────
 * Dry-run remains the default. Explicit SMTP/Baileys results use the same durable delivery state
 * machine and idempotent dispatch boundaries.
 *
 * ── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────────────
 * `stop()` stops the loop, wakes the poll sleep, and awaits the in-flight batch. A delivery that
 * is already claimed finishes and its status is written; nothing new is claimed. This is why the
 * loop awaits each batch rather than firing them concurrently.
 */

export type RunSkipReason = "DISABLED" | "LEASE_HELD" | "STOPPING";

export type BatchSummary = {
    ran: boolean;
    reason?: RunSkipReason;
    claimed: number;
    simulated: number;
    sent: number;
    retried: number;
    failed: number;
    skipped: number;
    recovered: number;
};

export type NotificationWorkerDependencies = {
    config?: NotificationConfig;
    /** Fixed instant for a batch, injectable for deterministic tests. */
    now?: () => Date;
    random?: () => number;
    workerId?: string;
    transports?: {
        email?: EmailTransport;
        whatsapp?: WhatsAppTransport;
    };
    /** Log sink, injectable so tests can assert on the exact lines. */
    log?: (line: string) => void;
    /** The conservative WhatsApp pause; injectable so tests do not sleep for real. */
    wait?: (ms: number) => Promise<void>;
    /** Daily-cap counter, injectable for a deterministic cap test. */
    countWhatsAppSends?: () => Promise<number>;
    /** Persistent operator latch, injectable so tests never touch the database. */
    isWhatsAppManuallyDisconnected?: () => Promise<boolean>;
};

export type NotificationWorker = {
    runOnce: () => Promise<BatchSummary>;
    start: () => Promise<void>;
    stop: () => Promise<void>;
};

const SIMULATED_CODE = "DRY_RUN_SIMULATED";
const SIMULATED_MESSAGE =
    "Phase 1 dry run: message was simulated and not transmitted to any provider.";

function emptySummary(
    ran: boolean,
    reason?: RunSkipReason
): BatchSummary {
    return {
        ran,
        ...(reason ? { reason } : {}),
        claimed: 0,
        simulated: 0,
        sent: 0,
        retried: 0,
        failed: 0,
        skipped: 0,
        recovered: 0,
    };
}

/** Run tasks with a bounded number in flight, preserving completion order. */
async function runWithConcurrency<T>(
    items: readonly T[],
    limit: number,
    task: (item: T) => Promise<void>
): Promise<void> {
    const queue = [...items];

    const runner = async () => {
        for (;;) {
            const next = queue.shift();

            if (next === undefined) {
                return;
            }

            await task(next);
        }
    };

    await Promise.all(
        Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner)
    );
}

function defaultWorkerId(): string {
    const suffix = Math.random().toString(36).slice(2, 10);

    return `${process.pid}-${suffix}`.slice(0, 64);
}

type DispatchDeps = {
    config: NotificationConfig;
    now: Date;
    random: () => number;
    log: (line: string) => void;
    workerId: string;
    email: EmailTransport;
    whatsapp: WhatsAppTransport;
    wait: (ms: number) => Promise<void>;
};

async function dispatchOne(
    delivery: ClaimedDelivery,
    deps: DispatchDeps
): Promise<"simulated" | "sent" | "retried" | "failed" | "skipped"> {
    const base = {
        deliveryId: delivery.id,
        notificationId: delivery.notificationId,
        channel: delivery.channel,
        category: delivery.category,
        attempt: delivery.attemptCount,
        maxAttempts: delivery.maxAttempts,
    };

    // Defensive: the claim query already excludes these, so reaching here means a row was
    // changed underneath us. Never render or send legacy/uncategorised data.
    if (delivery.category === null || delivery.templateKey === null) {
        await markDeliverySkipped(delivery.id, {
            code: "LEGACY_OR_UNCATEGORIZED",
            message: "Notification has no category or templateKey and is treated as legacy.",
            now: deps.now,
        });

        structuredLog("warn", "notification.dispatch.skipped", {
            ...base,
            reason: "LEGACY_OR_UNCATEGORIZED",
        }, deps.log);

        return "skipped";
    }

    // Ticket-issued notices are email-only. Also suppress WhatsApp rows already queued before
    // this policy was applied, so deploying the policy cannot release a backlog of duplicates.
    if (
        delivery.channel === "WHATSAPP" &&
        delivery.templateKey === TICKET_ISSUED_TEMPLATE_KEY
    ) {
        await markDeliverySkipped(delivery.id, {
            code: "CHANNEL_DISABLED_BY_POLICY",
            message:
                "WhatsApp delivery is disabled for ticket-issued notifications; nothing was transmitted.",
            now: deps.now,
        });

        structuredLog("info", "notification.dispatch.channel_disabled", {
            ...base,
            templateKey: delivery.templateKey,
            reason: "TICKET_ISSUED_WHATSAPP_DISABLED",
        }, deps.log);

        return "skipped";
    }

    /*
     * The recipient is validated HERE, after the row exists. A non-empty but malformed address
     * was still enqueued (so the failure is visible and recoverable), and this is the one place
     * that turns it into a terminal SKIP — no transport call, no retry, no guessed address. The
     * order's stored contact columns are untouched; only the delivery copy is normalized.
     */
    const recipient =
        delivery.channel === "EMAIL"
            ? normalizeRecipient("EMAIL", delivery.recipient)
            : delivery.channel === "WHATSAPP"
              ? normalizeRecipient("WHATSAPP", delivery.recipient)
              : null;

    if (!recipient) {
        await markDeliverySkipped(delivery.id, {
            code: "INVALID_RECIPIENT",
            message:
                "The stored recipient is not a valid address for this channel; nothing was transmitted.",
            now: deps.now,
        });

        structuredLog("warn", "notification.dispatch.invalid_recipient", {
            ...base,
            reason: "INVALID_RECIPIENT",
        }, deps.log);

        return "skipped";
    }

    let rendered;

    try {
        rendered = renderNotification(delivery.templateKey, delivery.payload, {
            // IN_APP is never enqueued (the deliverable channel set excludes it), so this is a
            // total mapping over the channels a claimed row can actually have.
            channel: delivery.channel === "EMAIL" ? "EMAIL" : "WHATSAPP",
        });
    } catch (error) {
        const code =
            error instanceof TemplatePayloadInvalidError
                ? "TEMPLATE_PAYLOAD_INVALID"
                : "TEMPLATE_NOT_FOUND";

        // Permanent: retrying cannot register a template.
        await markDeliverySkipped(delivery.id, {
            code,
            message: sanitizeErrorMessage(error),
            now: deps.now,
        });

        structuredLog("error", "notification.dispatch.template_rejected", {
            ...base,
            templateKey: delivery.templateKey,
            reason: code,
        }, deps.log);

        return "skipped";
    }

    /*
     * Attachments are derived HERE, from the same stored payload that produced the text, so the
     * queue keeps storing data rather than rendered messages. `buildWhatsAppMedia` never
     * throws and returns an empty list on any problem: a QR render failure degrades the message
     * to text instead of failing the delivery.
     */
    const media =
        delivery.channel === "WHATSAPP"
            ? await buildWhatsAppMedia(delivery.templateKey, delivery.payload)
            : [];

    const transport =
        delivery.channel === "EMAIL" ? deps.email : deps.whatsapp;

    if (transport.kind === "disabled") {
        await markDeliverySkipped(delivery.id, {
            code: "TRANSPORT_DISABLED",
            message: "The configured transport is disabled; nothing was transmitted.",
            provider: transport.name,
            now: deps.now,
        });

        structuredLog("warn", "notification.dispatch.transport_disabled", {
            ...base,
            transport: transport.name,
        }, deps.log);

        return "skipped";
    }

    // Conservative WhatsApp policy: one message at a time, with a deliberate pause before each
    // send, so a batch cannot resemble a broadcast. Email is unaffected.
    if (delivery.channel === "WHATSAPP") {
        await deps.wait(deps.config.whatsappSendDelayMs);
    }

    try {
        const context = {
            deliveryId: delivery.id,
            notificationId: delivery.notificationId,
        };

        // The two message shapes are kept separate on purpose: an email has a subject, a
        // WhatsApp message does not, and a shared supertype would let a subjectless email reach
        // the adapter (or a subject reach WhatsApp) without the compiler objecting.
        const result =
            delivery.channel === "EMAIL"
                ? await deps.email.send(
                      {
                          to: recipient,
                          subject: rendered.subject,
                          text: rendered.text,
                      },
                      context
                  )
                : await deps.whatsapp.send(
                      {
                          to: recipient,
                          text: rendered.text,
                          ...(media.length > 0 ? { media } : {}),
                      },
                      context
                  );

        if (result.simulated) {
            await markDeliverySimulated(delivery.id, {
                provider: transport.name,
                code: SIMULATED_CODE,
                message: SIMULATED_MESSAGE,
                now: deps.now,
            });

            // The wording is deliberate: "simulated", never "sent"/"delivered".
            structuredLog("info", "notification.dispatch.simulated", {
                ...base,
                transport: transport.name,
                outcome: "simulated",
            }, deps.log);

            return "simulated";
        }

        await markDeliverySent(delivery.id, {
            provider: transport.name,
            providerMessageId: result.providerMessageId,
            now: deps.now,
        });

        structuredLog("info", "notification.dispatch.sent", {
            ...base,
            transport: transport.name,
            hasProviderMessageId: Boolean(result.providerMessageId),
        }, deps.log);

        return "sent";
    } catch (error) {
        /*
         * FAILURE HANDLING — what the H-36 bug needed made explicit.
         *
         * A dropped Baileys connection, a `NOT_READY` gateway or a timeout is TRANSIENT: the
         * row returns to QUEUED with the 60 s / 5 min backoff and is retried until
         * `maxAttempts`. A permanent refusal (wrong gateway token, invalid JID format, unknown
         * template) is recorded as a terminal FAILED immediately: retrying cannot succeed, and
         * pretending otherwise hides the real cause behind two pointless retries.
         *
         * `permanent` forces the attempt counter to the budget, so the SAME state machine in
         * `queue.ts` decides the terminal state — no second failure path is introduced.
         */
        const classification = classifyDeliveryError(error);
        const attemptCount = classification.permanent
            ? Math.max(delivery.attemptCount, delivery.maxAttempts)
            : delivery.attemptCount;

        const outcome = await recordDeliveryFailure(delivery.id, {
            attemptCount,
            maxAttempts: delivery.maxAttempts,
            errorCode: classification.code,
            errorMessage: classification.message,
            now: deps.now,
            random: deps.random,
        });

        structuredLog(
            classification.permanent ? "error" : "warn",
            "notification.dispatch.failed",
            {
                ...base,
                transport: transport.name,
                errorCode: classification.code,
                permanent: classification.permanent,
                outcome,
                retryInMs:
                    outcome === "retry-scheduled"
                        ? computeRetryDelayMs(
                              delivery.attemptCount,
                              deps.random
                          )
                        : null,
            },
            deps.log
        );

        return outcome === "failed" ? "failed" : "retried";
    }
}

/** Run one batch. Safe to call from two processes at once: the lease and the CAS decide. */
export async function processNotificationBatch(
    dependencies: NotificationWorkerDependencies = {}
): Promise<BatchSummary> {
    const config = dependencies.config ?? resolveNotificationConfig();
    const now = dependencies.now?.() ?? new Date();
    const random = dependencies.random ?? Math.random;
    const workerId = dependencies.workerId ?? defaultWorkerId();
    const log = dependencies.log ?? ((line: string) => process.stdout.write(`${line}\n`));
    const wait =
        dependencies.wait ??
        ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const countWhatsAppSends =
        dependencies.countWhatsAppSends ??
        (() => countWhatsAppSendsToday({ now }));

    if (!config.enabled) {
        // The kill switch does not merely skip sends: it performs no database write at all.
        return emptySummary(false, "DISABLED");
    }

    const leased = await acquireNotificationWorkerLease({
        lockedBy: workerId,
        now,
        leaseMs: config.leaseMs,
    });

    if (!leased) {
        return emptySummary(false, "LEASE_HELD");
    }

    const manualWhatsApp = await (
        dependencies.isWhatsAppManuallyDisconnected ??
        isWhatsAppManuallyDisconnected
    )();
    const summary = emptySummary(true);

    const disabledTransport = {
        name: "disabled",
        kind: "disabled" as const,
        async send() { return { simulated: true as const }; },
    };
    const emailTransport = dependencies.transports?.email ??
        (config.emailTransport === "smtp" ? createSmtpEmailTransport() :
         config.emailTransport === "disabled" ? disabledTransport : createDryRunEmailTransport());
    const whatsappTransport = dependencies.transports?.whatsapp ??
        (config.whatsappTransport === "baileys" ? createBaileysWhatsAppTransport() :
         config.whatsappTransport === "disabled" ? disabledTransport : createDryRunWhatsAppTransport());

    if (
        (emailTransport.kind === "smtp" && config.emailTransport !== "smtp") ||
        (whatsappTransport.kind === "baileys" && config.whatsappTransport !== "baileys")
    ) {
        await releaseNotificationWorkerLease({ status: "FAILED", now });
        throw new Error("A live notification transport requires an explicit matching environment setting.");
    }

    const dispatchDeps: DispatchDeps = {
        config,
        now,
        random,
        log,
        workerId,
        email: emailTransport,
        whatsapp: whatsappTransport,
        wait,
    };

    let leaseStatus: "OK" | "FAILED" = "OK";

    try {
        summary.recovered = await recoverExpiredDeliveryLeases({
            now,
            limit: config.batchSize,
        });

        if (summary.recovered > 0) {
            structuredLog("warn", "notification.worker.ambiguous_recovered", {
                count: summary.recovered,
                code: "AMBIGUOUS_DELIVERY",
                autoRetried: false,
            }, log);
        }

        const emailBatch = await claimDueDeliveries({
            now,
            limit: config.batchSize,
            channels: ["EMAIL"],
            leaseMs: config.leaseMs,
        });

        /*
         * CONSERVATIVE WHATSAPP POLICY — DAILY CAP.
         *
         * The count is taken before the claim, so a cap reached today leaves the remaining rows
         * QUEUED (deferred) rather than claimed and failed. Nothing is incremented, no attempt
         * is burned, and tomorrow's batch picks them up. The cap counts real sends AND simulated
         * sends, so dry-run exercises the same gate production will.
         */
        let whatsappBatch: ClaimedDelivery[] = [];

        if (manualWhatsApp) {
            // Claim so the row leaves QUEUED, but never render, count against the cap,
            // or call a transport. The terminal SKIPPED below is the durable evidence.
            whatsappBatch = await claimDueDeliveries({
                now,
                limit: config.batchSize,
                channels: ["WHATSAPP"],
                leaseMs: config.leaseMs,
            });
        } else {
            const whatsappUsed = await countWhatsAppSends();
            const whatsappRemaining = Math.max(
                0,
                config.whatsappDailyCap - whatsappUsed
            );

            if (whatsappRemaining === 0) {
                structuredLog("warn", "notification.whatsapp.daily_cap_reached", {
                    cap: config.whatsappDailyCap,
                    used: whatsappUsed,
                    deferred: true,
                }, log);
            }

            whatsappBatch =
                whatsappRemaining > 0
                    ? await claimDueDeliveries({
                          now,
                          limit: Math.min(config.batchSize, whatsappRemaining),
                          channels: ["WHATSAPP"],
                          leaseMs: config.leaseMs,
                      })
                    : [];
        }

        const claimed = [...emailBatch, ...whatsappBatch];

        summary.claimed = claimed.length;

        const applyOutcome = (
            outcome: "simulated" | "sent" | "retried" | "failed" | "skipped"
        ) => {
            if (outcome === "simulated") summary.simulated += 1;
            else if (outcome === "sent") summary.sent += 1;
            else if (outcome === "retried") summary.retried += 1;
            else if (outcome === "failed") summary.failed += 1;
            else summary.skipped += 1;
        };

        await runWithConcurrency(emailBatch, config.emailConcurrency, async (delivery) => {
            applyOutcome(await dispatchOne(delivery, dispatchDeps));
        });

        // Heartbeat between the two channels: a large email batch must not let the worker lease
        // expire while WhatsApp rows are still waiting.
        await renewNotificationWorkerLease({
            lockedBy: workerId,
            now,
            leaseMs: config.leaseMs,
        });

        if (manualWhatsApp) {
            for (const delivery of whatsappBatch) {
                await markDeliverySkipped(delivery.id, {
                    code: MANUAL_DISCONNECT_SKIP_CODE,
                    message: MANUAL_DISCONNECT_SKIP_MESSAGE,
                    now,
                });
                summary.skipped += 1;
            }

            if (whatsappBatch.length > 0) {
                structuredLog(
                    "warn",
                    "notification.whatsapp.manual_disconnect_skipped",
                    {
                        count: whatsappBatch.length,
                        code: MANUAL_DISCONNECT_SKIP_CODE,
                    },
                    log
                );
            }
        } else {
            await runWithConcurrency(
                whatsappBatch,
                config.whatsappConcurrency,
                async (delivery) => {
                    applyOutcome(await dispatchOne(delivery, dispatchDeps));
                }
            );
        }
    } catch (error) {
        leaseStatus = "FAILED";

        structuredLog("error", "notification.worker.batch_failed", {
            error: sanitizeErrorMessage(error),
        }, log);

        throw error;
    } finally {
        await releaseNotificationWorkerLease({ status: leaseStatus, now });
    }

    structuredLog("info", "notification.worker.batch_complete", {
        claimed: summary.claimed,
        simulated: summary.simulated,
        sent: summary.sent,
        retried: summary.retried,
        failed: summary.failed,
        skipped: summary.skipped,
        recovered: summary.recovered,
        dryRunOnly: true,
    }, log);

    return summary;
}

/**
 * Create the long-lived worker.
 *
 * `start()` polls until `stop()`. `runOnce()` exists for an operator one-shot (`--once`) and for
 * tests. Neither is ever called from a request handler.
 */
export function createNotificationWorker(
    dependencies: NotificationWorkerDependencies = {}
): NotificationWorker {
    const config = dependencies.config ?? resolveNotificationConfig();
    const log = dependencies.log ?? ((line: string) => process.stdout.write(`${line}\n`));

    let stopped = false;
    let loop: Promise<void> | null = null;
    let wakeSleep: (() => void) | null = null;

    structuredLog("info", "notification.worker.config", {
        ...describeNotificationConfig(config),
        lock: NOTIFICATION_WORKER_LOCK,
    }, log);

    const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                wakeSleep = null;
                resolve();
            }, ms);

            wakeSleep = () => {
                clearTimeout(timer);
                wakeSleep = null;
                resolve();
            };
        });

    const runOnce = async (): Promise<BatchSummary> => {
        if (stopped) {
            return emptySummary(false, "STOPPING");
        }

        return processNotificationBatch({ ...dependencies, config, log });
    };

    return {
        runOnce,
        async start() {
            if (loop) {
                return loop;
            }

            loop = (async () => {
                while (!stopped) {
                    try {
                        await runOnce();
                    } catch {
                        // A batch failure is already logged with its sanitised cause. The loop
                        // must survive it: a transient database error is not a reason to require
                        // an operator to restart the process.
                    }

                    if (stopped) {
                        break;
                    }

                    await sleep(config.pollIntervalMs);
                }

                structuredLog("info", "notification.worker.stopped", {}, log);
            })();

            return loop;
        },
        async stop() {
            stopped = true;
            wakeSleep?.();

            if (loop) {
                await loop;
            }
        },
    };
}
