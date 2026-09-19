import { Prisma } from "@prisma/client";

import { AppError } from "@/lib/api/errors";
import {
    PERMISSIONS,
    requireOrganizerAccess,
    requirePlatformPermission,
    type AuthzScope,
} from "@/lib/authz";
import { slugify } from "@/lib/events/slug";
import { prisma } from "@/lib/prisma";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";

import type {
    AssignPicInput,
    CreatePicInput,
    UpdatePicStatusInput,
} from "./validation";

/**
 * ==========================================
 * PIC SERVICE
 * ==========================================
 *
 * PIC ("Penanggung Jawab / Person In Charge") is the ticketing product's referrer concept. It
 * replaces the retail Affiliate programme, which was deleted with the retail application together
 * with `AffiliateProfile`, `AffiliateConversion`, `AffiliateClick` and `AffiliatePayout`.
 *
 * ── WHY THIS IS NOT A RENAME ─────────────────────────────────────────────────────
 * The retail Affiliate was a different domain object: it converted against `Product` and the
 * retail `Order`, was paid commission on `Order.subtotal`, carried KYC document uploads and had
 * its own payout provider integration. The ticketing domain already had its own, unrelated
 * `PICProfile` / `PICEventAssignment` / `PICAttribution` / `PICFeeLedger` models, designed in
 * Phase 1 and referenced by checkout (`EventOrder.picProfileId`, `PICAttribution`). Renaming the
 * affiliate into "PIC" would have produced the SECOND PIC system the brief forbids.
 *
 * So the affiliate was deleted, and this service gives the ALREADY-EXISTING PIC models the
 * management surface they never had.
 *
 * ── AUTHORITY ───────────────────────────────────────────────────────────────────
 *   create / approve / suspend    → platform-scope `pic.manage` (ADMIN only)
 *   read fee + attribution totals → platform-scope `pic.manage`, plus the platform-scope
 *                                   `pic_attribution.read.all` / `pic_fee.read.all` permissions,
 *                                   which the platform ADMIN role holds
 *   assign to an event            → organizer-scope `pic.assign`, checked against the organizer
 *                                   that OWNS the event (never against a body parameter)
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────────
 * No payouts, no commission ledger writes, no rate defaults. `PICFeeLedger` is append-only and is
 * posted by the settlement work in a later phase; this surface only READS it. Nothing here invents
 * a fee rate: `defaultFeeRateBp` defaults to the schema's `0`, which means "inherit".
 */

const PIC_SELECT = {
    id: true,
    userId: true,
    picCode: true,
    displayName: true,
    status: true,
    defaultFeeRateBp: true,
    canSellAllEvents: true,
    bankName: true,
    bankAccountName: true,
    bankAccountNumber: true,
    taxId: true,
    identityNote: true,
    approvedByUserId: true,
    approvedAt: true,
    suspendedAt: true,
    suspendReason: true,
    createdAt: true,
    updatedAt: true,
    user: { select: { id: true, name: true, email: true, phone: true } },
    _count: { select: { eventAssignments: true, attributions: true, eventOrders: true } },
} satisfies Prisma.PICProfileSelect;

type PicRow = Prisma.PICProfileGetPayload<{ select: typeof PIC_SELECT }>;

function toPicPayload(row: PicRow) {
    return {
        id: row.id,
        userId: row.userId,
        picCode: row.picCode,
        displayName: row.displayName,
        status: row.status,
        defaultFeeRateBp: row.defaultFeeRateBp,
        canSellAllEvents: row.canSellAllEvents,
        bankName: row.bankName,
        bankAccountName: row.bankAccountName,
        bankAccountNumber: row.bankAccountNumber,
        taxId: row.taxId,
        identityNote: row.identityNote,
        approvedAt: row.approvedAt?.toISOString() ?? null,
        suspendedAt: row.suspendedAt?.toISOString() ?? null,
        suspendReason: row.suspendReason,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        account: {
            name: row.user.name,
            email: row.user.email,
            phone: row.user.phone,
        },
        counts: {
            assignments: row._count.eventAssignments,
            attributions: row._count.attributions,
            orders: row._count.eventOrders,
        },
    };
}

