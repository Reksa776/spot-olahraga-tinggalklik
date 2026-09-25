import {
    PERMISSIONS,
    requirePlatformPermission,
    type AuthzScope,
} from "@/lib/authz";
import {
    PLATFORM_SETTING_ID,
    getApplicationSettings,
    type ApplicationSettings,
} from "@/lib/app-settings";
import {
    brandingLogoFileNameFromUrl,
    deleteStoredBrandingLogo,
    storeBrandingLogo,
    type StoredBrandingLogo,
} from "@/lib/branding/logo";
import { prisma } from "@/lib/prisma";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";

import type { MaintenanceSettingsInput } from "./validation";

/**
 * ==========================================
 * PHASE 32 — APPLICATION CONTROL (ADMIN ONLY)
 * ==========================================
 *
 * The writes an application owner may make about the APPLICATION: its availability
 * (maintenance mode) and its identity (the logo). Both are platform-scope, and every
 * function here begins with the authorization guard that the API route also runs — defence
 * in depth, because a route is not the only possible caller (a future server action or job
 * would call the same function, and it must be just as refused).
 *
 * ── WHY THE GUARD IS HERE AND NOT ONLY IN THE ROUTE ─────────────────────────────
 * `requirePlatformPermission("maintenance.manage")` resolves from `lib/authz`'s
 * platform-role map, where only ADMIN holds it. A MANAGER who calls the endpoint directly —
 * with a valid session, a correct CSRF token and a well-formed body — is refused by the
 * SAME decision function the dashboard menu consults. Hiding the menu row is therefore a
 * courtesy on top of the control, never the control itself (brief §3/§9/§21).
 *
 * ── AUDIT (§22) ────────────────────────────────────────────────────────────────
 * Every mutation writes an audit row. What is recorded is deliberately metadata only:
 * the boolean, the messages, the stored file NAME and its content type and size. Never the
 * image bytes, never a path outside the generated name, never a credential. (The audit
 * writer additionally strips a forbidden-key list — see `lib/ticketing/audit-log.ts`.)
 * The maintenance rows use the fire-and-forget writer, matching every other non-money
 * action in this codebase: an audit failure must not roll back a legitimate availability
 * change, and a failed audit write is logged loudly instead.
 */

/** The application configuration, for an actor allowed to see it. */
export async function getApplicationSettingsForAdmin(): Promise<ApplicationSettings> {
    await requirePlatformPermission(PERMISSIONS.APPLICATION_SETTINGS);

    return getApplicationSettings();
}

/**
 * Set maintenance availability and/or its message.
 *
 * Revision-safe: the mode, the message and the ETA are written in ONE upsert, so an ADMIN
 * cannot enable maintenance and leave a stale notice by submitting two requests in the
 * wrong order. An omitted message field leaves the stored value untouched; `null` clears it.
 */
export async function updateMaintenanceSettings(
    scope: AuthzScope,
    input: MaintenanceSettingsInput,
    request?: Request
): Promise<ApplicationSettings> {
    await requirePlatformPermission(PERMISSIONS.MAINTENANCE_MANAGE);

    const before = await prisma.platformSetting.findUnique({
        where: { id: PLATFORM_SETTING_ID },
        select: {
            maintenanceMode: true,
            maintenanceMessage: true,
            maintenanceEtaMessage: true,
        },
    });

    const beforeMode = before?.maintenanceMode ?? false;

    const messageUpdate =
        input.maintenanceMessage === undefined
            ? {}
            : { maintenanceMessage: input.maintenanceMessage || null };

    const etaUpdate =
        input.maintenanceEtaMessage === undefined
            ? {}
            : { maintenanceEtaMessage: input.maintenanceEtaMessage || null };

    await prisma.platformSetting.upsert({
        where: { id: PLATFORM_SETTING_ID },
        create: {
            id: PLATFORM_SETTING_ID,
            maintenanceMode: input.maintenanceMode,
            maintenanceMessage: input.maintenanceMessage || null,
            maintenanceEtaMessage: input.maintenanceEtaMessage || null,
        },
        update: {
            maintenanceMode: input.maintenanceMode,
            ...messageUpdate,
            ...etaUpdate,
        },
    });

    const after = await prisma.platformSetting.findUnique({
        where: { id: PLATFORM_SETTING_ID },
        select: {
            maintenanceMode: true,
            maintenanceMessage: true,
            maintenanceEtaMessage: true,
        },
    });

    await writeTicketingAudit({
        action:
            beforeMode === input.maintenanceMode
                ? "application.maintenance.updated"
                : input.maintenanceMode
                  ? "application.maintenance.enabled"
                  : "application.maintenance.disabled",
        actor: scope,
        entityType: "PlatformSetting",
        entityRef: String(PLATFORM_SETTING_ID),
        description: input.maintenanceMode
            ? "Maintenance mode diaktifkan."
            : beforeMode
              ? "Maintenance mode dimatikan."
              : "Pengaturan maintenance diperbarui.",
        beforeState: before
            ? {
                  maintenanceMode: before.maintenanceMode,
                  maintenanceMessage: before.maintenanceMessage,
                  maintenanceEtaMessage: before.maintenanceEtaMessage,
              }
            : null,
        afterState: after
            ? {
                  maintenanceMode: after.maintenanceMode,
                  maintenanceMessage: after.maintenanceMessage,
                  maintenanceEtaMessage: after.maintenanceEtaMessage,
              }
            : null,
        request,
    });

    return getApplicationSettings();
}

