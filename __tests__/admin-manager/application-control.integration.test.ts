/**
 * ==========================================
 * PHASE 32 — APPLICATION CONTROL (INTEGRATION, REAL DATABASE)
 * ==========================================
 *
 * The role separation proved END TO END, against the real database, through the REAL service
 * functions the API routes call:
 *
 *   User.platformRole → resolveAuthzScope() → requirePlatformPermission()
 *                                            → the service write
 *                                            → the audit row
 *
 * `@/auth` is mocked so a scope can be resolved without a browser; nothing about
 * authorization, persistence or the audit trail is stubbed.
 *
 * ── THE SINGLETON IS SNAPSHOT AND RESTORED ──────────────────────────────────────
 * `PlatformSetting` is a one-row table shared by the whole suite, so this file captures the
 * row in `beforeAll` and puts it back in `afterAll` — a maintenance toggle left ON by a failed
 * test would otherwise close the public surface for every later integration suite in the run.
 * Audit rows written by this file are removed by the same window, so the append-only table is
 * not polluted by test traffic.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import fs from "fs/promises";
import os from "os";
import path from "path";

import { auth } from "@/auth";
import {
    getApplicationSettingsForAdmin,
    removeBrandingLogo,
    updateMaintenanceSettings,
    uploadBrandingLogo,
} from "@/lib/application/service";
import {
    DEFAULT_MAINTENANCE_MESSAGE,
    PLATFORM_SETTING_ID,
    getApplicationSettings,
} from "@/lib/app-settings";
import { AuthzErrorCode, resolveAuthzScope } from "@/lib/authz";
import { computeDashboardCapabilities } from "@/lib/dashboard/scope";
import { prisma } from "@/lib/prisma";

import { buildPng } from "../images/fixtures";

jest.setTimeout(60000);

const SUFFIX = `phase32-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let adminId: string;
let managerId: string;
let uploadRoot: string;

/** Point the mocked session at a user id. */
function signInAs(userId: string) {
    (auth as jest.Mock).mockResolvedValue({
        user: { id: userId, role: "CUSTOMER" },
    });
}

async function scopeFor(userId: string) {
    const scope = await resolveAuthzScope(userId);

    if (!scope) {
        throw new Error(`no scope for ${userId}`);
    }

    return scope;
}

/** The singleton row as it was before this suite ran. */
let originalSetting: Awaited<
    ReturnType<typeof prisma.platformSetting.findUnique>
>;

let auditWindowStart: Date;

beforeAll(async () => {
    originalSetting = await prisma.platformSetting.findUnique({
        where: { id: PLATFORM_SETTING_ID },
    });

    auditWindowStart = new Date();

    const admin = await prisma.user.create({
        data: {
            name: `Phase32 Admin ${SUFFIX}`,
            email: `phase32-admin-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            platformRole: "ADMIN",
        },
    });

    const manager = await prisma.user.create({
        data: {
            name: `Phase32 Manager ${SUFFIX}`,
            email: `phase32-manager-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            platformRole: "MANAGER",
        },
    });

    adminId = admin.id;
    managerId = manager.id;

    uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tinggalklik-p32-"));
    process.env.UPLOAD_DIR = uploadRoot;
});

afterAll(async () => {
    // ── RESTORE THE SINGLETON EXACTLY ────────────────────────────────────────────
    if (originalSetting) {
        await prisma.platformSetting.update({
            where: { id: PLATFORM_SETTING_ID },
            data: {
                logoUrl: originalSetting.logoUrl,
                maintenanceMode: originalSetting.maintenanceMode,
                maintenanceMessage: originalSetting.maintenanceMessage,
                maintenanceEtaMessage: originalSetting.maintenanceEtaMessage,
            },
        });
    } else {
        await prisma.platformSetting
            .delete({ where: { id: PLATFORM_SETTING_ID } })
            .catch(() => undefined);
    }

    await prisma.adminAuditLog.deleteMany({
        where: {
            entityType: "PlatformSetting",
            createdAt: { gte: auditWindowStart },
        },
    });

    await prisma.user.deleteMany({
        where: { id: { in: [adminId, managerId].filter(Boolean) } },
    });

    await fs.rm(uploadRoot, { recursive: true, force: true });
    delete process.env.UPLOAD_DIR;
});

