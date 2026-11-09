import { sanitizeErrorMessage } from "./logger";

/**
 * ==========================================
 * DELIVERY FAILURE CLASSIFICATION
 * ==========================================
 *
 * `queue.ts` already owns the state machine: a transient failure goes back to `QUEUED` with a
 * 60 s / 5 min backoff, and the last allowed attempt becomes terminal `FAILED`. What it cannot
 * know is which failures are worth retrying.
 *
 * This module makes that distinction explicit, so a WhatsApp send that failed because the JID
 * is invalid, the gateway token is wrong, or the template no longer exists is recorded as a
 * FINAL failure immediately (no wasted retries, no misleading "will retry" log), while a
 * dropped Baileys connection or a `NOT_READY` gateway is retried with the existing backoff.
 *
 * Classification is by the error `code` the transport already sets (`BaileysGatewayError`,
 * `NotificationEnqueueError`, the gateway's `errorCode`). An unrecognised error is treated as
 * TRANSIENT: the safe direction for a delivery that may not have left the process is to retry
 * a bounded number of times, never to discard it silently.
 */

/** Codes retrying cannot fix. Everything else is retried within the attempt budget. */
export const PERMANENT_DELIVERY_ERROR_CODES: ReadonlySet<string> = new Set([
    // Recipient problems are normally rejected before the transport (terminal SKIPPED); these
    // are the codes that can still surface from a gateway implementation.
    "INVALID_RECIPIENT",
    "INVALID_JID",
    // Configuration: a wrong token/base URL will not become correct by waiting.
    "GATEWAY_CONFIG_INVALID",
    "UNAUTHORIZED",
    "BODY_TOO_LARGE",
    // Template problems are already terminal SKIPPED in the worker; kept here as a backstop.
    "TEMPLATE_NOT_FOUND",
    "TEMPLATE_PAYLOAD_INVALID",
    "UNKNOWN_TEMPLATE",
    // Media refused before any byte was transmitted.
    "INVALID_MEDIA",
]);

export type DeliveryErrorClassification = {
    code: string;
    permanent: boolean;
    message: string;
};

export function classifyDeliveryError(
    error: unknown
): DeliveryErrorClassification {
    const code =
        error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "TRANSPORT_ERROR";

    return {
        code,
        permanent: PERMANENT_DELIVERY_ERROR_CODES.has(code),
        message: sanitizeErrorMessage(error),
    };
}
