import { Prisma } from "@prisma/client";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { requireOrganizerAccess } from "@/lib/authz/guards";
import {
    PERMISSIONS,
    type AuthzScope,
    type Permission,
} from "@/lib/authz/permissions";
import { resolveOrganizerFilter } from "@/lib/dashboard/scope";
import { prisma } from "@/lib/prisma";

import { writeTicketingAudit } from "../audit-log";
import {
    approveSettlement as approveSettlementCore,
    cancelSettlement as cancelSettlementCore,
    createPreparedSettlement,
    failSettlement as failSettlementCore,
    markSettlementPaid,
    readSettlementPayload,
    submitSettlement as submitSettlementCore,
    type PrepareSettlementOutcome,
} from "./settlement";
import {
    buildSettlementPayload,
    SETTLEMENT_ITEM_SELECT,
    SETTLEMENT_SELECT,
} from "./payload";
import {
    deleteStoredProof,
    readStoredProof,
    storeSettlementProof,
} from "./proof";
import type {
    FailSettlementInput,
    MarkPaidInput,
    PrepareSettlementInput,
    SettlementListQuery,
} from "./validation";

/**
 * ==========================================
 * SETTLEMENT SERVICE — PREPARE, CONTROL, PAY OUT, READ (PICO payout / settlement V1)
 * ==========================================
 *
 * The actor-facing half of the payout lifecycle. The money half lives in
 * `settlement.ts` (the split exists for the same reason the refund lifecycle splits:
 * the transactional core must be reachable without dragging authorization into a money
 * path). This module owns:
 *
 *   * the tenant capability checks — every action funnels through
 *     `requireOrganizerAccess(organizerId, ...)` with the acting organizer RESOLVED
 *     FROM THE ROW (`Settlement.organizerId`), never from the request;
 *   * separation of duties — the preparer never approves and never pays their own
 *     settlement;
 *   * proof-upload evidence handling (magic-byte validated, server-named, protected);
 *   * the read surfaces (list + detail), bank numbers masked.
 *
 * Lifecycle (Option C — manual bank transfer with system control):
 *
 *   DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED ──paid──▶ PAID
 *      │                     │                │
 *      └──cancel──▶ CANCELLED └──cancel──▶ CANCELLED  └──fail──▶ FAILED
 *
 * `paid` is the ONLY action that moves money out of the system, and it can only run from
 * `APPROVED`, only with a recorded proof file and a manual transfer reference, and only
 * by somebody other than the preparer.
 *
 * ── WHY THE ARCHITECTURE-LEVEL PERMISSION MAP IS NOT TOUCHED ─────────────────────
 * `SETTLEMENT_PREPARE` / `SETTLEMENT_APPROVE` / `SETTLEMENT_PROOF_UPLOAD` already exist,
 * are already tenant-scoped, and already appear on MANAGER/FINANCE by role (with
 * ADMIN/OWNER governed by the membership grant policy D-19). V1 consumes those
 * permissions as-they-are; no map is weakened and platform roles inside a tenant stay
 * financial-unless-granted.
 */

function requireSettlementPermission(
    organizerId: string,
    permission: Permission
): Promise<AuthzScope> {
    return requireOrganizerAccess(organizerId, permission);
}

/** Convert a non-P2002 prepare outcome into a payload, or a retry into a refusal. */
function resolvePrepareOutcome(
    outcome: PrepareSettlementOutcome
): { settlementId: string } {
    if (outcome.outcome === "RETRY_LATER") {
        throw new AppError(ERROR_CODES.CONFLICT, {
            message:
                "Settlement gagal disiapkan karena kontensi database; coba lagi.",
            details: { reason: "SETTLEMENT_CONTENTION" },
        });
    }

    return { settlementId: outcome.settlementId };
}

