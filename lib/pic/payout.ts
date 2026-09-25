import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireMyPic } from "@/lib/pic/self-service";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";
import {
    createPreparedSettlement,
    previewSettleable,
} from "@/lib/ticketing/settlement/settlement";
import { maskAccountNumber } from "@/lib/ticketing/settlement/payload";
import type { PicPayoutBankInput } from "@/lib/ticketing/settlement/validation";

/**
 * ==========================================
 * PIC PAYOUT REQUEST (PHASE 21 — PIC-INITIATED, OWN-SCOPE)
 * ==========================================
 *
 * The PIC's own half of the payout lifecycle. A PIC may ASK to be paid; they never pay
 * themselves, approve themselves or record their own transfer evidence. Every function
 * here funnels through `requireMyPic` with the new `pic_payout.request.own` capability,
 * so the identity is the SESSION user's ACTIVE profile and a forged `picProfileId` is
 * structurally impossible — no function accepts one.
 *
 * ── NO SECOND MONEY ENGINE ───────────────────────────────────────────────────────
 * A request does not compute money of its own. It calls the SAME
 * `createPreparedSettlement` the operator surface calls, with `origin: "PIC_REQUEST"`,
 * which:
 *   * selects the claim lines with `selectSettlementItems` (unsettled in-window EARNED
 *     rows minus their offsetting reversals, including carried post-paid claw-backs);
 *   * writes the claim under `SettlementItem.picFeeLedgerId @unique`, so two concurrent
 *     requests can never consume the same fee — the database, not a read-then-write
 *     check, decides the race;
 *   * snapshots the payee bank exactly as an operator-prepared settlement does.
 * The request lands as `REQUESTED`, authored by the PIC (`preparedByUserId`). Because
 * the author is the PIC, the operator's existing separation of duties (author ≠
 * approver ≠ payer) holds unchanged, and the PIC holds no `settlement.*` permission at
 * all — they can never reach the approve/pay/proof routes.
 *
 * ── THE AMOUNT IS NEVER CLIENT-SUPPLIED ──────────────────────────────────────────
 * There is no `amount` field anywhere in this module. The amount is whatever the PIC's
 * own eligible ledger rows add up to for the chosen tenant. `settleableNet` on the read
 * surface is that same `previewSettleable` figure, so the number the PIC is shown is the
 * number they can actually request, and it is labelled "saldo yang dapat dicairkan" —
 * NOT the whole-ledger canonical net.
 *
 * ── ONE TENANT PER REQUEST ───────────────────────────────────────────────────────
 * A request names exactly ONE organizer. The `organizerId` is validated by the money
 * engine itself: if the PIC holds no eligible ledger row in that tenant, nothing is
 * selectable and the request is refused (`NOTHING_SETTLEABLE`). There is no aggregation
 * across tenants, and no way to name a tenant the PIC did not earn in.
 *
 * ── THE PAYEE BANK RIDES WITH THE REQUEST ────────────────────────────────────────
 * A request may carry the PIC's own `bank` block. When it does, the three bank columns on
 * the PIC's OWN `PICProfile` are written FIRST — in the same call, under the same
 * `requireMyPic` identity — and only then is the money engine invoked. The engine re-reads
 * the profile and snapshots whatever it now holds, so the payout is always sent to the
 * account the PIC just confirmed. This is why the payout dialog can offer "complete/edit
 * your bank details" without giving the PIC any way to name someone else's destination:
 * the write is scoped to the session's own profile, and the block carries no id.
 *
 * The write and the settlement CANNOT share one transaction, because
 * `createPreparedSettlement` owns its own and accepts no client handle — deliberately, as
 * it is the single money engine. The two steps are therefore sequential, and the failure
 * mode is chosen rather than inherited: if the bank write succeeds and the request is
 * then refused by a business rule (`NOTHING_SETTLEABLE`, `ALREADY_CLAIMED`, contention),
 * the bank change simply STANDS and the PIC retries. That is the right trade — the PIC's
 * edit is what they asked for, it moves no money, and re-submitting is idempotent because
 * an unchanged block writes nothing.
 *
 * A bank write is NEVER silent: it appends a `pic.bank.update` audit row. The metadata
 * carries `bankName`, `bankAccountName`, `hasAccountNumber` and `accountNumberLast4` —
 * NEVER the account number (see `audit-log.ts`).
 */

