import type { NextRequest } from "next/server";

/**
 * ==========================================
 * APP ORIGIN RESOLUTION (SECURE)
 * ==========================================
 *
 * Resolves the application's origin URL for
 * payment callback URLs (finish, return, cancel).
 *
 * SECURITY (H1 FIX):
 * Previously, when NEXT_PUBLIC_APP_URL was not set,
 * the function fell back to x-forwarded-proto and
 * x-forwarded-host headers without validation.
 * An attacker could spoof these headers to redirect
 * users to a malicious site after payment.
 *
 * Fixed behavior:
 * 1. Always prefer NEXT_PUBLIC_APP_URL env var
 * 2. If env var not set, fall back to headers
 * 3. When using headers, validate host against allowlist
 * 4. If host doesn't match allowlist, return empty (reject)
 *
 * The allowlist includes:
 * - The hostname from NEXT_PUBLIC_APP_URL (if set)
 * - `localhost` / loopback variants, for development
 * - One hardcoded deployment domain (see `buildAllowedHosts`)
 */
export function getAppOrigin(request: NextRequest): string {
    const envUrl = process.env.NEXT_PUBLIC_APP_URL;

    // ==========================================
    // PRIMARY: Use env var (trusted source)
    // ==========================================
    if (envUrl && /^https?:\/\//.test(envUrl)) {
        return envUrl.replace(/\/+$/, "");
    }

    // ==========================================
    // FALLBACK: Build from request headers
    // ==========================================
    //
    // SECURITY: Validate host against allowlist
    // to prevent open redirect via header spoofing.

    const forwardedProto =
        request.headers.get("x-forwarded-proto") || "https";

    const host =
        request.headers.get("x-forwarded-host") ||
        request.headers.get("host");

    if (!host) {
        console.error(
            "APP_ORIGIN: NEXT_PUBLIC_APP_URL tidak ter-set " +
            "dan host tidak terdeteksi dari headers."
        );
        return "";
    }

    // Strip port for allowlist matching
    const hostname = host.split(":")[0];

    // ==========================================
    // HOST ALLOWLIST
    // ==========================================
    //
    // Only allow known hostnames. If the host
    // doesn't match, reject to prevent redirect
    // to attacker-controlled domain.

    const allowedHosts = buildAllowedHosts();

    if (!allowedHosts.has(hostname.toLowerCase())) {
        console.error(
            "APP_ORIGIN: REJECTED — host not in allowlist:",
            hostname
        );
        return "";
    }

    return `${forwardedProto}://${host}`;
}

/**
 * Build the set of allowed hostnames.
 *
 * Sources:
 * 1. NEXT_PUBLIC_APP_URL hostname (if set) — the authoritative one
 * 2. loopback / localhost variants (development)
 * 3. one hardcoded deployment domain, with the caveat documented at the entry
 *
 * The previous revision claimed source 2 was `next.config.ts allowedDevOrigins`; it in
 * fact never read that config. The comment is corrected here rather than the behaviour,
 * because a list that silently claims a source it does not use is worse than a short list
 * that says what it is.
 */
function buildAllowedHosts(): Set<string> {
    const hosts = new Set<string>();

    // From NEXT_PUBLIC_APP_URL
    const envUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (envUrl) {
        try {
            const parsed = new URL(envUrl);
            hosts.add(parsed.hostname.toLowerCase());
        } catch {
            // Invalid URL — skip
        }
    }

    // ── Known domains ──────────────────────────────────────────────────────────
    //
    // This is a FALLBACK, reached only when NEXT_PUBLIC_APP_URL is unset — which a
    // production deployment may not be: `lib/payment/config.ts` refuses to build a payment
    // session in production without it. So on a correctly configured deployment this list
    // is never consulted, and every entry here is defence for a misconfigured one.
    //
    // A NOTE ON WHAT USED TO BE HERE. The list previously also accepted an ephemeral
    // `trycloudflare.com` tunnel hostname (`debut-thanks-spray-wine.…`). That was removed:
    // a quick-tunnel hostname is issued by a third party, expires, and can be claimed again
    // by anyone, so accepting it means whoever holds that name at the relevant moment can
    // be handed the origin this function builds into payment callback URLs. The Phase 1
    // design already scheduled its removal; it is done rather than deferred because the
    // cost of leaving it is an open redirect and the cost of removing it is nothing — no
    // deployment that sets NEXT_PUBLIC_APP_URL can notice.
    //
    // The remaining entry is a real domain rather than a re-registerable one. It is listed
    // in the Phase 26 report as an owner decision: it is a hardcoded deployment host, so it
    // either belongs to this product (keep it) or should go the same way as the tunnel
    // (drop it).
    hosts.add("demosolusisejalan.my.id");

    // Localhost variants (development)
    hosts.add("localhost");
    hosts.add("127.0.0.1");
    hosts.add("0.0.0.0");

    return hosts;
}
