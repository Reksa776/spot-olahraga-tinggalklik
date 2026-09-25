import { Prisma } from "@prisma/client";

import { moneyString } from "../order-payload";

/**
 * ==========================================
 * SETTLEMENT RESPONSE PAYLOAD (PICO payout / settlement V1)
 * ==========================================
 *
 * One builder for every settlement response, so the prepare, submit, approve, proof,
 * paid, fail, cancel, list and detail endpoints cannot drift apart.
 *
 * ── MONEY IS STRINGS (D-61 / §36.5) ──────────────────────────────────────────────
 * `grossAmount` / `deductionAmount` / `netAmount` are rendered with `moneyString`, i.e.
 * the exact stored `Decimal(14,2)` as a fixed 2-decimal string. Never a JSON number,
 * never a `Number(...).toFixed(2)` round trip.
 *
 * ── THE PAYEE'S BANK IS MASKED ───────────────────────────────────────────────────
 * The prepared bank snapshot is exposed only to the operator who pays it out, and even
 * then the account number is masked to `••••` + last four digits — enough to recognise
 * an account in a conversation, not enough to reuse. The full number is never rendered
 * anywhere and never logged (brief §22 / §32.3); it is read fresh from
 * `Settlement.bankAccountNumber` only inside the operator detail payload.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────────
 * `preparedByUserId` / `approvedByUserId` / `paidByUserId` are operator identities the
 * UI already holds from the session; they are kept out of the payload. Internal ledger
 * ids are not exposed either — items carry `orderNumber` + `description` instead.
 */

/** Keep the last four digits — enough to recognise, not enough to reuse. */
export function maskAccountNumber(value: string | null): string | null {
    if (!value) {
        return null;
    }

    const digits = value.replace(/\s+/g, "");

    if (digits.length <= 4) {
        return `••••${digits}`;
    }

    return `••••${digits.slice(-4)}`;
}

export type SettlementItemPayload = {
    id: string;
    picFeeLedgerId: string | null;
    orderNumber: string | null;
    amount: string;
    direction: "CREDIT" | "DEBIT";
    description: string | null;
};

export type SettlementPayload = {
    id: string;
    settlementNumber: string;
    payeeType: string;
    picProfileId: string | null;
    picDisplayName: string | null;
    picCode: string | null;
    organizerId: string | null;
    organizerName: string | null;
    periodStart: string;
    periodEnd: string;
    grossAmount: string;
    deductionAmount: string;
    netAmount: string;
    currency: string;
    status: string;
    method: string;
    bankName: string | null;
    bankAccountName: string | null;
    bankAccountNumber: string | null;
    proofAvailable: boolean;
    proofFileName: string | null;
    providerReference: string | null;
    failureReason: string | null;
    notes: string | null;
    preparedByUserId: string;
    preparedAt: string;
    approvedAt: string | null;
    paidAt: string | null;
    itemCount: number;
    items?: SettlementItemPayload[];
    createdAt: string;
    updatedAt: string;
};

export type SettlementRow = {
    id: string;
    settlementNumber: string;
    payeeType: string;
    picProfileId: string | null;
    organizerId: string | null;
    periodStart: Date;
    periodEnd: Date;
    grossAmount: Prisma.Decimal;
    deductionAmount: Prisma.Decimal;
    netAmount: Prisma.Decimal;
    currency: string;
    status: string;
    method: string;
    bankName: string | null;
    bankAccountName: string | null;
    bankAccountNumber: string | null;
    proofFilePath: string | null;
    providerReference: string | null;
    failureReason: string | null;
    notes: string | null;
    preparedByUserId: string;
    preparedAt: Date;
    approvedAt: Date | null;
    paidAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    picProfile: {
        displayName: string;
        picCode: string;
    } | null;
    organizer: { name: string } | null;
    items?: {
        id: string;
        picFeeLedgerId: string | null;
        amount: Prisma.Decimal;
        direction: "CREDIT" | "DEBIT";
        description: string | null;
        order: { orderNumber: string } | null;
    }[];
};

/** The Prisma `select` that produces a `SettlementRow`. */
export const SETTLEMENT_SELECT = {
    id: true,
    settlementNumber: true,
    payeeType: true,
    picProfileId: true,
    organizerId: true,
    periodStart: true,
    periodEnd: true,
    grossAmount: true,
    deductionAmount: true,
    netAmount: true,
    currency: true,
    status: true,
    method: true,
    bankName: true,
    bankAccountName: true,
    bankAccountNumber: true,
    proofFilePath: true,
    providerReference: true,
    failureReason: true,
    notes: true,
    preparedByUserId: true,
    preparedAt: true,
    approvedAt: true,
    paidAt: true,
    createdAt: true,
    updatedAt: true,
    picProfile: {
        select: { displayName: true, picCode: true },
    },
    organizer: {
        select: { name: true },
    },
} as const;

/** The item selection used inside the same payload builder. */
export const SETTLEMENT_ITEM_SELECT = {
    id: true,
    picFeeLedgerId: true,
    amount: true,
    direction: true,
    description: true,
    order: {
        select: { orderNumber: true },
    },
} as const;

type WithItems<T> = T & {
    items?: SettlementRow["items"];
};

export function buildSettlementPayload(row: WithItems<SettlementRow>): SettlementPayload {
    return {
        id: row.id,
        settlementNumber: row.settlementNumber,
        payeeType: row.payeeType,
        picProfileId: row.picProfileId,
        picDisplayName: row.picProfile?.displayName ?? null,
        picCode: row.picProfile?.picCode ?? null,
        organizerId: row.organizerId,
        organizerName: row.organizer?.name ?? null,
        periodStart: row.periodStart.toISOString(),
        periodEnd: row.periodEnd.toISOString(),
        grossAmount: moneyString(row.grossAmount),
        deductionAmount: moneyString(row.deductionAmount),
        netAmount: moneyString(row.netAmount),
        currency: row.currency,
        status: row.status,
        method: row.method,
        bankName: row.bankName,
        bankAccountName: row.bankAccountName,
        bankAccountNumber: maskAccountNumber(row.bankAccountNumber),
        proofAvailable: row.proofFilePath !== null,
        proofFileName: row.proofFilePath,
        providerReference: row.providerReference,
        failureReason: row.failureReason,
        notes: row.notes,
        preparedByUserId: row.preparedByUserId,
        preparedAt: row.preparedAt.toISOString(),
        approvedAt: row.approvedAt?.toISOString() ?? null,
        paidAt: row.paidAt?.toISOString() ?? null,
        itemCount: row.items?.length ?? 0,
        ...(row.items
            ? {
                  items: row.items.map((item) => ({
                      id: item.id,
                      picFeeLedgerId: item.picFeeLedgerId,
                      orderNumber: item.order?.orderNumber ?? null,
                      amount: moneyString(item.amount),
                      direction: item.direction,
                      description: item.description,
                  })),
              }
            : {}),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}