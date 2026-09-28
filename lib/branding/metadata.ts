import type { ApplicationBranding } from "@/lib/app-settings";

/**
 * ==========================================
 * BRANDING → BROWSER TAB ICON
 * ==========================================
 *
 * The browser tab favicon must be the SAME asset the platform is branded with. That source of
 * truth already exists — `getApplicationBranding()` reads `PlatformSetting.logoUrl` and has
 * already resolved a missing/dangling asset to `null` — so this module does not read the database
 * itself. It only maps the resolved branding onto Next.js icon metadata, which keeps the
 * fallback rule in ONE place and makes it testable without a render.
 *
 * ── WHY THE FALLBACK LIVES IN `public/`, NOT `app/` ─────────────────────────────
 * `app/favicon.ico` is Next.js **file-based metadata**, and file-based metadata has higher
 * priority than the `icons` field returned by `generateMetadata()` — it would override the
 * configured logo and the tab icon could never follow branding. The static icon is therefore
 * served from `public/favicon.ico` (`/favicon.ico`) and referenced explicitly as the fallback,
 * which keeps the file-based convention from ever taking precedence again.
 *
 * ── NO SECOND BRANDING SOURCE ───────────────────────────────────────────────────
 * The URL comes from `ApplicationBranding.logoUrl` and nothing else: not an organizer logo, not an
 * event banner, not a user avatar. The uploaded filename is server-generated
 * (`<timestamp>-<32 hex>.<ext>`), so a new upload produces a new URL and the browser refetches the
 * icon without any cache-busting query.
 */

/** The static fallback tab icon served from `public/`. Used only when no logo is configured. */
export const DEFAULT_FAVICON_PATH = "/favicon.ico";

/** The `icons` field of Next.js `Metadata`, resolved from the platform branding. */
export type BrandingIcons = {
    icon: string;
    shortcut: string;
    apple: string;
};

/**
 * Resolve the platform branding into Next.js `icons` metadata.
 *
 * A configured logo is used VERBATIM for the icon, the shortcut and the Apple touch icon, so the
 * tab (and a home-screen shortcut) carry the operator's own mark. A `null` logo — the fresh-install
 * case, or a value `getApplicationSettings` refused because the file is gone — resolves to the
 * built-in `/favicon.ico`, which is why a missing logo can never produce a broken icon URL.
 */
export function brandingIcons(branding: ApplicationBranding): BrandingIcons {
    const icon = branding.logoUrl ?? DEFAULT_FAVICON_PATH;

    return {
        icon,
        shortcut: icon,
        apple: icon,
    };
}
