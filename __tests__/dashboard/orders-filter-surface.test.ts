/**
 * ==========================================
 * ORDERS — ONE STATUS FILTER, AND ONLY ONE
 * ==========================================
 *
 * The orders list used to carry three status concepts at once (`status`, `paymentStatus` and the
 * `review=1` worklist view), which made the page ambiguous: two of them are different lifecycles and
 * the third narrowed a list that the other two were also narrowing. The surface is now ONE filter —
 * the gateway `paymentStatus` — plus the free-text search. Everything else is either gone or
 * deliberately URL-only:
 *
 *   GONE      the `status` pill row, the `Tampilan` row, the `?review=1` link, and the page's own
 *             `review` parameter. The page no longer reads `review` at all;
 *   HONOURED  a validated `?status=`, because the overview's "Menunggu bayar" tile deep-links
 *             `/dashboard/orders?status=PENDING_PAYMENT` and that drill-down has to keep working.
 *             It has NO control; the bar states it in words when it is in force;
 *   INTACT    the read model. `status`, `paymentStatus`, `q` and `needsReview` are all still
 *             parameters of `listDashboardOrders` — the reconciliation read that `needsReview`
 *             serves is exercised by
 *             `__tests__/ticketing-refunds/refund-reconciliation-visibility.integration.test.ts`.
 *
 * ── WHY BOTH A SOURCE AND A RENDER ASSERTION ────────────────────────────────────
 * Source inspection proves what the page CAN read and forward; `renderToStaticMarkup` proves what a
 * browser actually receives, which is the only way to show that the highlighted pill, the preserved
 * filters and the deep-link notice are in the first byte of HTML (no hydration, no state that can
 * disagree with the rows). This repository has no DOM testing library; the static renderer is the
 * tool it uses for output, and `createElement` rather than JSX is its convention for a `.ts` suite.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));

import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { FilterBar } from "@/components/dashboard/filters/FilterBar";
import { buildFilterField } from "@/components/dashboard/filters/filter-types";
import { PAYMENT_STATUS_LABELS } from "@/lib/dashboard/filter-options";
import { PAYMENT_STATUS_FILTERS } from "@/lib/dashboard/orders";

function read(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf-8");
}

/** Source with comments removed, so a doc comment cannot satisfy (or defeat) an assertion. */
function code(path: string): string {
    return read(path)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

const ORDERS_PAGE = "app/dashboard/orders/page.tsx";
const ORDERS_READ_MODEL = "lib/dashboard/orders.ts";
const OVERVIEW_PAGE = "app/dashboard/page.tsx";

/** The payment states the orders page will actually query, in the order the read model offers. */
const members = [...PAYMENT_STATUS_FILTERS];

/** The page's one field, built exactly the way the page builds it. */
function paymentField(values: readonly string[]) {
    return buildFilterField({
        name: "paymentStatus",
        label: "Status pembayaran",
        allLabel: "Semua pembayaran",
        values,
        members,
        labels: PAYMENT_STATUS_LABELS,
    });
}

/* ==================================================================================
 * 1. ONE FILTER, AND IT IS paymentStatus
 * ================================================================================== */

describe("orders has exactly one status filter", () => {
    it("builds ONE field and it is the payment status", () => {
        const source = code(ORDERS_PAGE);

        expect(source.match(/buildFilterField\(/g)?.length).toBe(1);
        expect(source).toContain('name: "paymentStatus"');
        expect(source).toContain('label: "Status pembayaran"');
        expect(source).toContain('allLabel: "Semua pembayaran"');
        expect(source).toContain("fields={[paymentStatusField]}");
    });

    it("renders no order-status filter and no worklist view", () => {
        const source = code(ORDERS_PAGE);

        expect(source).not.toContain('label: "Status pesanan"');
        expect(source).not.toContain('label: "Tampilan"');
        expect(source).not.toContain('name: "review"');
        expect(source).not.toContain("review=1");
        expect(source).not.toContain("review:");
    });

    it("offers every payment state the read model can be asked for", () => {
        const values = paymentField([]).options.map((option) => option.value);

        for (const status of members) {
            expect(values).toContain(status);
        }
    });

    it("does not read `review` from the URL any more", () => {
        const source = code(ORDERS_PAGE);

        // The parameter is not declared, not read, and not forwarded to the pager.
        expect(source).not.toMatch(/review\?:/);
        expect(source).not.toContain("params.review");
        expect(source).not.toContain("needsReview");
    });

    it("still forwards the DEEP-LINKABLE order status the KPI relies on", () => {
        const source = code(ORDERS_PAGE);

        // Present in the page's searchParams type, validated, and handed to the scoped read — but
        // with no field built for it, so it cannot be chosen from the UI.
        expect(source).toContain("status?: string | string[];");
        expect(source).toContain("const status = parseStatus(");
        expect(source).toContain("status,");
        expect(source).not.toContain("orderStatusField");
    });
});

/* ==================================================================================
 * 2. THE READ MODEL KEPT ITS CAPABILITIES
 * ================================================================================== */

describe("the read model lost no predicate", () => {
    const model = code(ORDERS_READ_MODEL);

    it("keeps `needsReview` as the reconciliation read", () => {
        expect(model).toContain("needsReview?: boolean;");
        expect(model).toContain("if (params.needsReview)");
        expect(model).toContain("fulfilmentBlockedAt: { not: null }");
    });

    it("keeps `status` and `paymentStatus` as SIBLING where keys, so they AND", () => {
        expect(model).toContain("...(params.status ? { status: params.status } : {}),");
        expect(model).toContain(
            "...(params.paymentStatus"
        );
        // Sibling keys in one object literal — neither can overwrite the other.
        expect(model).not.toContain("status: params.paymentStatus");
    });

    it("keeps the search predicate on the three columns it always matched", () => {
        expect(model).toContain("orderNumber: { contains: params.q }");
        expect(model).toContain("buyerName: { contains: params.q }");
        expect(model).toContain("buyerEmail: { contains: params.q }");
    });
});

/* ==================================================================================
 * 3. VALIDATION — AN UNKNOWN VALUE NEVER REACHES PRISMA
 * ================================================================================== */

describe("an unknown paymentStatus is dropped before the query", () => {
    it("narrows against the shared enum list rather than forwarding the string", () => {
        const source = code(ORDERS_PAGE);

        expect(source).toContain("VALID_PAYMENT_STATUSES as readonly string[]).includes(raw)");
        expect(source).toContain(": null;");
    });

    it("treats a repeated parameter by taking the FIRST value", () => {
        expect(code(ORDERS_PAGE)).toContain(
            "const raw = Array.isArray(value) ? value[0] : value;"
        );
    });

    it("declares the accepted list from the payment statuses the product can produce", () => {
        // `PAYMENT_STATUS_FILTERS` is re-exported from the read model so the page and the shape it
        // validates against cannot drift.
        expect(members.length).toBeGreaterThan(0);
        expect(members).toContain("PAID");

        for (const status of members) {
            expect(PAYMENT_STATUS_LABELS[status]?.trim()).toBeTruthy();
        }
    });
});

/* ==================================================================================
 * 4. SEARCH + FILTER TOGETHER, AND PAGINATION
 * ================================================================================== */

describe("search and filter coexist and survive pagination", () => {
    it("sends both to the read model in one call", () => {
        const source = code(ORDERS_PAGE);

        expect(source).toContain("paymentStatus,");
        expect(source).toContain("q: params.q ?? null,");
    });

    it("carries both filters, and the deep-linked status, into the pager", () => {
        const source = code(ORDERS_PAGE);
        const start = source.indexOf("query={{");
        const block = source.slice(start, start + 400);

        expect(block).toContain("status: status ?? undefined,");
        expect(block).toContain("paymentStatus: paymentStatus ?? undefined,");
        expect(block).toContain("q: params.q,");
    });

    it("renders search state in the streamed HTML next to the payment pills", () => {
        const html = renderToStaticMarkup(
            createElement(FilterBar, {
                basePath: "/dashboard/orders",
                current: { paymentStatus: "PAID", q: "andi" },
                fields: [paymentField(["PAID"])],
                search: {
                    label: "Cari pesanan",
                    placeholder: "Nomor pesanan, pembeli, atau email",
                    value: "andi",
                },
            })
        );

        expect(html).toContain("Semua pembayaran");
        expect(html).toContain("Lunas");
        expect(html).toContain('aria-current="true"');
        expect(html).toContain('value="andi"');
        expect(html).toContain("Cari pesanan");
    });
});

/* ==================================================================================
 * 5. THE DEEP-LINK NOTICE — STATED, NOT OFFERED
 * ================================================================================== */

describe("an order-status deep link is stated rather than offered", () => {
    it("uses the bar's hint slot for the applied status and the way out", () => {
        const source = code(ORDERS_PAGE);

        expect(source).toContain("deepLinkHint");
        expect(source).toContain("ORDER_STATUS_LABELS[status]");
        expect(source).toContain('href="/dashboard/orders"');
        expect(source).toContain("Tampilkan semua pesanan");
    });

    it("the notice is a sentence plus a clearing link — never a choosable row", () => {
        // `fields` is the ONLY source of pills. A single field means a single pill row, so the
        // deep-link status cannot be selected (only cleared).
        expect(code(ORDERS_PAGE)).toContain("fields={[paymentStatusField]}");
    });

    it("explains itself in the empty state too, instead of claiming there are no orders", () => {
        const source = code(ORDERS_PAGE);

        expect(source).toContain("Tidak ada pesanan berstatus");
        expect(source).toContain("Belum ada pesanan");
    });
});

/* ==================================================================================
 * 6. KPI NAVIGATION — THE TWO LIFECYCLES STAY DISTINCT
 * ================================================================================== */

describe("the KPI drill-downs still say what they mean", () => {
    const overview = code(OVERVIEW_PAGE);

    it("'Tiket terjual' filters on paymentStatus, never on the order status", () => {
        expect(overview).toContain('href="/dashboard/orders?paymentStatus=PAID"');
        expect(overview).not.toContain('href="/dashboard/orders?status=PAID"');
    });

    it("'Menunggu bayar' keeps its ORDER-status semantics (OrderStatus, not PaymentStatus)", () => {
        // The tile counts `eventOrder.groupBy(["status"])`; its destination must be the same
        // predicate. Changing it to `paymentStatus=` would make the tile and the list disagree.
        expect(overview).toContain('href="/dashboard/orders?status=PENDING_PAYMENT"');
    });

    it("no KPI points at the removed worklist view", () => {
        expect(overview).not.toContain("review=1");
        expect(overview).not.toContain("review:");
    });

    it("the plain orders tile opens the unfiltered list", () => {
        expect(overview).toContain('href="/dashboard/orders"');
    });
});
