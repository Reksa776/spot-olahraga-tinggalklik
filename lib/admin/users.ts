import { Prisma } from "@prisma/client";

import { AppError } from "@/lib/api/errors";
import {
    PERMISSIONS,
    requirePlatformPermission,
    type AuthzScope,
} from "@/lib/authz";
import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";

/**
 * ==========================================
 * USER MANAGEMENT V1 (PHASE 33 — ADMIN ONLY)
 * ==========================================
 *
 * The controlled surface for creating and deactivating the two NON-ADMIN operational
 * accounts: MANAGER and PIC. Scope is deliberately narrow — this is not a general user
 * administration system, and it never creates ADMIN accounts (an ADMIN is provisioned
 * out-of-band, by an operator with database access, exactly as the existing deployment's
 * ADMIN was).
 *
 * ── WHY `user.manage` IS THE GUARD ─────────────────────────────────────────────
 * Every entry point funnels through `requirePlatformPermission(PERMISSIONS.USER_MANAGE)`,
 * which only the platform ADMIN role holds. A MANAGER, PIC or CUSTOMER calling any of
 * these functions is refused before a single query runs. `user.manage` is absent from
 * `ADMIN_GRANT_REQUIRED`, so a PermissionGrant cannot manufacture it for another role —
 * the same non-escalability the Phase 32 application-control permissions have.
 *
 * ── FIXED ROLE CHOICES, NEVER A CLIENT-SUPPLIED ROLE ───────────────────────────
 * The role comes from `ManagedRole` — a two-value union, parsed through the Zod enum at
 * the route — and is written into an explicit allow-list. A request body field can
 * therefore choose MANAGER or PIC and nothing else: `platformRole: "ADMIN"` in a body is
 * a validation error, not a value. There is deliberately no permission-editing here
 * either: authority is defined by the role maps in `lib/authz/permissions.ts`, not by
 * per-user rows this surface could write.
 *
 * ── ACCOUNT STATUS: `disabledAt`, THE SINGLE STATUS FIELD ─────────────────────
 * `User` had no active/disabled column before this phase (the schema audit confirmed
 * it — suspension lived only on `PICProfile.status` and `OrganizerMember.status`). A
 * single nullable `disabledAt` is added additively: NULL = active. No second status
 * field is introduced and no user is ever deleted: deactivation is reversible, and the
 * login path refuses a disabled account so the flag is real at every entry point.
 *
 * ── MANAGER OPERATIONAL SCOPE (PHASE 38) ─────────────────────────────────────
 * The platform role map already grants MANAGER the FULL operational organizer
 * capability (`PLATFORM_ROLE_ORGANIZER_PERMISSIONS.MANAGER`); but the intersection
 * rule (D-05) makes every tenant-scoped permission require an ACTIVE OrganizerMember
 * row, and a freshly created MANAGER has none — which is why its dashboard previously
 * opened to an honest but empty "Belum Ada Organisasi" state.
 *
 * Because the launch architecture is single-organizer, creating a MANAGER account now
 * ALSO provisions its operational scope through that EXISTING mechanism: an ACTIVE
 * `OrganizerMember` with role MANAGER in the organisers the platform owns (resolved
 * as `Organizer` rows in which a non-disabled platform ADMIN holds an ACTIVE OWNER
 * membership — the same anchor the bootstrap `prisma/seed-organizer.ts` uses). This is
 * not a new assignment system and it is not a membership creation surface: no API,
 * route body or client value contributes an `organizerId`, application control
 * (settings/branding/maintenance/users) stays ADMIN-only because those are
 * PLATFORM-scope permissions the MANAGER map does not hold, and every tenant read is
 * still re-decided per request against the resolved membership.
 *
 * Fail-closed: when no ACTIVE ADMIN-owned organizer exists the account is still
 * created (so it can be assigned by an operator later through the same membership
 * table) but without a membership — the standing notice remains the honest state.
 * When it exists, every MANAGER created here becomes operational immediately, which
 * is the "login → /dashboard → dashboard operasional seperti ADMIN" flow.
 */

/** The only platform roles this surface can create. Fixed by design (brief §M). */
export const MANAGED_ROLES = ["MANAGER", "PIC"] as const;

export type ManagedRole = (typeof MANAGED_ROLES)[number];

