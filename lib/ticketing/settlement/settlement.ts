import crypto from "crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import type { AuthzScope } from "@/lib/authz/permissions";
import { prisma } from "@/lib/prisma";

import { writeTicketingAuditInTx } from "../audit-log";
import { withContentionRetry } from "../db-contention";
import {
    buildSettlementPayload,
    SETTLEMENT_ITEM_SELECT,
    SETTLEMENT_SELECT,
} from "./payload";

/**
 * ==========================================
 * SETTLEMENT TRANSACTIONAL CORE (PICO payout / settlement V1)
 * ==========================================
 *
 * The money half of the payout lifecycle, separated from `service.ts` so the ledger
 * flips are reachable from a context that never touches authorization (the same reason
 * the refund lifecycle keeps `processConfirmedRefund` in `refunds/settlement.ts`).
 * Every transition runs in ONE database transaction, in a fixed order, and any throw
 * rolls the whole transition back — that is what makes "no duplicate state
 * transitions" and "one ledger entry can never be settled twice" DATABASE properties
 * rather than application conventions.
 *
 * ── THE RAIL IS A MANUAL BANK TRANSFER (D-P17-04 = B) ────────────────────────────
 * There is no provider call here and none is missing: iPaymu has no payout endpoint
 * (D-04), so `method` is always `MANUAL_TRANSFER` and `Settlement.providerReference`
 * is the operator's own bank-transfer reference, recorded at `paid`. Nothing in this
 * module may pretend an automatic disbursement happened, and `GATEWAY_SPLIT` is never
 * written (storage-only, D-04).
 *
 * ── THE LEDGER RULE: CREDIT − DEBIT ─────────────────────────────────────────────
 * The PIC's self-service balance is `Σ CREDIT − Σ DEBIT` over the append-only
 * `PICFeeLedger` (see `lib/pic/self-service.ts`). A settlement makes three ledger
 * touches, all of them APPEND/LINK only, all inside the `paid` transaction:
 *
 *   1. the included EARNED rows are flipped `EARNED → SETTLED` and linked to the
 *      settlement (the `settlementId` column the schema documents as "the one the
 *      money code flips");
 *   2. the included REVERSAL rows (already DEBIT) are linked to the settlement;
 *   3. a PAYOUT DEBIT row (type `PAYOUT`, direction `DEBIT`, status `SETTLED`) is
 *      appended for each included EARNED item, equal to that item's net of its
 *      offsetting reversals, keyed `fee:payout:{settlementId}:{earnedId}` — WITHOUT
 *      those DEBIT rows the self-service "Net Fee" would still read as earned (the
 *      money left the system but the ledger would not say so).
 *
 * ── THE ORGANIZER COLUMN ON A PIC SETTLEMENT ────────────────────────────────────
 * The schema doc comment says "exactly one of picProfileId / organizerId is
 * populated". V1 deliberately populates BOTH for `payeeType = PIC`: the row records
 * the payee (picProfileId) AND the accounting tenant that owes the money
 * (organizerId). This is what makes tenant isolation enforceable — an operator's
 * `settlement.prepare`/`settlement.approve` capabilities are per-organizer, and a
 * payload row without the acting tenant could not be scoped by the operator who is
 * allowed to touch it. It is also what the schema's own
 * `@@unique([payeeType, organizerId, periodStart, periodEnd])` and
 * `@@index([organizerId, status])` indexes assume — a PIC that earns in two tenants
 * during the same window must be settleable twice, once per tenant.
 */

export type SettlementTransitionOutcome =
    | { outcome: "DONE"; settlementId: string }
    | { outcome: "ALREADY"; settlementId: string }
    | { outcome: "RETRY_LATER"; settlementId: string; detail: string };

function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2002"
    );
}

/** `STL-{epochMillis}-{8 hex}`. Unique by construction, never reused. */
export function buildSettlementNumber(now: Date = new Date()): string {
    return `STL-${now.getTime()}-${crypto.randomBytes(4).toString("hex")}`;
}

/** Read a settlement row fresh (committed truth) with items for payload building. */
export async function readSettlementPayload(
    settlementId: string,
    db: PrismaClient | Prisma.TransactionClient = prisma
) {
    const row = await db.settlement.findUniqueOrThrow({
        where: { id: settlementId },
        select: {
            ...SETTLEMENT_SELECT,
            items: { select: SETTLEMENT_ITEM_SELECT },
        },
    });

    return buildSettlementPayload(row);
}

/** Delete the claim lines of a settlement that will not pay out. */
export async function releaseSettlementItems(
    tx: Prisma.TransactionClient,
    settlementId: string
): Promise<void> {
    await tx.settlementItem.deleteMany({ where: { settlementId } });
}

/**
 * One line a prepared settlement claims. `picFeeLedgerId` is set exactly when the line
 * OWNS the ledger row; it is what the paid transaction flips.
 */
type PreparedItem = {
    picFeeLedgerId: string;
    orderId: string | null;
    amount: Prisma.Decimal;
    direction: "CREDIT" | "DEBIT";
    description: string;
};

