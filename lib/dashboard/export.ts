import { AppError } from "@/lib/api/errors";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import { toCsv, withUtf8Bom, type CsvColumn, type CsvRow } from "@/lib/csv";
import { hasOrganizerPermission, organizerIdsWith } from "@/lib/dashboard/scope";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";
import { listSettlements } from "@/lib/ticketing/settlement/service";
import { XLSX_CONTENT_TYPE, buildXlsx, type XlsxSheet } from "@/lib/xlsx";

import {
    DASHBOARD_REPORT_EXPORT_ROW_LIMIT,
    getDashboardReport,
    loadDashboardReportOrderRows,
    loadDashboardReportRefundRows,
    type DashboardReportFilters,
} from "./reports";

/**
 * ==========================================
 * DASHBOARD REPORT EXPORT (CSV + Excel)
 * ==========================================
 *
 * A READ-ONLY projection of `lib/dashboard/reports.ts`. It owns no query and no money rule: every
 * figure and every row comes from the same module the screen reads, under the same filters, so
 * "the download matches what you see" is structural rather than a promise. Nothing in this file
 * can move money — there is not a single `create`, `update` or `delete` in it.
 *
 * ── AUTHORITY ──────────────────────────────────────────────────────────────────
 * An export needs BOTH the report READ and the export permission, and both are asked of the real
 * decider (`hasOrganizerPermission` → `decideOrganizerPermission`):
 *
 *   * `report.transaction.read` — the same permission the report page and its aggregates resolve,
 *     so an actor who cannot see the numbers cannot obtain them by downloading;
 *   * `report.export.transaction` — held by MANAGER / OWNER / FINANCE by role, and by ADMIN only
 *     with an explicit grant (`ADMIN_GRANT_REQUIRED`), which is the platform's standing rule that
 *     an ADMIN holds no financial power by default.
 *
 * A caller holding neither is refused with `FORBIDDEN` rather than handed an empty file: a
 * silently-empty download is the failure mode that teaches an operator their export "worked".
 * `resolveOrganizerFilter` then re-decides the tenant boundary inside every loader, so a forged
 * `organizerId` in the query string is a refusal, not a wider export.
 *
 * ── WHAT IS EXPORTED ───────────────────────────────────────────────────────────
 *   CSV    the order-level transaction rows for the window — the dataset an accountant reconciles.
 *          UTF-8 with BOM, RFC 4180 quoting, formula-injection neutralisation on free text, money
 *          as the exact `Decimal(14,2)` string.
 *   XLSX   a workbook whose sheets mirror the report: Ringkasan, Pesanan, Penjualan Tiket, Refund,
 *          and Pencairan when the actor may settle — every one of them restricted to the report
 *          window. Money columns are numeric and formatted
 *          `#,##0.00` so a column can be summed; the Ringkasan block is literal text so a header
 *          value is never mistaken for a data point.
 *
 * ── TENANCY ────────────────────────────────────────────────────────────────────
 * Every sheet is produced by a loader that resolved the caller's organizer scope from the session.
 * There is no code path here that can name an organizer the caller has no permission in — the
 * only organizer id that reaches the builders came from a URL and was re-decided. Bank account
 * numbers on the settlement sheet are the MASKED payload values, never the stored column.
 *
 * ── LIMITS ─────────────────────────────────────────────────────────────────────
 * Every capped sheet (Pesanan, Refund, Pencairan) is loaded with an over-fetch of ONE row: the
 * extra row is never written, it only proves the sheet was cut. The Ringkasan sheet states when
 * ANY of those caps was reached, so a truncated file can never be mistaken for a complete one.
 *
 * ── THE PAYOUT SHEET'S WINDOW ──────────────────────────────────────────────────
 * `listSettlements` has no date predicate — a settlement is a PAYOUT with a coverage period, not a
 * row that happens on a day — so the Pencairan sheet is the one sheet whose window cannot be
 * pushed into the query. The scan pages the settlement list (never a second query implementation)
 * and keeps a row only when its own `periodStart … periodEnd` INTERSECTS the report window, so the
 * tab matches the workbook it sits in rather than silently listing the tenant's whole history.
 * Because a period is not a point, that is also the honest rule: a payout covering last month and
 * this one belongs in a report that asks about either.
 */

