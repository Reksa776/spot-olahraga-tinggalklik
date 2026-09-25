import { Prisma } from "@prisma/client";

import { PERMISSIONS, requireOrganizerAccess } from "@/lib/authz";
import { toCsv, type CsvColumn, type CsvRow } from "@/lib/csv";
import { resolvePicFeeReportFilters, type PicFeeReportQuery } from "@/lib/pic/reporting";
import { prisma } from "@/lib/prisma";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";
import { moneyString } from "@/lib/ticketing/order-payload";

/**
 * ==========================================
 * ORGANIZER (TENANT) PIC FEE REPORTING (PHASE 31)
 * ==========================================
 *
 * The minimum useful tenant-side PIC fee surface: per-PIC canonical totals for ONE organizer,
 * and a CSV export.
 *
 * ── AUTHORITY ──────────────────────────────────────────────────────────────────
 * `organizerId` is a routing key, never authority: every function runs
 * `requireOrganizerAccess(organizerId, ...)` with the SESSION actor first, so naming another
 * tenant is a 404, not a peek. Reads require `pic_fee.read.all`; the export requires
 * `report.export.pic_fee` as well. Platform ADMIN behaviour is untouched (an ADMIN still
 * needs an ACTIVE membership to act inside a tenant — the existing intersection rule).
 *
 * ── MONEY ──────────────────────────────────────────────────────────────────────
 * Totals are `Σ CREDIT − Σ DEBIT` per PIC, aggregated over the WHOLE ledger (a `groupBy`,
 * never a `take`), using `Prisma.Decimal`. No second formula is introduced.
 */

export type OrganizerPicFeeReportItem = {
    picProfileId: string;
    displayName: string;
    picCode: string;
    status: string;
    earned: string;
    reversals: string;
    payouts: string;
    netBalance: string;
    entryCount: number;
};

function organizerLedgerWhere(
    organizerId: string,
    query: PicFeeReportQuery
): Prisma.PICFeeLedgerWhereInput {
    const filters = resolvePicFeeReportFilters(query);

    const createdAt: Prisma.DateTimeFilter = {};
    if (filters.from) {
        createdAt.gte = filters.from;
    }
    if (filters.to) {
        createdAt.lte = filters.to;
    }

    return {
        organizerId,
        ...(filters.eventId ? { eventId: filters.eventId } : {}),
        ...(filters.from || filters.to ? { createdAt } : {}),
    };
}

/** Per-PIC canonical totals for one organizer. */
export async function getOrganizerPicFeeReport(
    organizerId: string,
    query: PicFeeReportQuery
): Promise<{ organizerId: string; items: OrganizerPicFeeReportItem[] }> {
    await requireOrganizerAccess(organizerId, PERMISSIONS.PIC_FEE_READ_ALL);

    const where = organizerLedgerWhere(organizerId, query);

    const [byType, byDirection, countRows] = await Promise.all([
        prisma.pICFeeLedger.groupBy({
            by: ["picProfileId", "type"],
            where,
            _sum: { amount: true },
        }),
        prisma.pICFeeLedger.groupBy({
            by: ["picProfileId", "direction"],
            where,
            _sum: { amount: true },
        }),
        prisma.pICFeeLedger.groupBy({
            by: ["picProfileId"],
            where,
            _count: { _all: true },
        }),
    ]);

    const picIds = Array.from(new Set(byDirection.map((row) => row.picProfileId)));

    const profiles = await prisma.pICProfile.findMany({
        where: { id: { in: picIds } },
        select: { id: true, displayName: true, picCode: true, status: true },
    });
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

    const zero = new Prisma.Decimal(0);
    const typeSum = (picId: string, type: string) =>
        byType.find((row) => row.picProfileId === picId && row.type === type)?._sum
            .amount ?? zero;
    const directionSum = (picId: string, direction: string) =>
        byDirection.find(
            (row) => row.picProfileId === picId && row.direction === direction
        )?._sum.amount ?? zero;

    const items: OrganizerPicFeeReportItem[] = picIds.map((picId) => {
        const profile = profileById.get(picId);
        const credit = directionSum(picId, "CREDIT");
        const debit = directionSum(picId, "DEBIT");

        return {
            picProfileId: picId,
            displayName: profile?.displayName ?? "(PIC tidak ditemukan)",
            picCode: profile?.picCode ?? "",
            status: profile?.status ?? "UNKNOWN",
            earned: moneyString(typeSum(picId, "EARNED")),
            reversals: moneyString(typeSum(picId, "REVERSAL")),
            payouts: moneyString(typeSum(picId, "PAYOUT")),
            netBalance: moneyString(credit.minus(debit)),
            entryCount:
                countRows.find((row) => row.picProfileId === picId)?._count._all ?? 0,
        };
    });

    items.sort((a, b) => a.displayName.localeCompare(b.displayName));

    return { organizerId, items };
}

export const ORGANIZER_PIC_FEE_CSV_COLUMNS: readonly CsvColumn[] = [
    { key: "picCode", header: "picCode" },
    { key: "displayName", header: "picName", kind: "text" },
    { key: "status", header: "picStatus" },
    { key: "earned", header: "earned" },
    { key: "reversals", header: "reversals" },
    { key: "payouts", header: "payouts" },
    { key: "netBalance", header: "netBalance" },
    { key: "entryCount", header: "entryCount" },
];

/** The tenant CSV export. Requires `report.export.pic_fee` on top of the read permission. */
export async function exportOrganizerPicFeeCsv(
    organizerId: string,
    query: PicFeeReportQuery
): Promise<string> {
    const scope = await requireOrganizerAccess(
        organizerId,
        PERMISSIONS.REPORT_EXPORT_PIC_FEE
    );

    const report = await getOrganizerPicFeeReport(organizerId, query);

    const rows: CsvRow[] = report.items.map((item) => ({
        picCode: item.picCode,
        displayName: item.displayName,
        status: item.status,
        earned: item.earned,
        reversals: item.reversals,
        payouts: item.payouts,
        netBalance: item.netBalance,
        entryCount: String(item.entryCount),
    }));

    // A tenant financial export is auditable. Fire-and-forget (the shared writer swallows
    // failures) so a failed audit line never blocks a download the actor is entitled to.
    // The metadata is counts + filters only — no bank account, token or credential.
    await writeTicketingAudit({
        action: "report.export.pic_fee",
        entityType: "Report",
        entityRef: organizerId,
        description: `PIC fee tenant export (${rows.length} PIC)`,
        actor: scope,
        actorOrganizerId: organizerId,
        organizerId,
        afterState: {
            format: "csv",
            picCount: rows.length,
            from: query.from ?? null,
            to: query.to ?? null,
            eventId: query.eventId ?? null,
        },
    });

    return toCsv(ORGANIZER_PIC_FEE_CSV_COLUMNS, rows);
}
