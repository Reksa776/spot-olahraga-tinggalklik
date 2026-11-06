import { Prisma } from "@prisma/client";
import type {
    NotificationCategory,
    NotificationRecipientType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { hasTemplate } from "./templates";
import { isPhase1Channel, type Phase1DeliveryChannel } from "./types";

/**
 * ==========================================
 * ENQUEUE — THE ONLY WRITER OF THE QUEUE TABLES (PHASE 1)
 * ==========================================
 *
 * Nothing else in the application writes `notification` or `notificationdelivery`. Phase 2 will
 * call THIS function from the settlement path; it must not learn to insert rows itself.
 *
 * ── WHERE THIS MAY BE CALLED ──────────────────────────────────────────────────────────
 * AFTER the caller's transaction commits, never inside the payment/issuance `$transaction`.
 * The repository already follows that rule for realtime publishes, and for the same reason: a
 * notification is a side effect, so it must not hold locks in, lengthen, or be able to roll back
 * the financial transaction. Enqueue performs no network I/O — it is one local INSERT — so it
 * cannot make a payment webhook slow or fail on a provider outage.
 *
 * ── IDEMPOTENCY, IN TWO LAYERS ────────────────────────────────────────────────────────
 *   notification.idempotencyKey @unique       → the same logical event enqueues ONCE
 *   UNIQUE (notificationId, channel)          → each channel fans out ONCE
 *
 * The nested `create` is a single atomic statement pair, so an existing key and a missing
 * delivery row cannot both be observed. A duplicate key is not an error: the caller receives the
 * EXISTING notification and its delivery, which is what makes a replayed webhook harmless.
 *
 * ── THE LEGACY ROWS ──────────────────────────────────────────────────────────────────
 * 44 pre-ticketing rows have `category IS NULL` and `channel="whatsapp"`. This writer never
 * touches them, and the worker's claim query excludes them (`queue.ts`). Legacy data is not
 * migrated, rewritten or deleted.
 */

export const MAX_IDEMPOTENCY_KEY_LENGTH = 191;
export const MAX_RECIPIENT_LENGTH = 320;
export const MAX_TEMPLATE_KEY_LENGTH = 100;

export type NotificationEnqueueErrorCode =
    | "INVALID_IDEMPOTENCY_KEY"
    | "INVALID_CHANNEL"
    | "INVALID_RECIPIENT"
    | "INVALID_TEMPLATE_KEY"
    | "UNKNOWN_TEMPLATE"
    | "MISSING_CATEGORY";

export class NotificationEnqueueError extends Error {
    readonly code: NotificationEnqueueErrorCode;

    constructor(code: NotificationEnqueueErrorCode, message: string) {
        super(message);
        this.name = "NotificationEnqueueError";
        this.code = code;
    }
}

export type EnqueueNotificationInput = {
    /** Stable per logical event: e.g. `order:<orderNumber>:proof:email:v1`. */
    idempotencyKey: string;
    channel: Phase1DeliveryChannel;
    recipient: string;
    /** REQUIRED. This is what keeps a new row out of the legacy population. */
    category: NotificationCategory;
    templateKey: string;
    recipientType?: NotificationRecipientType;
    payload?: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    userId?: string | null;
    eventOrderId?: string | null;
    ticketId?: string | null;
    eventId?: string | null;
    organizerId?: string | null;
    picProfileId?: string | null;
};

export type EnqueueNotificationResult = {
    notificationId: number;
    deliveryId: string;
    /** False when the idempotency key already existed; the rows were reused, not duplicated. */
    created: boolean;
};

type EnqueueDb = Pick<typeof prisma, "notification" | "notificationDelivery">;

function assertInput(input: EnqueueNotificationInput): void {
    const key = input.idempotencyKey?.trim() ?? "";

    if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw new NotificationEnqueueError(
            "INVALID_IDEMPOTENCY_KEY",
            `idempotencyKey must be 1–${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`
        );
    }

    if (!isPhase1Channel(input.channel)) {
        throw new NotificationEnqueueError(
            "INVALID_CHANNEL",
            "Phase 1 only enqueues EMAIL and WHATSAPP deliveries."
        );
    }

    const recipient = input.recipient?.trim() ?? "";

    if (recipient.length === 0 || recipient.length > MAX_RECIPIENT_LENGTH) {
        throw new NotificationEnqueueError(
            "INVALID_RECIPIENT",
            `recipient must be 1–${MAX_RECIPIENT_LENGTH} characters.`
        );
    }

    if (!input.category) {
        throw new NotificationEnqueueError(
            "MISSING_CATEGORY",
            "category is required: an uncategorised notification is treated as legacy data."
        );
    }

    const templateKey = input.templateKey?.trim() ?? "";

    if (templateKey.length === 0 || templateKey.length > MAX_TEMPLATE_KEY_LENGTH) {
        throw new NotificationEnqueueError(
            "INVALID_TEMPLATE_KEY",
            `templateKey must be 1–${MAX_TEMPLATE_KEY_LENGTH} characters.`
        );
    }

    if (!hasTemplate(templateKey)) {
        throw new NotificationEnqueueError(
            "UNKNOWN_TEMPLATE",
            `templateKey "${templateKey}" is not registered on the server.`
        );
    }
}