/** Convert a non-P2002 transition outcome into a payload. */
function resolveTransitionOutcome(
    outcomes: Awaited<ReturnType<typeof submitSettlementCore>>
): { settlementId: string } {
    if (outcomes.outcome === "RETRY_LATER") {
        throw new AppError(ERROR_CODES.CONFLICT, {
            message:
                "Perubahan status settlement gagal karena kontensi database; coba lagi.",
            details: { reason: "SETTLEMENT_CONTENTION" },
        });
    }

    return { settlementId: outcomes.settlementId };
}

/**
 * The tenant-scoped read guard for a single settlement: same decider as the list, but
 * against the row's OWN `organizerId` (which is the row's factual tenant, never a
 * client value).
 */
function refuseIfNotReadable(scope: AuthzScope, organizerId: string): void {
    requireOrganizerAccess(organizerId, PERMISSIONS.SETTLEMENT_PREPARE);
}

/**
 * `POST /api/organizer/settlements` — prepare a DRAFT payout for a PIC and a period.
 */
export async function prepareSettlement(
    input: PrepareSettlementInput,
    actor: AuthzScope
): Promise<ReturnType<typeof buildSettlementPayload>> {
    await requireSettlementPermission(input.organizerId, PERMISSIONS.SETTLEMENT_PREPARE);

    const outcome = await createPreparedSettlement({
        organizerId: input.organizerId,
        picProfileId: input.picProfileId,
        periodStart: new Date(input.periodStart),
        periodEnd: new Date(input.periodEnd),
        notes: input.notes ?? null,
        actor,
    });

    const { settlementId } = resolvePrepareOutcome(outcome);

    return readSettlementPayload(settlementId);
}

/**
 * `POST /api/organizer/settlements/[id]/submit` — `DRAFT → PENDING_APPROVAL`.
 */
export async function submitSettlement(
    settlementId: string,
    actor: AuthzScope
): Promise<ReturnType<typeof buildSettlementPayload>> {
    const row = await prisma.settlement.findUniqueOrThrow({
        where: { id: settlementId },
        select: { organizerId: true },
    });

    if (!row.organizerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Settlement tidak ditemukan.",
        });
    }

    await requireSettlementPermission(row.organizerId, PERMISSIONS.SETTLEMENT_PREPARE);

    const outcome = await submitSettlementCore(settlementId, actor);

    return readSettlementPayload(
        resolveTransitionOutcome(outcome).settlementId
    );
}

/**
 * `POST /api/organizer/settlements/[id]/approve` — `PENDING_APPROVAL → APPROVED`
 * with separation of duties: the preparer may never approve their own settlement.
 */
export async function approveSettlement(
    settlementId: string,
    actor: AuthzScope
): Promise<ReturnType<typeof buildSettlementPayload>> {
    const row = await prisma.settlement.findUniqueOrThrow({
        where: { id: settlementId },
        select: { organizerId: true, preparedByUserId: true, status: true },
    });

    if (!row.organizerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Settlement tidak ditemukan.",
        });
    }

    await requireSettlementPermission(row.organizerId, PERMISSIONS.SETTLEMENT_APPROVE);

    if (row.preparedByUserId === actor.userId) {
        throw new AppError(ERROR_CODES.FORBIDDEN, {
            message:
                "Penyusun settlement tidak dapat menyetujui penyusunannya sendiri.",
            details: { reason: "SEPARATION_OF_DUTIES" },
        });
    }

    const outcome = await approveSettlementCore(settlementId, actor);

    return readSettlementPayload(
        resolveTransitionOutcome(outcome).settlementId
    );
}

/**
 * `POST /api/organizer/settlements/[id]/paid` — record the MANUAL BANK TRANSFER and
 * move the money, with the same SoD as approval.
 */