export type PicPayload = ReturnType<typeof toPicPayload>;

/**
 * Platform PIC list.
 *
 * Aggregated money figures are read straight off the append-only ledger with `groupBy`, so a PIC's
 * payable total is derived from posted entries rather than from a mutable counter. Nothing here
 * posts entries.
 */
export async function listPicsForAdmin(_scope: AuthzScope) {
    await requirePlatformPermission(PERMISSIONS.PIC_MANAGE);

    const rows = await prisma.pICProfile.findMany({
        select: PIC_SELECT,
        orderBy: [{ status: "asc" }, { displayName: "asc" }],
    });

    const ids = rows.map((row) => row.id);

    const ledger = ids.length
        ? await prisma.pICFeeLedger.groupBy({
              by: ["picProfileId"],
              where: { picProfileId: { in: ids } },
              _sum: { amount: true },
          })
        : [];

    const ledgerByPic = new Map(
        ledger.map((entry) => [entry.picProfileId, entry._sum.amount ?? new Prisma.Decimal(0)])
    );

    return {
        items: rows.map((row) => ({
            ...toPicPayload(row),
            ledgerTotal: (ledgerByPic.get(row.id) ?? new Prisma.Decimal(0)).toFixed(2),
        })),
    };
}

/** Derive a unique PIC code from the display name, or validate a supplied one. */
async function resolvePicCode(
    displayName: string,
    requested: string | undefined,
    excludePicId?: string
): Promise<string> {
    const base = (requested ?? slugify(displayName).replace(/-/g, "").toUpperCase())
        .toUpperCase()
        .trim();

    if (base.length === 0) {
        throw AppError.validation("Kode PIC tidak valid.");
    }

    // A supplied code that is already taken is an error; a DERIVED one gets a numeric suffix,
    // because the operator did not choose it and should not be blocked by someone else's name.
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = attempt === 0 ? base : `${base}${attempt + 1}`;

        const clash = await prisma.pICProfile.findUnique({
            where: { picCode: candidate },
            select: { id: true },
        });

        if (!clash || clash.id === excludePicId) {
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
 * Create a PIC profile for an EXISTING account.
 *
 * The account is resolved by e-mail. This is the model's own definition ("a PIC is a User with a
 * PIC profile") applied literally, and it keeps account creation in one place: this route cannot
 * mint a credential-less user, and it cannot take over an address that is already registered.
 */
export async function createPic(
    scope: AuthzScope,
    input: CreatePicInput,
    request?: Request
) {
    const authorized = await requirePlatformPermission(PERMISSIONS.PIC_MANAGE);

    const account = await prisma.user.findUnique({
        where: { email: input.email },
        select: { id: true, email: true, picProfile: { select: { id: true } } },
    });

    if (!account) {
        throw AppError.validation(
            "Belum ada akun dengan email tersebut. Minta PIC mendaftar akun terlebih dahulu.",
            { fields: [{ path: "email", message: "Akun tidak ditemukan." }] }
        );
    }

    if (account.picProfile) {
        throw AppError.conflict("Akun ini sudah memiliki profil PIC.");
    }

    const picCode = await resolvePicCode(input.displayName, input.picCode);

    const created = await prisma.pICProfile.create({
        data: {
            userId: account.id,
            picCode,
            displayName: input.displayName,
            // Deliberately PENDING: creating a profile is not approving it, and an unapproved
            // profile cannot be assigned to an event.
            status: "PENDING",
            ...(input.defaultFeeRateBp === undefined
                ? {}
                : { defaultFeeRateBp: input.defaultFeeRateBp }),
            ...(input.canSellAllEvents === undefined
                ? {}
                : { canSellAllEvents: input.canSellAllEvents }),
            bankName: input.bankName ?? null,
            bankAccountName: input.bankAccountName ?? null,
            bankAccountNumber: input.bankAccountNumber ?? null,
            taxId: input.taxId ?? null,
            identityNote: input.identityNote ?? null,
        },
        select: PIC_SELECT,
    });

    await writeTicketingAudit({
        action: "pic.create",
        actor: authorized,
        actorOrganizerId: null,
        organizerId: null,
        entityType: "PICProfile",
        entityRef: created.id,
        description: `Profil PIC dibuat: ${created.displayName} (${created.picCode})`,
        afterState: {
            picCode: created.picCode,
            displayName: created.displayName,
            status: created.status,
            defaultFeeRateBp: created.defaultFeeRateBp,
        },
        request,
    });

    return toPicPayload(created);
}

/**
 * Move a PIC between PENDING / ACTIVE / SUSPENDED / REJECTED.
 *
 * `approvedAt` / `approvedByUserId` are written ONLY on approval and cleared when a profile leaves
 * ACTIVE, so an approval stamp can never describe a suspended or rejected profile.
 */
export async function updatePicStatus(
    scope: AuthzScope,
    picId: string,
    input: UpdatePicStatusInput,
    request?: Request
) {
    const authorized = await requirePlatformPermission(PERMISSIONS.PIC_MANAGE);

    const before = await prisma.pICProfile.findUnique({
        where: { id: picId },
        select: PIC_SELECT,
    });

    if (!before) {
        throw AppError.notFound("PIC tidak ditemukan.");
    }

    const isApproval = input.status === "ACTIVE";

    const updated = await prisma.pICProfile.update({
        where: { id: before.id },
        data: {
            status: input.status,
            approvedAt: isApproval ? new Date() : null,
            approvedByUserId: isApproval ? authorized.userId : null,
            suspendedAt: input.status === "SUSPENDED" ? new Date() : null,
            suspendReason:
                input.status === "SUSPENDED" ? (input.reason ?? null) : null,
        },
        select: PIC_SELECT,
    });

    await writeTicketingAudit({
        action: "pic.status.update",
        actor: authorized,
        actorOrganizerId: null,
        organizerId: null,
        entityType: "PICProfile",
        entityRef: before.id,
        description: `Status PIC ${before.displayName}: ${before.status} → ${updated.status}`,
        beforeState: { status: before.status },
        afterState: { status: updated.status, reason: input.reason ?? null },
        request,
    });

    return toPicPayload(updated);
}

/**
 * A PIC's own detail: profile, per-event assignments and the posted fee entries.
 *
 * Requires the platform `pic.manage` permission because this is the operator's view of someone
 * else's earnings. A PIC reading their own figures is a separate own-scope endpoint
 * (`pic_fee.read.own`), which is not part of this surface.
 */
export async function getPicDetail(scope: AuthzScope, picId: string) {
    await requirePlatformPermission(PERMISSIONS.PIC_MANAGE);

    const pic = await prisma.pICProfile.findUnique({
        where: { id: picId },
        select: PIC_SELECT,
    });

    if (!pic) {
        throw AppError.notFound("PIC tidak ditemukan.");
    }

    const [assignments, ledger] = await Promise.all([
        prisma.pICEventAssignment.findMany({
            where: { picProfileId: pic.id },
            select: {
                id: true,
                eventId: true,
                organizerId: true,
                feeRateBp: true,
                feeTypeOverride: true,
                assignedAt: true,
                revokedAt: true,
                isActive: true,
                event: { select: { title: true, slug: true, status: true } },
            },
            orderBy: [{ createdAt: "desc" }],
            take: 100,
        }),
        prisma.pICFeeLedger.findMany({
            where: { picProfileId: pic.id },
            select: {
                id: true,
                type: true,
                direction: true,
                amount: true,
                currency: true,
                status: true,
                createdAt: true,
            },
            orderBy: [{ createdAt: "desc" }],
            take: 100,
        }),
    ]);

    return {
        pic: toPicPayload(pic),
        assignments: assignments.map((assignment) => ({
            id: assignment.id,
            eventId: assignment.eventId,
            organizerId: assignment.organizerId,
            eventTitle: assignment.event.title,
            eventSlug: assignment.event.slug,
            eventStatus: assignment.event.status,
            feeRateBp: assignment.feeRateBp,
            feeTypeOverride: assignment.feeTypeOverride,
            assignedAt: assignment.assignedAt.toISOString(),
            revokedAt: assignment.revokedAt?.toISOString() ?? null,
            isActive: assignment.isActive,
        })),
        ledger: ledger.map((entry) => ({
            id: entry.id,
            type: entry.type,
            direction: entry.direction,
            amount: entry.amount.toFixed(2),
            currency: entry.currency,
            status: entry.status,
            createdAt: entry.createdAt.toISOString(),
        })),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Organizer side — assignment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The assignment surface for one organizer.
 *
 * Returns the organizer's events, the PICs that may be assigned to them, and the current
 * assignments. The PIC list is the set of ACTIVE profiles — an unapproved or suspended PIC is not
 * assignable — and the event list is scoped to the organizer by `requireOrganizerAccess`, so a
 * member of organizer A cannot even enumerate organizer B's events here.
 */
export async function listOrganizerPicAssignments(
    scope: AuthzScope,
    organizerId: string
) {
    await requireOrganizerAccess(organizerId, PERMISSIONS.PIC_ASSIGN);

    const [assignments, events, pics] = await Promise.all([
        prisma.pICEventAssignment.findMany({
            where: { organizerId },
            select: {
                id: true,
                picProfileId: true,
                eventId: true,
                feeRateBp: true,
                feeTypeOverride: true,
                assignedAt: true,
                revokedAt: true,
                isActive: true,
                picProfile: { select: { displayName: true, picCode: true, status: true } },
                event: { select: { title: true, slug: true, status: true } },
            },
            orderBy: [{ createdAt: "desc" }],
            take: 200,
        }),
        prisma.event.findMany({
            where: { organizerId },
            select: { id: true, title: true, slug: true, status: true },
            orderBy: [{ startAt: "desc" }],
            take: 200,
        }),
        prisma.pICProfile.findMany({
            where: { status: "ACTIVE" },
            select: { id: true, displayName: true, picCode: true },
            orderBy: [{ displayName: "asc" }],
            take: 200,
        }),
    ]);

    return {
        organizerId,
        assignments: assignments.map((assignment) => ({
            id: assignment.id,
            picProfileId: assignment.picProfileId,
            picName: assignment.picProfile.displayName,
            picCode: assignment.picProfile.picCode,
            picStatus: assignment.picProfile.status,
            eventId: assignment.eventId,
            eventTitle: assignment.event.title,
            eventSlug: assignment.event.slug,
            eventStatus: assignment.event.status,
            feeRateBp: assignment.feeRateBp,
            feeTypeOverride: assignment.feeTypeOverride,
            assignedAt: assignment.assignedAt.toISOString(),
            revokedAt: assignment.revokedAt?.toISOString() ?? null,
            isActive: assignment.isActive,
        })),
        events: events.map((event) => ({
            id: event.id,
            title: event.title,
            slug: event.slug,
            status: event.status,
        })),
        pics: pics.map((pic) => ({
            id: pic.id,
            displayName: pic.displayName,
            picCode: pic.picCode,
        })),
    };
}

/**
 * Assign a PIC to one of the organizer's events.
 *
 * Authorization is two-sided and neither side is a request parameter:
 *
 *   1. the actor must hold `pic.assign` for the organizer that OWNS the event — the event is looked
 *      up first and its `organizerId` is the authority scope, so an actor cannot assign against
 *      their own tenant while naming another tenant's event;
 *   2. the PIC must be ACTIVE, so a pending or suspended profile cannot be attached to a sale.
 *
 * A previously revoked assignment is REACTIVATED rather than duplicated, because the schema makes
 * `(picProfileId, eventId)` unique — the same pairing can only ever be one row.
 */
export async function assignPicToEvent(
    scope: AuthzScope,
    input: AssignPicInput,
    request?: Request
) {
    const event = await prisma.event.findUnique({
        where: { id: input.eventId },
        select: { id: true, organizerId: true, title: true },
    });

    // A missing event and a foreign event are the same answer: NOT_FOUND. The caller learns nothing
    // about which event ids exist in other tenants.
    if (!event) {
        throw AppError.notFound("Event tidak ditemukan.");
    }

    const authorized = await requireOrganizerAccess(
        event.organizerId,
        PERMISSIONS.PIC_ASSIGN
    );

    const pic = await prisma.pICProfile.findUnique({
        where: { id: input.picProfileId },
        select: { id: true, displayName: true, status: true },
    });

    if (!pic) {
        throw AppError.notFound("PIC tidak ditemukan.");
    }

    if (pic.status !== "ACTIVE") {
        throw AppError.conflict(
            "PIC belum aktif sehingga tidak dapat ditugaskan ke event."
        );
    }

    const existing = await prisma.pICEventAssignment.findUnique({
        where: {
            picProfileId_eventId: {
                picProfileId: pic.id,
                eventId: event.id,
            },
        },
        select: { id: true, revokedAt: true },
    });

    const data = {
        organizerId: event.organizerId,
        feeRateBp: input.feeRateBp ?? null,
        feeTypeOverride: input.feeTypeOverride ?? null,
        assignedByUserId: authorized.userId,
        assignedAt: new Date(),
        revokedAt: null,
        isActive: true,
    };

    const assignment = existing
        ? await prisma.pICEventAssignment.update({
              where: { id: existing.id },
              data,
              select: { id: true, picProfileId: true, eventId: true, isActive: true },
          })
        : await prisma.pICEventAssignment.create({
              data: { picProfileId: pic.id, eventId: event.id, ...data },
              select: { id: true, picProfileId: true, eventId: true, isActive: true },
          });

    await writeTicketingAudit({
        action: existing ? "pic.assign.reactivate" : "pic.assign",
        actor: authorized,
        actorOrganizerId: event.organizerId,
        organizerId: event.organizerId,
        entityType: "PICEventAssignment",
        entityRef: assignment.id,
        description: `PIC ${pic.displayName} ditugaskan ke event ${event.title}`,
        afterState: {
            picProfileId: pic.id,
            eventId: event.id,
            feeRateBp: data.feeRateBp,
            feeTypeOverride: data.feeTypeOverride,
        },
        request,
    });

    return assignment;
}

/**
 * Revoke an assignment.
 *
 * Soft, not destructive: `isActive: false` + `revokedAt` preserves the fact that the PIC once
 * covered the event, which matters because attributions and fee entries may already reference that
 * pairing. Deleting the row would orphan that history.
 */
export async function revokePicAssignment(
    scope: AuthzScope,
    assignmentId: string,
    request?: Request
) {
    const assignment = await prisma.pICEventAssignment.findUnique({
        where: { id: assignmentId },
        select: {
            id: true,
            organizerId: true,
            isActive: true,
            picProfile: { select: { displayName: true } },
            event: { select: { title: true } },
        },
    });

    if (!assignment) {
        throw AppError.notFound("Penugasan PIC tidak ditemukan.");
    }

    const authorized = await requireOrganizerAccess(
        assignment.organizerId,
        PERMISSIONS.PIC_ASSIGN
    );

    if (!assignment.isActive) {
        throw AppError.conflict("Penugasan ini sudah dicabut.");
    }

    // WHO revoked it is recorded on the audit row, not on the assignment: the model carries
    // `revokedAt` only (there is no `revokedByUserId` column), and adding one would be a schema
    // change this feature does not need. `writeTicketingAudit` below already names the actor and
    // the tenant, which is where an auditor looks for that answer.
    const updated = await prisma.pICEventAssignment.update({
        where: { id: assignment.id },
        data: {
            isActive: false,
            revokedAt: new Date(),
        },
        select: { id: true, isActive: true, revokedAt: true },
    });

    await writeTicketingAudit({
        action: "pic.assign.revoke",
        actor: authorized,
        actorOrganizerId: assignment.organizerId,
        organizerId: assignment.organizerId,
        entityType: "PICEventAssignment",
        entityRef: assignment.id,
        description: `Penugasan PIC ${assignment.picProfile.displayName} pada event ${assignment.event.title} dicabut`,
        beforeState: { isActive: true },
        afterState: { isActive: false },
        request,
    });

    return updated;
}
