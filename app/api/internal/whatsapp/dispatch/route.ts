import { createHash, timingSafeEqual } from "node:crypto";
import { getWhatsAppGatewayForWeb } from "@/lib/whatsapp/gateway/web-runtime";
import { validateTextDispatch } from "@/lib/whatsapp/gateway/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Text plus up to five QR images. The body is validated before the gateway is touched, and the
 * media validator bounds each image, so this is a ceiling rather than an invitation.
 */
const MAX_DISPATCH_BODY_BYTES = 524_288;

function authorized(request: Request): boolean {
    const expected = process.env.WA_GATEWAY_TOKEN?.trim() ?? "";
    const supplied = request.headers.get("authorization") ?? "";
    if (expected.length < 32 || !supplied.startsWith("Bearer ")) return false;
    const actualHash = createHash("sha256").update(supplied.slice(7)).digest();
    const expectedHash = createHash("sha256").update(expected).digest();
    return timingSafeEqual(actualHash, expectedHash);
}

export async function POST(request: Request): Promise<Response> {
    if (!authorized(request)) {
        return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: { "cache-control": "no-store" } });
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DISPATCH_BODY_BYTES) {
        return Response.json({ error: "BODY_TOO_LARGE" }, { status: 413 });
    }

    let body: unknown;
    try {
        const raw = await request.text();
        if (Buffer.byteLength(raw) > MAX_DISPATCH_BODY_BYTES) return Response.json({ error: "BODY_TOO_LARGE" }, { status: 413 });
        body = JSON.parse(raw);
    } catch {
        return Response.json({ error: "INVALID_JSON" }, { status: 400 });
    }

    const validated = validateTextDispatch(body);
    if (!validated.ok) {
        return Response.json({ error: validated.code, message: validated.message }, { status: 400 });
    }

    const gateway = await getWhatsAppGatewayForWeb();
    if (!gateway) return Response.json({ status: "NOT_READY", errorCode: "GATEWAY_NOT_READY" }, { status: 503 });

    const result = await gateway.dispatchText(validated.value);
    const status = result.status === "SENT" ? 200 : result.status === "FAILED_BEFORE_SEND" ? 502 : 503;
    return Response.json(result, { status, headers: { "cache-control": "no-store" } });
}