/**
 * Build the lines an operator can settle: EVERY consumable EARNED row of the PIC in the
 * window, offset by every consumable REVERSAL row of the same order item.
 *
 * Eligibility (contract from `PIC_PAYOUT_SETTLEMENT_DEEP_AUDIT_REPORT.md` §3/§4):
 *
 *   * an EARNED row is eligible when `type=EARNED`, `status=EARNED`,
 *     `direction=CREDIT`, `settlementId IS NULL` and `createdAt` inside the window;
 *   * per order item, net = EARNED − Σ(reversal DEBIT rows of that order item whose
 *     `settlementId IS NULL`). Full claw-back (net ≤ 0) excludes the item entirely;
 *   * a partial claw-back includes the EARNED line AND the offsetting REVERSAL lines,
 *     which is why a settlement item can carry `direction = DEBIT`.
 *
 * Whatever the writer does today (it only ever reverses a fully refunded whole item,
 * one EARNED + at most one REVERSAL per order item), this selection is written against
 * the ledger's own uniqueness guarantees (`@@unique([orderItemId, type])`), not
 * against patterns that happen to hold.
 */
async function selectSettlementItems(
    tx: Prisma.TransactionClient,
    input: {
        picProfileId: string;
        organizerId: string;
        periodStart: Date;
        periodEnd: Date;
    }
): Promise<{
    items: PreparedItem[];
    gross: Prisma.Decimal;
    deduction: Prisma.Decimal;
    net: Prisma.Decimal;
}> {
    const earnedRows = await tx.pICFeeLedger.findMany({
        where: {
            picProfileId: input.picProfileId,
            organizerId: input.organizerId,
            type: "EARNED",
            direction: "CREDIT",
            status: "EARNED",
            settlementId: null,
            createdAt: { gte: input.periodStart, lte: input.periodEnd },
        },
        orderBy: [{ createdAt: "asc" }],
        select: { id: true, orderId: true, orderItemId: true, amount: true },
    });

    const earnedOrderItemIds = Array.from(
        new Set(
            earnedRows
                .map((row) => row.orderItemId)
                .filter((id): id is string => id !== null)
        )
    );

    // All unsettled REVERSAL rows for this PIC + tenant. They split by the fate of their
    // item's EARNED row:
    //   in-window  — the item has an eligible EARNED row in THIS window, so the reversal
    //                offsets that item right here (net ≤ 0 → the item is skipped and the
    //                rows stay consumable for a future, wider window);
    //   carried    — the item's EARNED was settled by an EARLIER settlement (i.e. the
    //                refund happened AFTER that money was already paid out, D-18/BUG-1).
    //                The post-paid reversal is a deficit that must be netted off the NEXT
    //                payout, so it is consumed here as a deduction.
    //   else       — the item is not yet settled and its EARNED is outside this window;
    //                neither set applies, and the reversal waits for the window that
    //                eventually settles that item.
    const reversalRows = await tx.pICFeeLedger.findMany({
        where: {
            picProfileId: input.picProfileId,
            organizerId: input.organizerId,
            type: "REVERSAL",
            direction: "DEBIT",
            settlementId: null,
        },
        orderBy: [{ createdAt: "asc" }],
        select: { id: true, orderId: true, orderItemId: true, amount: true },
    });

    const inWindowItemIds = new Set(earnedOrderItemIds);

    const carryCandidates = Array.from(
        new Set(
            reversalRows
                .map((row) => row.orderItemId)
                .filter(
                    (id): id is string =>
                        id !== null && !inWindowItemIds.has(id)
                )
        )
    );

    // An item is "carried" only if its unique EARNED row is already SETTLED — the refund
    // landed after the payout. Unsettled out-of-window items stay untouched (their own
    // reversals will be matched the window that settles them).
    const settledEarnedItems =
        carryCandidates.length > 0
            ? await tx.pICFeeLedger.findMany({
                  where: {
                      orderItemId: { in: carryCandidates },
                      type: "EARNED",
                      settlementId: { not: null },
                  },
                  select: { orderItemId: true },
              })
            : [];

    const carriedItemIds = new Set(
        settledEarnedItems
            .map((row) => row.orderItemId)
            .filter((id): id is string => id !== null)
    );

    const earnedByItem = new Map<string, typeof earnedRows>();
    for (const row of earnedRows) {
        if (row.orderItemId === null) {
            continue;
        }

        const bucket = earnedByItem.get(row.orderItemId) ?? [];
        bucket.push(row);
        earnedByItem.set(row.orderItemId, bucket);
    }

    const reversalByItem = new Map<string, typeof reversalRows>();
    for (const row of reversalRows) {
        if (row.orderItemId === null) {
            continue;
        }

        const bucket = reversalByItem.get(row.orderItemId) ?? [];
        bucket.push(row);
        reversalByItem.set(row.orderItemId, bucket);
    }

    const items: PreparedItem[] = [];
    let gross = new Prisma.Decimal(0);
    let deduction = new Prisma.Decimal(0);

    for (const [orderItemId, earnedSet] of earnedByItem) {
        const earnedSum = earnedSet.reduce(
            (sum, row) => sum.plus(row.amount),
            new Prisma.Decimal(0)
        );
        const reversals = reversalByItem.get(orderItemId) ?? [];
        const reversalSum = reversals.reduce(
            (sum, row) => sum.plus(row.amount),
            new Prisma.Decimal(0)
        );
        const net = earnedSum.minus(reversalSum);

        if (net.lessThanOrEqualTo(0)) {
            // Fully clawed back. The item is not settled; its EARNED (and the offsetting
            // REVERSAL rows) stay consumable for a future, wider window.
            continue;
        }

        for (const earned of earnedSet) {
            items.push({
                picFeeLedgerId: earned.id,
                orderId: earned.orderId,
                amount: earned.amount,
                direction: "CREDIT",
                description: "Fee EARNED",
            });
            gross = gross.plus(earned.amount);
        }

        for (const reversal of reversals) {
            items.push({
                picFeeLedgerId: reversal.id,
                orderId: reversal.orderId,
                amount: reversal.amount,
                direction: "DEBIT",
                description: "Pembatalan (REVERSAL)",
            });
            deduction = deduction.plus(reversal.amount);
        }
    }

    // Post-paid claw-backs (D-18 / BUG-1): reversals for items whose payout already
    // happened. They reduce the NEXT settlement, whole-or-nothing. If their total exceeds
    // this window's earnings the prepared net is ≤ 0 and the caller refuses the
    // settlement, leaving the deficit to carry onward.
    for (const reversal of reversalRows) {
        if (
            reversal.orderItemId !== null &&
            carriedItemIds.has(reversal.orderItemId)
        ) {
            items.push({
                picFeeLedgerId: reversal.id,
                orderId: reversal.orderId,
                amount: reversal.amount,
                direction: "DEBIT",
                description: "Pembatalan sesudah dibayar (REVERSAL)",
            });
            deduction = deduction.plus(reversal.amount);
        }
    }

    return { items, gross, deduction, net: gross.minus(deduction) };
}