export async function paySettlement(
    settlementId: string,
    input: MarkPaidInput,
    actor: AuthzScope
): Promise<ReturnType<typeof buildSettlementPayload>> {
    const row = await prisma.settlement.findUniqueOrThrow({
        where: { id: settlementId },
        select: { organizerId: true, preparedByUserId: true },
    });

    if (!row.organizerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Settlement tidak ditemukan.",
        });
    }

    await requireSettlementPermission(row.organizerId, PERMISSIONS.SETTLEMENT_APPROVE);

    if (row.preparedByUserId === actor.userId) {
        throw new AppError(ERROR_CODES.FORBIDDEN, {
            message:
                "Penyusun settlement tidak dapat menandai pembayarannya sendiri.",
            details: { reason: "SEPARATION_OF_DUTIES" },
        });
    }

    const outcome = await markSettlementPaid(
        settlementId,
        {
            providerReference: input.providerReference,
            note: input.note ?? null,
            actor,
        },
        new Date()
    );

    if (outcome.outcome === "RETRY_LATER") {
        throw new AppError(ERROR_CODES.CONFLICT, {
            message:
                "Settlement gagal ditandai dibayar karena kontensi database; coba lagi.",
            details: { reason: "SETTLEMENT_CONTENTION" },
        });
    }

    return readSettlementPayload(outcome.settlementId);
}

/**
 * `POST /api/organizer/settlements/[id]/fail` — abandon an APPROVED payout whose
 * transfer did not complete; the claim lines are released.
 */
export async function failSettlement(
    settlementId: string,
    input: FailSettlementInput,
    actor: AuthzScope
): Promise<ReturnType<typeof buildSettlementPayload>> {
    const row = await prisma.settlement.findUniqueOrThrow({
        where: { id: settlementId },
        select: { organizerId: true },
    });

    if (!row.organizerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Settlement tidak ditemukan.",
        });
    }

    await requireSettlementPermission(row.organizerId, PERMISSIONS.SETTLEMENT_APPROVE);

    const outcome = await failSettlementCore(settlementId, input.reason, actor);

    return readSettlementPayload(resolveTransitionOutcome(outcome).settlementId);
}

/**
 * `POST /api/organizer/settlements/[id]/cancel` — back out of a
 * `DRAFT | PENDING_APPROVAL` payout; the claim lines are released.
 */
export async function cancelSettlement(
    settlementId: string,
    actor: AuthzScope
): Promise<ReturnType<typeof buildSettlementPayload>> {
    const row = await prisma.settlement.findUniqueOrThrow({
        where: { id: settlementId },
        select: { organizerId: true },
    });

    if (!row.organizerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Settlement tidak ditemukan.",
        });
    }

    await requireSettlementPermission(row.organizerId, PERMISSIONS.SETTLEMENT_PREPARE);

    const outcome = await cancelSettlementCore(settlementId, actor);

    return readSettlementPayload(resolveTransitionOutcome(outcome).settlementId);
}

/**
 * `POST /api/organizer/settlements/[id]/proof` — store the MANUAL TRANSFER evidence.
 *
 * Only `APPROVED` settlements may take a proof (nothing to prove before approval; a
 * paid settlement is already decided). Re-upload while APPROVED replaces the previous
 * evidence. The bytes are validated and stored by `proof.ts`; the DB link is CASed on
 * `APPROVED` so a concurrent payment cannot be overwritten with a new proof.
 */