export type DashboardReportExportFormat = "csv" | "xlsx";

export type DashboardReportExport = {
    format: DashboardReportExportFormat;
    fileName: string;
    contentType: string;
    /** A BOM-prefixed CSV document, or the xlsx archive bytes. */
    body: string | Uint8Array;
    /** Rows written across every dataset (used for the audit line and for tests). */
    rowCount: number;
    /** Tab names, in workbook order. For the CSV format, the single dataset name. */
    sheets: string[];
};

export const DASHBOARD_REPORT_EXPORT_FORMATS: readonly DashboardReportExportFormat[] = [
    "csv",
    "xlsx",
];

export function parseDashboardReportExportFormat(
    value: string | null | undefined
): DashboardReportExportFormat {
    if (value === "csv" || value === "xlsx") {
        return value;
    }

    throw AppError.validation(
        `Format ekspor tidak dikenal: ${value ?? "(kosong)"}. Gunakan csv atau xlsx.`
    );
}

/* ── CSV: the transaction rows ────────────────────────────────────────────────── */

/**
 * Stable CSV column order. The export contract is that columns never reorder between releases, so
 * a downstream spreadsheet formula keeps pointing at the same field.
 *
 * `kind: "text"` marks every value a human typed (a buyer name, an event title): those are the
 * ones a spreadsheet could execute, so `lib/csv.ts` neutralises a leading `=`/`+`/`-`/`@`. Ids,
 * enums, dates and money stay `value` cells so the decimal string is emitted verbatim.
 */
export const DASHBOARD_REPORT_CSV_COLUMNS: readonly CsvColumn[] = [
    { key: "orderNumber", header: "orderNumber" },
    { key: "createdAt", header: "createdAt" },
    { key: "paidAt", header: "paidAt" },
    { key: "eventTitle", header: "event", kind: "text" },
    { key: "organizerName", header: "penyelenggara", kind: "text" },
    { key: "buyerName", header: "pembeli", kind: "text" },
    { key: "buyerEmail", header: "emailPembeli", kind: "text" },
    { key: "status", header: "status" },
    { key: "paymentStatus", header: "statusPembayaran" },
    { key: "subtotal", header: "subtotal" },
    { key: "discount", header: "diskon" },
    { key: "total", header: "total" },
    { key: "currency", header: "mataUang" },
];

function orderRowToCsv(row: Awaited<ReturnType<typeof loadDashboardReportOrderRows>>["rows"][number]): CsvRow {
    return {
        orderNumber: row.orderNumber,
        createdAt: row.createdAt,
        paidAt: row.paidAt ?? "",
        eventTitle: row.eventTitle,
        organizerName: row.organizerName,
        buyerName: row.buyerName,
        buyerEmail: row.buyerEmail ?? "",
        status: row.status,
        paymentStatus: row.paymentStatus,
        subtotal: row.subtotal,
        discount: row.discount,
        total: row.total,
        currency: row.currency,
    };
}

/* ── EXCEL: the workbook ─────────────────────────────────────────────────────── */

const ORDERS_SHEET_COLUMNS = [
    { header: "orderNumber" },
    { header: "dibuat" },
    { header: "dibayar" },
    { header: "event", kind: "text" as const },
    { header: "penyelenggara", kind: "text" as const },
    { header: "pembeli", kind: "text" as const },
    { header: "emailPembeli", kind: "text" as const },
    { header: "status" },
    { header: "statusPembayaran" },
    { header: "subtotal", kind: "money" as const },
    { header: "diskon", kind: "money" as const },
    { header: "total", kind: "money" as const },
    { header: "mataUang" },
];

const EVENT_SHEET_COLUMNS = [
    { header: "event", kind: "text" as const, width: 40 },
    { header: "slug", kind: "text" as const, width: 28 },
    { header: "pesananLunas", kind: "integer" as const },
    { header: "tiketTerjual", kind: "integer" as const },
    { header: "pendapatan", kind: "money" as const, width: 18 },
    { header: "refund", kind: "money" as const, width: 18 },
    { header: "pendapatanBersih", kind: "money" as const, width: 18 },
];