/**
 * The last four characters of the account number, whitespace-stripped — the SAME
 * normalisation `maskAccountNumber` uses, so the audit trail's `accountNumberLast4` and
 * the operator's masked view can never disagree about which digits "last four" means.
 */
function accountNumberLast4(value: string): string {
    return value.replace(/\s+/g, "").slice(-4);
}

/**
 * Persist the PIC's own bank destination, and audit the change.
 *
 * Only writes when something actually DIFFERS: re-submitting an unchanged block is a
 * no-op, so a routine re-request does not litter the audit log with rows that claim a
 * change that never happened. The caller has already resolved the profile from the
 * session, so there is no id to forge here.
 */
async function saveMyPicBankDetails(
    picProfileId: string,
    bank: PicPayoutBankInput,
    scope: AuthzScope,
    request?: Request
): Promise<void> {
    const before = await prisma.pICProfile.findUnique({
        where: { id: picProfileId },
        select: {
            bankName: true,
            bankAccountName: true,
            bankAccountNumber: true,
        },
    });

    if (!before) {
        throw AppError.notFound("PIC tidak ditemukan.");
    }

    const changed =
        before.bankName !== bank.bankName ||
        before.bankAccountName !== bank.bankAccountName ||
        before.bankAccountNumber !== bank.bankAccountNumber;

    if (!changed) {
        return;
    }

    await prisma.pICProfile.update({
        where: { id: picProfileId },
        data: {
            bankName: bank.bankName,
            bankAccountName: bank.bankAccountName,
            bankAccountNumber: bank.bankAccountNumber,
        },
        select: { id: true },
    });

    /*
     * The account number is NEVER in the metadata — not the old one and not the new one.
     * `bankName` / `bankAccountName` are recorded because an auditor asking "who redirected
     * this payee's account?" needs to see what it was changed TO at the institution level;
     * the number itself is represented only by "present or not" and its last four, which is
     * enough to recognise an account in a conversation and not enough to reuse it.
     */
    await writeTicketingAudit({
        action: "pic.bank.update",
        actor: scope,
        actorOrganizerId: null,
        organizerId: null,
        entityType: "PICProfile",
        entityRef: picProfileId,
        description: "PIC memperbarui data rekening pencairan miliknya.",
        beforeState: {
            bankName: before.bankName,
            bankAccountName: before.bankAccountName,
            hasAccountNumber: Boolean(before.bankAccountNumber),
        },
        afterState: {
            bankName: bank.bankName,
            bankAccountName: bank.bankAccountName,
            hasAccountNumber: true,
            accountNumberLast4: accountNumberLast4(bank.bankAccountNumber),
        },
        reason: "PIC_UPDATED_PAYOUT_BANK_DETAILS",
        request,
    });
}

/** The organizer ids a PIC has eligible (unsettled, EARNED) fee rows in. */
async function settleableOrganizerIds(picProfileId: string): Promise<string[]> {
    const rows = await prisma.pICFeeLedger.findMany({
        where: {
            picProfileId,
            type: "EARNED",
            direction: "CREDIT",
            status: "EARNED",
            settlementId: null,
        },
        select: { organizerId: true },
        distinct: ["organizerId"],
    });

    return rows.map((row) => row.organizerId);
}