export async function recordSettlementProof(
    settlementId: string,
    file: File,
    actor: AuthzScope,
    request?: Request
): Promise<ReturnType<typeof buildSettlementPayload>> {
    const row = await prisma.settlement.findUniqueOrThrow({
        where: { id: settlementId },
        select: {
            organizerId: true,
            status: true,
            settlementNumber: true,
            proofFilePath: true,
        },
    });

    if (!row.organizerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Settlement tidak ditemukan.",
        });
    }

    await requireSettlementPermission(
        row.organizerId,
        PERMISSIONS.SETTLEMENT_PROOF_UPLOAD
    );

    if (row.status !== "APPROVED") {
        throw new AppError(ERROR_CODES.SETTLEMENT_STATE_INVALID, {
            message:
                "Bukti transfer hanya dapat diupload untuk settlement yang disetujui.",
            details: { status: row.status, reason: "NOT_APPROVED" },
        });
    }

    const stored = await storeSettlementProof(file);

    try {
        const cas = await prisma.settlement.updateMany({
            where: { id: settlementId, status: "APPROVED" },
            data: { proofFilePath: stored.fileName },
        });

        if (cas.count !== 1) {
            throw new AppError(ERROR_CODES.SETTLEMENT_STATE_INVALID, {
                message:
                    "Status settlement berubah saat bukti diupload; coba lagi.",
                details: { reason: "STATE_CHANGED" },
            });
        }
    } catch (error) {
        // The DB link failed; do not leave an unreferenced file behind.
        await deleteStoredProof(stored.fileName);
        throw error;
    }

    // The previous evidence is superseded only after the new one is committed.
    await deleteStoredProof(row.proofFilePath);

    await writeTicketingAudit({
        action: "settlement.proof_upload",
        actor,
        actorOrganizerId: row.organizerId,
        organizerId: row.organizerId,
        entityType: "Settlement",
        entityRef: row.settlementNumber,
        description: "Bukti transfer manual diupload.",
        beforeState: { status: "APPROVED" },
        afterState: {
            status: "APPROVED",
            proofSize: stored.size,
            replaced: row.proofFilePath !== null,
        },
        reason: "SETTLEMENT_PROOF_UPLOADED",
        request,
    });

    return readSettlementPayload(settlementId);
}

/**
 * `POST /api/organizer/settlements/[id]/proof/view` — serve the evidence file.
 *
 * Every request re-checks the settlement's tenant + `SETTLEMENT_PROOF_UPLOAD`, exactly
 * like the read path; the filename is reduced to a basename inside `proof.ts`.
 */
export async function readSettlementProof(
    settlementId: string,
    fileName: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
    const row = await prisma.settlement.findUniqueOrThrow({
        where: { id: settlementId },
        select: { organizerId: true, proofFilePath: true },
    });

    if (!row.organizerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Settlement tidak ditemukan.",
        });
    }

    await requireSettlementPermission(
        row.organizerId,
        PERMISSIONS.SETTLEMENT_PROOF_UPLOAD
    );

    // The served file must be EXACTLY the one the settlement row names — never a
    // look-alike path.
    if (row.proofFilePath !== fileName) {
        return null;
    }

    return readStoredProof(fileName);
}

/**
 * `GET /api/organizer/settlements` — tenant-scoped list. Without `organizerId` the
 * scope is every organizer the actor may settle in; with it, the decider must allow it.
 */
export async function listSettlements(
    scope: AuthzScope,
    query: SettlementListQuery
): Promise<{ items: ReturnType<typeof buildSettlementPayload>[]; total: number }> {
    const organizerIds = resolveOrganizerFilter(
        scope,
        PERMISSIONS.SETTLEMENT_PREPARE,
        query.organizerId ?? null
    );

    if (organizerIds.length === 0) {
        return { items: [], total: 0 };
    }

    const where: Prisma.SettlementWhereInput = {
        organizerId: { in: organizerIds },
        ...(query.status ? { status: query.status } : {}),
        ...(query.picProfileId ? { picProfileId: query.picProfileId } : {}),
    };

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [rows, total] = await Promise.all([
        prisma.settlement.findMany({
            where,
            select: SETTLEMENT_SELECT,
            orderBy: [{ createdAt: "desc" }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.settlement.count({ where }),
    ]);

    return {
        items: rows.map((row) => buildSettlementPayload(row)),
        total,
    };
}

/**
 * `GET /api/organizer/settlements/[id]` — one settlement with its claim lines.
 */
export async function getSettlement(
    settlementId: string,
    scope: AuthzScope
): Promise<ReturnType<typeof buildSettlementPayload>> {
    const row = await prisma.settlement.findUnique({
        where: { id: settlementId },
        select: {
            ...SETTLEMENT_SELECT,
            items: { select: SETTLEMENT_ITEM_SELECT },
        },
    });

    if (!row || !row.organizerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Settlement tidak ditemukan.",
        });
    }

    refuseIfNotReadable(scope, row.organizerId);

    return buildSettlementPayload(row);
}