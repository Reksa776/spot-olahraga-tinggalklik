/**
 * ==========================================
 * DASHBOARD FILTER WIRING — VISIBLE PILL ROWS (STATIC)
 * ==========================================
 *
 * The dashboard's list filters are a row of visible PILL LINKS, not a `<select>`: every choice is on
 * screen, the applied one is highlighted, and a filter change is one click that the URL performs
 * before any JavaScript runs. This suite pins that wiring from the source, because this repository
 * has no DOM testing library and the properties that matter here are structural:
 *
 *   one row          every filter-bearing list renders `FilterBar` (the shared pill row), against its
 *                    own path;
 *   still server     no list page became a client component: no `useState`/`useEffect`/`fetch(` and no
 *                    `router.` in any page, and the pill row itself has no client boundary at all —
 *                    the ONE island is the search box, which must hold a draft;
 *   still scoped     no filter page reads a tenant id from the search params;
 *   still preserved  each page hands its filters AND its search term to `LinkPagination`;
 *   unions           the three NAMED UNIONS still emit REPEATED parameters
 *                    (`?status=PENDING&status=PROCESSING`, `?status=PUBLISHED&status=ONGOING`,
 *                    `?status=REQUESTED&status=PENDING_APPROVAL`) — the format the read models,
 *                    `LinkPagination` and the KPI deep links already use;
 *   reports          its date/event/status form keeps its native `<select>`s (it must work before
 *                    hydration) and its window shortcuts are a pill row again;
 *   keys             every pill is keyed by its stable option value, so a filter row cannot
 *                    reintroduce the "unique key" warning.
 *   output           the rows are rendered and asserted from their MARKUP, not only from source.
 */

// `@/lib/dashboard/reports` (which the option vocabulary reads its period list from) resolves its
// scope through `@/lib/authz`, which reaches the NextAuth instance. Nothing here reads a session.
jest.mock("@/auth", () => ({ auth: jest.fn() }));

// The search box navigates with `useRouter`. A `renderToStaticMarkup` render never calls it.
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));

import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { FilterBar } from "@/components/dashboard/filters/FilterBar";
import { FilterPills } from "@/components/dashboard/filters/FilterPills";
import { PeriodPills } from "@/components/dashboard/filters/PeriodPills";
import {
    buildFilterField,
    buildPeriodField,
    FILTER_ALL,
    type FilterField,
} from "@/components/dashboard/filters/filter-types";
import { EVENT_STATUS_LABELS, REPORT_PERIOD_KEYS, REPORT_PERIOD_LABELS } from "@/lib/dashboard/filter-options";
import { EVENT_ACTIVE_STATUSES, EVENT_STATUS_FILTERS } from "@/lib/events/status";

function read(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf-8");
}