/** The list-row shape. Never a credential, never a hash, never a bank account number. */
const USER_SELECT = {
    id: true,
    name: true,
    email: true,
    phone: true,
    platformRole: true,
    disabledAt: true,
    createdAt: true,
    picProfile: {
        select: { id: true, picCode: true, displayName: true, status: true },
    },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

function toUserPayload(row: UserRow) {
    return {
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        platformRole: row.platformRole,
        disabled: row.disabledAt !== null,
        disabledAt: row.disabledAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        picProfile: row.picProfile
            ? {
                  id: row.picProfile.id,
                  picCode: row.picProfile.picCode,
                  displayName: row.picProfile.displayName,
                  status: row.picProfile.status,
              }
            : null,
    };
}

export type UserPayload = ReturnType<typeof toUserPayload>;

/** How many users are listed per page (the design's standard list cap). */
const LIST_LIMIT = 50;

/**
 * The user list: the two managed roles (and PIC profiles), newest first.
 *
 * ADMIN rows are deliberately excluded from the listing — the surface manages MANAGER and
 * PIC accounts, and V1 must not present ADMIN accounts as editable rows (brief §U). A
 * disabled user stays listed, with its status, so deactivation is visible and reversible.
 */
export async function listManagedUsers(
    _scope: AuthzScope,
    params: { role?: ManagedRole; search?: string; page?: number } = {}
) {
    await requirePlatformPermission(PERMISSIONS.USER_MANAGE);

    const page = Math.max(1, params.page ?? 1);

    const where: Prisma.UserWhereInput = {
        platformRole: { in: params.role ? [params.role] : [...MANAGED_ROLES] },
        ...(params.search
            ? {
                  OR: [
                      { name: { contains: params.search } },
                      { email: { contains: params.search } },
                  ],
              }
            : {}),
    };

    const [rows, total] = await Promise.all([
        prisma.user.findMany({
            where,
            select: USER_SELECT,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * LIST_LIMIT,
            take: LIST_LIMIT,
        }),
        prisma.user.count({ where }),
    ]);

    return {
        items: rows.map(toUserPayload),
        pagination: {
            page,
            limit: LIST_LIMIT,
            total,
            totalPages: Math.ceil(total / LIST_LIMIT),
        },
    };
}

/**
 * Create a MANAGER or PIC account.
 *
 * One transaction writes both records a PIC needs (`User` + `PICProfile`), so an account
 * can never exist as "a PIC" without its profile, or as a profile without an account —
 * which is exactly the invariant the audit found the existing "Tambah PIC" flow could not
 * express (it required a pre-existing account and created only a profile).
 *
 * `platformRole` is set HERE from the validated `ManagedRole`, never from the body
 * verbatim. The password is hashed with the existing auth implementation (bcrypt cost 12,
 * `lib/password.ts`) and never returned, logged or audited.
 */
export async function createManagedUser(
    scope: AuthzScope,
    input: {
        name: string;
        email: string;
        password: string;
        role: ManagedRole;
        phone?: string;
        pic?: { displayName?: string; picCode?: string; defaultFeeRateBp?: number };
    },
    request?: Request
) {
    const authorized = await requirePlatformPermission(PERMISSIONS.USER_MANAGE);

    if (!MANAGED_ROLES.includes(input.role)) {
        // Unreachable through the route's Zod enum; a guard for direct service callers.
        throw AppError.validation("Peran pengguna tidak valid.");
    }

    const email = input.email.trim().toLowerCase();
    const phone = input.phone?.trim() || null;

    const duplicate = await prisma.user.findFirst({
        where: { OR: [{ email }, ...(phone ? [{ phone }] : [])] },
        select: { id: true, email: true, phone: true },
    });

    if (duplicate) {
        throw AppError.conflict("Email atau nomor HP sudah digunakan.", {
            fields: [{ path: "email", message: "Sudah digunakan." }],
        });
    }

    const passwordHash = await hashPassword(input.password);

    const { created, membershipOrganizerIds } = await prisma.$transaction(
        async (tx) => {
            const created = await tx.user.create({
                data: {
                    name: input.name.trim(),
                    email,
                    phone,
                    password: passwordHash,
                    // The role decision is made here, from the fixed union — never from the
                    // request body verbatim, and never from a column default.
                    platformRole: input.role,
                    // The legacy retail column stays a dormant CUSTOMER for every new
                    // back-office account, exactly as `resolveAuthzScope` documents.
                    role: "CUSTOMER",
                },
                select: { id: true },
            });

        let membershipOrganizerIds: string[] = [];

        if (input.role === "PIC") {
            await tx.pICProfile.create({
                data: {
                    userId: created.id,
                    picCode: await resolveManagedPicCode(
                        tx,
                        input.pic?.displayName ?? input.name,
                        input.pic?.picCode
                    ),
                    displayName: input.pic?.displayName?.trim() ?? input.name.trim(),
                    // A freshly minted PIC account starts PENDING, identical to the
                    // existing "link existing account" flow: approval is a separate,
                    // deliberate decision, and an unapproved profile cannot be assigned
                    // to an event (assignPicToEvent refuses non-ACTIVE profiles).
                    status: "PENDING",
                    ...(input.pic?.defaultFeeRateBp === undefined
                        ? {}
                        : { defaultFeeRateBp: input.pic.defaultFeeRateBp }),
                },
                select: { id: true },
            });
        }

        if (input.role === "MANAGER") {
            // PHASE 38 — operational scope through the existing membership mechanism.
            // Provision an ACTIVE MANAGER membership in each platform-owned organizer
            // (actors in which a non-disabled platform ADMIN holds an ACTIVE OWNER
            // membership, per the seed's anchor). Fail-closed: with no such organizer
            // the MANAGER still gets an account but no membership — the standing notice
            // stays the honest state instead of inventing a tenant.
            membershipOrganizerIds = await resolvePlatformOrganizerIds(tx);

            if (membershipOrganizerIds.length > 0) {
                await tx.organizerMember.createMany({
                    data: membershipOrganizerIds.map((organizerId) => ({
                        organizerId,
                        userId: created.id,
                        role: "MANAGER",
                        status: "ACTIVE",
                        invitedByUserId: authorized.userId,
                        invitedAt: new Date(),
                        acceptedAt: new Date(),
                    })),
                });
            }
        }

        return { created, membershipOrganizerIds };
    });

    await writeTicketingAudit({
        action: input.role === "PIC" ? "pic.user.created" : "user.created",
        actor: authorized,
        actorOrganizerId: null,
        organizerId: null,
        entityType: "User",
        entityRef: created.id,
        description: `Akun ${input.role} dibuat: ${input.name.trim()} (${email})`,
        afterState: {
            userId: created.id,
            email,
            platformRole: input.role,
            hasPicProfile: input.role === "PIC",
            membershipOrganizerIds,
        },
        request,
    });

    return { id: created.id, platformRole: input.role };
}

/**
 * The platform-owned organizers — the tenants a created MANAGER becomes operational
 * in. Resolved as every ACTIVE `Organizer` in which a non-disabled platform ADMIN
 * holds an ACTIVE OWNER membership: precisely the organizers the bootstrap seed
 * establishes for the single-organizer launch (D-05), and the same anchor in both
 * code paths so a seed-run and a user-creation cannot pick different tenants.
 *
 * Fail-closed: empty result means the platform has no owned organizer yet, and the
 * MANAGER account is created WITHOUT a membership so no tenant is invented.
 */
async function resolvePlatformOrganizerIds(
    tx: Prisma.TransactionClient
): Promise<string[]> {
    const admins = await tx.user.findMany({
        where: { platformRole: "ADMIN", disabledAt: null },
        select: { id: true },
    });

    if (admins.length === 0) {
        return [];
    }

    const memberships = await tx.organizerMember.findMany({
        where: {
            userId: { in: admins.map((admin) => admin.id) },
            role: "OWNER",
            status: "ACTIVE",
            organizer: { status: "ACTIVE" },
        },
        select: { organizerId: true },
    });

    return [...new Set(memberships.map((membership) => membership.organizerId))];
}

/** Derive a unique PIC code (same rules as `lib/pic/service.ts#resolvePicCode`). */
async function resolveManagedPicCode(
    tx: Prisma.TransactionClient,
    displayName: string,
    requested?: string
): Promise<string> {
    const base = (
        requested ?? displayName.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()
    )
        .toUpperCase()
        .trim();

    if (base.length < 3) {
        throw AppError.validation("Kode PIC minimal 3 karakter.");
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = attempt === 0 ? base : `${base}${attempt + 1}`;

        const clash = await tx.pICProfile.findUnique({
            where: { picCode: candidate },
            select: { id: true },
        });

        if (!clash) {
            return candidate;
        }

        if (requested !== undefined) {
            break;
        }
    }

    throw AppError.conflict("Kode PIC sudah digunakan.", {
        fields: [{ path: "picCode", message: "Sudah digunakan." }],
    });
}

/**
 * Deactivate (disable) a MANAGER or PIC account — reversible, never a delete.
 *
 * The guard is two-sided: the actor must hold `user.manage`, AND the target must be one
 * of the two managed roles. An ADMIN row can therefore never be disabled through this
 * surface, and an ADMIN cannot accidentally lock themselves out of the platform by
 * listing an ADMIN id in the URL.
 */
export async function setManagedUserDisabled(
    scope: AuthzScope,
    userId: string,
    disabled: boolean,
    request?: Request
) {
    const authorized = await requirePlatformPermission(PERMISSIONS.USER_MANAGE);

    const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, platformRole: true, disabledAt: true },
    });

    if (!target) {
        throw AppError.notFound("Pengguna tidak ditemukan.");
    }

    if (
        target.platformRole !== "MANAGER" &&
        target.platformRole !== "PIC"
    ) {
        throw AppError.conflict(
            "Hanya akun MANAGER atau PIC yang dapat dikelola melalui permukaan ini."
        );
    }

    if ((target.disabledAt !== null) === disabled) {
        // Already in the requested state — a no-op success, not an error.
        return { id: target.id, disabled };
    }

    if (target.id === authorized.userId && disabled) {
        throw AppError.conflict("Tidak dapat menonaktifkan akun sendiri.");
    }

    const updated = await prisma.user.update({
        where: { id: target.id },
        data: { disabledAt: disabled ? new Date() : null },
        select: { id: true, disabledAt: true },
    });

    await writeTicketingAudit({
        action: disabled ? "user.disabled" : "user.enabled",
        actor: authorized,
        actorOrganizerId: null,
        organizerId: null,
        entityType: "User",
        entityRef: target.id,
        description: `Akun ${target.platformRole} ${target.name ?? target.email} ${
            disabled ? "dinonaktifkan" : "diaktifkan kembali"
        }`,
        beforeState: { disabled: target.disabledAt !== null },
        afterState: { disabled: updated.disabledAt !== null },
        request,
    });

    return { id: updated.id, disabled: updated.disabledAt !== null };
}
