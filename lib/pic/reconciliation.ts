import { Prisma } from "@prisma/client";

import { getPicLedgerBalance } from "@/lib/pic/ledger";
import { prisma } from "@/lib/prisma";
import { moneyString } from "@/lib/ticketing/order-payload";

/**
 * ==========================================
 * PIC FEE RECONCILIATION (PHASE 31, operational view)
 * ==========================================
 *
 * Makes the ledger's money relationships inspectable without inventing a new formula:
 *
 *   EARNED  ──settled ──▶ SETTLED (settlementId set)   ──▶ PAYOUT (DEBIT)
 *           ──unsettled─▶ still payable
 *   REVERSAL ─consumed─▶ linked to a settlement
 *            ─carried──▶ post-paid deficit waiting for the next settlement (D-18)
 *            ─pending──▶ item's EARNED not yet settled
 *
 * Every number here is a `Prisma.Decimal` aggregate over the WHOLE ledger; the canonical
 * `net` is `Σ CREDIT − Σ DEBIT` from the Phase 30 helper. Purely read-only and unguarded —
 * callers MUST authorize (platform `pic.manage` or organizer `pic_fee.read.all` scoped to the
 * same tenant) before invoking it.
 */

const ZERO = new Prisma.Decimal(0);

export type PicFeeReconciliation = {
    picProfileId: string;
    balance: { credit: string; debit: string; net: string };
    totalsByType: { type: string; count: number; amount: string }[];
    earned: {
        total: string;
        settled: string;
        unsettled: string;
        settledCount: number;
        unsettledCount: number;
    };
    reversal: {
        total: string;
        consumed: string;
        carried: string;
        pending: string;
        consumedCount: number;
        carriedCount: number;
        pendingCount: number;
    };
    payout: { total: string; count: number };
    checks: {
        /** EARNED splits exactly into settled + unsettled. */
        earnedSplits: boolean;
        /** REVERSAL splits exactly into consumed + carried + pending. */
        reversalSplits: boolean;
        /** The reported net equals Σ CREDIT − Σ DEBIT. */
        netMatchesDirection: boolean;
    };
};

export async function getPicFeeReconciliation(
    picProfileId: string,
    organizerId?: string | null
): Promise<PicFeeReconciliation> {
    const scope = {
        picProfileId,
        ...(organizerId ? { organizerId } : {}),
    };

    const [
        balance,
        byType,
        settledEarned,
        unsettledEarned,
        consumedReversal,
        payoutAgg,
        openReversals,
    ] = await Promise.all([
        getPicLedgerBalance(picProfileId),
        prisma.pICFeeLedger.groupBy({
            by: ["type"],
            where: scope,
            _sum: { amount: true },
            _count: { _all: true },
        }),
        prisma.pICFeeLedger.aggregate({
            where: { ...scope, type: "EARNED", settlementId: { not: null } },
            _sum: { amount: true },
            _count: { _all: true },
        }),
        prisma.pICFeeLedger.aggregate({
            where: { ...scope, type: "EARNED", settlementId: null },
            _sum: { amount: true },
            _count: { _all: true },
        }),
        prisma.pICFeeLedger.aggregate({
            where: { ...scope, type: "REVERSAL", settlementId: { not: null } },
            _sum: { amount: true },
            _count: { _all: true },
        }),
        prisma.pICFeeLedger.aggregate({
            where: { ...scope, type: "PAYOUT" },
            _sum: { amount: true },
            _count: { _all: true },
        }),
        prisma.pICFeeLedger.findMany({
            where: { ...scope, type: "REVERSAL", settlementId: null },
            select: { orderItemId: true, amount: true },
        }),
    ]);

    // A reversal is CARRIED when its order item's unique EARNED row is already settled — the
    // post-paid refund D-18 nets off a future settlement. Otherwise it is PENDING (the item's
    // EARNED is still open and will be matched by the window that settles it).
    const openItemIds = Array.from(
        new Set(
            openReversals
                .map((row) => row.orderItemId)
                .filter((id): id is string => id !== null)
        )
    );

    const settledItems =
        openItemIds.length > 0
            ? await prisma.pICFeeLedger.findMany({
                  where: {
                      orderItemId: { in: openItemIds },
                      type: "EARNED",
                      settlementId: { not: null },
                  },
                  select: { orderItemId: true },
              })
            : [];

    const settledItemSet = new Set(settledItems.map((row) => row.orderItemId));

    let carried = ZERO;
    let pending = ZERO;
    let carriedCount = 0;
    let pendingCount = 0;

    for (const reversal of openReversals) {
        if (reversal.orderItemId && settledItemSet.has(reversal.orderItemId)) {
            carried = carried.plus(reversal.amount);
            carriedCount += 1;
        } else {
            pending = pending.plus(reversal.amount);
            pendingCount += 1;
        }
    }

    const typeSum = (type: string) =>
        byType.find((entry) => entry.type === type)?._sum.amount ?? ZERO;

    const earnedTotal = typeSum("EARNED");
    const reversalTotal = typeSum("REVERSAL");

    const settled = settledEarned._sum.amount ?? ZERO;
    const unsettled = unsettledEarned._sum.amount ?? ZERO;
    const consumed = consumedReversal._sum.amount ?? ZERO;
    const payoutTotal = payoutAgg._sum.amount ?? ZERO;

    return {
        picProfileId,
        balance: {
            credit: moneyString(balance.credit),
            debit: moneyString(balance.debit),
            net: moneyString(balance.net),
        },
        totalsByType: byType
            .map((entry) => ({
                type: entry.type,
                count: entry._count._all,
                amount: moneyString(entry._sum.amount ?? ZERO),
            }))
            .sort((a, b) => a.type.localeCompare(b.type)),
        earned: {
            total: moneyString(earnedTotal),
            settled: moneyString(settled),
            unsettled: moneyString(unsettled),
            settledCount: settledEarned._count._all,
            unsettledCount: unsettledEarned._count._all,
        },
        reversal: {
            total: moneyString(reversalTotal),
            consumed: moneyString(consumed),
            carried: moneyString(carried),
            pending: moneyString(pending),
            consumedCount: consumedReversal._count._all,
            carriedCount,
            pendingCount,
        },
        payout: {
            total: moneyString(payoutTotal),
            count: payoutAgg._count._all,
        },
        checks: {
            earnedSplits: earnedTotal.equals(settled.plus(unsettled)),
            reversalSplits: reversalTotal.equals(consumed.plus(carried).plus(pending)),
            netMatchesDirection: balance.net.equals(balance.credit.minus(balance.debit)),
        },
    };
}