export type PrepareSettlementInput = {
    organizerId: string;
    picProfileId: string;
    periodStart: Date;
    periodEnd: Date;
    notes?: string | null;
    actor: AuthzScope;
    now?: Date;
};

export type PrepareSettlementOutcome =
    | { outcome: "CREATED"; settlementId: string }
    | { outcome: "EXISTS"; settlementId: string }
    | { outcome: "RETRY_LATER"; settlementId: string | null; detail: string };

/**
 * `POST /api/organizer/settlements` — prepare a DRAFT payout.
 *
 * The organiser + PIC + window triple is UNIQUE (`Settlement` indexes), so a
 * re-prepared window replays the existing row instead of double-settling. Concurrent
 * prepares collide on the unique index (P2002), the loser re-reads and returns the
 * winner's row.
 */
export async function createPreparedSettlement(
    input: PrepareSettlementInput
): Promise<PrepareSettlementOutcome> {
    const now = input.now ?? new Date();

    try {
        const result = await withContentionRetry(async () =>
            prisma.$transaction(
                async (tx) => {
                    const existing = await tx.settlement.findFirst({
                        where: {
                            payeeType: "PIC",
                            organizerId: input.organizerId,
                            picProfileId: input.picProfileId,
                            periodStart: input.periodStart,
                            periodEnd: input.periodEnd,
                        },
                        select: { id: true, status: true },
                    });

                    if (existing) {
                        // A draft already in flight (or already paid) is the same claim:
                        // return it untouched. A closed claim (CANCELLED / FAILED) means
                        // the window was released — the operator must widen or shift it.
                        if (
                            existing.status === "CANCELLED" ||
                            existing.status === "FAILED"
                        ) {
                            throw new AppError(ERROR_CODES.CONFLICT, {
                                message:
                                    "Periode tersebut pernah disiapkan dan ditutup; gunakan rentang periode lain.",
                                details: {
                                    reason: "PERIOD_ALREADY_CLOSED",
                                    settlementId: existing.id,
                                },
                            });
                        }

                        return {
                            outcome: "EXISTS" as const,
                            settlementId: existing.id,
                        };
                    }

                    const profile = await tx.pICProfile.findUnique({
                        where: { id: input.picProfileId },
                        select: {
                            id: true,
                            bankName: true,
                            bankAccountName: true,
                            bankAccountNumber: true,
                        },
                    });

                    if (!profile) {
                        throw new AppError(ERROR_CODES.NOT_FOUND, {
                            message: "PIC tidak ditemukan.",
                        });
                    }

                    if (
                        !profile.bankName ||
                        !profile.bankAccountName ||
                        !profile.bankAccountNumber
                    ) {
                        throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
                            message:
                                "PIC belum melengkapi data rekening bank di profilnya.",
                            details: { reason: "BANK_DETAILS_MISSING" },
                        });
                    }

                    const { items, gross, deduction, net } =
                        await selectSettlementItems(tx, {
                            picProfileId: input.picProfileId,
                            organizerId: input.organizerId,
                            periodStart: input.periodStart,
                            periodEnd: input.periodEnd,
                        });

                    if (items.length === 0 || net.lessThanOrEqualTo(0)) {
                        throw new AppError(ERROR_CODES.CONFLICT, {
                            message:
                                "Tidak ada fee yang layak di-settlement pada periode ini.",
                            details: { reason: "NOTHING_SETTLEABLE" },
                        });
                    }

                    const number = buildSettlementNumber(now);

                    const settlement = await tx.settlement.create({
                        data: {
                            settlementNumber: number,
                            payeeType: "PIC",
                            picProfileId: input.picProfileId,
                            organizerId: input.organizerId,
                            periodStart: input.periodStart,
                            periodEnd: input.periodEnd,
                            grossAmount: gross,
                            deductionAmount: deduction,
                            netAmount: net,
                            currency: "IDR",
                            status: "DRAFT",
                            method: "MANUAL_TRANSFER",
                            bankName: profile.bankName,
                            bankAccountName: profile.bankAccountName,
                            bankAccountNumber: profile.bankAccountNumber,
                            preparedByUserId: input.actor.userId,
                            preparedAt: now,
                            notes: input.notes ?? null,
                        },
                        select: { id: true },
                    });

                    await tx.settlementItem.createMany({
                        data: items.map((item) => ({
                            settlementId: settlement.id,
                            picFeeLedgerId: item.picFeeLedgerId,
                            orderId: item.orderId,
                            amount: item.amount,
                            direction: item.direction,
                            description: item.description,
                        })),
                    });

                    await writeTicketingAuditInTx(
                        {
                            action: "settlement.prepare",
                            actor: input.actor,
                            actorOrganizerId: input.organizerId,
                            organizerId: input.organizerId,
                            entityType: "Settlement",
                            entityRef: number,
                            description:
                                "Settlement disiapkan; line fee EARNED diklaim, data bank di-snapshot.",
                            afterState: {
                                status: "DRAFT",
                                payeeType: "PIC",
                                picProfileId: input.picProfileId,
                                periodStart: input.periodStart.toISOString(),
                                periodEnd: input.periodEnd.toISOString(),
                                grossAmount: gross.toFixed(2),
                                deductionAmount: deduction.toFixed(2),
                                netAmount: net.toFixed(2),
                                items: items.length,
                                method: "MANUAL_TRANSFER",
                            },
                            reason: "SETTLEMENT_PREPARED",
                        },
                        tx
                    );

                    return {
                        outcome: "CREATED" as const,
                        settlementId: settlement.id,
                    };
                },
                { timeout: 20_000 }
            )
        );

        if (!result.ok) {
            return {
                outcome: "RETRY_LATER" as const,
                settlementId: null,
                detail: `gave up after ${result.attempts} attempts`,
            };
        }

        return result.value;
    } catch (error) {
        if (isUniqueViolation(error)) {
            // Two prepares for the same window raced; the other one wrote the row. Replay.
            const existing = await prisma.settlement.findFirst({
                where: {
                    payeeType: "PIC",
                    organizerId: input.organizerId,
                    picProfileId: input.picProfileId,
                    periodStart: input.periodStart,
                    periodEnd: input.periodEnd,
                },
                select: { id: true },
            });

            if (existing) {
                return { outcome: "EXISTS", settlementId: existing.id };
            }
        }

        throw error;
    }
}

