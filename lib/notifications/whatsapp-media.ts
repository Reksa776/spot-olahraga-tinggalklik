import QRCode from "qrcode";

import { isTicketCode } from "@/lib/ticketing/tickets/reference";

import { POST_EVENT_DOCUMENT_TEMPLATE_KEY } from "./post-event-document-template";
import { PURCHASE_PROOF_TEMPLATE_KEY } from "./purchase-proof-template";
import { TICKET_ISSUED_TEMPLATE_KEY } from "./ticket-issued-template";
import type { OutboundWhatsAppMedia } from "./types";

/**
 * ==========================================
 * WHATSAPP MEDIA FROM A STORED PAYLOAD
 * ==========================================
 *
 * The notification queue stores DATA (`notification.payload`), never a rendered message. The
 * worker is the only process that renders and sends, so attachments are derived there from the
 * same payload the text was rendered from:
 *
 *   purchase-proof.v1 / ticket-issued.v1
 *     → one PNG QR per public ticket code, encoded as `TICKET:<ticketCode>` — exactly what
 *       the wallet displays. Only `Ticket.ticketCode` (a public lookup label) is ever used;
 *       `qrTokenHash` and the scanner secret are not in the payload and are never read.
 *
 *   post-event-document.v1
 *     → the already-issued tokenised HTTPS download URL as a PDF document attachment.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────────────
 * A media failure must NEVER suppress the text message: every branch returns an empty array
 * (and the caller sends the text) rather than throwing. Media is capped at five items so a
 * batch cannot amplify one delivery into an unbounded number of socket sends. A document URL
 * must be absolute HTTPS; a stored value that is not is dropped, not "repaired".
 */

/** One message may carry a bounded number of images. */
export const MAX_WHATSAPP_MEDIA = 5;

const MAX_DOCUMENT_URL = 2_000;
const MAX_FILE_NAME = 180;
const QR_WIDTH = 640;

function parsePayload(
    payloadJson: string | null
): Record<string, unknown> | null {
    if (payloadJson === null || payloadJson.trim().length === 0) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(payloadJson);

        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/** Public codes only, de-duplicated, in stored order. */
function publicTicketCodes(payload: Record<string, unknown>): string[] {
    const value = payload.tickets;

    if (!Array.isArray(value)) {
        return [];
    }

    const codes: string[] = [];
    const seen = new Set<string>();

    for (const entry of value) {
        const candidate =
            typeof entry === "string"
                ? entry.trim()
                : typeof entry === "object" && entry !== null
                  ? String(
                        (entry as { ticketCode?: unknown }).ticketCode ?? ""
                    ).trim()
                  : "";

        if (isTicketCode(candidate) && !seen.has(candidate)) {
            seen.add(candidate);
            codes.push(candidate);
        }

        if (codes.length >= MAX_WHATSAPP_MEDIA) {
            break;
        }
    }

    return codes;
}

function documentFileName(title: string): string {
    const cleaned = title
        .replace(/[^\w\-. ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_FILE_NAME - 4);

    return `${cleaned || "dokumen"}.pdf`;
}

export async function buildWhatsAppMedia(
    templateKey: string,
    payloadJson: string | null
): Promise<OutboundWhatsAppMedia[]> {
    try {
        if (templateKey === POST_EVENT_DOCUMENT_TEMPLATE_KEY) {
            const payload = parsePayload(payloadJson);

            if (!payload) {
                return [];
            }

            const url =
                typeof payload.downloadUrl === "string"
                    ? payload.downloadUrl.trim()
                    : "";
            const title =
                typeof payload.title === "string" ? payload.title : "";

            let parsedUrl: URL;

            try {
                parsedUrl = new URL(url);
            } catch {
                return [];
            }

            if (
                parsedUrl.protocol !== "https:" ||
                url.length > MAX_DOCUMENT_URL
            ) {
                return [];
            }

            return [
                {
                    kind: "document",
                    url,
                    fileName: documentFileName(title),
                },
            ];
        }

        if (
            templateKey !== PURCHASE_PROOF_TEMPLATE_KEY &&
            templateKey !== TICKET_ISSUED_TEMPLATE_KEY
        ) {
            return [];
        }

        const payload = parsePayload(payloadJson);

        if (!payload) {
            return [];
        }

        const codes = publicTicketCodes(payload);
        const media: OutboundWhatsAppMedia[] = [];

        for (const code of codes) {
            try {
                const dataUrl = await QRCode.toDataURL(`TICKET:${code}`, {
                    errorCorrectionLevel: "M",
                    margin: 1,
                    width: QR_WIDTH,
                });

                media.push({ kind: "image", dataUrl });
            } catch {
                // One unrenderable code must not stop the others (or the text).
            }
        }

        return media;
    } catch {
        return [];
    }
}
