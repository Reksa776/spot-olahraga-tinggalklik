import QRCode from "qrcode";

/**
 * ==========================================
 * QRIS QR IMAGE — SERVER-SIDE RENDERER
 * ==========================================
 *
 * Renders the provider's `QrString` payload into a QR PNG **on the server** and returns it
 * as a `data:image/png;base64,…` URL, so the buyer-facing page receives an image and never
 * the raw payload (`qrString` must not reach the browser — it is the payment instrument's
 * literal content, and leaking it would let anyone reproduce the payment request).
 *
 * Why a local render at all: the provider's own `QrImage` URL is served as an HTML page in
 * the sandbox environment (a document embedding `data:image/png;base64,…`), not as a bare
 * image, so a plain `<img src={qrImageUrl}>` renders nothing. Encoding the same `QrString`
 * the gateway returned produces a QR whose payload is byte-for-byte what a wallet must
 * decode — using the gateway's own bytes is the reason this is a render, not a fabrication.
 *
 * Purposely NOT `qrcode.react`: that component renders through React DOM plumbing, which
 * Turbopack forbids mixing with `react-dom/server` in app code. `qrcode` is a pure-JS
 * encoder (PNG via zlib, no canvas), so it is the smallest correct tool for a server
 * render.
 */
export async function qrisImageDataUrl(
    qrString: string
): Promise<string | null> {
    if (!qrString) {
        return null;
    }

    try {
        return await QRCode.toDataURL(qrString, {
            errorCorrectionLevel: "M",
            margin: 1,
            width: 496,
        });
    } catch {
        // A render failure must degrade the image, not the page. Callers fall back.
        return null;
    }
}