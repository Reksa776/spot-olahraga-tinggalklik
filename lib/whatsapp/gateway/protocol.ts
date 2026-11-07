import type { DeliveryAcknowledgementStatus, WhatsAppGatewayMessageState } from "@prisma/client";
import { normalizeIndonesianPhone } from "@/lib/notifications/contacts";
import type { GatewayState } from "./lifecycle";

/**
 * Internal HTTP protocol shared by the server and the gateway. It is intentionally tiny:
 * one text-message dispatch, one delivery lookup and one explicit reconciliation.
 *
 * Validation happens BEFORE the ledger is touched. A malformed request must not create a row,
 * acquire a lease or reach a socket.
 */

export type TextDispatchRequest = {
    deliveryId: string;
    notificationId: number;
    jid: string;
    text: string;
};

export type GatewayDispatchStatus =
    | "SENT"
    | "AMBIGUOUS"
    | "FAILED_BEFORE_SEND"
    | "IN_PROGRESS"
    | "NOT_READY";

export type GatewayDispatchResult = {
    status: GatewayDispatchStatus;
    deliveryId: string;
    messageId?: string | null;
    errorCode?: string | null;
    ackStatus?: DeliveryAcknowledgementStatus;
    replayed?: boolean;
};

export type GatewayDeliveryView = {
    deliveryId: string;
    state: WhatsAppGatewayMessageState;
    ackStatus: DeliveryAcknowledgementStatus;
    messageId: string | null;
    errorCode: string | null;
    attemptCount: number;
    acceptedAt: string | null;
    deliveredAt: string | null;
    readAt: string | null;
};

export type GatewayReconcileResult =
    | {
          status: "RECONCILED";
          deliveryId: string;
          state: "SENT" | "FAILED_BEFORE_SEND";
          messageId: string | null;
      }
    | {
          status: "NOT_FOUND" | "NOT_AMBIGUOUS" | "INVALID_RECONCILIATION";
          deliveryId: string;
          errorCode: string;
      };

export type GatewaySnapshot = {
    state: GatewayState;
    ready: boolean;
    ownershipHeld: boolean;
    connected: boolean;
    sessionPresent: boolean;
    lastErrorCode: string | null;
};

export interface GatewayOperations {
    snapshot(): GatewaySnapshot;
  beginPairing?(): Promise<{ started: boolean }>;
  pairingStatus?(): { qr: string | null; expiresAt: string | null };
    dispatchText(input: TextDispatchRequest): Promise<GatewayDispatchResult>;
    getDelivery(deliveryId: string): Promise<GatewayDeliveryView | null>;
    reconcileDelivery(
        deliveryId: string,
        input: { state: "SENT" | "FAILED_BEFORE_SEND"; messageId?: string; note?: string }
    ): Promise<GatewayReconcileResult>;
}

const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,190}$/;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,190}$/;

export function isValidDeliveryId(value: unknown): value is string {
    return typeof value === "string" && DELIVERY_ID.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

export function validateTextDispatch(
    value: unknown
):
    | { ok: true; value: TextDispatchRequest }
    | { ok: false; code: string; message: string } {
    const input = asRecord(value);

    if (!input) {
        return { ok: false, code: "INVALID_BODY", message: "A JSON object is required." };
    }

    if (!isValidDeliveryId(input.deliveryId)) {
        return {
            ok: false,
            code: "INVALID_DELIVERY_ID",
            message: "deliveryId must be a stable 1-191 character identifier.",
        };
    }

    if (
        typeof input.notificationId !== "number" ||
        !Number.isSafeInteger(input.notificationId) ||
        input.notificationId <= 0
    ) {
        return {
            ok: false,
            code: "INVALID_NOTIFICATION_ID",
            message: "notificationId must be a positive integer.",
        };
    }

    if (typeof input.to !== "string" || input.to.includes("@") || input.to.includes("/")) {
        return {
            ok: false,
            code: "INVALID_RECIPIENT",
            message: "to must be an Indonesian mobile number; group and remote JIDs are refused.",
        };
    }

    const normalized = normalizeIndonesianPhone(input.to);

    if (!normalized) {
        return {
            ok: false,
            code: "INVALID_RECIPIENT",
            message: "to must be a valid Indonesian mobile number.",
        };
    }

    if (
        typeof input.text !== "string" ||
        input.text.trim().length === 0 ||
        input.text.length > 4_096
    ) {
        return {
            ok: false,
            code: "INVALID_TEXT",
            message: "text must contain 1-4096 characters.",
        };
    }

    return {
        ok: true,
        value: {
            deliveryId: input.deliveryId,
            notificationId: input.notificationId,
            jid: `${normalized}@s.whatsapp.net`,
            text: input.text,
        },
    };
}

export function validateReconciliation(
    value: unknown
):
    | {
          ok: true;
          value: { state: "SENT" | "FAILED_BEFORE_SEND"; messageId?: string; note?: string };
      }
    | { ok: false; code: string; message: string } {
    const input = asRecord(value);

    if (!input) {
        return { ok: false, code: "INVALID_BODY", message: "A JSON object is required." };
    }

    if (input.state !== "SENT" && input.state !== "FAILED_BEFORE_SEND") {
        return {
            ok: false,
            code: "INVALID_RECONCILIATION_STATE",
            message: "state must be SENT or FAILED_BEFORE_SEND.",
        };
    }

    const messageId = input.messageId;

    if (messageId !== undefined && (typeof messageId !== "string" || !MESSAGE_ID.test(messageId))) {
        return {
            ok: false,
            code: "INVALID_MESSAGE_ID",
            message: "messageId must be a stable identifier when supplied.",
        };
    }

    if (input.state === "SENT" && !messageId) {
        return {
            ok: false,
            code: "MESSAGE_ID_REQUIRED",
            message: "A SENT reconciliation requires the real provider messageId.",
        };
    }

    const note = input.note;

    if (
        note !== undefined &&
        (typeof note !== "string" || note.length > 300 || /[\u0000-\u001f\u007f]/.test(note))
    ) {
        return {
            ok: false,
            code: "INVALID_RECONCILIATION_NOTE",
            message: "note must be at most 300 printable characters.",
        };
    }

    return {
        ok: true,
        value: {
            state: input.state,
            ...(messageId ? { messageId } : {}),
            ...(note ? { note } : {}),
        },
    };
}
