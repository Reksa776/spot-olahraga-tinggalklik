import type { PICFeeEntryType, PICFeeStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { AppError } from "@/lib/api/errors";
import { PERMISSIONS } from "@/lib/authz";
import { toCsv, type CsvColumn, type CsvRow } from "@/lib/csv";
import { getPicLedgerBalance } from "@/lib/pic/ledger";
import { requireMyPic } from "@/lib/pic/self-service";
import { prisma } from "@/lib/prisma";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";
import { moneyString } from "@/lib/ticketing/order-payload";

/**
 * ==========================================
 * PIC FEE REPORTING (PHASE 31)
 * ==========================================
 *
 * The PIC's own financial report and CSV export. It consumes the Phase 30 canonical balance
 * helper (`getPicLedgerBalance`, Σ CREDIT − Σ DEBIT) and never invents a second formula.
 *
 * ── SUMMARY vs LIST ─────────────────────────────────────────────────────────────
 * `summary` is the CANONICAL whole-ledger position (gross earned / total reversals / total
 * payouts / net balance) and is deliberately NOT narrowed by the row filters: `netBalance`
 * must equal what every other Phase 30 surface shows, and a filter must not be able to make
 * two "balance" numbers exist. The row filters (`from`/`to`/`eventId`/`type`/`status`) narrow
 * the TRANSACTION LIST only, server-side.
 *
 * ── DATE CONTRACT ───────────────────────────────────────────────────────────────
 * A date-only filter (`YYYY-MM-DD`) is interpreted as an Asia/Jakarta calendar day and
 * converted to an exact server-side instant (`from` = 00:00:00.000, `to` = 23:59:59.999,
 * both +07:00). A full ISO timestamp is taken as the exact instant given. This makes results
 * independent of the browser's timezone.
 */

const LEDGER_TYPES: readonly PICFeeEntryType[] = [
    "EARLY_ACCRUAL",
    "EARNED",
    "EARNED_ADJUSTMENT",
    "REVERSAL",
    "PAYOUT",
    "ADJUSTMENT",
];

const LEDGER_STATUSES: readonly PICFeeStatus[] = [
    "PENDING",
    "EARNED",
    "PAYABLE",
    "APPROVED",
    "SETTLED",
    "VOID",
];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const JAKARTA_OFFSET = "+07:00";

export const PIC_FEE_REPORT_DEFAULT_PAGE_SIZE = 25;
export const PIC_FEE_REPORT_MAX_PAGE_SIZE = 200;

export type PicFeeReportQuery = {
    from?: string | null;
    to?: string | null;
    eventId?: string | null;
    type?: string | null;
    status?: string | null;
    page?: string | number | null;
    pageSize?: string | number | null;
};

export type PicFeeReportFilters = {
    from: Date | null;
    to: Date | null;
    eventId: string | null;
    type: PICFeeEntryType | null;
    status: PICFeeStatus | null;
    page: number;
    pageSize: number;
};

function parseBoundary(value: string, boundary: "start" | "end"): Date {
    if (DATE_ONLY.test(value)) {
        const time = boundary === "start" ? "00:00:00.000" : "23:59:59.999";
        const parsed = new Date(`${value}T${time}${JAKARTA_OFFSET}`);
        if (Number.isNaN(parsed.getTime())) {
            throw AppError.validation(`Tanggal tidak valid: ${value}.`);
        }
        return parsed;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw AppError.validation(`Tanggal tidak valid: ${value}.`);
    }
    return parsed;
}

function parsePositiveInt(
    value: string | number | null | undefined,
    fallback: number,
    max: number
): number {
    if (value === null || value === undefined || value === "") {
        return fallback;
    }
    const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }
    return Math.min(parsed, max);
}

/**
 * Parse + validate report filters. Unknown enum values are a 400 rather than being silently
 * ignored, so a client cannot believe a filter applied when it did not.
 */
