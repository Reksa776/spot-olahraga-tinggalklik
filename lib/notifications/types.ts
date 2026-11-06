import type { NotificationDeliveryChannel } from "@prisma/client";

/**
 * ==========================================
 * NOTIFICATION FOUNDATION — SHARED CONTRACT (PHASE 1)
 * ==========================================
 *
 * The delivery queue already exists in the schema (`notification` +
 * `notificationdelivery`). This module is only the CONTRACT between the three parties that
 * Phase 1 introduces:
 *
 *   enqueue (web process)  →  the two tables  →  worker (separate process)  →  transport
 *
 * A transport is the ONLY thing that could ever talk to the outside world, so its interface is
 * deliberately tiny and it carries no business rules. Phase 1 instantiates nothing but the
 * dry-run implementation (see `transports/dry-run.ts`); the SMTP and Baileys adapters exist as
 * fail-closed stubs so the shape is ready without a single byte leaving the host.
 */

/**
 * The only channels Phase 1 is allowed to enqueue. `IN_APP` exists in the schema but has no
 * writer yet, so it is refused rather than silently queued for a consumer that does not exist.
 */
export const PHASE_1_DELIVERY_CHANNELS = ["EMAIL", "WHATSAPP"] as const;

export type Phase1DeliveryChannel = (typeof PHASE_1_DELIVERY_CHANNELS)[number];

export function isPhase1Channel(
    channel: NotificationDeliveryChannel
): channel is Phase1DeliveryChannel {
    return (PHASE_1_DELIVERY_CHANNELS as readonly string[]).includes(channel);
}

/** A message shaped for an email transport. Plain text only; no HTML, no attachments, no `raw`. */
export type OutboundEmail = {
    to: string;
    subject: string;
    text: string;
};

/** A message shaped for a WhatsApp transport. Plain text only. */
export type OutboundWhatsApp = {
    to: string;
    text: string;
};

/**
 * The outcome of one send attempt.
 *
 * `simulated: true` is the Phase 1 answer: nothing was transmitted. It is deliberately a
 * DIFFERENT shape from success so a caller cannot record a dry run as `SENT` by accident.
 */
export type TransportSendResult =
    | { simulated: true; providerMessageId?: undefined }
    | { simulated: false; providerMessageId?: string };

export type TransportContext = {
    deliveryId: string;
    notificationId: number;
};

export interface NotificationTransport<TMessage> {
    /** Recorded on the delivery row as `provider`. Never a credential or a URL. */
    readonly name: string;
    readonly kind: "dry-run" | "smtp" | "baileys" | "disabled";
    send(
        message: TMessage,
        context: TransportContext
    ): Promise<TransportSendResult>;
}

export type EmailTransport = NotificationTransport<OutboundEmail>;
export type WhatsAppTransport = NotificationTransport<OutboundWhatsApp>;
