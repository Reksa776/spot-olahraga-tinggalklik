export const POST_EVENT_DOCUMENT_TEMPLATE_KEY = "post-event-document.v1";

export function renderPostEventDocument(payload: Record<string, unknown>) {
    const clean = (value: unknown, max: number) => typeof value === "string"
        ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
        : "";
    const title = clean(payload.title, 160);
    const event = clean(payload.eventTitle, 160);
    const link = clean(payload.downloadUrl, 1000);
    // PIC blast greeting. Optional: the original organiser flow sends no message and must
    // render exactly as before. Sanitized and bounded like every other payload field, so a
    // stored message can only appear as plain text.
    const message = clean(payload.message, 1000);
    if (!title || !event || !/^https:\/\//.test(link)) {
        throw new Error("POST_EVENT_DOCUMENT_PAYLOAD_INVALID");
    }
    return {
        subject: `Dokumen acara ${event}`,
        text: `Halo,\n\n${message ? `${message}\n\n` : ""}Dokumen pasca-acara ${event} sudah tersedia: ${title}\n\nUnduh: ${link}\n\nTautan berlaku terbatas.`,
    };
}