const REFUND_SHEET_COLUMNS = [
    { header: "refundNumber" },
    { header: "dibuat" },
    { header: "selesai" },
    { header: "orderNumber" },
    { header: "pembeli", kind: "text" as const },
    { header: "event", kind: "text" as const, width: 32 },
    { header: "status" },
    { header: "jumlahDiminta", kind: "money" as const, width: 18 },
    { header: "jumlahDikonfirmasi", kind: "money" as const, width: 20 },
    { header: "referensiTransfer", kind: "text" as const, width: 24 },
];

const SETTLEMENT_SHEET_COLUMNS = [
    { header: "settlementNumber" },
    { header: "dibuat" },
    { header: "pic", kind: "text" as const },
    { header: "kodePic" },
    { header: "penyelenggara", kind: "text" as const, width: 28 },
    { header: "periodeMulai" },
    { header: "periodeSelesai" },
    { header: "bruto", kind: "money" as const, width: 18 },
    { header: "potongan", kind: "money" as const, width: 18 },
    { header: "netto", kind: "money" as const, width: 18 },
    { header: "status" },
    { header: "bank", kind: "text" as const },
    { header: "atasNama", kind: "text" as const },
    { header: "rekening", kind: "text" as const },
    { header: "referensiTransfer", kind: "text" as const, width: 24 },
    { header: "dibayar" },
];

function summaryRow(metric: string, value: string): [string, string] {
    return [metric, value];
}

/**
 * One payout row exactly as the Pencairan sheet writes it. Every field is the settlement PAYLOAD's
 * own string form, so the sheet re-derives no figure — in particular `bankAccountNumber` is the
 * payload's MASKED value and never the stored column.
 */
type DashboardReportSettlementRow = {
    settlementNumber: string;
    createdAt: string;
    pic: string;
    picCode: string;
    organizerName: string;
    periodStart: string;
    periodEnd: string;
    grossAmount: string;
    deductionAmount: string;
    netAmount: string;
    status: string;
    bankName: string;
    bankAccountName: string;
    bankAccountNumber: string;
    providerReference: string;
    paidAt: string;
};

/**
 * Build the workbook.
 *
 * The Ringkasan sheet is a LABEL/VALUE block rather than a data row on purpose: its values are
 * mixed units (counts, a window, a money string), and forcing them into typed columns would put a
 * decimal point on a count. The detail sheets are the ones that carry numeric money.
 */