function isIdempotencyCollision(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
        return false;
    }

    if (error.code !== "P2002") {
        return false;
    }

    const target = error.meta?.target;

    if (Array.isArray(target)) {
        return target.includes("idempotencyKey");
    }

    return typeof target === "string" ? target.includes("idempotencyKey") : true;
}

/**
 * Enqueue one notification and its single-channel delivery, idempotently.
 *
 * The duplicate-key path also repairs a missing delivery row (with `skipDuplicates`) so a
 * half-written pair from an interrupted earlier call converges to the same result instead of
 * failing forever.
 */
export async function enqueueNotification(
    input: EnqueueNotificationInput,
    db: EnqueueDb = prisma
): Promise<EnqueueNotificationResult> {
    assertInput(input);

    const idempotencyKey = input.idempotencyKey.trim();
    const recipient = input.recipient.trim();
    const templateKey = input.templateKey.trim();

    try {
        const notification = await db.notification.create({
            data: {
                idempotencyKey,
                // The legacy column is the same channel in its pre-enum, lowercase form, so the
                // two columns cannot disagree about what was asked for.
                channel: input.channel.toLowerCase(),
                recipient,
                category: input.category,
                templateKey,
                recipientType: input.recipientType,
                payload: input.payload ? JSON.stringify(input.payload) : null,
                priority: input.priority,
                maxRetries: input.maxAttempts ?? 3,
                userId: input.userId ?? null,
                eventOrderId: input.eventOrderId ?? null,
                ticketId: input.ticketId ?? null,
                eventId: input.eventId ?? null,
                organizerId: input.organizerId ?? null,
                picProfileId: input.picProfileId ?? null,
                deliveries: {
                    create: [
                        {
                            channel: input.channel,
                            maxAttempts: input.maxAttempts ?? 3,
                        },
                    ],
                },
            },
            select: {
                id: true,
                deliveries: { select: { id: true } },
            },
        });

        return {
            notificationId: notification.id,
            deliveryId: notification.deliveries[0].id,
            created: true,
        };
    } catch (error) {
        if (!isIdempotencyCollision(error)) {
            throw error;
        }
    }

    const existing = await db.notification.findUnique({
        where: { idempotencyKey },
        select: {
            id: true,
            deliveries: {
                where: { channel: input.channel },
                select: { id: true },
            },
        },
    });

    if (!existing) {
        // The unique violation said the row exists; not finding it means the database state is
        // inconsistent, and inventing a second row would be worse than failing loudly.
        throw new Error("Idempotency key collision but the existing notification is missing.");
    }

    const existingDelivery = existing.deliveries[0];

    if (existingDelivery) {
        return {
            notificationId: existing.id,
            deliveryId: existingDelivery.id,
            created: false,
        };
    }

    // Repair path: the notification exists but this channel's delivery does not.
    await db.notificationDelivery.createMany({
        data: [
            {
                notificationId: existing.id,
                channel: input.channel,
                maxAttempts: input.maxAttempts ?? 3,
            },
        ],
        skipDuplicates: true,
    });

    const repaired = await db.notificationDelivery.findUnique({
        where: {
            notificationId_channel: {
                notificationId: existing.id,
                channel: input.channel,
            },
        },
        select: { id: true },
    });

    if (!repaired) {
        throw new Error("Failed to repair the missing notification delivery row.");
    }

    return {
        notificationId: existing.id,
        deliveryId: repaired.id,
        created: false,
    };
}
