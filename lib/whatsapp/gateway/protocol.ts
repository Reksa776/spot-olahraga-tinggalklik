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

/**
 * Attachments accepted by ONE dispatch. Deliberately closed to two shapes:
 *
 *   image    — a server-rendered PNG data URL (the business templates' ticket QR).
 *   document — an absolute HTTPS URL plus a display fileName (post-event PDF).
 *
 * Nothing here can name a local path, a `file://` URL or an arbitrary socket content object.
 */
export type DispatchImageMedia = { kind: "image"; dataUrl: string };
export type DispatchDocumentMedia = {
    kind: "document";
    url: string;
    fileName: string;
    caption?: string;
};
export type DispatchMedia = DispatchImageMedia | DispatchDocumentMedia;

export type TextDispatchRequest = {
    deliveryId: string;
    notificationId: number;
    jid: string;
    text: string;
    media?: DispatchMedia[];
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
    /** TRUE when the operator latched a manual disconnect; no socket may be opened. */
    manualDisconnect: boolean;
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

const MAX_MEDIA_ITEMS = 5;
const MAX_IMAGE_DATA_URL = 400_000;
const MAX_DOCUMENT_URL = 2_000;
const IMAGE_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const DOCUMENT_FILE_NAME = /^[^\\/\u0000-\u001f]{1,180}$/;

/**
 * Validate the optional attachment list BEFORE the ledger is touched.
 *
 * A rejected media item must not create a row, acquire a lease or reach a socket. The PNG data
 * URL is bounded (a 640px QR is a few KB; the bound stops a caller turning one dispatch into
 * a memory amplifier), and a document URL must be absolute HTTPS.
 */
export function validateDispatchMedia(
    value: unknown
):
    | { ok: true; value: DispatchMedia[] }
    | { ok: false; code: string; message: string } {
    if (value === undefined) {
        return { ok: true, value: [] };
    }

    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEDIA_ITEMS) {
        return {
            ok: false,
            code: "INVALID_MEDIA",
            message: `media must contain 1-${MAX_MEDIA_ITEMS} items when supplied.`,
        };
    }

    const out: DispatchMedia[] = [];

    for (const entry of value) {
        const item = asRecord(entry);

        if (!item) {
            return {
                ok: false,
                code: "INVALID_MEDIA",
                message: "Every media item must be an object.",
            };
        }

        if (item.kind === "image") {
            if (
                typeof item.dataUrl !== "string" ||
                item.dataUrl.length > MAX_IMAGE_DATA_URL ||
                !IMAGE_DATA_URL.test(item.dataUrl)
            ) {
                return {
                    ok: false,
                    code: "INVALID_MEDIA",
                    message: "image media must be a PNG data URL within the size limit.",
                };
            }

            out.push({ kind: "image", dataUrl: item.dataUrl });
            continue;
        }

        if (item.kind === "document") {
            const url = typeof item.url === "string" ? item.url.trim() : "";
            const fileName =
                typeof item.fileName === "string" ? item.fileName.trim() : "";

            let parsed: URL | null = null;

            try {
                parsed = new URL(url);
            } catch {
                parsed = null;
            }

            if (!parsed || parsed.protocol !== "https:" || url.length > MAX_DOCUMENT_URL) {
                return {
                    ok: false,
                    code: "INVALID_MEDIA",
                    message: "document media requires an absolute HTTPS url.",
                };
            }

            if (!DOCUMENT_FILE_NAME.test(fileName)) {
                return {
                    ok: false,
                    code: "INVALID_MEDIA",
                    message: "document media requires a safe fileName.",
                };
            }

            const caption =
                typeof item.caption === "string" && item.caption.trim().length > 0
                    ? item.caption.trim().slice(0, 1_024)
                    : undefined;

            out.push({
                kind: "document",
                url,
                fileName,
                ...(caption ? { caption } : {}),
            });
            continue;
        }

        return {
            ok: false,
            code: "INVALID_MEDIA",
            message: 'media kind must be "image" or "document".',
        };
    }

    return { ok: true, value: out };
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

    const media = validateDispatchMedia(input.media);

    if (!media.ok) {
        return { ok: false, code: media.code, message: media.message };
    }

    return {
        ok: true,
        value: {
            deliveryId: input.deliveryId,
            notificationId: input.notificationId,
            jid: `${normalized}@s.whatsapp.net`,
            text: input.text,
            ...(media.value.length > 0 ? { media: media.value } : {}),
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