/**
 * Upload a new logo and make it the configured branding.
 *
 * The order is fixed and matters: validate + store the new asset FIRST, then point the
 * database at it, and only then delete the asset it replaced. A failure at any earlier step
 * leaves the previous logo configured and untouched, and the only recoverable state is
 * "branding unchanged" — never "branding points at a file that does not exist".
 */
export async function uploadBrandingLogo(
    scope: AuthzScope,
    file: File,
    request?: Request
): Promise<{ logoUrl: string; replaced: boolean }> {
    await requirePlatformPermission(PERMISSIONS.BRANDING_MANAGE);

    const stored = await storeBrandingLogo(file);

    return applyBrandingLogo(scope, stored, request);
}

/** Remove the configured logo, falling back to the built-in brand mark. */
export async function removeBrandingLogo(
    scope: AuthzScope,
    request?: Request
): Promise<{ logoUrl: null }> {
    await requirePlatformPermission(PERMISSIONS.BRANDING_MANAGE);

    const before = await prisma.platformSetting.findUnique({
        where: { id: PLATFORM_SETTING_ID },
        select: { logoUrl: true },
    });

    await prisma.platformSetting.upsert({
        where: { id: PLATFORM_SETTING_ID },
        create: { id: PLATFORM_SETTING_ID, logoUrl: null },
        update: { logoUrl: null },
    });

    const previous = before?.logoUrl ?? null;

    // Remove the file only AFTER the database has stopped referencing it, so a failure to
    // unlink can never leave the platform pointing at a missing asset. Deleting a file that
    // another surface is still serving is acceptable; serving a 404 from the DB is not.
    const previousFile = previous
        ? brandingLogoFileNameFromUrl(previous)
        : null;

    if (previousFile) {
        await deleteStoredBrandingLogo(previousFile);
    }

    await writeTicketingAudit({
        action: "application.branding.logo_removed",
        actor: scope,
        entityType: "PlatformSetting",
        entityRef: String(PLATFORM_SETTING_ID),
        description: "Logo aplikasi dihapus; kembali ke brand bawaan.",
        beforeState: { logoConfigured: Boolean(previous) },
        afterState: { logoConfigured: false },
        request,
    });

    return { logoUrl: null };
}

/**
 * Shared tail of the branding writes: point the singleton at the new asset, then dispose of
 * the one it replaced and record the change.
 */
async function applyBrandingLogo(
    scope: AuthzScope,
    stored: StoredBrandingLogo,
    request?: Request
): Promise<{ logoUrl: string; replaced: boolean }> {
    const before = await prisma.platformSetting.findUnique({
        where: { id: PLATFORM_SETTING_ID },
        select: { logoUrl: true },
    });

    const previous = before?.logoUrl ?? null;

    await prisma.platformSetting.upsert({
        where: { id: PLATFORM_SETTING_ID },
        create: { id: PLATFORM_SETTING_ID, logoUrl: stored.url },
        update: { logoUrl: stored.url },
    });

    const previousFile = previous
        ? brandingLogoFileNameFromUrl(previous)
        : null;

    if (previousFile && previousFile !== stored.fileName) {
        await deleteStoredBrandingLogo(previousFile);
    }

    await writeTicketingAudit({
        action: previous
            ? "application.branding.logo_replaced"
            : "application.branding.logo_uploaded",
        actor: scope,
        entityType: "PlatformSetting",
        entityRef: String(PLATFORM_SETTING_ID),
        description: previous
            ? "Logo aplikasi diganti."
            : "Logo aplikasi diunggah.",
        beforeState: { logoConfigured: Boolean(previous) },
        afterState: {
            logoConfigured: true,
            fileName: stored.fileName,
            contentType: stored.contentType,
            size: stored.size,
            removedMetadata: stored.removedMetadata,
        },
        request,
    });

    return { logoUrl: stored.url, replaced: Boolean(previous) };
}
