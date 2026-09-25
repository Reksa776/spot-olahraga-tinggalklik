import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * PIC LEDGER BALANCE — THE ONE CANONICAL SUM (Phase 30, GAP-1/GAP-2)
 * ==========================================
 *
 * The PIC fee ledger is a single-currency (IDR), single-sense ledger: CREDIT = earned or
 * payable, DEBIT = reversal / payout / adjustment. Its outstanding balance to a PIC is
 * ALWAYS `Σ CREDIT − Σ DEBIT`, and because DEBIT rows are Deltas the result carries a sign
 * (negative means the PIC owes the organizer/platform — e.g. a post-paid refund that has
 * not been netted off a payout yet).
 *
 * Every surface that presents a PIC money figure must use ONE of these two helpers so the
 * number never drifts between views: magnitude sums (which would double-count a settlement
 * claw-back against its already-paid EARNED row) and window-limited reads (which silently
 * miss rows after the first 100) are exactly the two defects this file exists to prevent.
 *
 * Both helpers aggregate by `direction` over the WHOLE ledger — nothing is time-boxed and
 * nothing is truncated — and return `Prisma.Decimal`, so callers never touch floats.
 */

const ZERO = new Prisma.Decimal(0);

export type PicLedgerBalance = {
    credit: Prisma.Decimal;
    debit: Prisma.Decimal;
    net: Prisma.Decimal;
};

/** Full balance for ONE PIC, all rows. */
export async function getPicLedgerBalance(
    picProfileId: string
): Promise<PicLedgerBalance> {
    const byDirection = await prisma.pICFeeLedger.groupBy({
        by: ["direction"],
        where: { picProfileId },
        _sum: { amount: true },
    });

    const credit =
        byDirection.find((entry) => entry.direction === "CREDIT")?._sum.amount ?? ZERO;
    const debit =
        byDirection.find((entry) => entry.direction === "DEBIT")?._sum.amount ?? ZERO;

    return { credit, debit, net: credit.sub(debit) };
}

/** Full balance for MANY PICs at once (one groupBy, ordered to match `ids`). */
export async function getPicLedgerBalances(
    ids: readonly string[]
): Promise<Map<string, PicLedgerBalance>> {
    const balances = new Map<string, PicLedgerBalance>();
    if (ids.length === 0) {
        return balances;
    }

    for (const id of ids) {
        balances.set(id, { credit: ZERO, debit: ZERO, net: ZERO });
    }

    const rows = await prisma.pICFeeLedger.groupBy({
        by: ["picProfileId", "direction"],
        where: { picProfileId: { in: [...ids] } },
        _sum: { amount: true },
    });

    for (const row of rows) {
        const balance = balances.get(row.picProfileId);
        if (!balance) {
            continue;
        }

        const amount = row._sum.amount ?? ZERO;
        if (row.direction === "CREDIT") {
            balance.credit = amount;
        } else {
            balance.debit = amount;
        }
    }

    for (const balance of balances.values()) {
        balance.net = balance.credit.sub(balance.debit);
    }

    return balances;
}