export function resolvePicFeeReportFilters(
    query: PicFeeReportQuery
): PicFeeReportFilters {
    const from = query.from ? parseBoundary(query.from, "start") : null;
    const to = query.to ? parseBoundary(query.to, "end") : null;

    if (from && to && from.getTime() > to.getTime()) {
        throw AppError.validation("Rentang tanggal tidak valid (from > to).");
    }

    const type = query.type
        ? (() => {
              const candidate = query.type as PICFeeEntryType;
              if (!LEDGER_TYPES.includes(candidate)) {
                  throw AppError.validation(`Jenis ledger tidak dikenal: ${query.type}.`);
              }
              return candidate;
          })()
        : null;

    const status = query.status
        ? (() => {
              const candidate = query.status as PICFeeStatus;
              if (!LEDGER_STATUSES.includes(candidate)) {
                  throw AppError.validation(`Status ledger tidak dikenal: ${query.status}.`);
              }
              return candidate;
          })()
        : null;

    return {
        from,
        to,
        eventId: query.eventId?.trim() ? query.eventId.trim() : null,
        type,
        status,
        page: parsePositiveInt(query.page, 1, Number.MAX_SAFE_INTEGER),
        pageSize: parsePositiveInt(
            query.pageSize,
            PIC_FEE_REPORT_DEFAULT_PAGE_SIZE,
            PIC_FEE_REPORT_MAX_PAGE_SIZE
        ),
    };
}

/** The Prisma `where` the filters describe, always scoped to one PIC profile. */
export function buildPicFeeLedgerWhere(
    picProfileId: string,
    filters: Pick<PicFeeReportFilters, "from" | "to" | "eventId" | "type" | "status">
): Prisma.PICFeeLedgerWhereInput {
    const createdAt: Prisma.DateTimeFilter = {};
    if (filters.from) {
        createdAt.gte = filters.from;
    }
    if (filters.to) {
        createdAt.lte = filters.to;
    }

    return {
        picProfileId,
        ...(filters.eventId ? { eventId: filters.eventId } : {}),
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.from || filters.to ? { createdAt } : {}),
    };
}

export const PIC_FEE_LEDGER_ROW_SELECT = {
    id: true,
    type: true,
    direction: true,
    amount: true,
    currency: true,
    feeType: true,
    rateBp: true,
    basisType: true,
    basisAmount: true,
    quantity: true,
    status: true,
    orderId: true,
    orderItemId: true,
    settlementId: true,
    refundId: true,
    reversalRef: true,
    createdAt: true,
    event: { select: { title: true } },
    order: { select: { orderNumber: true } },
} as const;

export type PicFeeLedgerRow = Prisma.PICFeeLedgerGetPayload<{
    select: typeof PIC_FEE_LEDGER_ROW_SELECT;
}>;

export function toPicFeeLedgerRowPayload(row: PicFeeLedgerRow) {
    return {
        id: row.id,
        type: row.type,
        direction: row.direction,
        amount: moneyString(row.amount),
        currency: row.currency,
        feeType: row.feeType,
        rateBp: row.rateBp,
        basisType: row.basisType,
        basisAmount: moneyString(row.basisAmount),
        quantity: row.quantity,
        status: row.status,
        eventTitle: row.event.title,
        orderNumber: row.order.orderNumber,
        orderItemId: row.orderItemId,
        settlementId: row.settlementId,
        refundId: row.refundId,
        reversalRef: row.reversalRef,
        createdAt: row.createdAt.toISOString(),
    };
}

export type PicFeeReportSummary = {
    grossEarned: string;
    totalReversals: string;
    totalPayouts: string;
    credit: string;
    debit: string;
    netBalance: string;
};

/** The canonical, whole-ledger summary — identical to every other Phase 30 money surface. */
export async function loadPicFeeReportSummary(
    picProfileId: string
): Promise<PicFeeReportSummary> {
    const [balance, byType] = await Promise.all([
        getPicLedgerBalance(picProfileId),
        prisma.pICFeeLedger.groupBy({
            by: ["type"],
            where: { picProfileId },
            _sum: { amount: true },
        }),
    ]);

    const typeSum = (type: PICFeeEntryType) =>
        byType.find((entry) => entry.type === type)?._sum.amount ??
        new Prisma.Decimal(0);

    return {
        grossEarned: moneyString(typeSum("EARNED")),
        totalReversals: moneyString(typeSum("REVERSAL")),
        totalPayouts: moneyString(typeSum("PAYOUT")),
        credit: moneyString(balance.credit),
        debit: moneyString(balance.debit),
        netBalance: moneyString(balance.net),
    };
}

/**
 * The PIC's own report. Authority: `pic_fee.read.own` over the SESSION user's ACTIVE profile
 * (the `userId` is a routing key, never an authority; a forged id is a denial inside
 * `requireMyPic`).
 */