/**
 * `POST /api/organizer/settlements/[id]/submit` — `DRAFT → PENDING_APPROVAL`.
 */
export async function submitSettlement(
    settlementId: string,
    actor: AuthzScope
): Promise<SettlementTransitionOutcome> {
    const result = await withContentionRetry(async () =>
        prisma.$transaction(
            async (tx) => {
                const row = await tx.settlement.findUnique({
                    where: { id: settlementId },
                    select: { id: true, status: true, settlementNumber: true, organizerId: true },
                });

                if (!row || !row.organizerId) {
                    throw new AppError(ERROR_CODES.NOT_FOUND, {
                        message: "Settlement tidak ditemukan.",
                    });
                }

                if (row.status !== "DRAFT") {
                    if (
                        row.status === "PENDING_APPROVAL" ||
                        row.status === "APPROVED" ||
                        row.status === "PAID"
                    ) {
                        return { outcome: "ALREADY", settlementId } as const;
                    }

                    throw new AppError(ERROR_CODES.SETTLEMENT_STATE_INVALID, {
                        message: "Settlement ini tidak dapat diajukan untuk disetujui.",
                        details: { status: row.status, reason: "NOT_DRAFT" },
                    });
                }

                const cas = await tx.settlement.updateMany({
                    where: { id: settlementId, status: "DRAFT" },
                    data: { status: "PENDING_APPROVAL" },
                });

                if (cas.count !== 1) {
                    return { outcome: "ALREADY", settlementId } as const;
                }

                await writeTicketingAuditInTx(
                    {
                        action: "settlement.submit",
                        actor,
                        actorOrganizerId: row.organizerId,
                        organizerId: row.organizerId,
                        entityType: "Settlement",
                        entityRef: row.settlementNumber,
                        description:
                            "Settlement diajukan untuk persetujuan (menunggu review).",
                        beforeState: { status: "DRAFT" },
                        afterState: { status: "PENDING_APPROVAL" },
                        reason: "SETTLEMENT_SUBMITTED",
                    },
                    tx
                );

                return { outcome: "DONE", settlementId } as const;
            },
            { timeout: 15_000 }
        )
    );

    if (!result.ok) {
        return { outcome: "RETRY_LATER", settlementId, detail: result.reason } as const;
    }

    return result.value;
}