function buildWorkbook(options: {
    report: Awaited<ReturnType<typeof getDashboardReport>>;
    orders: Awaited<ReturnType<typeof loadDashboardReportOrderRows>>;
    refunds: Awaited<ReturnType<typeof loadDashboardReportRefundRows>>;
    settlements: {
        allowed: boolean;
        truncated: boolean;
        rows: DashboardReportSettlementRow[];
    };
    generatedAt: string;
}): XlsxSheet[] {
    const { report, orders, refunds, settlements } = options;

    const eventFilterLabel =
        report.eventOptions.find((event) => event.id === report.filters.eventId)?.title ??
        (report.filters.eventId ?? "Semua event");

    const summaryRows: [string, string][] = [
        summaryRow("Laporan", "Transaksi, penjualan tiket, refund, dan pencairan"),
        summaryRow("Periode", report.range.label),
        summaryRow("Dari", report.range.fromKey),
        summaryRow("Sampai", report.range.toKey),
        summaryRow("Granularitas", report.filters.granularity === "week" ? "Mingguan" : "Harian"),
        summaryRow("Filter event", eventFilterLabel),
        summaryRow(
            "Filter status pesanan",
            report.filters.orderStatus ?? "Semua status"
        ),
        summaryRow("Dibuat", options.generatedAt),
        summaryRow("", ""),
        summaryRow("Pesanan dibuat", String(report.summary.orders)),
        summaryRow("Pesanan lunas", String(report.summary.paidOrders)),
        summaryRow("Tiket terjual", String(report.summary.ticketsSold)),
        summaryRow("Pendapatan kotor", report.summary.revenue),
        summaryRow("Refund (jumlah)", String(report.summary.refunds)),
        summaryRow("Nilai refund", report.summary.refundAmount),
        summaryRow("Pendapatan bersih", report.summary.netRevenue),
        summaryRow("Rata-rata per pesanan lunas", report.summary.averageOrderValue),
        summaryRow("", ""),
        summaryRow("Baris pesanan diekspor", String(orders.rows.length)),
        summaryRow("Baris refund diekspor", String(refunds.rows.length)),
        summaryRow(
            "Baris pencairan diekspor",
            settlements.allowed ? String(settlements.rows.length) : "Tidak diizinkan"
        ),
        // The payout sheet is selected by period INTERSECTION rather than by a creation date, so
        // the rule is spelled out here: a reader comparing this tab's length with the others must
        // not have to guess which day a row was filtered on.
        summaryRow(
            "Cakupan sheet pencairan",
            settlements.allowed
                ? `Pencairan yang periodenya bersinggungan dengan ${report.range.fromKey} – ${report.range.toKey}`
                : "Tidak diizinkan"
        ),
    ];

    if (orders.truncated || refunds.truncated || settlements.truncated) {
        summaryRows.push(
            summaryRow(
                "Catatan",
                `Sebagian sheet dipotong pada ${DASHBOARD_REPORT_EXPORT_ROW_LIMIT} baris. Persempit periode atau filter.`
            )
        );
    }

    const methodRows = report.byMethod.map(
        (method) => [method.method, String(method.payments), method.amount] as [string, string, string]
    );

    const sheets: XlsxSheet[] = [
        {
            name: "Ringkasan",
            // The value column is deliberately UNTYPED. This block mixes units — a window, a
            // status, counts and money — and one column cannot have one number format without
            // printing a decimal point on a count. So its money stays the exact decimal STRING
            // that CSV uses, and the typed, summable money lives on the detail sheets below.
            columns: [
                { header: "Metrik", width: 30 },
                { header: "Nilai", width: 44 },
            ],
            rows: [...summaryRows, ["", ""], ["Metode pembayaran", "Transaksi"], ...methodRows.map(
                (row) => [row[0], `${row[1]} transaksi · ${row[2]}`] as [string, string]
            )],
        },
        {
            name: "Pesanan",
            columns: ORDERS_SHEET_COLUMNS,
            rows: orders.rows.map((row) => [
                row.orderNumber,
                row.createdAt,
                row.paidAt ?? "",
                row.eventTitle,
                row.organizerName,
                row.buyerName,
                row.buyerEmail ?? "",
                row.status,
                row.paymentStatus,
                row.subtotal,
                row.discount,
                row.total,
                row.currency,
            ]),
        },
        {
            name: "Penjualan Tiket",
            columns: EVENT_SHEET_COLUMNS,
            rows: report.byEvent.map((event) => [
                event.title,
                event.slug,
                event.paidOrders,
                event.ticketsSold,
                event.revenue,
                event.refundAmount,
                event.netRevenue,
            ]),
        },
        {
            name: "Refund",
            columns: REFUND_SHEET_COLUMNS,
            rows: refunds.rows.map((row) => [
                row.refundNumber,
                row.createdAt,
                row.completedAt ?? "",
                row.orderNumber,
                row.buyerName,
                row.eventTitle,
                row.status,
                row.requestedAmount,
                row.confirmedAmount,
                row.providerRef ?? "",
            ]),
        },
    ];

    // The payout sheet exists only for an actor who may settle: it is the one sheet whose rows come
    // from a DIFFERENT permission, and omitting it is how this module keeps that boundary visible
    // instead of silently widening `report.export.transaction`. Its rows are window-scoped by
    // period intersection — see `loadDashboardReportSettlementRows`.
    if (settlements.allowed) {
        sheets.push({
            name: "Pencairan",
            columns: SETTLEMENT_SHEET_COLUMNS,
            rows: settlements.rows.map((row) => [
                row.settlementNumber,
                row.createdAt,
                row.pic,
                row.picCode,
                row.organizerName,
                row.periodStart,
                row.periodEnd,
                row.grossAmount,
                row.deductionAmount,
                row.netAmount,
                row.status,
                row.bankName,
                row.bankAccountName,
                row.bankAccountNumber,
                row.providerReference,
                row.paidAt,
            ]),
        });
    }

    return sheets;
}

