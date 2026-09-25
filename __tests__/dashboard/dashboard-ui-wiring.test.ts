/**
 * ==========================================
 * DASHBOARD REPORTING — WIRING (STATIC)
 * ==========================================
 *
 * The architectural contract of the new reporting surfaces, checked from the source rather than
 * from a render: this repository has no DOM testing library, and the properties that matter here
 * are structural anyway.
 *
 * What it pins:
 *
 *   server-side data   the pages read the scoped read model directly (no client fetch, no second
 *                      API over the same rows) and the export route calls the same module;
 *   authority          authorization is asked of the permission deciders, never of a role string;
 *   read-only          the reporting layer contains no mutation of business state;
 *   one filter parser  the page (lenient) and the endpoint (strict) use the SAME function;
 *   exact window       a download link carries the RESOLVED day keys, so the file covers exactly
 *                      the window on screen even if "now" moves before the click;
 *   token colours      every chart consumes the chart palette and names no colour of its own.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf-8");
}

/** Source with comments removed, so a doc comment cannot satisfy (or defeat) an assertion. */
function code(path: string): string {
    return read(path)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

const REPORTS_PAGE = "app/dashboard/reports/page.tsx";
const DASHBOARD_PAGE = "app/dashboard/page.tsx";
const FILTER_BAR = "components/dashboard/ReportFilters.tsx";
const CHARTS = "components/dashboard/charts.tsx";
const EXPORT_ROUTE = "app/api/organizer/reports/export/route.ts";
const REPORTS_LIB = "lib/dashboard/reports.ts";
const EXPORT_LIB = "lib/dashboard/export.ts";
const ACTIVITY_LIB = "lib/dashboard/activity.ts";
const OVERVIEW_LIB = "lib/dashboard/overview.ts";

describe("the reports page reads the scoped read model on the server", () => {
    it("queries through getDashboardReport and parses its filters with the shared parser", () => {
        const source = code(REPORTS_PAGE);

        expect(source).toContain("getDashboardReport");
        expect(source).toContain("resolveDashboardReportFilters");
        expect(source).toContain("getAuthzScope");
        // No client-side data fetching: the page is a server component and its numbers are already
        // in the payload before any JavaScript runs.
        expect(source).not.toContain("useEffect");
        expect(source).not.toContain("fetch(");
    });

    it("offers the summary KPIs, the per-event report table and the payment breakdown", () => {
        const source = code(REPORTS_PAGE);

        expect(source).toContain("StatCard");
        expect(source).toContain("Performa event");
        expect(source).toContain("Metode pembayaran");
        expect(source).toContain("Distribusi status pesanan");
        // The refund and net columns were added to the per-event table.
        expect(source).toContain("event.refundAmount");
        expect(source).toContain("event.netRevenue");
    });

    it("renders both download actions against the export endpoint", () => {
        const source = code(REPORTS_PAGE);

        expect(source).toContain("Download CSV");
        expect(source).toContain("Download Excel");
        expect(source).toContain("/api/organizer/reports/export");
        expect(source).toContain('format: "csv"');
        expect(source).toContain('format: "xlsx"');
    });

    it("carries the RESOLVED window into the download link, not the period shortcut", () => {
        const source = code(REPORTS_PAGE);

        // The endpoint re-resolves `period` against its own clock, so a link that carried "3m"
        // could cover a different window than the one on screen. Day keys cannot drift.
        expect(source).toContain("report.range.fromKey");
        expect(source).toContain("report.range.toKey");
        expect(source).toContain("report.filters.eventId");
        expect(source).toContain("report.filters.orderStatus");
    });

    it("gates the download buttons on the export permission, not on a role", () => {
        const source = code(REPORTS_PAGE);

        expect(source).toContain("PERMISSIONS.REPORT_EXPORT_TRANSACTION");
        expect(source).toContain("PERMISSIONS.REPORT_TRANSACTION_READ");
        expect(source).toContain("hasOrganizerPermission");
    });

    it("ignores an unusable filter visibly rather than throwing inside the render", () => {
        const source = code(REPORTS_PAGE);

        expect(source).toContain("report.filters.clamped");
        expect(source).toContain("report.filters.rangeFallback");
        expect(source).toContain("notices");
    });
});

describe("the filter bar is a server-rendered GET form", () => {
    it("uses a plain form and native dropdowns so the window lives in the URL", () => {
        const source = code(FILTER_BAR);

        expect(source).toContain('method="get"');
        expect(source).toContain('name="from"');
        expect(source).toContain('name="to"');
        expect(source).toContain('name="eventId"');
        expect(source).toContain('name="status"');
        // Native selects, deliberately: a hydrated-only control would silently submit the wrong
        // window on a fresh load.
        expect(source).toContain("<select");
        expect(source).not.toContain("useState");
    });

    it("uses a plain anchor for a download, because a navigation cannot honour the attachment", () => {
        const source = code(FILTER_BAR);

        expect(source).toContain("<a");
        expect(source).toContain("download.href");
    });

    it("is not a client component — it must work before hydration", () => {
        expect(read(FILTER_BAR)).not.toContain('"use client"');
    });
});

describe("the dashboard overview shows operational KPIs, charts and recent activity", () => {
    it("reads all three scoped models", () => {
        const source = code(DASHBOARD_PAGE);

        expect(source).toContain("getDashboardOverview");
        expect(source).toContain("getDashboardReport");
        expect(source).toContain("getDashboardActivity");
    });

    it("renders the four operational charts", () => {
        const source = code(DASHBOARD_PAGE);

        expect(source).toContain("SalesTrendChart");
        expect(source).toContain("RevenueRefundChart");
        expect(source).toContain("OrderStatusChart");
        expect(source).toContain("EventPerformanceChart");
    });

    it("offers a selectable period AND a custom date range", () => {
        const source = code(DASHBOARD_PAGE);

        expect(source).toContain("DASHBOARD_REPORT_PERIODS");
        expect(source).toContain("period=");
        expect(source).toContain('type="date"');
        expect(source).toContain("resolveDashboardReportFilters");
    });

    it("gates the charts on the report read permission and says so instead of plotting zeroes", () => {
        const source = code(DASHBOARD_PAGE);

        expect(source).toContain("canReadTransactionReport");
        expect(source).toContain("PERMISSIONS.REPORT_TRANSACTION_READ");
        // The explanatory note replaces the series when the permission is absent.
        expect(source).toContain("bukan berarti tidak ada penjualan");
    });

    it("shows the refund and settlement standing the brief asks for", () => {
        const source = code(DASHBOARD_PAGE);

        expect(source).toContain("Refund perlu ditangani");
        expect(source).toContain("Pencairan menunggu");
        expect(source).toContain("tenant?.refundsPending");
        expect(source).toContain("settlements.awaiting");
    });

    it("renders the three recent-activity panels with an explicit no-access state", () => {
        const source = code(DASHBOARD_PAGE);

        expect(source).toContain("Pesanan terbaru");
        expect(source).toContain("Refund terbaru");
        expect(source).toContain("Pencairan terbaru");
        expect(source).toContain("panel.allowed");
    });
});

describe("the charts consume the chart palette and never invent data", () => {
    it("is a client component built on the shadcn chart container", () => {
        const source = read(CHARTS);

        expect(source).toContain('"use client"');
        expect(source).toContain("ChartContainer");
        expect(source).toContain("@/components/dashboard/ui/chart");
    });

    it("paints only through palette tokens", () => {
        const source = code(CHARTS);

        expect(source).toContain("var(--chart-1)");
        expect(source).toContain("var(--color-");
        expect(/#[0-9a-fA-F]{6}/.test(source)).toBe(false);
    });

    it("renders an explicit empty state rather than an axis of zeroes", () => {
        const source = code(CHARTS);

        // Four charts, four empty states.
        expect(source.match(/EmptyBlock/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
        expect(source).toContain("Belum ada");
    });

    it("never queries: the data arrives as props", () => {
        const source = code(CHARTS);

        expect(source).not.toContain("prisma");
        expect(source).not.toContain("@/lib/authz");
        expect(source).not.toContain("@/lib/dashboard/reports");
    });

    it("formats money through the shared formatter", () => {
        expect(code(CHARTS)).toContain("formatIdr");
    });
});

describe("the export endpoint is authorized, strict and read-only", () => {
    it("declares the Node runtime, because the archive is deflated with node:zlib", () => {
        const source = code(EXPORT_ROUTE);

        expect(source).toContain('runtime = "nodejs"');
    });

    it("resolves the session and parses the query in strict mode", () => {
        const source = code(EXPORT_ROUTE);

        expect(source).toContain("requireAuth");
        expect(source).toContain("resolveDashboardReportFilters");
        expect(source).toContain("strict: true");
        expect(source).toContain("parseDashboardReportExportFormat");
    });

    it("delegates the authority decision to the service, not to the route", () => {
        const source = code(EXPORT_ROUTE);

        expect(source).toContain("exportDashboardReport");
        // The route must not decide access itself, and must not read a role.
        expect(source).not.toContain("platformRole");
        expect(source).not.toContain("user.role");
    });

    it("answers as a download with the type pinned and sniffing off", () => {
        const source = code(EXPORT_ROUTE);

        expect(source).toContain("Content-Disposition");
        expect(source).toContain("attachment");
        expect(source).toContain("X-Content-Type-Options");
        expect(source).toContain("nosniff");
        expect(source).toContain("no-store");
    });
});

describe("the reporting layer is a read model", () => {
    it("authorizes with the permission deciders, never with a role string", () => {
        for (const file of [REPORTS_LIB, EXPORT_LIB, ACTIVITY_LIB, OVERVIEW_LIB]) {
            const source = code(file);

            expect({ file, role: /\.role\s*===/.test(source) }).toEqual({ file, role: false });
            expect({ file, platform: source.includes("platformRole ===") }).toEqual({
                file,
                platform: false,
            });
        }

        expect(code(REPORTS_LIB)).toContain("resolveOrganizerFilter");
        expect(code(REPORTS_LIB)).toContain("PERMISSIONS.REPORT_TRANSACTION_READ");
        expect(code(EXPORT_LIB)).toContain("hasOrganizerPermission");
        expect(code(EXPORT_LIB)).toContain("PERMISSIONS.REPORT_TRANSACTION_READ");
        expect(code(EXPORT_LIB)).toContain("PERMISSIONS.REPORT_EXPORT_TRANSACTION");
        // A refusal is a 403, never an empty file an operator would read as "no sales".
        expect(code(EXPORT_LIB)).toContain("AppError.forbidden");
    });

    it("never mutates business state", () => {
        for (const file of [REPORTS_LIB, EXPORT_LIB, ACTIVITY_LIB, OVERVIEW_LIB]) {
            const source = code(file);

            expect({ file, create: /\.create\(/.test(source) }).toEqual({ file, create: false });
            expect({ file, update: /prisma\.[a-zA-Z]+\.update/.test(source) }).toEqual({
                file,
                update: false,
            });
            expect({ file, delete: /\.deleteMany\(|\.delete\(/.test(source) }).toEqual({
                file,
                delete: false,
            });
        }
    });

    it("keeps money in Decimal and the exact string, never floating point", () => {
        const source = code(REPORTS_LIB);

        expect(source).toContain("Prisma.Decimal");
        expect(source).toContain(".minus(");
        expect(source).toContain("toFixed(2)");
        expect(source).not.toContain("parseFloat");
    });

    it("produces the export from the SAME read model the screen renders", () => {
        const reports = code(REPORTS_LIB);
        const exporter = code(EXPORT_LIB);

        // The builders live in the read model...
        for (const builder of [
            "buildDashboardReportOrderWhere",
            "buildDashboardReportPaidWhere",
            "buildDashboardReportTicketWhere",
            "buildDashboardReportRefundWhere",
        ]) {
            expect(reports).toContain(builder);
        }

        // ...and the exporter goes through the loaders that use them, so the download and the
        // screen cannot describe different filter sets.
        expect(exporter).toContain("getDashboardReport");
        expect(exporter).toContain("loadDashboardReportOrderRows");
        expect(exporter).toContain("loadDashboardReportRefundRows");
        // It owns no query of its own.
        expect(code(EXPORT_LIB)).not.toContain("prisma");
    });

    it("exports the workbook with the dependency-free writer, not a new library", () => {
        const source = code(EXPORT_LIB);

        expect(source).toContain('from "@/lib/xlsx"');
        expect(source).toContain("buildXlsx");
        expect(source).toContain('from "@/lib/csv"');
        // The CSV path keeps its escaping/neutralisation helpers.
        expect(source).toContain("toCsv");
        expect(source).toContain("withUtf8Bom");
        expect(JSON.parse(read("package.json")).dependencies).not.toHaveProperty("exceljs");
        expect(JSON.parse(read("package.json")).dependencies).not.toHaveProperty("xlsx");
    });

    it("records the download in the audit log", () => {
        const source = code(EXPORT_LIB);

        expect(source).toContain('action: "report.export.transaction"');
        expect(source).toContain("writeTicketingAudit");
        expect(source).toContain('entityType: "Report"');
    });

    it("builds the recent-activity panels from the existing scoped services", () => {
        const source = code(ACTIVITY_LIB);

        expect(source).toContain("listDashboardOrders");
        expect(source).toContain("listDashboardRefunds");
        expect(source).toContain("listSettlements");
        // It owns no query of its own.
        expect(source).not.toContain("prisma");
    });

    it("reads refunds under the same permission the refunds board uses", () => {
        const source = code(OVERVIEW_LIB);

        expect(source).toContain("prisma.refund.groupBy");
        expect(source).toContain("canReadOrders");
        expect(source).toContain("PERMISSIONS.SETTLEMENT_PREPARE");
    });
});

describe("the reporting surface ships tests with itself", () => {
    it("is enrolled in the jest testMatch list", () => {
        expect(read("jest.config.js")).toContain("**/__tests__/dashboard/*.test.ts");
    });
});
