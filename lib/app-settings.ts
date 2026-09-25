import { cache } from "react";

import { brandingLogoExists } from "@/lib/branding/logo";
import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * PHASE 32 — APPLICATION SETTINGS (READ MODEL)
 * ==========================================
 *
 * The ONE place the application reads its own configuration. Before this module the
 * `PlatformSetting` model existed (Phase 2) and was read directly by
 * `lib/ticketing/reservations.ts` for `reservationTtlMinutes`; every other field —
 * including `platformName` and `logoUrl` — had no reader at all.
 *
 * ── WHY `PlatformSetting` AND NOT A NEW MODEL ────────────────────────────────────
 * The brief (§8) says to reuse the existing platform settings model if one exists. It
 * does: `PlatformSetting` is a single-row platform configuration (`id = 1`) whose own
 * schema comment calls it exactly that, and the Phase 32 migration added
 * `maintenanceMode` / `maintenanceMessage` / `maintenanceEtaMessage` to it additively.
 * `logoUrl` was already modelled there. `StoreSetting` — the OTHER singleton — is the
 * legacy retail store row: it carries a shipping-era address block and is read only by
 * the public legal pages through `lib/store-settings.ts`. Writing application control
 * into the retail row would have meant the branding of a ticketing platform lives in a
 * table named "store", so the ticketing platform row is used instead.
 *
 * ── FAIL-SAFE DEFAULTS, NEVER A HARDCODED STATE ──────────────────────────────────
 * `PlatformSetting` is a singleton that a fresh deployment may not have inserted yet
 * (nothing in the bootstrap seeds it — see `prisma/seed-organizer.ts`). Every read here
 * therefore has a defined answer when the row is absent: maintenance OFF and no logo.
 * That is deliberate and is the opposite of "hardcoding maintenance state in code":
 * the state lives in the database when it exists, and when it does not exist the
 * application is available and unbranded, which is exactly the pre-Phase-32 behaviour.
 * A deployment can never appear "stuck in maintenance" because a row is missing.
 *
 * ── WHY THE READ IS REQUEST-CACHED ───────────────────────────────────────────────
 * The root layout, the ticketing header, the footer and the dashboard shell all ask the
 * same question within one render. React's `cache()` collapses those into a single query
 * per request. Outside a React render (a route handler, a test) `cache()` is a plain
 * pass-through — it does NOT memoize across requests, so a maintenance toggle is visible
 * on the very next request rather than up to a TTL later.
 */

/** The `PlatformSetting` singleton row id (`Int @id @default(1)`). */
export const PLATFORM_SETTING_ID = 1;

/** Built-in wording, used only when the operator has not supplied their own. */
export const DEFAULT_MAINTENANCE_MESSAGE = "Website sedang dalam maintenance.";
export const DEFAULT_MAINTENANCE_ETA_MESSAGE =
    "Silakan kembali beberapa saat lagi.";

export type MaintenanceState = {
    /** TRUE means the public surface is closed and only ADMIN may use the dashboard. */
    enabled: boolean;
    /** The operator's message, already resolved to the built-in default when unset. */
    message: string;
    /** Optional "back at …" line. `null` when unset — there is no built-in ETA. */
    etaMessage: string | null;
};

export type ApplicationSettings = {
    platformName: string;
    /**
     * The persistent, DB-backed logo reference (a `platformsetting.logoUrl` value pointing
     * at a stored asset such as `/api/uploads/branding/<generated>.<ext>`), or `null` when
     * no custom logo is configured. NEVER a temporary browser object URL: nothing in this
     * codebase can write one here.
     */
    logoUrl: string | null;
    maintenance: MaintenanceState;
};

const FALLBACK_PLATFORM_NAME = "TinggalKlik.Co";

/**
 * The application's current configuration.
 *
 * One query, one shape, one place to change. Every consumer that only needs part of it
 * (`getApplicationBranding`, `getMaintenanceState`) composes on top of this function
 * rather than issuing its own select, so the defaults exist once.
 */
export const getApplicationSettings = cache(
    async (): Promise<ApplicationSettings> => {
        const row = await prisma.platformSetting
            .findUnique({
                where: { id: PLATFORM_SETTING_ID },
                select: {
                    platformName: true,
                    logoUrl: true,
                    maintenanceMode: true,
                    maintenanceMessage: true,
                    maintenanceEtaMessage: true,
                },
            })
            .catch(() => null);

        if (!row) {
            return {
                platformName: FALLBACK_PLATFORM_NAME,
                logoUrl: null,
                maintenance: {
                    enabled: false,
                    message: DEFAULT_MAINTENANCE_MESSAGE,
                    etaMessage: null,
                },
            };
        }

        /*
         * A logo reference is only SERVED when the asset it names is really there.
         *
         * The writer never creates a dangling reference (it stores the file first and points
         * at it second), so this is a belt-and-braces read-side guarantee against the ways one
         * can still appear — the file removed from disk, the upload tree replaced by a
         * deployment, the row edited by hand. Without it, such a reference would render as a
         * broken image on the landing page and in the dashboard lockup, which is precisely the
         * failure the brief forbids. With it, the reader answers `null` and the built-in mark
         * is drawn: no broken image, no 404, no empty gap.
         *
         * One `fs.access` per request, collapsed by the same `cache()` that collapses the
         * query.
         */
        const logoUrl =
            row.logoUrl && (await brandingLogoExists(row.logoUrl))
                ? row.logoUrl
                : null;

        return {
            platformName: row.platformName || FALLBACK_PLATFORM_NAME,
            logoUrl,
            maintenance: {
                enabled: row.maintenanceMode,
                message:
                    row.maintenanceMessage?.trim() || DEFAULT_MAINTENANCE_MESSAGE,
                etaMessage: row.maintenanceEtaMessage?.trim() || null,
            },
        };
    }
);

/** Just the branding half — the public chrome and the dashboard lockup need this. */
export const getApplicationBranding = cache(
    async (): Promise<{ logoUrl: string | null }> => {
        const settings = await getApplicationSettings();

        return { logoUrl: settings.logoUrl };
    }
);

/** Just the availability half. */
export const getMaintenanceState = cache(
    async (): Promise<MaintenanceState> => {
        const settings = await getApplicationSettings();

        return settings.maintenance;
    }
);