/* ── THE PAYOUT SHEET'S LOADER ───────────────────────────────────────────────── */

/**
 * How many settlements one page of the window scan asks for. Only a page size, not a cap: the scan
 * keeps paging until it has `limit` rows that fall in the window or the list is exhausted.
 */
const SETTLEMENT_SCAN_PAGE_SIZE = 500;

/**
 * Does a payout's own coverage period INTERSECT the report window?
 *
 * The window is inclusive on both ends (`to` is 23:59:59.999 +07:00 of its day), and so is the
 * test: a payout that ends exactly at the first instant of the window, or starts exactly at its
 * last, is in. A period is not a point, so intersection — not containment — is what keeps a
 * multi-day payout visible in a report that covers any part of it. An unparseable period is
 * dropped rather than widened: it cannot be proven to be inside the window.
 */
function settlementIntersectsWindow(
    periodStart: string,
    periodEnd: string,
    filters: DashboardReportFilters
): boolean {
    const start = new Date(periodStart).getTime();
    const end = new Date(periodEnd).getTime();

    if (Number.isNaN(start) || Number.isNaN(end)) {
        return false;
    }

    return start <= filters.to.getTime() && end >= filters.from.getTime();
}

/**
 * The Pencairan sheet's rows: settlements in the caller's settle scope whose period intersects the
 * report window, capped at `limit` with one-row over-fetch semantics.
 *
 * Authority is untouched — `listSettlements` re-decides `settlement.prepare` and resolves the
 * organizer scope from the session on EVERY page, so a forged `organizerId` is still a refusal and
 * a paging loop cannot widen the tenant boundary. The scan pages instead of asking for one huge
 * page because the window predicate is applied here, not in the query: a page large enough to hold
 * every out-of-window settlement would be exactly the all-time read this sheet must not perform.
 */
async function loadDashboardReportSettlementRows(
    scope: AuthzScope,
    filters: DashboardReportFilters,
    limit: number = DASHBOARD_REPORT_EXPORT_ROW_LIMIT
): Promise<{ rows: DashboardReportSettlementRow[]; truncated: boolean }> {
    const rows: DashboardReportSettlementRow[] = [];
    let truncated = false;
    let page = 1;

    for (;;) {
        const result = await listSettlements(scope, {
            page,
            limit: SETTLEMENT_SCAN_PAGE_SIZE,
            ...(filters.organizerId ? { organizerId: filters.organizerId } : {}),
        });

        for (const settlement of result.items) {
            if (!settlementIntersectsWindow(settlement.periodStart, settlement.periodEnd, filters)) {
                continue;
            }

            // The row one past the cap is the whole truncation test: it is never written, it only
            // proves the sheet was cut, so `truncated` is never a guess about the tenant's size.
            if (rows.length === limit) {
                truncated = true;
                break;
            }

            rows.push({
                settlementNumber: settlement.settlementNumber,
                createdAt: settlement.createdAt,
                pic: settlement.picDisplayName ?? "",
                picCode: settlement.picCode ?? "",
                organizerName: settlement.organizerName ?? "",
                periodStart: settlement.periodStart,
                periodEnd: settlement.periodEnd,
                grossAmount: settlement.grossAmount,
                deductionAmount: settlement.deductionAmount,
                netAmount: settlement.netAmount,
                status: settlement.status,
                bankName: settlement.bankName ?? "",
                bankAccountName: settlement.bankAccountName ?? "",
                // The payload's masked value — never the stored account number.
                bankAccountNumber: settlement.bankAccountNumber ?? "",
                providerReference: settlement.providerReference ?? "",
                paidAt: settlement.paidAt ?? "",
            });
        }

        if (truncated) {
            break;
        }

        // `total` counts every settlement in scope, not just the in-window ones, so it describes
        // the list being paged — which is exactly when there is nothing left to read.
        if (result.items.length === 0 || page * SETTLEMENT_SCAN_PAGE_SIZE >= result.total) {
            break;
        }

        page += 1;
    }

    return { rows, truncated };
}