/** The earliest eligible EARNED `createdAt` for one PIC + tenant, or `null`. */
async function settleableWindowStart(
    picProfileId: string,
    organizerId: string
): Promise<Date | null> {
    const row = await prisma.pICFeeLedger.findFirst({
        where: {
            picProfileId,
            organizerId,
            type: "EARNED",
            direction: "CREDIT",
            status: "EARNED",
            settlementId: null,
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
    });

    return row?.createdAt ?? null;
}

export type SettleableOrganizer = {
    organizerId: string;
    organizerName: string;
    /** The exact `Decimal(14,2)` string the PIC may request for this tenant. */
    settleableNet: string;
};

/**
 * The PER-TENANT settleable amounts a PIC may request, newest tenants first.
 *
 * A tenant is offered only when its settleable net is strictly positive — the same
 * condition `createPreparedSettlement` enforces, so the UI never offers an amount the
 * server would refuse. The amount is computed with `previewSettleable`, i.e. the money
 * engine's own selection, never a display-only sum.
 */
export async function listMyPicSettleableOrganizers(
    userId: string
): Promise<SettleableOrganizer[]> {
    const { picProfileId } = await requireMyPic(userId, [
        PERMISSIONS.PIC_PAYOUT_REQUEST_OWN,
    ]);

    const organizerIds = await settleableOrganizerIds(picProfileId);

    if (organizerIds.length === 0) {
        return [];
    }

    const [organizers, earliestRows] = await Promise.all([
        prisma.organizer.findMany({
            where: { id: { in: organizerIds } },
            select: { id: true, name: true },
        }),
        prisma.pICFeeLedger.findMany({
            where: {
                picProfileId,
                organizerId: { in: organizerIds },
                type: "EARNED",
                direction: "CREDIT",
                status: "EARNED",
                settlementId: null,
            },
            select: { organizerId: true, createdAt: true },
            orderBy: { createdAt: "asc" },
        }),
    ]);

    const nameById = new Map(organizers.map((row) => [row.id, row.name]));
    const startByOrganizer = new Map<string, Date>();

    for (const row of earliestRows) {
        if (!startByOrganizer.has(row.organizerId)) {
            startByOrganizer.set(row.organizerId, row.createdAt);
        }
    }

    const now = new Date();
    const result: SettleableOrganizer[] = [];

    for (const organizerId of organizerIds) {
        const periodStart = startByOrganizer.get(organizerId);

        if (!periodStart) {
            continue;
        }

        const preview = await previewSettleable({
            picProfileId,
            organizerId,
            periodStart,
            periodEnd: now,
        });

        if (preview.net.lessThanOrEqualTo(0)) {
            continue;
        }

        result.push({
            organizerId,
            organizerName: nameById.get(organizerId) ?? "Penyelenggara",
            settleableNet: preview.net.toFixed(2),
        });
    }

    return result;
}

export type PicPayoutRequestPayload = {
    id: string;
    settlementNumber: string;
    status: string;
    organizerName: string | null;
    periodStart: string;
    periodEnd: string;
    grossAmount: string;
    deductionAmount: string;
    netAmount: string;
    currency: string;
    bankName: string | null;
    bankAccountName: string | null;
    /** Masked (`••••` + last four) — never the full account number. */
    bankAccountNumber: string | null;
    providerReference: string | null;
    /** PHASE 21 — present only on a `REJECTED` request, and shown to the PIC. */
    rejectionReason: string | null;
    rejectedAt: string | null;
    paidAt: string | null;
    createdAt: string;
};

const PIC_PAYOUT_SELECT = {
    id: true,
    settlementNumber: true,
    status: true,
    periodStart: true,
    periodEnd: true,
    grossAmount: true,
    deductionAmount: true,
    netAmount: true,
    currency: true,
    bankName: true,
    bankAccountName: true,
    bankAccountNumber: true,
    providerReference: true,
    rejectionReason: true,
    rejectedAt: true,
    paidAt: true,
    createdAt: true,
    organizer: { select: { name: true } },
} as const;

type PicPayoutRow = {
    id: string;
    settlementNumber: string;
    status: string;
    periodStart: Date;
    periodEnd: Date;
    grossAmount: { toFixed: (digits: number) => string } | string;
    deductionAmount: { toFixed: (digits: number) => string } | string;
    netAmount: { toFixed: (digits: number) => string } | string;
    currency: string;
    bankName: string | null;
    bankAccountName: string | null;
    bankAccountNumber: string | null;
    providerReference: string | null;
    rejectionReason: string | null;
    rejectedAt: Date | null;
    paidAt: Date | null;
    createdAt: Date;
    organizer: { name: string } | null;
};

function money(value: PicPayoutRow["netAmount"]): string {
    return typeof value === "string" ? value : value.toFixed(2);
}

function toPicPayoutPayload(row: PicPayoutRow): PicPayoutRequestPayload {
    return {
        id: row.id,
        settlementNumber: row.settlementNumber,
        status: row.status,
        organizerName: row.organizer?.name ?? null,
        periodStart: row.periodStart.toISOString(),
        periodEnd: row.periodEnd.toISOString(),
        grossAmount: money(row.grossAmount),
        deductionAmount: money(row.deductionAmount),
        netAmount: money(row.netAmount),
        currency: row.currency,
        bankName: row.bankName,
        bankAccountName: row.bankAccountName,
        bankAccountNumber: maskAccountNumber(row.bankAccountNumber),
        providerReference: row.providerReference,
        rejectionReason: row.rejectionReason,
        rejectedAt: row.rejectedAt?.toISOString() ?? null,
        paidAt: row.paidAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
    };
}

/**
 * The PIC's own payout requests (and any operator-created settlement for them), newest
 * first. Read-only, identity-scoped, and safe: the bank is masked, and the PIC's own
 * data is the only data reachable.
 */
export async function listMyPicPayoutRequests(
    userId: string
): Promise<PicPayoutRequestPayload[]> {
    const { picProfileId } = await requireMyPic(userId, [
        PERMISSIONS.PIC_FEE_READ_OWN,
    ]);

    const rows = await prisma.settlement.findMany({
        where: { payeeType: "PIC", picProfileId },
        select: PIC_PAYOUT_SELECT,
        orderBy: { createdAt: "desc" },
        take: 50,
    });

    return rows.map(toPicPayoutPayload);
}

/**
 * Create a PIC-initiated payout request for ONE tenant.
 *
 * The window is derived server-side from the PIC's own earliest eligible row through
 * NOW, so every currently-settleable row is claimed and no client timestamp is trusted.
 * The claim is transactional and guarded by `SettlementItem.picFeeLedgerId @unique`.
 *
 * `bank`, when supplied, is written to the caller's OWN profile first (see the module
 * docblock) so the snapshot the engine takes is the account the PIC just confirmed.
 */
export async function createMyPicPayoutRequest(
    userId: string,
    input: { organizerId: string; notes?: string; bank?: PicPayoutBankInput },
    request?: Request
): Promise<PicPayoutRequestPayload> {
    const { scope, picProfileId } = await requireMyPic(userId, [
        PERMISSIONS.PIC_PAYOUT_REQUEST_OWN,
    ]);

    const organizerId = typeof input.organizerId === "string" ? input.organizerId.trim() : "";

    if (!organizerId) {
        throw AppError.validation("Penyelenggara wajib dipilih.");
    }

    // The bank destination is settled BEFORE the money engine runs, so the snapshot taken
    // below is the latest data. The engine itself is untouched and re-reads the profile.
    if (input.bank) {
        await saveMyPicBankDetails(picProfileId, input.bank, scope, request);
    }

    const periodStart = await settleableWindowStart(picProfileId, organizerId);

    if (!periodStart) {
        throw new AppError(ERROR_CODES.CONFLICT, {
            message: "Belum ada fee yang dapat dicairkan untuk penyelenggara ini.",
            details: { reason: "NOTHING_SETTLEABLE" },
        });
    }

    const now = new Date();

    let outcome;

    try {
        outcome = await createPreparedSettlement({
            organizerId,
            picProfileId,
            periodStart,
            periodEnd: now,
            notes: input.notes?.trim() ? input.notes.trim() : null,
            actor: scope,
            origin: "PIC_REQUEST",
            now,
        });
    } catch (error) {
        // A claim collision: a CONCURRENT request already consumed one of this PIC's
        // ledger rows (the `SettlementItem.picFeeLedgerId @unique` boundary firing). The
        // money is safe — nothing was double-claimed — so the caller is told to retry
        // rather than shown an internal error.
        if (
            typeof error === "object" &&
            error !== null &&
            (error as { code?: string }).code === "P2002"
        ) {
            throw new AppError(ERROR_CODES.CONFLICT, {
                message:
                    "Sebagian fee sudah diklaim permintaan pencairan lain; muat ulang lalu coba lagi.",
                details: { reason: "ALREADY_CLAIMED" },
            });
        }

        throw error;
    }

    if (outcome.outcome === "RETRY_LATER") {
        throw new AppError(ERROR_CODES.CONFLICT, {
            message:
                "Permintaan pencairan gagal karena kontensi database; coba lagi.",
            details: { reason: "SETTLEMENT_CONTENTION" },
        });
    }

    // Re-read through the PIC-scoped select so the response shape matches the list
    // endpoint and the bank stays masked. The extra `picProfileId` predicate is defence
    // in depth: the id came from the guard, so this can only ever find the PIC's own row.
    const row = await prisma.settlement.findFirstOrThrow({
        where: { id: outcome.settlementId, payeeType: "PIC", picProfileId },
        select: PIC_PAYOUT_SELECT,
    });

    return toPicPayoutPayload(row);
}
