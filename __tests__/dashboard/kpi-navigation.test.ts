/**
 * ==========================================
 * DASHBOARD KPI NAVIGATION + CONTEXTUAL FILTERING
 * ==========================================
 *
 * The audit that preceded this work found that the eight KPI tiles were inert numbers, and that
 * three of their definitions (the "event aktif" union, the paid orders behind "tiket terjual", and
 * the "perlu ditangani" / "menunggu persetujuan" worklists) could not be expressed by any existing
 * filter. This suite pins the contract the tiles now depend on:
 *
 *   navigation   every tile is a semantic `<Link>` to an audited destination (no click handler,
 *                no `router.push`, no client state);
 *   vocabulary   "aktif" is exactly PUBLISHED ∪ ONGOING, "perlu ditangani" is exactly
 *                PENDING ∪ PROCESSING, "menunggu persetujuan" is exactly REQUESTED ∪ PENDING_APPROVAL
 *                — the same unions the overview read model counts;
 *   parity       each destination filters on the SAME predicate the KPI counts (order status vs
 *                gateway payment status stay distinct);
 *   plumbing     repeated `?status=` values are validated before they reach Prisma, queried with
 *                `IN`, and preserved through pagination;
 *   tenancy      the new filters narrow an already-scoped query and never read `organizerId` from
 *                the URL.
 *
 * It follows the repository's convention for the dashboard surface: the properties that matter are
 * structural, so they are asserted from the source (this suite has no DOM testing library) plus the
 * pure parsers, which are exercised directly.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// `lib/dashboard/refunds` resolves its scope through `@/lib/authz`, which reaches the NextAuth
// instance. The read model is imported for a constant only, so the auth module is stubbed the same
// way every other suite that touches the dashboard read models stubs it.
jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { applyFilterChange } from "@/components/dashboard/filters/filter-types";
import { REFUND_NEEDS_HANDLING_STATUSES } from "@/lib/dashboard/refunds";
import {
    EVENT_ACTIVE_STATUSES,
    EVENT_STATUS_FILTERS,
    isEventActiveStatusFilter,
    parseEventStatusFilters,
} from "@/lib/events/status";
import { SETTLEMENT_AWAITING_APPROVAL_STATUSES } from "@/lib/ticketing/settlement/validation";

const DASHBOARD_PAGE = "app/dashboard/page.tsx";
const OVERVIEW_LIB = "lib/dashboard/overview.ts";
const EVENTS_PAGE = "app/dashboard/events/page.tsx";
const EVENTS_SERVICE = "lib/events/service.ts";
const ORDERS_PAGE = "app/dashboard/orders/page.tsx";
const ORDERS_LIB = "lib/dashboard/orders.ts";
const REFUNDS_PAGE = "app/dashboard/refunds/page.tsx";
const REFUNDS_LIB = "lib/dashboard/refunds.ts";
const SETTLEMENTS_PAGE = "app/dashboard/settlements/page.tsx";
const SETTLEMENTS_SERVICE = "lib/ticketing/settlement/service.ts";
const PRIMITIVES = "components/dashboard/primitives.tsx";

function read(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf-8");
}

/** Source with comments removed, so a doc comment cannot satisfy (or defeat) an assertion. */
function code(path: string): string {
    return read(path)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

/* ------------------------------------------------------------------------------------------------
 * A. KPI CARD NAVIGATION
 * ------------------------------------------------------------------------------------------------
 */

describe("the eight KPI cards navigate to the audited destinations", () => {
    const EXPECTED_HREFS = [
        "/dashboard/events",
        "/dashboard/events?status=PUBLISHED&status=ONGOING",
        "/dashboard/orders",
        "/dashboard/orders?paymentStatus=PAID",
        "/dashboard/reports",
        "/dashboard/orders?status=PENDING_PAYMENT",
        "/dashboard/refunds?status=PENDING&status=PROCESSING",
        "/dashboard/settlements?status=REQUESTED&status=PENDING_APPROVAL",
    ];

    it("renders all eight tiles as links to those URLs", () => {
        const source = code(DASHBOARD_PAGE);

        for (const href of EXPECTED_HREFS) {
            expect(source).toContain(`href="${href}"`);
        }

        // At least the eight KPI tiles, each wrapped in its own link (the platform block adds a
        // few more tiles below them, which intentionally stay non-navigational).
        expect(source.match(/<StatCard\b/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
        expect(source.match(/<Link\b/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
    });

    it("uses semantic links rather than click handlers or imperative navigation", () => {
        const source = code(DASHBOARD_PAGE);

        expect(source).not.toContain("onClick");
        expect(source).not.toContain("window.location");
        expect(source).not.toMatch(/router\.(push|replace)\(/);
    });

    it("does not add an href prop to the shared StatCard primitive", () => {
        // The navigation is dashboard-specific; the primitive stays presentational. Asserted on the
        // StatCard body only, because the file's other components legitimately own their own links.
        const primitives = code(PRIMITIVES);
        const statCard = primitives.slice(
            primitives.indexOf("export function StatCard"),
            primitives.indexOf("export function StatGrid")
        );

        expect(statCard).not.toContain("href");
    });
});

/* ------------------------------------------------------------------------------------------------
 * B. EVENTS — PUBLISHED ∪ ONGOING
 * ------------------------------------------------------------------------------------------------
 */

describe("the events list represents the 'event aktif' union", () => {
    it("keeps the active definition exactly PUBLISHED + ONGOING", () => {
        expect([...EVENT_ACTIVE_STATUSES]).toEqual(["PUBLISHED", "ONGOING"]);
    });

    it("still exposes every individual status", () => {
        expect([...EVENT_STATUS_FILTERS]).toEqual([
            "DRAFT",
            "PUBLISHED",
            "ONGOING",
            "COMPLETED",
            "CANCELLED",
            "ARCHIVED",
        ]);
    });

    it("normalises a single value, a repeated value, and drops everything unknown", () => {
        expect(parseEventStatusFilters("PUBLISHED")).toEqual(["PUBLISHED"]);
        expect(parseEventStatusFilters(["PUBLISHED", "ONGOING"])).toEqual([
            "PUBLISHED",
            "ONGOING",
        ]);
        // An unknown string would make Prisma raise on the enum — it must never pass through.
        expect(
            parseEventStatusFilters(["PUBLISHED", "NOPE", "PENDING_REVIEW"])
        ).toEqual(["PUBLISHED"]);
        expect(parseEventStatusFilters(["ONGOING", "ONGOING"])).toEqual(["ONGOING"]);
        expect(parseEventStatusFilters(undefined)).toEqual([]);
        expect(parseEventStatusFilters([])).toEqual([]);
    });

    it("recognises the active union regardless of the order the values arrive in", () => {
        expect(isEventActiveStatusFilter(["PUBLISHED", "ONGOING"])).toBe(true);
        expect(isEventActiveStatusFilter(["ONGOING", "PUBLISHED"])).toBe(true);
        expect(isEventActiveStatusFilter(["PUBLISHED"])).toBe(false);
        expect(isEventActiveStatusFilter([])).toBe(false);
    });

    it("queries `status IN (...)` from the validated list", () => {
        expect(code(EVENTS_SERVICE)).toContain("status: { in: params.statuses }");
        // The single-value API contract is preserved for the JSON endpoint.
        expect(code(EVENTS_SERVICE)).toContain("status: params.status");
    });

    it("reads repeated params and renders the 'Aktif' option", () => {
        const page = code(EVENTS_PAGE);

        expect(page).toContain("parseEventStatusFilters");
        expect(page).toContain("isEventActiveStatusFilter");
        expect(page).toContain("Aktif");

        /*
         * FILTER STANDARDIZATION — where this assertion lives now.
         *
         * The events list renders the status filter as a single dropdown option instead of a row of
         * links, so the union's repeated-parameter URL is produced by the shared filter builder
         * rather than written out in the page. The guarantee is unchanged and is now checked at both
         * ends: the page still builds the union from `EVENT_ACTIVE_STATUSES` (so the option and the
         * KPI tile cannot disagree), and the builder still turns it into exactly
         * `status=PUBLISHED&status=ONGOING` — the format the parser, the service and the pager read.
         */
        expect(page).toContain("EVENT_ACTIVE_STATUSES");

        expect(
            applyFilterChange("/dashboard/events", {}, {
                status: [...EVENT_ACTIVE_STATUSES],
            })
        ).toBe("/dashboard/events?status=PUBLISHED&status=ONGOING");
    });
});

/* ------------------------------------------------------------------------------------------------
 * C. ORDERS — ORDER STATUS vs GATEWAY PAYMENT STATUS
 * ------------------------------------------------------------------------------------------------
 */

describe("orders filter by gateway payment status without touching the order-status filter", () => {
    it("filters the real paymentStatus column and ANDs it with the order status", () => {
        const orders = code(ORDERS_LIB);

        expect(orders).toContain("paymentStatus?: PaymentStatus");
        expect(orders).toContain("paymentStatus: params.paymentStatus");
        // Both predicates are sibling keys of the same `where`, so one narrows the other rather
        // than replacing it.
        expect(orders).toContain("...(params.status ? { status: params.status } : {})");
        expect(orders).toContain("...(params.paymentStatus");
    });

    it("validates the payment status value before it reaches Prisma", () => {
        const page = code(ORDERS_PAGE);

        expect(page).toContain("parsePaymentStatus");
        expect(page).toContain("VALID_PAYMENT_STATUSES");
        // The 'tiket terjual' destination.
        expect(page).toContain('"PAID"');
    });

    it("preserves both filters through pagination", () => {
        const page = code(ORDERS_PAGE);

        expect(page).toContain("status: status ?? undefined");
        expect(page).toContain("paymentStatus: paymentStatus ?? undefined");
    });
});

/* ------------------------------------------------------------------------------------------------
 * D. REFUNDS — PERLU DITANGANI (PENDING ∪ PROCESSING)
 * ------------------------------------------------------------------------------------------------
 */

describe("refunds expose the 'Perlu Ditangani' worklist", () => {
    it("defines the worklist as exactly PENDING + PROCESSING", () => {
        expect([...REFUND_NEEDS_HANDLING_STATUSES]).toEqual(["PENDING", "PROCESSING"]);
    });

    it("queries a validated status list with IN semantics", () => {
        expect(code(REFUNDS_LIB)).toContain("statuses?: RefundStatus");
        expect(code(REFUNDS_LIB)).toContain("status: { in: params.statuses }");
    });

    it("renders the worklist option and keeps the individual lifecycle filters", () => {
        const page = code(REFUNDS_PAGE);

        expect(page).toContain("Perlu Ditangani");
        expect(page).toContain("REFUND_NEEDS_HANDLING_STATUSES");
        expect(page).toContain("parseStatuses");

        for (const status of [
            "PENDING",
            "APPROVED",
            "REJECTED",
            "PROCESSING",
            "REFUNDED",
            "FAILED",
        ]) {
            expect(page).toContain(`"${status}"`);
        }
    });
});

/* ------------------------------------------------------------------------------------------------
 * E. SETTLEMENTS — MENUNGGU PERSETUJUAN (REQUESTED ∪ PENDING_APPROVAL)
 * ------------------------------------------------------------------------------------------------
 */

describe("settlements expose the 'Menunggu Persetujuan' worklist", () => {
    it("defines the queue as exactly REQUESTED + PENDING_APPROVAL", () => {
        expect([...SETTLEMENT_AWAITING_APPROVAL_STATUSES]).toEqual([
            "REQUESTED",
            "PENDING_APPROVAL",
        ]);
    });

    it("queries a validated status list with IN semantics", () => {
        expect(code(SETTLEMENTS_SERVICE)).toContain("status: { in: query.statuses }");
    });

    it("renders the queue option and keeps the individual lifecycle filters", () => {
        const page = code(SETTLEMENTS_PAGE);

        expect(page).toContain("Menunggu Persetujuan");
        expect(page).toContain("SETTLEMENT_AWAITING_APPROVAL_STATUSES");
        expect(page).toContain("parseStatuses");
        expect(page).toContain("SETTLEMENT_STATUSES");
    });
});

/* ------------------------------------------------------------------------------------------------
 * F. PESANAN BREAKDOWN
 * ------------------------------------------------------------------------------------------------
 */

describe("the overview exposes the Pesanan breakdown without changing the total", () => {
    it("counts cancelled and expired from one grouped read", () => {
        const overview = code(OVERVIEW_LIB);

        expect(overview).toContain("prisma.eventOrder.groupBy");
        expect(overview).toContain('by: ["status"]');
        expect(overview).toContain('orderCount("PENDING_PAYMENT")');
        expect(overview).toContain('orderCount("CANCELLED")');
        expect(overview).toContain('orderCount("EXPIRED")');
        // The total stays every order: the sum of the grouped counts.
        expect(overview).toContain("orderStatusGroups.reduce");
    });

    it("keeps the paid count on paymentStatus, not the order status", () => {
        expect(code(OVERVIEW_LIB)).toContain('paymentStatus: "PAID"');
    });

    it("renders Lunas · Menunggu · Cancel/Expired on the tile", () => {
        const source = code(DASHBOARD_PAGE);

        expect(source).toContain("Lunas ${tenant.ordersPaid}");
        expect(source).toContain("Menunggu ${tenant.ordersPendingPayment}");
        expect(source).toContain(
            "Cancel/Expired ${tenant.ordersCancelled + tenant.ordersExpired}"
        );
    });
});

/* ------------------------------------------------------------------------------------------------
 * G. PAGINATION PRESERVES MULTI-VALUE FILTERS
 * ------------------------------------------------------------------------------------------------
 */

describe("multi-value filters survive pagination", () => {
    it("LinkPagination appends repeated parameters instead of joining them", () => {
        const primitives = code(PRIMITIVES);

        expect(primitives).toContain("(string | number)[]");
        expect(primitives).toContain("params.append(key, String(entry))");
    });

    it("each filtered page hands its array to the pager", () => {
        expect(code(EVENTS_PAGE)).toContain(
            "status: statuses.length > 0 ? statuses : undefined"
        );
        expect(code(REFUNDS_PAGE)).toContain(
            "status: statuses.length > 0 ? statuses : undefined"
        );
        expect(code(SETTLEMENTS_PAGE)).toContain(
            "status: statuses.length > 0 ? statuses : undefined"
        );
        expect(code(ORDERS_PAGE)).toContain("paymentStatus: paymentStatus ?? undefined");
    });
});

/* ------------------------------------------------------------------------------------------------
 * H. AUTHORIZATION — FILTERS NARROW, NEVER WIDEN
 * ------------------------------------------------------------------------------------------------
 */

describe("the new filters narrow an already-scoped query", () => {
    it("keeps every destination on its existing scoped decider", () => {
        expect(code(ORDERS_LIB)).toContain("resolveOrganizerFilter");
        expect(code(ORDERS_LIB)).toContain("PERMISSIONS.ORDER_READ_TENANT");
        expect(code(REFUNDS_LIB)).toContain("resolveOrganizerFilter");
        expect(code(REFUNDS_LIB)).toContain("PERMISSIONS.ORDER_READ_TENANT");
        expect(code(SETTLEMENTS_SERVICE)).toContain("PERMISSIONS.SETTLEMENT_PREPARE");
        expect(code(EVENTS_SERVICE)).toContain("PERMISSIONS.EVENT_READ");
    });

    it("never reads an organizerId from the URL as an authority source", () => {
        for (const page of [EVENTS_PAGE, ORDERS_PAGE, REFUNDS_PAGE, SETTLEMENTS_PAGE]) {
            expect(code(page)).not.toContain("params.organizerId");
        }
    });
});