/* ── THE EXPORT ──────────────────────────────────────────────────────────────── */

export async function exportDashboardReport(
    scope: AuthzScope,
    filters: DashboardReportFilters,
    format: DashboardReportExportFormat,
    options: { now?: Date } = {}
): Promise<DashboardReportExport> {
    const canRead = hasOrganizerPermission(scope, PERMISSIONS.REPORT_TRANSACTION_READ);
    const canExport = hasOrganizerPermission(scope, PERMISSIONS.REPORT_EXPORT_TRANSACTION);

    if (!canRead || !canExport) {
        throw AppError.forbidden(
            "Akun kamu tidak memiliki izin mengunduh laporan ini."
        );
    }

    const now = options.now ?? new Date();

    const report = await getDashboardReport(scope, filters);
    const orders = await loadDashboardReportOrderRows(scope, filters);
    const refunds = await loadDashboardReportRefundRows(scope, filters);

    /*
     * The payout sheet has its own authority (`settlement.prepare`), which is NOT implied by the
     * export permission. It is therefore included only when the actor may settle in the organizer
     * the export is scoped to — asked as a membership test rather than by passing the id into the
     * settlement service, because a refusal there would fail the WHOLE download over one optional
     * sheet. An actor with no settle scope simply gets a workbook without that tab.
     */
    const settleOrganizerIds = organizerIdsWith(
        scope,
        PERMISSIONS.SETTLEMENT_PREPARE
    );
    const canReadSettlements = filters.organizerId
        ? settleOrganizerIds.includes(filters.organizerId)
        : settleOrganizerIds.length > 0;

    const settlementScan = canReadSettlements
        ? await loadDashboardReportSettlementRows(scope, filters)
        : { rows: [] as DashboardReportSettlementRow[], truncated: false };

    const settlements = {
        allowed: canReadSettlements,
        truncated: settlementScan.truncated,
        rows: settlementScan.rows,
    };

    const stem = `laporan-transaksi-${filters.fromKey}_${filters.toKey}`;
    const sheets =
        format === "xlsx"
            ? buildWorkbook({
                  report,
                  orders,
                  refunds,
                  settlements,
                  generatedAt: now.toISOString(),
              })
            : [];

    const body: string | Uint8Array =
        format === "csv"
            ? withUtf8Bom(
                  toCsv(
                      DASHBOARD_REPORT_CSV_COLUMNS,
                      orders.rows.map((row) => orderRowToCsv(row))
                  )
              )
            : buildXlsx(sheets);

    const sheetNames =
        format === "csv" ? ["Pesanan"] : sheets.map((sheet) => sheet.name);

    const rowCount =
        format === "csv"
            ? orders.rows.length
            : sheets.reduce((total, sheet) => total + sheet.rows.length, 0);

    // A financial export is a READ that leaves the system, so it is recorded as such. Fire and
    // forget — the shared writer swallows failures — because a failed audit line must not fail a
    // download the actor is entitled to. The metadata is counts, filters and the SHEET NAMES: no
    // bank account, no buyer email, no credential.
    await writeTicketingAudit({
        action: "report.export.transaction",
        entityType: "Report",
        entityRef: filters.organizerId ?? "scoped",
        description: `Ekspor laporan transaksi (${format}, ${rowCount} baris)`,
        actor: scope,
        organizerId: filters.organizerId,
        afterState: {
            format,
            rowCount,
            sheets: sheetNames,
            from: filters.from.toISOString(),
            to: filters.to.toISOString(),
            eventId: filters.eventId,
            orderStatus: filters.orderStatus,
            truncated: orders.truncated || refunds.truncated || settlements.truncated,
        },
    });

    return {
        format,
        fileName: `${stem}.${format}`,
        contentType: format === "csv" ? "text/csv; charset=utf-8" : XLSX_CONTENT_TYPE,
        body,
        rowCount,
        sheets: sheetNames,
    };
}

export const __exportInternals = {
    buildWorkbook,
    orderRowToCsv,
    settlementIntersectsWindow,
    loadDashboardReportSettlementRows,
};
