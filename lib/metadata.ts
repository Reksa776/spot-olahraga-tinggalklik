import type { Metadata } from "next";

import type { ApplicationBranding } from "@/lib/app-settings";

/**
 * ==========================================
 * BROWSER TAB TITLE — ONE FORMAT, ONE BRAND SOURCE
 * ==========================================
 *
 * Every page in the application owns a FEATURE title; the root layout owns the brand suffix. That
 * split is what keeps the promise "<Feature> — TinggalKlik.Co" true everywhere without repeating the
 * wordmark in a hundred files:
 *
 *   layout    `title.template` is `%s — <configured platform name>` and `title.default` is the
 *             configured platform name (Next.js requires a default whenever a template is set);
 *   pages     export a short `title` — `"Events"`, `"Detail Pesanan"` — and Next composes it.
 *
 * ── THE BRAND COMES FROM THE DATABASE, NOT FROM THIS FILE ───────────────────────
 * The suffix is built at request time from `getApplicationBranding().platformName`
 * (`PlatformSetting.platformName`, already resolved to its built-in default). Renaming the platform
 * in the dashboard settings therefore renames the tab, exactly as it already renames the lockup and
 * the favicon — there is no second, hardcoded brand string to drift from it.
 *
 * ── WHY A TITLE IS NEVER BUILT BY HAND ─────────────────────────────────────────
 * `platformTitle` exists for the ONE case the template cannot cover: a segment that defines the
 * template cannot itself be templated, so a page that must carry the brand in full (and must ignore
 * an inherited template) returns `title.absolute`. Hand-building `"Events — TinggalKlik.Co"` in a
 * page would hardcode the brand and double the suffix the moment the template applied.
 */

/** The separator between the feature and the brand. Em dash, spaced, on every surface. */
export const TITLE_SEPARATOR = " — ";

/** The complete, already-composed title — used with `title.absolute`. */
export function platformTitle(feature: string, platformName: string): string {
    return `${feature}${TITLE_SEPARATOR}${platformName}`;
}

/** The layout's `title.template`, so the feature a page exports is composed with the brand. */
export function titleTemplate(platformName: string): string {
    return `%s${TITLE_SEPARATOR}${platformName}`;
}

/**
 * The `title` half of the root metadata, resolved from the platform branding.
 *
 * A `template` REQUIRES a `default` (Next.js warns and drops the template otherwise): a route that
 * somehow defines no title of its own still gets the platform name rather than a path-derived title.
 */
export function brandingTitle(branding: ApplicationBranding): Metadata["title"] {
    return {
        default: branding.platformName,
        template: titleTemplate(branding.platformName),
    };
}