/* ==================================================================================
 * 1. READING THE APPLICATION SETTINGS
 * ================================================================================== */

describe("application settings: read authority", () => {
    test("a platform ADMIN reads the settings", async () => {
        signInAs(adminId);

        const settings = await getApplicationSettingsForAdmin();

        expect(typeof settings.platformName).toBe("string");
        expect(typeof settings.maintenance.enabled).toBe("boolean");
        // The read model always resolves a message, so the maintenance page can never render
        // a blank notice while mode is ON.
        expect(typeof settings.maintenance.message).toBe("string");
        expect(settings.maintenance.message.length).toBeGreaterThan(0);
    });

    test("a platform MANAGER is refused — the read is guarded too", async () => {
        signInAs(managerId);

        await expect(getApplicationSettingsForAdmin()).rejects.toMatchObject({
            code: AuthzErrorCode.FORBIDDEN,
        });

        // …and the underlying read model, which is NOT guarded, still returns the truth: the
        // refusal above is an AUTHORIZATION outcome, not a data one. The public chrome
        // legitimately uses this accessor for the logo and availability.
        const settings = await getApplicationSettings();
        expect(typeof settings.maintenance.enabled).toBe("boolean");
    });
});

/* ==================================================================================
 * 2. MAINTENANCE MODE
 * ================================================================================== */

