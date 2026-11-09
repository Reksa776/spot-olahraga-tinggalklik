/**
 * ==========================================
 * TEMPLATE REGISTRY (PHASE 1)
 * ==========================================
 *
 * Templates are SERVER-SIDE and versioned by key. `notification.templateKey` points at an entry
 * in this registry, and `notification.payload` is data, never a template: nothing a caller sends
 * can become markup or a message body.
 *
 * Phase 1 shipped ONE synthetic template — `phase1.dry-run.v1`. Phase 2 adds exactly TWO
 * business templates — `purchase-proof.v1` (settlement) and `ticket-issued.v1` (post-issuance) —
 * and nothing else. Phase 4 registers `reminder.h36.v1`; the post-event document template still
 * belongs to Phase 5 and remains unregistered, so "no Phase 5 message can be enqueued" stays
 * checkable.
 *
 * Unknown keys are a terminal, non-retryable condition: retrying cannot make a deleted template
 * reappear, and a silent fallback body would be worse than a recorded failure.
 */

import {
    PURCHASE_PROOF_TEMPLATE_KEY,
    renderPurchaseProof,
} from "./purchase-proof-template";
import {
    H36_REMINDER_TEMPLATE_KEY,
    renderH36Reminder,
} from "./h36-reminder-template";
import {
    TICKET_ISSUED_TEMPLATE_KEY,
    renderTicketIssued,
} from "./ticket-issued-template";
import { POST_EVENT_DOCUMENT_TEMPLATE_KEY, renderPostEventDocument } from "./post-event-document-template";

export const PHASE_1_DRY_RUN_TEMPLATE_KEY = "phase1.dry-run.v1";

export type RenderedNotification = {
    subject: string;
    text: string;
};

/**
 * Channel context for a renderer. Optional and ignored by templates whose wording is shared.
 *
 * `purchase-proof.v1` uses it for ONE sentence: before issuance the WhatsApp copy must say
 * the e-ticket will follow, while the existing email wording stays byte-identical (the email
 * feature is out of scope and its tests pin that text).
 */
export type RenderOptions = { channel?: "EMAIL" | "WHATSAPP" };

export class TemplateNotFoundError extends Error {
    readonly code = "TEMPLATE_NOT_FOUND";

    constructor(templateKey: string) {
        super(`Notification template "${templateKey}" is not registered.`);
        this.name = "TemplateNotFoundError";
    }
}

export class TemplatePayloadInvalidError extends Error {
    readonly code = "TEMPLATE_PAYLOAD_INVALID";

    constructor(templateKey: string) {
        super(`Notification payload for "${templateKey}" is not a JSON object.`);
        this.name = "TemplatePayloadInvalidError";
    }
}

/**
 * A v1 dry-run body.
 *
 * The only interpolated value is a whitelisted `reference` scalar (letters, digits, `-`, `_`,
 * `.`) truncated to 40 characters, so the body cannot carry injected line breaks, HTML or a
 * recipient address. The wording is explicit about being a simulation: a dry run must never
 * read like a delivered message.
 */
function renderDryRun(payload: Record<string, unknown>): RenderedNotification {
    const rawReference = payload.reference;
    const reference =
        typeof rawReference === "string"
            ? rawReference.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40)
            : "";

    return {
        subject: "TinggalKlik.Co — simulasi notifikasi",
        text: [
            "SIMULASI (DRY RUN) — pesan ini tidak dikirim ke siapa pun.",
            "Phase 1 hanya memverifikasi antrean, worker, dan adapter.",
            ...(reference ? [`Referensi: ${reference}`] : []),
        ].join("\n"),
    };
}

const TEMPLATES: Record<
    string,
    (
        payload: Record<string, unknown>,
        options?: RenderOptions
    ) => RenderedNotification
> = {
    [PHASE_1_DRY_RUN_TEMPLATE_KEY]: renderDryRun,
    [PURCHASE_PROOF_TEMPLATE_KEY]: renderPurchaseProof,
    [TICKET_ISSUED_TEMPLATE_KEY]: renderTicketIssued,
    [H36_REMINDER_TEMPLATE_KEY]: renderH36Reminder,
    [POST_EVENT_DOCUMENT_TEMPLATE_KEY]: renderPostEventDocument,
};

export function hasTemplate(templateKey: string): boolean {
    return Object.prototype.hasOwnProperty.call(TEMPLATES, templateKey);
}

/**
 * Render a stored payload.
 *
 * A null/blank payload is treated as an empty object because the dry-run template needs no data;
 * a payload that parses to a non-object (array, string, number) is invalid rather than coerced.
 */
export function renderNotification(
    templateKey: string,
    payloadJson: string | null,
    options?: RenderOptions
): RenderedNotification {
    const renderer = TEMPLATES[templateKey];

    if (!renderer) {
        throw new TemplateNotFoundError(templateKey);
    }

    let payload: Record<string, unknown> = {};

    if (payloadJson !== null && payloadJson.trim().length > 0) {
        let parsed: unknown;

        try {
            parsed = JSON.parse(payloadJson);
        } catch {
            throw new TemplatePayloadInvalidError(templateKey);
        }

        if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
        ) {
            throw new TemplatePayloadInvalidError(templateKey);
        }

        payload = parsed as Record<string, unknown>;
    }

    return renderer(payload, options);
}
