/**
 * ==========================================
 * WHATSAPP MEDIA — PURE UNIT
 * ==========================================
 *
 * `buildWhatsAppMedia` derives attachments from the STORED notification payload, at dispatch
 * time. It is pure apart from the QR encoder, so it is tested without a database:
 *
 *   • purchase-proof / ticket-issued with public ticket codes → PNG images;
 *   • post-event-document with an absolute HTTPS URL → one PDF document;
 *   • the five-image ceiling is enforced before any encoding work;
 *   • every failure path returns `[]` rather than throwing, because a media failure must
 *     never suppress the text message.
 */

import QRCode from "qrcode";

import { POST_EVENT_DOCUMENT_TEMPLATE_KEY } from "@/lib/notifications/post-event-document-template";
import { PURCHASE_PROOF_TEMPLATE_KEY } from "@/lib/notifications/purchase-proof-template";
import { TICKET_ISSUED_TEMPLATE_KEY } from "@/lib/notifications/ticket-issued-template";
import {
    buildWhatsAppMedia,
    MAX_WHATSAPP_MEDIA,
} from "@/lib/notifications/whatsapp-media";

// Real PNG generation (not a mock) is deliberate: these tests exercise the encoder the
// worker actually calls. Five 640px QRs take longer than Jest's 5s default.
jest.setTimeout(120_000);

const CODE = "EVT-7K3M-9A2B";
const OTHER_CODE = "EVT-7K3M-9A2C";

/** The public, non-secret shape the worker stores for issued tickets. */
function payload(value: unknown): string {
    return JSON.stringify(value);
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe("QR images for purchase proof and ticket issued", () => {
    test("one valid public code becomes one PNG data URL, encoding TICKET:<code>", async () => {
        const spy = jest.spyOn(QRCode, "toDataURL");

        const media = await buildWhatsAppMedia(
            PURCHASE_PROOF_TEMPLATE_KEY,
            payload({ tickets: [{ ticketCode: CODE }] })
        );

        expect(media).toHaveLength(1);
        expect(media[0]).toMatchObject({ kind: "image" });

        if (media[0]?.kind !== "image") {
            throw new Error("expected an image attachment");
        }

        expect(media[0].dataUrl).toMatch(/^data:image\/png;base64,/);
        expect(spy).toHaveBeenCalledWith(
            `TICKET:${CODE}`,
            expect.objectContaining({ width: 640 })
        );
    });

    test("the ticket-issued template uses the same public payload", async () => {
        const media = await buildWhatsAppMedia(
            TICKET_ISSUED_TEMPLATE_KEY,
            payload({ tickets: [{ ticketCode: CODE }] })
        );

        expect(media).toHaveLength(1);
        expect(media[0]?.kind).toBe("image");
    });

    test("only valid codes are encoded, duplicates are collapsed, and malformed ones dropped", async () => {
        const spy = jest.spyOn(QRCode, "toDataURL");

        const media = await buildWhatsAppMedia(
            PURCHASE_PROOF_TEMPLATE_KEY,
            payload({
                tickets: [
                    { ticketCode: CODE },
                    CODE,
                    { ticketCode: "not-a-ticket-code" },
                    null,
                    { ticketCode: OTHER_CODE },
                ],
            })
        );

        expect(media).toHaveLength(2);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenNthCalledWith(
            1,
            `TICKET:${CODE}`,
            expect.anything()
        );
        expect(spy).toHaveBeenNthCalledWith(
            2,
            `TICKET:${OTHER_CODE}`,
            expect.anything()
        );
    });

    test("at most five images are produced, even when the payload holds more", async () => {
        const codes = ["2", "3", "4", "5", "6", "7", "8"].map(
            (suffix) => `EVT-7K3M-9A2${suffix}`
        );

        const media = await buildWhatsAppMedia(
            PURCHASE_PROOF_TEMPLATE_KEY,
            payload({ tickets: codes.map((ticketCode) => ({ ticketCode })) })
        );

        expect(MAX_WHATSAPP_MEDIA).toBe(5);
        expect(media).toHaveLength(5);
        expect(media.every((item) => item.kind === "image")).toBe(true);
    });
});

describe("post-event document attachment", () => {
    test("an absolute HTTPS URL becomes a PDF document with a safe filename", async () => {
        const url =
            "https://example.test/api/public/event-documents/download-token";

        const media = await buildWhatsAppMedia(
            POST_EVENT_DOCUMENT_TEMPLATE_KEY,
            payload({ title: "Foto/Video: Panitia?", downloadUrl: url })
        );

        expect(media).toEqual([
            {
                kind: "document",
                url,
                fileName: "Foto Video Panitia.pdf",
            },
        ]);
    });

    test("a missing title still yields a usable default filename", async () => {
        const media = await buildWhatsAppMedia(
            POST_EVENT_DOCUMENT_TEMPLATE_KEY,
            payload({ downloadUrl: "https://example.test/d/abc" })
        );

        expect(media).toHaveLength(1);
        expect(media[0]).toMatchObject({ fileName: "dokumen.pdf" });
    });

    test("a non-HTTPS or unparseable URL is dropped instead of repaired", async () => {
        for (const downloadUrl of [
            "http://example.test/d/abc",
            "/relative/path.pdf",
            "not a url",
            "",
        ]) {
            await expect(
                buildWhatsAppMedia(
                    POST_EVENT_DOCUMENT_TEMPLATE_KEY,
                    payload({ title: "Dokumen", downloadUrl })
                )
            ).resolves.toEqual([]);
        }
    });
});

describe("failure paths never throw", () => {
    test("an encoder failure yields no attachments, leaving the text to send", async () => {
        const spy = jest.spyOn(QRCode, "toDataURL") as unknown as jest.Mock;
        spy.mockRejectedValue(new Error("encoder unavailable"));

        await expect(
            buildWhatsAppMedia(
                PURCHASE_PROOF_TEMPLATE_KEY,
                payload({ tickets: [{ ticketCode: CODE }] })
            )
        ).resolves.toEqual([]);
    });

    test("malformed, empty or non-object payloads yield no attachments", async () => {
        for (const value of [null, "", "{not-json", "[]", '"text"']) {
            await expect(
                buildWhatsAppMedia(PURCHASE_PROOF_TEMPLATE_KEY, value)
            ).resolves.toEqual([]);
        }
    });

    test("an unknown template carries no media", async () => {
        await expect(
            buildWhatsAppMedia(
                "some-other-template.v1",
                payload({ tickets: [{ ticketCode: CODE }] })
            )
        ).resolves.toEqual([]);
    });
});