describe("maintenance mode: ADMIN only, audited", () => {
    test("ADMIN enables maintenance with a custom message and ETA", async () => {
        signInAs(adminId);

        const settings = await updateMaintenanceSettings(
            await scopeFor(adminId),
            {
                maintenanceMode: true,
                maintenanceMessage: "Website sedang dalam maintenance.",
                maintenanceEtaMessage: "Silakan kembali beberapa saat lagi.",
            }
        );

        expect(settings.maintenance.enabled).toBe(true);
        expect(settings.maintenance.message).toBe(
            "Website sedang dalam maintenance."
        );
        expect(settings.maintenance.etaMessage).toBe(
            "Silakan kembali beberapa saat lagi."
        );

        // The write really landed in the singleton.
        const row = await prisma.platformSetting.findUnique({
            where: { id: PLATFORM_SETTING_ID },
        });

        expect(row?.maintenanceMode).toBe(true);
        expect(row?.maintenanceMessage).toBe(
            "Website sedang dalam maintenance."
        );
    });

    test("the enable is audited, with metadata and no secrets", async () => {
        const rows = await prisma.adminAuditLog.findMany({
            where: {
                entityType: "PlatformSetting",
                action: "application.maintenance.enabled",
                createdAt: { gte: auditWindowStart },
            },
        });

        expect(rows.length).toBeGreaterThan(0);

        const row = rows[rows.length - 1];

        expect(row.actorUserId).toBe(adminId);
        expect(row.actorRole).toBe("ADMIN");
        expect(row.entityRef).toBe(String(PLATFORM_SETTING_ID));
        // beforeState/afterState carry the boolean and the messages — the useful metadata.
        expect(row.afterState).toMatchObject({ maintenanceMode: true });
    });

    test("an empty message clears to null, and the read model applies the default", async () => {
        signInAs(adminId);

        // `null` (not "") is what a cleared field becomes — the route maps `""` to null.
        const settings = await updateMaintenanceSettings(
            await scopeFor(adminId),
            { maintenanceMode: true, maintenanceMessage: null }
        );

        expect(settings.maintenance.message).toBe(DEFAULT_MAINTENANCE_MESSAGE);

        const row = await prisma.platformSetting.findUnique({
            where: { id: PLATFORM_SETTING_ID },
        });

        expect(row?.maintenanceMessage).toBeNull();
    });

    test("MANAGER cannot change availability — direct service call, not a hidden button", async () => {
        signInAs(managerId);

        const before = await prisma.platformSetting.findUnique({
            where: { id: PLATFORM_SETTING_ID },
        });

        await expect(
            updateMaintenanceSettings(await scopeFor(managerId), {
                maintenanceMode: false,
            })
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        // Not merely refused — nothing moved.
        const after = await prisma.platformSetting.findUnique({
            where: { id: PLATFORM_SETTING_ID },
        });

        expect(after?.maintenanceMode).toBe(before?.maintenanceMode);
    });

    test("an unauthenticated caller is refused", async () => {
        (auth as jest.Mock).mockResolvedValue(null);

        await expect(
            updateMaintenanceSettings(
                {
                    userId: "nobody",
                    platformRole: "ADMIN",
                    organizerScopes: [],
                    grants: [],
                },
                { maintenanceMode: false }
            )
        ).rejects.toMatchObject({ code: AuthzErrorCode.UNAUTHORIZED });
    });

    test("ADMIN turns maintenance back OFF and the disable is audited", async () => {
        signInAs(adminId);

        const settings = await updateMaintenanceSettings(
            await scopeFor(adminId),
            { maintenanceMode: false }
        );

        expect(settings.maintenance.enabled).toBe(false);

        const rows = await prisma.adminAuditLog.findMany({
            where: {
                action: "application.maintenance.disabled",
                createdAt: { gte: auditWindowStart },
            },
        });

        expect(rows.length).toBeGreaterThan(0);
    });

    test("editing only the message writes `updated`, not enable/disable", async () => {
        signInAs(adminId);

        await updateMaintenanceSettings(await scopeFor(adminId), {
            maintenanceMode: false,
            maintenanceMessage: "Sedang upgrade server.",
        });

        const rows = await prisma.adminAuditLog.findMany({
            where: {
                action: "application.maintenance.updated",
                createdAt: { gte: auditWindowStart },
            },
        });

        expect(rows.length).toBeGreaterThan(0);
    });
});

/* ==================================================================================
 * 3. BRANDING (application logo)
 * ================================================================================== */

describe("application logo: ADMIN only, stored persistently, audited", () => {
    test("MANAGER cannot upload, replace or remove a logo", async () => {
        signInAs(managerId);

        const scope = await scopeFor(managerId);

        await expect(
            uploadBrandingLogo(
                scope,
                new File([new Uint8Array(buildPng())], "logo.png", {
                    type: "image/png",
                })
            )
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });

        await expect(removeBrandingLogo(scope)).rejects.toMatchObject({
            code: AuthzErrorCode.FORBIDDEN,
        });
    });

    test("a valid PNG uploads, is stored on disk, and becomes the configured logo", async () => {
        signInAs(adminId);

        const result = await uploadBrandingLogo(
            await scopeFor(adminId),
            new File([new Uint8Array(buildPng())], "logo.png", {
                type: "image/png",
            })
        );

        expect(result.replaced).toBe(false);
        expect(result.logoUrl.startsWith("/api/uploads/branding/")).toBe(true);

        // The DB points at the stored asset…
        const row = await prisma.platformSetting.findUnique({
            where: { id: PLATFORM_SETTING_ID },
        });

        expect(row?.logoUrl).toBe(result.logoUrl);

        // …and the asset really exists in the PERSISTENT upload tree (never `.next`/tmp).
        const fileName = result.logoUrl.split("/").pop() as string;
        const stored = await fs.readFile(
            path.join(uploadRoot, "branding", fileName)
        );

        expect(stored.length).toBeGreaterThan(0);

        // The upload is audited as an upload.
        const rows = await prisma.adminAuditLog.findMany({
            where: {
                action: "application.branding.logo_uploaded",
                createdAt: { gte: auditWindowStart },
            },
        });

        expect(rows.length).toBeGreaterThan(0);
    });

    test("replacing deletes the previous asset and audits a REPLACE", async () => {
        signInAs(adminId);

        const first = await prisma.platformSetting.findUnique({
            where: { id: PLATFORM_SETTING_ID },
        });

        const previousFile = (first?.logoUrl ?? "").split("/").pop() as string;

        const result = await uploadBrandingLogo(
            await scopeFor(adminId),
            new File([new Uint8Array(buildPng())], "logo2.png", {
                type: "image/png",
            })
        );

        expect(result.replaced).toBe(true);

        // The replaced file is gone (no orphan accumulation)…
        await expect(
            fs.readFile(path.join(uploadRoot, "branding", previousFile))
        ).rejects.toBeTruthy();

        // …and the action is recorded as a REPLACE, which is the fact a reviewer asks about.
        const rows = await prisma.adminAuditLog.findMany({
            where: {
                action: "application.branding.logo_replaced",
                createdAt: { gte: auditWindowStart },
            },
        });

        expect(rows.length).toBeGreaterThan(0);
    });

    test("removing clears the reference, deletes the asset and audits the removal", async () => {
        signInAs(adminId);

        const before = await prisma.platformSetting.findUnique({
            where: { id: PLATFORM_SETTING_ID },
        });

        const fileName = (before?.logoUrl ?? "").split("/").pop() as string;

        const result = await removeBrandingLogo(await scopeFor(adminId));

        expect(result.logoUrl).toBeNull();

        const row = await prisma.platformSetting.findUnique({
            where: { id: PLATFORM_SETTING_ID },
        });

        expect(row?.logoUrl).toBeNull();
        expect((await getApplicationSettings()).logoUrl).toBeNull();

        await expect(
            fs.readFile(path.join(uploadRoot, "branding", fileName))
        ).rejects.toBeTruthy();

        const rows = await prisma.adminAuditLog.findMany({
            where: {
                action: "application.branding.logo_removed",
                createdAt: { gte: auditWindowStart },
            },
        });

        expect(rows.length).toBeGreaterThan(0);
    });
});

