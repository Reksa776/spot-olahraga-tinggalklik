import type {
    EmailTransport,
    OutboundEmail,
    OutboundWhatsApp,
    WhatsAppTransport,
} from "../types";

/**
 * ==========================================
 * DRY-RUN TRANSPORTS — THE ACTIVE PHASE 1 TRANSPORT
 * ==========================================
 *
 * These are not mocks in the test sense; they are the transport the Phase 1 worker actually
 * uses. They import no networking module, read no credential and resolve immediately with
 * `simulated: true`.
 *
 * The worker turns a simulated result into `SKIPPED` with `errorCode = DRY_RUN_SIMULATED`, never
 * into `SENT`. That distinction is the difference between "the queue worked" and a false claim
 * that a customer received a message.
 *
 * `onSimulated` is a callback for the worker's structured log. It receives ids and the channel —
 * never the recipient or the body.
 */

export const DRY_RUN_EMAIL_TRANSPORT_NAME = "dry-run-email";
export const DRY_RUN_WHATSAPP_TRANSPORT_NAME = "dry-run-whatsapp";

export type DryRunSimulationEvent = {
    transport: string;
    deliveryId: string;
    notificationId: number;
};

export function createDryRunEmailTransport(
    onSimulated?: (event: DryRunSimulationEvent) => void
): EmailTransport {
    return {
        name: DRY_RUN_EMAIL_TRANSPORT_NAME,
        kind: "dry-run",
        async send(_message: OutboundEmail, context) {
            onSimulated?.({
                transport: DRY_RUN_EMAIL_TRANSPORT_NAME,
                deliveryId: context.deliveryId,
                notificationId: context.notificationId,
            });

            return { simulated: true };
        },
    };
}

export function createDryRunWhatsAppTransport(
    onSimulated?: (event: DryRunSimulationEvent) => void
): WhatsAppTransport {
    return {
        name: DRY_RUN_WHATSAPP_TRANSPORT_NAME,
        kind: "dry-run",
        async send(_message: OutboundWhatsApp, context) {
            onSimulated?.({
                transport: DRY_RUN_WHATSAPP_TRANSPORT_NAME,
                deliveryId: context.deliveryId,
                notificationId: context.notificationId,
            });

            return { simulated: true };
        },
    };
}