export async function getMyPicFeeReport(
    userId: string,
    query: PicFeeReportQuery
) {
    const { picProfileId } = await requireMyPic(userId, [PERMISSIONS.PIC_FEE_READ_OWN]);

    const filters = resolvePicFeeReportFilters(query);
    const where = buildPicFeeLedgerWhere(picProfileId, filters);

    const [summary, total, rows] = await Promise.all([
        loadPicFeeReportSummary(picProfileId),
        prisma.pICFeeLedger.count({ where }),
        prisma.pICFeeLedger.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (filters.page - 1) * filters.pageSize,
            take: filters.pageSize,
            select: PIC_FEE_LEDGER_ROW_SELECT,
        }),
    ]);

    return {
        picProfileId,
        filters: {
            from: filters.from?.toISOString() ?? null,
            to: filters.to?.toISOString() ?? null,
            eventId: filters.eventId,
            type: filters.type,
            status: filters.status,
        },
        summary,
        rows: rows.map(toPicFeeLedgerRowPayload),
        pagination: {
            page: filters.page,
            pageSize: filters.pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
        },
    };
}

/** Stable CSV column order for the `report.export.own_pic_fee` contract. */
export const PIC_FEE_CSV_COLUMNS: readonly CsvColumn[] = [
    { key: "createdAt", header: "createdAt" },
    { key: "eventTitle", header: "event", kind: "text" },
    { key: "orderNumber", header: "orderNumber" },
    { key: "orderItemId", header: "orderItemId" },
    { key: "type", header: "ledgerType" },
    { key: "direction", header: "direction" },
    { key: "amount", header: "amount" },
    { key: "feeType", header: "feeType" },
    { key: "rateBp", header: "rateBp" },
    { key: "basisType", header: "basisType" },
    { key: "basisAmount", header: "basisAmount" },
    { key: "quantity", header: "quantity" },
    { key: "status", header: "status" },
    { key: "settlementId", header: "settlementId" },
    { key: "refundId", header: "refundId" },
    { key: "reversalRef", header: "reversalRef" },
];

function rowToCsv(row: ReturnType<typeof toPicFeeLedgerRowPayload>): CsvRow {
    return {
        createdAt: row.createdAt,
        eventTitle: row.eventTitle,
        orderNumber: row.orderNumber,
        orderItemId: row.orderItemId,
        type: row.type,
        direction: row.direction,
        amount: row.amount,
        feeType: row.feeType,
        rateBp: row.rateBp === null ? "" : String(row.rateBp),
        basisType: row.basisType,
        basisAmount: row.basisAmount,
        quantity: String(row.quantity),
        status: row.status,
        settlementId: row.settlementId,
        refundId: row.refundId === null ? "" : String(row.refundId),
        reversalRef: row.reversalRef,
    };
}

/**
 * The PIC's own CSV export. Authority: `pic_fee.read.own` AND `report.export.own_pic_fee`.
 * Exports ALL matching rows — never the report's current page — so UI pagination cannot
 * silently truncate a download.
 */
export async function exportMyPicFeeCsv(
    userId: string,
    query: PicFeeReportQuery
): Promise<string> {
    const { scope, picProfileId } = await requireMyPic(userId, [
        PERMISSIONS.PIC_FEE_READ_OWN,
        PERMISSIONS.REPORT_EXPORT_OWN_PIC_FEE,
    ]);

    // The page/pageSize of the query are deliberately ignored: an export is the whole filtered set.
    const filters = resolvePicFeeReportFilters({ ...query, page: 1, pageSize: 1 });
    const where = buildPicFeeLedgerWhere(picProfileId, filters);

    const rows = await prisma.pICFeeLedger.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: PIC_FEE_LEDGER_ROW_SELECT,
    });

    // A financial export is an auditable read that leaves the system. Fire-and-forget
    // (the shared writer swallows failures): a failed audit line must not fail a download
    // the actor is entitled to. `entityRef` is the PIC's OWN profile — the export names
    // no other tenant, and the metadata carries only counts and filters, never a bank
    // account, token or credential.
    await writeTicketingAudit({
        action: "report.export.own_pic_fee",
        entityType: "Report",
        entityRef: picProfileId,
        description: `PIC fee ledger export (${rows.length} baris)`,
        actor: scope,
        afterState: {
            format: "csv",
            rowCount: rows.length,
            from: filters.from?.toISOString() ?? null,
            to: filters.to?.toISOString() ?? null,
            eventId: filters.eventId,
            type: filters.type,
            status: filters.status,
        },
    });

    return toCsv(PIC_FEE_CSV_COLUMNS, rows.map((row) => rowToCsv(toPicFeeLedgerRowPayload(row))));
}

export const __reportingInternals = { rowToCsv, parseBoundary, parsePositiveInt };