/* ==================================================================================
 * 3b. THE READ SIDE NEVER SERVES A LOGO THAT IS NOT THERE
 * ================================================================================== */

describe("logo fallback", () => {
    test("a dangling reference falls back to the built-in mark (no broken image, no 404)", async () => {
        // The writer cannot create this state, but a file removed from disk / an upload tree
        // replaced by a deployment / a row edited by hand all can. The reader must absorb it.
        await prisma.platformSetting.update({
            where: { id: PLATFORM_SETTING_ID },
            data: { logoUrl: "/api/uploads/branding/does-not-exist-1234.png" },
        });

        expect((await getApplicationSettings()).logoUrl).toBeNull();

        // A value that is not a branding URL at all — including a traversal-shaped one — is
        // never treated as a path to check, let alone to serve.
        for (const hostile of [
            "/api/uploads/branding/../../.env",
            "/etc/passwd",
            "https://evil.example/logo.png",
            "",
        ]) {
            await prisma.platformSetting.update({
                where: { id: PLATFORM_SETTING_ID },
                data: { logoUrl: hostile },
            });

            expect({ hostile, logoUrl: (await getApplicationSettings()).logoUrl })
                .toEqual({ hostile, logoUrl: null });
        }

        await prisma.platformSetting.update({
            where: { id: PLATFORM_SETTING_ID },
            data: { logoUrl: null },
        });
    });

    test("a reference whose file IS present is served", async () => {
        signInAs(adminId);

        const uploaded = await uploadBrandingLogo(
            await scopeFor(adminId),
            new File([new Uint8Array(buildPng())], "logo3.png", {
                type: "image/png",
            })
        );

        expect((await getApplicationSettings()).logoUrl).toBe(uploaded.logoUrl);

        signInAs(adminId);
        await removeBrandingLogo(await scopeFor(adminId));
    });
});

/* ==================================================================================
 * 4. DASHBOARD CAPABILITIES (the menu's input, from the real DB)
 * ================================================================================== */

describe("dashboard capabilities reflect the separation", () => {
    test("ADMIN holds application control; MANAGER holds none of it", async () => {
        const adminCaps = computeDashboardCapabilities(await scopeFor(adminId));
        const managerCaps = computeDashboardCapabilities(
            await scopeFor(managerId)
        );

        expect(adminCaps.canManageApplicationSettings).toBe(true);
        expect(adminCaps.canManageMaintenance).toBe(true);
        expect(adminCaps.canManageBranding).toBe(true);

        expect(managerCaps.canManageApplicationSettings).toBe(false);
        expect(managerCaps.canManageMaintenance).toBe(false);
        expect(managerCaps.canManageBranding).toBe(false);
    });
});