/**
 * `POST /api/organizer/settlements/[id]/approve` — `PENDING_APPROVAL → APPROVED`.
 *
 * Separation of duties is decided in `service.ts` (the approver may not be the
 * preparer); this core only moves the state once.
 */
export async function approveSettlement(
    settlementId: string,
    actor: AuthzScope
): Promise<SettlementTransitionOutcome> {
    const result = await withContentionRetry(async () =>
        prisma.$transaction(
            async (tx) => {
                const row = await tx.settlement.findUnique({
                    where: { id: settlementId },
                    select: { id: true, status: true, settlementNumber: true, organizerId: true },
                });

                if (!row || !row.organizerId) {
                    throw new AppError(ERROR_CODES.NOT_FOUND, {
                        message: "Settlement tidak ditemukan.",
                    });
                }

                if (row.status !== "PENDING_APPROVAL") {
                    if (row.status === "APPROVED" || row.status === "PAID") {
                        return { outcome: "ALREADY", settlementId } as const;
                    }

                    throw new AppError(ERROR_CODES.SETTLEMENT_STATE_INVALID, {
                        message: "Settlement ini belum siap untuk disetujui.",
                        details: { status: row.status, reason: "NOT_PENDING_APPROVAL" },
                    });
                }

                const now = new Date();

                const cas = await tx.settlement.updateMany({
                    where: { id: settlementId, status: "PENDING_APPROVAL" },
                    data: { status: "APPROVED", approvedByUserId: actor.userId, approvedAt: now },
                });

                if (cas.count !== 1) {
                    return { outcome: "ALREADY", settlementId } as const;
                }

                await writeTicketingAuditInTx(
                    {
                        action: "settlement.approve",
                        actor,
                        actorOrganizerId: row.organizerId,
                        organizerId: row.organizerId,
                        entityType: "Settlement",
                        entityRef: row.settlementNumber,
                        description:
                            "Settlement disetujui; transfer bank kini boleh dieksekusi.",
                        beforeState: { status: "PENDING_APPROVAL" },
                        afterState: { status: "APPROVED" },
                        reason: "SETTLEMENT_APPROVED",
                    },
                    tx
                );

                return { outcome: "DONE", settlementId } as const;
            },
            { timeout: 15_000 }
        )
    );

    if (!result.ok) {
        return { outcome: "RETRY_LATER", settlementId, detail: result.reason } as const;
    }

    return result.value;
}

/**
 * The ONE place a payout becomes real — `APPROVED → PAID` (the settlement equivalent
 * of `processConfirmedRefund`).
 *
 * Every ledger flip happens in the same transaction as the state change: the EARNED
 * rows are settled and linked, the REVERSAL rows are linked, the PAYOUT DEBIT rows are
 * appended, the transfer reference is recorded. Any throw rolls all of it back, so
 * "money out" can never be half-recorded.
 */
