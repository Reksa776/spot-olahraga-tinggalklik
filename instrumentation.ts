/**
 * Keep the local WhatsApp gateway beside the single self-hosted Next.js server process.
 * This makes the authenticated dashboard work after a normal web-app restart without an
 * operator having to remember a separate PM2 process. The existing DB lease and local lock
 * still elect exactly one gateway if the dedicated PM2 entry is also enabled.
 */
export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    if (process.env.WA_GATEWAY_ENABLED?.trim().toLowerCase() !== "true") return;

    const { startWhatsAppGatewayForWeb } = await import("./lib/whatsapp/gateway/web-runtime");
    await startWhatsAppGatewayForWeb();
}
