import { headers } from "next/headers";

/**
 * ==========================================
 * SERVER-COMPONENT ORIGIN (for display links)
 * ==========================================
 *
 * Builds the absolute origin used for **canonical and share links rendered into a
 * page** — the copy-share button, the QR payload, and the Open Graph URL.
 *
 * WHY THIS IS A SEPARATE HELPER FROM `lib/app-origin.ts`
 * ------------------------------------------------------
 * That module exists to build **payment callback URLs**, where a spoofed
 * `x-forwarded-host` would let an attacker redirect a payer to their own site after
 * payment. It therefore validates the host against a hard-coded allowlist and returns
 * an empty string on a mismatch — the right behaviour for a security boundary.
 *
 * A server component has no `NextRequest` to pass it (it receives no request object),
 * and the value being built here is not a redirect target: it is the URL of the page
 * the visitor is already reading, rendered back to them as text. Applying the payment
 * allowlist would also mean cancelling a deployment whenever a new hostname is added,
 * which is the wrong fit for a display path.
 *
 * So the rules are deliberately different, and stated rather than implied:
 *
 *   1. `NEXT_PUBLIC_APP_URL` wins when set — the same precedence the payment helper
 *      uses, and the recommended configuration.
 *   2. Otherwise the request's own host is used, because the user is already on it.
 *   3. Unset env **and** no host resolves to an empty string, which the catalog turns
 *      into a root-relative link (`/e/{slug}`) rather than a link to somewhere else.
 *
 * No `x-forwarded-host` value can move a visitor off-site through this path, because
 * nothing here issues a redirect.
 */

export async function getServerOrigin(): Promise<string> {
    const envUrl = process.env.NEXT_PUBLIC_APP_URL;

    if (envUrl && /^https?:\/\//.test(envUrl)) {
        return envUrl.replace(/\/+$/, "");
    }

    try {
        const headerList = await headers();

        const proto =
            headerList.get("x-forwarded-proto") ??
            (process.env.NODE_ENV === "production" ? "https" : "http");

        const host =
            headerList.get("x-forwarded-host") ?? headerList.get("host");

        if (!host) {
            return "";
        }

        return `${proto}://${host}`;
    } catch {
        // No request scope (a build-time render, for example). Callers fall back to a
        // relative link.
        return "";
    }
}