/** Source with comments removed, so a doc comment cannot satisfy (or defeat) an assertion. */
function code(path: string): string {
    return read(path)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

const EVENTS_PAGE = "app/dashboard/events/page.tsx";
const ORDERS_PAGE = "app/dashboard/orders/page.tsx";
const PAYMENTS_PAGE = "app/dashboard/payments/page.tsx";
const REFUNDS_PAGE = "app/dashboard/refunds/page.tsx";
const SETTLEMENTS_PAGE = "app/dashboard/settlements/page.tsx";
const CUSTOMERS_PAGE = "app/dashboard/customers/page.tsx";
const USERS_PAGE = "app/dashboard/users/page.tsx";
const VENUES_PAGE = "app/dashboard/venues/page.tsx";
const GLOBAL_VENUES_PAGE = "app/dashboard/settings/venues/page.tsx";
const REPORTS_PAGE = "app/dashboard/reports/page.tsx";
const OVERVIEW_PAGE = "app/dashboard/page.tsx";

const FILTER_TYPES = "components/dashboard/filters/filter-types.ts";
const FILTER_BAR = "components/dashboard/filters/FilterBar.tsx";
const FILTER_PILLS = "components/dashboard/filters/FilterPills.tsx";
const PERIOD_PILLS = "components/dashboard/filters/PeriodPills.tsx";
const FILTER_SEARCH = "components/dashboard/filters/DashboardFilterSearch.tsx";
const REPORT_FILTERS = "components/dashboard/ReportFilters.tsx";

/** The list pages that render a filter row. */
const PILL_PAGES = [
    EVENTS_PAGE,
    ORDERS_PAGE,
    PAYMENTS_PAGE,
    REFUNDS_PAGE,
    SETTLEMENTS_PAGE,
];

/** Every filter-bearing page, including the ones whose only control is a search box. */
const ALL_FILTER_PAGES = [...PILL_PAGES, CUSTOMERS_PAGE];

/* ==================================================================================
 * 1. EVERY LIST PAGE RENDERS THE SHARED PILL BAR
 * ================================================================================== */

describe("every list page renders the shared pill filter bar", () => {
    it.each([
        [EVENTS_PAGE, "/dashboard/events"],
        [ORDERS_PAGE, "/dashboard/orders"],
        [PAYMENTS_PAGE, "/dashboard/payments"],
        [REFUNDS_PAGE, "/dashboard/refunds"],
        [SETTLEMENTS_PAGE, "/dashboard/settlements"],
    ])("%s renders the bar against its own path", (page, basePath) => {
        const source = code(page);

        expect(source).toContain("FilterBar");
        expect(source).toContain(`basePath="${basePath}"`);
        expect(source).toContain("buildFilterField");
        // The page's validated state is handed to the row, so a pill's href is built from it.
        expect(source).toContain("current={{");
    });

    it.each([
        [EVENTS_PAGE, "Status"],
        [ORDERS_PAGE, "Status pembayaran"],
        [PAYMENTS_PAGE, "Status pembayaran"],
        [REFUNDS_PAGE, "Status refund"],
        [SETTLEMENTS_PAGE, "Status pencairan"],
        [USERS_PAGE, "Peran"],
    ])("%s builds the intended pill field: %s", (page, label) => {
        expect(code(page)).toContain(`label: "${label}"`);
    });

    it.each(PILL_PAGES)("%s no longer renders a hand-rolled filter link", (page) => {
        // The pill row owns the markup; a page that still wrote its own `<Link href="/dashboard/...?">`
        // would be a second, drifting implementation of the active state.
        expect(code(page)).not.toContain("TextLink href={`/dashboard");
    });
});

/* ==================================================================================
 * 2. FILTERING REMAINS SERVER-SIDE
 * ================================================================================== */

describe("the filtering is still the server's", () => {
    it.each(ALL_FILTER_PAGES)("%s stays a server component", (page) => {
        const source = code(page);

        expect(source).not.toContain("useState");
        expect(source).not.toContain("useEffect");
        expect(source).not.toContain("fetch(");
        expect(source).not.toContain("router.");
        expect(source).not.toContain('"use client"');
    });

    it("the pill row has no client boundary — it is server-rendered HTML", () => {
        // The reason the row is pills: the filter is applied by the URL itself, before hydration.
        for (const file of [FILTER_BAR, FILTER_PILLS, PERIOD_PILLS]) {
            const source = code(file);

            expect({ file, client: source.includes('"use client"') }).toEqual({
                file,
                client: false,
            });
            expect({ file, state: source.includes("useState") }).toEqual({
                file,
                state: false,
            });
            expect({ file, router: source.includes("useRouter") }).toEqual({
                file,
                router: false,
            });
        }
    });

    it("the ONE client island is the search box, and it navigates the URL", () => {
        const source = code(FILTER_SEARCH);

        expect(source).toContain('"use client"');
        expect(source).toContain("useRouter");
        expect(source).toContain("router.push(");
        expect(source).toContain("applyFilterChange(basePath, current");
        // It never reads a row: the rows arrive already filtered from the page.
        expect(source).not.toContain("fetch(");
    });
});

/* ==================================================================================
 * 3. TENANT SAFETY — NO CLIENT-SUPPLIED TENANT
 * ================================================================================== */

describe("no filter page accepts a tenant from the client", () => {
    it.each([...ALL_FILTER_PAGES, REPORTS_PAGE, OVERVIEW_PAGE])(
        "%s never reads a tenant id from the URL",
        (page) => {
            expect(code(page)).not.toContain("params.organizerId");
        }
    );

    it("the shared filter module has no tenant concept of its own", () => {
        for (const file of [
            FILTER_TYPES,
            FILTER_BAR,
            FILTER_PILLS,
            PERIOD_PILLS,
            FILTER_SEARCH,
        ]) {
            const source = code(file);

            expect({ file, tenant: source.includes("organizerId") }).toEqual({
                file,
                tenant: false,
            });
            expect({ file, authz: source.includes("@/lib/authz") }).toEqual({
                file,
                authz: false,
            });
        }
    });
});

/* ==================================================================================
 * 4. SEARCH — THE ALREADY-SHIPPED `q` BECOMES VISIBLE
 * ================================================================================== */

describe("the search the read models already implemented is now visible", () => {
    it.each([
        [EVENTS_PAGE, "q,"],
        [ORDERS_PAGE, "q: params.q ?? null,"],
        [PAYMENTS_PAGE, "q: params.q ?? null,"],
        [REFUNDS_PAGE, "q: params.q ?? null,"],
        [CUSTOMERS_PAGE, "q: params.q ?? null,"],
    ])("%s forwards `q` to its scoped service", (page, forward) => {
        expect(code(page)).toContain(forward);
    });

    it.each([EVENTS_PAGE, ORDERS_PAGE, PAYMENTS_PAGE, REFUNDS_PAGE, CUSTOMERS_PAGE])(
        "%s renders a search field",
        (page) => {
            const source = code(page);

            expect(source).toContain("search={{");
            expect(source).toContain("value: params.q");
        }
    );

    it.each([EVENTS_PAGE, ORDERS_PAGE, PAYMENTS_PAGE, REFUNDS_PAGE, CUSTOMERS_PAGE])(
        "%s carries the search term through pagination",
        (page) => {
            expect(code(page)).toContain("q: params.q");
        }
    );

    it("the customers page forwards the term it previously dropped", () => {
        // Before standardization `listDashboardCustomers` accepted `q` and the page never read or
        // passed it, so the capability was unreachable from the product.
        expect(code(CUSTOMERS_PAGE)).toContain("listDashboardCustomers");
        expect(code(CUSTOMERS_PAGE)).toContain("q: params.q ?? null,");
    });

    it.each([
        // Both read models accepted `q` while no control existed; both now forward it unchanged.
        [VENUES_PAGE, "listVenues", "q: params.q ?? null,"],
        [GLOBAL_VENUES_PAGE, "listGlobalVenues", "{ q: params.q ?? null }"],
    ])("%s forwards the venue search to `%s`", (page, service, forward) => {
        const source = code(page);

        expect(source).toContain(service);
        expect(source).toContain(forward);
        expect(source).toContain('search={{');
    });

    it("the users page forwards role + search and paginates", () => {
        // `listManagedUsers` accepted `{ role, search, page }` and returned a pagination envelope
        // while the page called it with NO arguments — the 50-row cap silently hid the rest.
        const source = code(USERS_PAGE);

        expect(source).toContain("listManagedUsers(scope, {");
        expect(source).toContain("role: role ?? undefined,");
        expect(source).toContain("search: search ?? undefined,");
        expect(source).toContain("page,");
        expect(source).toContain("LinkPagination");
        expect(source).toContain("result.pagination.totalPages");
        // The search box uses the SERVICE's parameter name, not a second vocabulary.
        expect(source).toContain('name: "search"');
    });
});

/* ==================================================================================
 * 5. PAGINATION PRESERVES EVERY FILTER
 * ================================================================================== */

describe("pagination keeps the filters and the search term", () => {
    it.each([
        [EVENTS_PAGE, "status: statuses.length > 0 ? statuses : undefined"],
        [REFUNDS_PAGE, "status: statuses.length > 0 ? statuses : undefined"],
        [SETTLEMENTS_PAGE, "status: statuses.length > 0 ? statuses : undefined"],
        [ORDERS_PAGE, "status: status ?? undefined"],
        [ORDERS_PAGE, "paymentStatus: paymentStatus ?? undefined"],
        [USERS_PAGE, "role: role ?? undefined"],
        [USERS_PAGE, "search: search ?? undefined"],
        [PAYMENTS_PAGE, "status: status ?? undefined"],
    ])("%s hands `%s` to the pager", (page, expression) => {
        expect(code(page)).toContain(expression);
    });

    it("the payments pager carries the VALIDATED status, not the raw one", () => {
        // `orders` already did; `payments` used to re-emit `params.status`. Both now re-emit the
        // value the service actually queried with.
        const source = code(PAYMENTS_PAGE);

        expect(source).toContain("query={{ status: status ?? undefined, q: params.q }}");
        expect(source).not.toContain("status: params.status");
    });

    it("the pager itself was not changed", () => {
        // The repeated-parameter behaviour it already had is what keeps a union across pages.
        const primitives = code("components/dashboard/primitives.tsx");

        expect(primitives).toContain("params.append(key, String(entry))");
        expect(primitives).toContain("(string | number)[]");
    });
});

/* ==================================================================================
 * 6. FIGURE OUT WHICH OPTION IS ACTIVE — FROM THE VALIDATED STATE
 * ================================================================================== */

describe("the pill that is highlighted is the one the server queried with", () => {
    it("highlights nothing but 'Semua' when no status is filtered", () => {
        const field = eventsField([]);

        expect(field.value).toBe(FILTER_ALL);
        expect(field.options[0].label).toBe("Semua status");
    });

    it("highlights the member when exactly one status is filtered", () => {
        expect(eventsField(["DRAFT"]).value).toBe("DRAFT");
    });

    it("highlights the named union whatever order the URL listed it in", () => {
        expect(eventsField(["PUBLISHED", "ONGOING"]).value).toBe("active");
        expect(eventsField(["ONGOING", "PUBLISHED"]).value).toBe("active");
    });

    it("each page's field carries the union label its KPI tile links to", () => {
        expect(code(REFUNDS_PAGE)).toContain('label: "Perlu Ditangani"');
        expect(code(SETTLEMENTS_PAGE)).toContain('label: "Menunggu Persetujuan"');
        expect(code(EVENTS_PAGE)).toContain('label: "Aktif"');
    });
});

/* ==================================================================================
 * 7. ORDERS — THE TWO LIFECYCLES STAY DISTINCT
 * ================================================================================== */

describe("the orders filters keep the order status and the gateway status apart", () => {
    it("labels the payment filter as the gateway column and never as the order status", () => {
        const source = code(ORDERS_PAGE);

        expect(source).toContain('name: "paymentStatus"');
        // Both enum lists are still present, and the VALIDATED values are what reach the service.
        expect(source).toContain("VALID_STATUSES");
        expect(source).toContain("VALID_PAYMENT_STATUSES");
        expect(source).toContain("paymentStatus,");
        // The order status is forwarded (a KPI deep-links it) but has no control.
        expect(source).toContain("status,");
        expect(source).not.toContain('label: "Status pesanan"');
    });

    it("offers exactly ONE status row — the gateway column — plus search", () => {
        const source = code(ORDERS_PAGE);

        // One `buildFilterField` call: the payment status. The order-status and worklist rows are
        // gone from the surface (their rules are pinned in `orders-filter-surface.test.ts`).
        expect(source.match(/buildFilterField\(/g)?.length).toBe(1);
        expect(source).toContain('name: "paymentStatus"');
        expect(source).not.toContain('name: "review"');
        expect(source).not.toContain('name: "status"');
    });

    it("keeps `paymentStatus=PAID` distinct from `status=PAID` in the rendered hrefs", () => {
        const ordersPayment = buildFilterField({
            name: "paymentStatus",
            label: "Status pembayaran",
            allLabel: "Semua pembayaran",
            values: [],
            members: ["UNPAID", "PENDING", "PAID", "FAILED", "EXPIRED", "REFUNDED", "PARTIALLY_REFUNDED"],
            labels: { PAID: "Lunas" },
        });

        expect(ordersPayment.options.find((option) => option.value === "PAID")?.params).toEqual({
            paymentStatus: "PAID",
        });
    });
});

/* ==================================================================================
 * 8. REPORTS — NATIVE SELECTS FOR THE FORM, PILLS FOR THE WINDOW
 * ================================================================================== */

describe("reports keeps the mechanism its test pins", () => {
    it("the report filter bar is still NOT a client component", () => {
        expect(read(REPORT_FILTERS)).not.toContain('"use client"');
        expect(code(REPORT_FILTERS)).not.toContain("useState");
    });

    it("keeps the date/event/status GET form and its native selects", () => {
        const source = code(REPORT_FILTERS);

        expect(source).toContain('method="get"');
        expect(source).toContain('name="from"');
        expect(source).toContain('name="to"');
        expect(source).toContain('name="eventId"');
        expect(source).toContain('name="status"');
        expect(source).toContain("<select");
        expect(source).toContain("download.href");
    });

    it("renders the window shortcuts as a pill row again, not a form control", () => {
        const source = code(REPORT_FILTERS);

        expect(source).toContain("PeriodPills");
        // No period form, and no hidden `period` field: the shortcut is a link.
        expect(source).not.toContain("PeriodSelectForm");
        expect(source).not.toContain('name="period"');
    });

    it("never posts `from`/`to` alongside a shortcut", () => {
        // `resolveDashboardReportFilters` gives an explicit `from` precedence over a shortcut, so a
        // link that carried both would silently keep the OLD window when someone picked "7 hari".
        const reports = code(REPORTS_PAGE);

        expect(reports).toContain("resolveDashboardReportFilters");
        expect(reports).toContain("active: report.filters.period,");
        // The pill row is given ONLY the other filters, so `from`/`to` are dropped by the merge.
        expect(reports).not.toContain("PeriodSelectForm");
        expect(reports).not.toContain("REPORT_PERIOD_CUSTOM");
    });

    it("still reports an unrecognised period instead of forwarding it", () => {
        expect(code(REPORTS_PAGE)).toContain("requestedPeriod && !report.filters.period");
    });
});

/* ==================================================================================
 * 9. THE OVERVIEW — THE SAME PILL ROW, WITHOUT BECOMING A CLIENT PAGE
 * ================================================================================== */

describe("the overview's period is the same pill row", () => {
    it("renders the shortcuts as links instead of a period form", () => {
        const source = code(OVERVIEW_PAGE);

        expect(source).toContain("PeriodPills");
        expect(source).not.toContain("PeriodSelectForm");
        // The KPI navigation assertions (no onClick, no router) still hold — asserted in
        // `kpi-navigation.test.ts`; this is the same property, checked next to the control.
        expect(source).not.toContain("onClick");
        expect(source).not.toContain("router.push(");
    });
});

/* ==================================================================================
 * 10. KEYS — THE FILTER ROW CANNOT REINTRODUCE THE WARNING
 * ================================================================================== */

describe("the pill row keys every option", () => {
    it("keys each pill by its stable option value", () => {
        const source = code(FILTER_PILLS);

        expect(source).toContain("key={option.value}");
        expect(source).toContain("aria-current={active ? \"true\" : undefined}");
    });

    it("gives the active pill a visible treatment, not just an attribute", () => {
        const source = code(FILTER_PILLS);

        expect(source).toContain("border-primary bg-primary/10 font-semibold text-primary");
    });

    it("the builder cannot emit a duplicate or empty option value", () => {
        // A duplicate key is what the DataTable warning was about; the pill row keys by option value.
        for (const field of [
            eventsField([]),
            eventsField(["PUBLISHED", "ONGOING"]),
            eventsField(["DRAFT", "COMPLETED"]),
        ]) {
            const values = field.options.map((option) => option.value);

            expect(new Set(values).size).toBe(values.length);
            expect(values.every((value) => value !== "")).toBe(true);
        }
    });
});

/* ==================================================================================
 * 11. THE SHARED MODULE IS SERVER-SAFE
 * ================================================================================== */

describe("the shared filter module can be read by both sides", () => {
    it("is not a client module, so a server component can import its constants", () => {
        const source = read(FILTER_TYPES);

        expect(source).not.toContain('"use client"');
        expect(code(FILTER_TYPES)).not.toContain("useState");
    });

    it("pulls in no Prisma runtime and no React", () => {
        const source = code(FILTER_TYPES);

        // The type-only imports the option vocabulary needs are erased; a VALUE import of the
        // Prisma client would drag the database into the browser bundle.
        expect(source).not.toContain('from "@prisma/client"');
        expect(source).not.toContain("react");
    });

    it("declares the field/option contract the pages build their fields from", () => {
        const source = code(FILTER_TYPES);

        for (const name of [
            "export type FilterOption",
            "export type FilterField",
            "export const FILTER_ALL",
            "export function applyFilterChange",
            "export function buildFilterField",
            "export function buildPeriodField",
            "export function hasActiveFilter",
        ]) {
            expect(source).toContain(name);
        }
    });
});

/* ==================================================================================
 * 12. THE CONTROLS RENDER THEIR STATE IN THE STREAMED HTML
 * ==================================================================================
 *
 * Source inspection proves the wiring; this proves the OUTPUT. The whole point of a pill LINK is that
 * the filter is correct in the first byte of HTML — no hydration, no open dropdown, no state that can
 * disagree with the rows. `renderToStaticMarkup` is the tool the repository uses for that (there is no
 * jsdom here), and it is a real render of the real component.
 *
 * `createElement` rather than JSX: the suite is a `.ts` file, which is the repository's convention for
 * render tests.
 */

function eventsField(values: readonly string[]): FilterField {
    return buildFilterField({
        name: "status",
        label: "Status",
        allLabel: "Semua status",
        values,
        members: [...EVENT_STATUS_FILTERS],
        labels: EVENT_STATUS_LABELS,
        union: {
            value: "active",
            label: "Aktif",
            statuses: EVENT_ACTIVE_STATUSES,
        },
    });
}

describe("the pill rows render their state in the streamed HTML", () => {
    it("shows EVERY choice, not just the applied one", () => {
        const html = renderToStaticMarkup(
            createElement(FilterPills, {
                field: eventsField([]),
                basePath: "/dashboard/events",
                current: {},
            })
        );

        expect(html).toContain("Semua status");
        expect(html).toContain("Aktif");
        expect(html).toContain("Draft");
        expect(html).toContain("Dipublikasikan");
        expect(html).toContain("Diarsipkan");
    });

    it("marks the applied pill with `aria-current`, before any JavaScript", () => {
        const html = renderToStaticMarkup(
            createElement(FilterPills, {
                field: eventsField(["PUBLISHED", "ONGOING"]),
                basePath: "/dashboard/events",
                current: {},
            })
        );

        // The label is a link, and exactly one pill claims to be current.
        expect(html).toContain("Aktif");
        expect(html).toContain('aria-current="true"');
        expect(html.match(/aria-current="true"/g)?.length).toBe(1);
    });

    it("emits the union as a REPEATED query parameter", () => {
        const html = renderToStaticMarkup(
            createElement(FilterPills, {
                field: eventsField([]),
                basePath: "/dashboard/events",
                current: {},
            })
        );

        expect(html).toContain("status=PUBLISHED&amp;status=ONGOING");
    });

    it("preserves the other filters and the search term in every href", () => {
        const html = renderToStaticMarkup(
            createElement(FilterPills, {
                field: eventsField([]),
                basePath: "/dashboard/refunds",
                current: { q: "INV-1" },
            })
        );

        expect(html).toContain("q=INV-1");
    });

    it("returns to page 1 when a pill is picked", () => {
        const html = renderToStaticMarkup(
            createElement(FilterPills, {
                field: eventsField([]),
                basePath: "/dashboard/orders",
                current: { page: "7" },
            })
        );

        expect(html).not.toContain("page=7");
    });

    it("labels the row for a screen reader", () => {
        const html = renderToStaticMarkup(
            createElement(FilterPills, {
                field: eventsField([]),
                basePath: "/dashboard/events",
                current: {},
            })
        );

        expect(html).toContain('aria-label="Status"');
    });

    it("offers the reset affordance only while a filter is applied", () => {
        const unfiltered = renderToStaticMarkup(
            createElement(FilterBar, {
                basePath: "/dashboard/events",
                fields: [eventsField([])],
                current: {},
            })
        );

        expect(unfiltered).not.toContain("Reset filter");

        const filtered = renderToStaticMarkup(
            createElement(FilterBar, {
                basePath: "/dashboard/events",
                fields: [eventsField(["PUBLISHED", "ONGOING"])],
                current: {},
            })
        );

        expect(filtered).toContain("Reset filter");
    });

    it("captions each row only when there is more than one", () => {
        const single = renderToStaticMarkup(
            createElement(FilterBar, {
                basePath: "/dashboard/events",
                fields: [eventsField([])],
                current: {},
            })
        );

        // One row reads as a row of pills; a caption above a single group is noise.
        expect(single).not.toContain('class="text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground">Status<');

        const rows = renderToStaticMarkup(
            createElement(FilterBar, {
                basePath: "/dashboard/orders",
                fields: [
                    eventsField([]),
                    buildFilterField({
                        name: "paymentStatus",
                        label: "Status pembayaran",
                        allLabel: "Semua pembayaran",
                        values: [],
                        members: ["PAID"],
                        labels: { PAID: "Lunas" },
                    }),
                ],
                current: {},
            })
        );

        expect(rows).toContain("Status pembayaran");
        expect(rows).toContain("Semua pembayaran");
    });

    it("renders the search box with the applied term, and treats it as active state", () => {
        const html = renderToStaticMarkup(
            createElement(FilterBar, {
                basePath: "/dashboard/orders",
                fields: [],
                current: { q: "INV-1" },
                search: {
                    label: "Cari pesanan",
                    placeholder: "Nomor pesanan, pembeli, atau email",
                    value: "INV-1",
                },
            })
        );

        expect(html).toContain('value="INV-1"');
        expect(html).toContain("Cari pesanan");
        expect(html).toContain("Reset filter");
    });

    it("renders an empty search box with no reset link when the list is unfiltered", () => {
        const html = renderToStaticMarkup(
            createElement(FilterBar, {
                basePath: "/dashboard/customers",
                fields: [],
                current: {},
                search: { label: "Cari pelanggan", value: undefined },
            })
        );

        expect(html).toContain("Cari pelanggan");
        expect(html).not.toContain("Reset filter");
    });

    it("renders the period shortcuts as links that REPLACE a custom range", () => {
        const html = renderToStaticMarkup(
            createElement(PeriodPills, {
                basePath: "/dashboard/reports",
                active: "7d",
                current: { eventId: "evt_1", status: "PAID" },
            })
        );

        expect(html).toContain("7 hari");
        expect(html).toContain("30 hari");
        expect(html).toContain("3 bulan");
        // The other filters ride along…
        expect(html).toContain("eventId=evt_1");
        expect(html).toContain("status=PAID");
        // …and the shortcut carries no `from`/`to`, so the explicit range cannot win inside the parser.
        expect(html).not.toContain("from=");
        expect(html).not.toContain("to=");
        // The applied window is marked.
        expect(html).toContain('aria-current="true"');
    });

    it("marks NO shortcut while an explicit range is in force", () => {
        const html = renderToStaticMarkup(
            createElement(PeriodPills, {
                basePath: "/dashboard",
                active: null,
                current: {},
            })
        );

        expect(html).toContain("7 hari");
        expect(html).not.toContain('aria-current="true"');
    });

    it("offers no 'all' option on the period row — a window is always a range", () => {
        const field = buildPeriodField({
            active: null,
            keys: REPORT_PERIOD_KEYS,
            labels: REPORT_PERIOD_LABELS,
        });

        expect(field.options.map((option) => option.value)).toEqual([
            ...REPORT_PERIOD_KEYS,
        ]);
        expect(field.options.some((option) => option.value === FILTER_ALL)).toBe(false);
    });
});