export async function markSettlementPaid(
    settlementId: string,
    input: { providerReference: string; note?: string | null; actor: AuthzScope },
    now: Date = new Date()
): Promise<SettlementTransitionOutcome> {
    const result = await withContentionRetry(async () =>
        prisma.$transaction(
            async (tx) => {
                const row = await tx.settlement.findUnique({
                    where: { id: settlementId },
                    select: {
                        id: true,
                        status: true,
                        settlementNumber: true,
                        organizerId: true,
                        picProfileId: true,
                        netAmount: true,
                        proofFilePath: true,
                        preparedByUserId: true,
                    },
                });

                if (!row || !row.organizerId || !row.picProfileId) {
                    throw new AppError(ERROR_CODES.NOT_FOUND, {
                        message: "Settlement tidak ditemukan.",
                    });
                }

                if (row.status === "PAID") {
                    return { outcome: "ALREADY", settlementId } as const;
                }

                if (row.status !== "APPROVED") {
                    throw new AppError(ERROR_CODES.SETTLEMENT_STATE_INVALID, {
                        message: "Settlement ini belum disetujui untuk dibayar.",
                        details: { status: row.status, reason: "NOT_APPROVED" },
                    });
                }

                if (!row.proofFilePath) {
                    throw new AppError(ERROR_CODES.CONFLICT, {
                        message:
                            "Bukti transfer harus diupload sebelum settlement ditandai dibayar.",
                        details: { reason: "PROOF_REQUIRED" },
                    });
                }

                const cas = await tx.settlement.updateMany({
                    where: { id: settlementId, status: "APPROVED" },
                    data: {
                        status: "PAID",
                        paidByUserId: input.actor.userId,
                        paidAt: now,
                        providerReference: input.providerReference,
                        providerStatus: "MANUAL_TRANSFER",
                        notes: input.note ?? null,
                    },
                });

                if (cas.count !== 1) {
                    return { outcome: "ALREADY", settlementId } as const;
                }

                const included = await tx.settlementItem.findMany({
                    where: { settlementId },
                    select: { picFeeLedgerId: true, direction: true, amount: true },
                });

                const ledgerIds = included
                    .map((item) => item.picFeeLedgerId)
                    .filter((id): id is string => id !== null);

                const ledgerRows =
                    ledgerIds.length > 0
                        ? await tx.pICFeeLedger.findMany({
                              where: { id: { in: ledgerIds } },
                              select: {
                                  id: true,
                                  orderItemId: true,
                                  picProfileId: true,
                                  organizerId: true,
                                  eventId: true,
                                  orderId: true,
                                  ticketTypeId: true,
                                  attributionId: true,
                                  currency: true,
                                  feeType: true,
                                  rateBp: true,
                                  fixedAmount: true,
                                  basisType: true,
                                  basisAmount: true,
                                  quantity: true,
                                  amount: true,
                                  createdAt: true,
                              },
                          })
                        : [];

                // ── PAID-TIME RE-CHECK (Phase 11) ───────────────────────────────────
                // Between prepare and now a refund may have reversed one of the included
                // order items again. A reversal the settlement did not claim means the
                // item's value changed since prepare — paying the old number would
                // overpay. Detect any UNCONSUMED reversal on an included order item and
                // refuse; the operator fails the settlement and re-prepares.
                //
                // The check excludes the settlement's OWN included REVERSAL lines (which
                // are still settlementId=null at this point — they are linked a few
                // lines down): those are the deductions the operator already priced in.
                const includedReversalIds = included
                    .filter((item) => item.direction === "DEBIT")
                    .map((item) => item.picFeeLedgerId)
                    .filter((id): id is string => id !== null);

                const earnedLedger = ledgerRows.filter(
                    (ledgerRow) =>
                        included.some(
                            (item) =>
                                item.direction === "CREDIT" &&
                                item.picFeeLedgerId === ledgerRow.id
                        )
                );

                // Deterministic payout order: earliest EARNED first (deductions spread in
                // that order below).
                earnedLedger.sort(
                    (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
                );

                const includedOrderItemIds = Array.from(
                    new Set(
                        earnedLedger
                            .map((row) => row.orderItemId)
                            .filter((id): id is string => id !== null)
                    )
                );

                const unclaimedReversals =
                    includedOrderItemIds.length > 0
                        ? await tx.pICFeeLedger.findMany({
                              where: {
                                  orderItemId: { in: includedOrderItemIds },
                                  type: "REVERSAL",
                                  settlementId: null,
                                  id: { notIn: includedReversalIds },
                              },
                              select: { id: true },
                          })
                        : [];

                if (unclaimedReversals.length > 0) {
                    throw new AppError(ERROR_CODES.CONFLICT, {
                        message:
                            "Terjadi pembatalan fee setelah settlement disiapkan; batalkan settlement lalu siapkan ulang.",
                        details: {
                            reason: "NEW_REVERSAL_DETECTED",
                            ledgerEntries: unclaimedReversals.map((entry) => entry.id),
                        },
                    });
                }

                // ── Flip the EARNED rows (EARNED → SETTLED, linked) ─────────────
                for (const ledgerRow of earnedLedger) {
                    const flip = await tx.pICFeeLedger.updateMany({
                        where: {
                            id: ledgerRow.id,
                            status: "EARNED",
                            settlementId: null,
                        },
                        data: { status: "SETTLED", settlementId },
                    });

                    if (flip.count !== 1) {
                        throw new AppError(ERROR_CODES.CONFLICT, {
                            message:
                                "Entri fee sudah bergeser dari status yang disiapkan.",
                            details: { reason: "LEDGER_ALREADY_SETTLED", ledgerId: ledgerRow.id },
                        });
                    }
                }

                // ── Link the included REVERSAL rows ─────────────────────────────
                const reversalLedger = ledgerRows.filter(
                    (ledgerRow) =>
                        included.some(
                            (item) =>
                                item.direction === "DEBIT" &&
                                item.picFeeLedgerId === ledgerRow.id
                        )
                );

                for (const ledgerRow of reversalLedger) {
                    const link = await tx.pICFeeLedger.updateMany({
                        where: { id: ledgerRow.id, settlementId: null },
                        data: { settlementId },
                    });

                    if (link.count !== 1) {
                        throw new AppError(ERROR_CODES.CONFLICT, {
                            message:
                                "Entri pembatalan sudah digunakan settlement lain.",
                            details: { reason: "REVERSAL_ALREADY_CONSUMED", ledgerId: ledgerRow.id },
                        });
                    }
                }

                // ── Append the PAYOUT DEBIT rows, one per included EARNED item ──
                // Each PAYOUT row = that EARNED item's amount minus the offsetting
                // REVERSAL rows this settlement consumed for the same order item. The
                // preliminary payout sum exceeds `netAmount` by exactly the CARRIED
                // post-paid claw-backs this settlement netted (D-18 / BUG-1); that excess
                // is then spread across the payout rows (earliest EARNED first, never
                // below zero), so the appended DEBIT rows sum EXACTLY to `netAmount`.
                const reversalByItem = new Map<string, Prisma.Decimal>();
                for (const ledgerRow of reversalLedger) {
                    const key = ledgerRow.orderItemId ?? `order:${ledgerRow.orderId}`;
                    reversalByItem.set(
                        key,
                        (reversalByItem.get(key) ?? new Prisma.Decimal(0)).plus(
                            ledgerRow.amount
                        )
                    );
                }

                type PayoutRow = {
                    ledgerRow: (typeof ledgerRows)[number];
                    amount: Prisma.Decimal;
                };

                const payoutRows: PayoutRow[] = [];
                let payoutSum = new Prisma.Decimal(0);

                for (const ledgerRow of earnedLedger) {
                    const key = ledgerRow.orderItemId ?? `order:${ledgerRow.orderId}`;
                    const offset = reversalByItem.get(key) ?? new Prisma.Decimal(0);
                    const itemNet = new Prisma.Decimal(ledgerRow.amount).minus(offset);

                    if (itemNet.lessThanOrEqualTo(0)) {
                        continue;
                    }

                    payoutRows.push({ ledgerRow, amount: itemNet });
                    payoutSum = payoutSum.plus(itemNet);
                }

                // Carried-over post-paid claw-backs. Equals `payoutSum − netAmount` (the
                // amount the prepared deductions overstate the payouts); underflow is not
                // possible when net > 0, but is clamped defensively.
                let carriedToOffset = payoutSum.minus(row.netAmount);
                if (carriedToOffset.lessThan(0)) {
                    carriedToOffset = new Prisma.Decimal(0);
                }

                for (const payout of payoutRows) {
                    if (carriedToOffset.greaterThan(0)) {
                        const reduced = Prisma.Decimal.min(
                            payout.amount,
                            carriedToOffset
                        );
                        payout.amount = payout.amount.minus(reduced);
                        carriedToOffset = carriedToOffset.minus(reduced);
                    }

                    if (payout.amount.lessThanOrEqualTo(0)) {
                        continue;
                    }

                    const ledgerRow = payout.ledgerRow;

                    await tx.pICFeeLedger.create({
                        data: {
                            picProfileId: row.picProfileId,
                            organizerId: ledgerRow.organizerId,
                            eventId: ledgerRow.eventId,
                            orderId: ledgerRow.orderId,
                            orderItemId: ledgerRow.orderItemId,
                            ticketTypeId: ledgerRow.ticketTypeId,
                            attributionId: ledgerRow.attributionId,
                            type: "PAYOUT",
                            direction: "DEBIT",
                            amount: payout.amount,
                            currency: ledgerRow.currency,
                            feeType: ledgerRow.feeType,
                            rateBp: ledgerRow.rateBp,
                            fixedAmount: ledgerRow.fixedAmount,
                            basisType: ledgerRow.basisType,
                            basisAmount: ledgerRow.basisAmount,
                            quantity: ledgerRow.quantity,
                            status: "SETTLED",
                            settlementId,
                            createdByUserId: input.actor.userId,
                            adjustmentReason: "PAYOUT",
                            idempotencyKey: `fee:payout:${settlementId}:${ledgerRow.id}`,
                        },
                    });
                }

                await writeTicketingAuditInTx(
                    {
                        action: "settlement.paid",
                        actor: input.actor,
                        actorOrganizerId: row.organizerId,
                        organizerId: row.organizerId,
                        entityType: "Settlement",
                        entityRef: row.settlementNumber,
                        description:
                            "Settlement dibayar dengan transfer bank manual; ledger EARNED di-SETTLED dan DEBIT PAYOUT diposting.",
                        beforeState: { status: "APPROVED" },
                        afterState: {
                            status: "PAID",
                            netAmount: row.netAmount.toFixed(2),
                            providerReference: input.providerReference,
                            providerStatus: "MANUAL_TRANSFER",
                        },
                        reason: "SETTLEMENT_PAID_MANUAL",
                    },
                    tx
                );

                return { outcome: "DONE", settlementId } as const;
            },
            { timeout: 20_000 }
        )
    );

    if (!result.ok) {
        return { outcome: "RETRY_LATER", settlementId, detail: result.reason } as const;
    }

    return result.value;
}

/**
 * `POST /api/organizer/settlements/[id]/fail` — `APPROVED → FAILED`, releasing the
 * claim lines so a corrected settlement can be prepared on an adjusted window.
 *
 * The `FAILED` row and its audit trail remain as the record of the attempt; the EARNED
 * rows were never touched (they were only linked by `SettlementItem`), so releasing the
 * lines leaves them consumable again.
 */
export async function failSettlement(
    settlementId: string,
    reason: string,
    actor: AuthzScope
): Promise<SettlementTransitionOutcome> {
    const result = await withContentionRetry(async () =>
        prisma.$transaction(
            async (tx) => {
                const row = await tx.settlement.findUnique({
                    where: { id: settlementId },
                    select: { settlementNumber: true, organizerId: true, status: true },
                });

                if (!row || !row.organizerId) {
                    throw new AppError(ERROR_CODES.NOT_FOUND, {
                        message: "Settlement tidak ditemukan.",
                    });
                }

                if (row.status === "FAILED") {
                    return { outcome: "ALREADY", settlementId } as const;
                }

                if (row.status !== "APPROVED") {
                    throw new AppError(ERROR_CODES.SETTLEMENT_STATE_INVALID, {
                        message: "Hanya settlement yang disetujui yang dapat digagalkan.",
                        details: { status: row.status, reason: "NOT_APPROVED" },
                    });
                }

                const cas = await tx.settlement.updateMany({
                    where: { id: settlementId, status: "APPROVED" },
                    data: { status: "FAILED", failureReason: reason },
                });

                if (cas.count !== 1) {
                    return { outcome: "ALREADY", settlementId } as const;
                }

                await releaseSettlementItems(tx, settlementId);

                await writeTicketingAuditInTx(
                    {
                        action: "settlement.failed",
                        actor,
                        actorOrganizerId: row.organizerId,
                        organizerId: row.organizerId,
                        entityType: "Settlement",
                        entityRef: row.settlementNumber,
                        description:
                            "Settlement gagal; tidak ada dana yang dipindahkan dan klaim fee dilepas.",
                        beforeState: { status: "APPROVED" },
                        afterState: { status: "FAILED", failureReason: reason },
                        reason: "SETTLEMENT_FAILED",
                    },
                    tx
                );

                return { outcome: "DONE", settlementId } as const;
            },
            { timeout: 15_000 }
        )
    );

    if (!result.ok) {
        return { outcome: "RETRY_LATER", settlementId, detail: result.reason } as const;
    }

    return result.value;
}

/**
 * `POST /api/organizer/settlements/[id]/cancel` — `DRAFT | PENDING_APPROVAL → CANCELLED`,
 * releasing the claim lines. Used when a draft is wrong or the transfer is abandoned
 * before approval.
 */
export async function cancelSettlement(
    settlementId: string,
    actor: AuthzScope
): Promise<SettlementTransitionOutcome> {
    const result = await withContentionRetry(async () =>
        prisma.$transaction(
            async (tx) => {
                const row = await tx.settlement.findUnique({
                    where: { id: settlementId },
                    select: { settlementNumber: true, organizerId: true, status: true },
                });

                if (!row || !row.organizerId) {
                    throw new AppError(ERROR_CODES.NOT_FOUND, {
                        message: "Settlement tidak ditemukan.",
                    });
                }

                if (row.status === "CANCELLED") {
                    return { outcome: "ALREADY", settlementId } as const;
                }

                if (row.status !== "DRAFT" && row.status !== "PENDING_APPROVAL") {
                    throw new AppError(ERROR_CODES.SETTLEMENT_STATE_INVALID, {
                        message: "Settlement dalam status ini tidak dapat dibatalkan.",
                        details: { status: row.status, reason: "NOT_CANCELLABLE" },
                    });
                }

                const cas = await tx.settlement.updateMany({
                    where: { id: settlementId, status: { in: ["DRAFT", "PENDING_APPROVAL"] } },
                    data: { status: "CANCELLED" },
                });

                if (cas.count !== 1) {
                    return { outcome: "ALREADY", settlementId } as const;
                }

                await releaseSettlementItems(tx, settlementId);

                await writeTicketingAuditInTx(
                    {
                        action: "settlement.cancel",
                        actor,
                        actorOrganizerId: row.organizerId,
                        organizerId: row.organizerId,
                        entityType: "Settlement",
                        entityRef: row.settlementNumber,
                        description:
                            "Settlement dibatalkan; tidak ada dana yang dipindahkan dan klaim fee dilepas.",
                        beforeState: { status: row.status },
                        afterState: { status: "CANCELLED" },
                        reason: "SETTLEMENT_CANCELLED",
                    },
                    tx
                );

                return { outcome: "DONE", settlementId } as const;
            },
            { timeout: 15_000 }
        )
    );

    if (!result.ok) {
        return { outcome: "RETRY_LATER", settlementId, detail: result.reason } as const;
    }

    return result.value;
}

export const __internals = {
    selectSettlementItems,
    releaseSettlementItems,
};