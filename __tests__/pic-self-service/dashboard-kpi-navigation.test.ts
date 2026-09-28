/**
 * ==========================================
 * PIC DASHBOARD — KPI NAVIGATION, FILTERS AND FEE SEMANTICS
 * ==========================================
 *
 * The audit behind this work found three things on `/dashboard/pic` that made the page read
 * better than it was:
 *
 *   1. five tiles that were inert numbers, with no way to see which rows produced them;
 *   2. an `Event Saya` table with no filter, no pagination, and only a boolean "Penugasan"
 *      badge to explain the assignment state;
 *   3. a `Fee Bersih` tile whose number was the LEDGER BALANCE (`Σ CREDIT − Σ DEBIT`, i.e.
 *      what is still owed) — which is neither "the fee this PIC has earned" nor "the fee that
 *      has been settled", and which drops to zero the moment a payout is actually paid.
 *
 * This suite pins the shape of the fix, following the repository's convention for the
 * dashboard surface (the properties that matter are structural, so they are asserted from the
 * source plus the pure builders, and the rendered markup where a render says more):
 *
 *   navigation  every tile is a semantic `<Link>` to the section that produces its number —
 *               and never to a Manager surface a PIC holds no authority for;
 *   anchors     every link's `#fragment` resolves to an `id` the page really declares;
 *   vocabulary  the two filter dimensions are the values the read model really implements
 *               (`PIC_ASSIGNMENT_STATUSES`, `EVENT_STATUS_FILTERS`, `PAYMENT_STATUS_FILTERS`);
 *   plumbing    the URL is the only state, `page` is dropped on a filter change and preserved
 *               by the pager, and a union still emits the repeated parameter;
 *   semantics   `Potensi Fee` (ledger entitlement) and `Fee Bersih` (approved payouts) read
 *               two different sources and cannot be computed from one another.
 *
 * ── V3: THE `Tiket Terjual` TILE NO LONGER LOOPS BACK TO THE ORDER LIST ──────────
 * `Tiket Terjual` used to link to `?attributionPaymentStatus=PAID#attributions`, i.e. a
 * FILTERED VIEW OF THE ORDER LIST the reader had already scrolled past — clicking the tile
 * looked like the dashboard was going in circles. The tile now targets its own
 * `#tickets-sold` section, an event-level rollup over the SAME PAID set the tile counts
 * (`getMyPicTicketSales`), while the attribution table keeps its payment filter and gains a
 * per-order `Tiket` column. The assertions below pin that separation: the tile's href, the
 * absence of the old destination, and the existence of the sections both tables need.
 */

// The filter vocabulary and the PIC read model both resolve their scope through `@/lib/authz`,
// which reaches the NextAuth instance. Nothing here reads a session, so the auth module is stubbed
// the same way every other suite that touches these modules stubs it.
jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FilterBar } from "@/components/dashboard/filters/FilterBar";
import {
    applyFilterChange,
    buildFilterField,
} from "@/components/dashboard/filters/filter-types";
import {
    EVENT_STATUS_LABELS,
    PAYMENT_STATUS_LABELS,
    PIC_ASSIGNMENT_STATUS_LABELS,
} from "@/lib/dashboard/filter-options";
import { PAYMENT_STATUS_FILTERS } from "@/lib/dashboard/orders";
import {
    EVENT_ACTIVE_STATUSES,
    EVENT_STATUS_FILTERS,
} from "@/lib/events/status";
import { PIC_ASSIGNMENT_STATUSES, parsePicAssignmentStatus } from "@/lib/pic/self-service";

const PIC_PAGE = "app/dashboard/pic/page.tsx";
const PIC_SELF_SERVICE = "lib/pic/self-service.ts";
const PIC_LEDGER = "lib/pic/ledger.ts";
const OVERVIEW_PAGE = "app/dashboard/page.tsx";
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

/* ==================================================================================
 * A. KPI CARD NAVIGATION
 * ================================================================================== */

/** The five destinations, in the order the tiles are rendered. */
const EXPECTED_KPI_HREFS = [
    "/dashboard/pic?assignmentStatus=ACTIVE#events",
    "/dashboard/pic#attributions",
    "/dashboard/pic#tickets-sold",
    "/dashboard/pic#fees",
    "/dashboard/pic#payouts",
];

/** Every section anchor the page must declare, filters and tiles included. */
const EXPECTED_ANCHORS = [
    "events",
    "referrals",
    "earnings",
    "attributions",
    "tickets-sold",
    "fees",
    "payouts",
];

describe("the five PIC KPI tiles navigate to the section that produces each number", () => {
    it("renders every tile as a link to its audited destination", () => {
        const page = code(PIC_PAGE);

        for (const href of EXPECTED_KPI_HREFS) {
            expect(page).toContain(`href="${href}"`);
        }

        // Five tiles, each wrapped in its own link: `StatCard` renders no link of its own.
        expect(page.match(/<StatCard\b/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
        expect(page.match(/<Link\b/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    });

    it("uses semantic links rather than click handlers or imperative navigation", () => {
        const page = code(PIC_PAGE);

        expect(page).not.toContain("onClick");
        expect(page).not.toContain("window.location");
        expect(page).not.toMatch(/router\.(push|replace)\(/);
    });

    it("never points a PIC tile at a Manager/dashboard surface it cannot read", () => {
        const page = code(PIC_PAGE);

        // Every tile destination stays on the PIC's own route…
        for (const href of EXPECTED_KPI_HREFS) {
            expect(href.startsWith("/dashboard/pic")).toBe(true);
        }

        // …and no tile reaches a tenant-scoped list. (`actionHref="/dashboard/events"` lower in
        // the file belongs to the ORGANIZER denial panel, which only a MANAGER ever sees — it is
        // not a tile, which is why the check is on these link targets rather than on the string.)
        for (const forbidden of [
            'href="/dashboard/settlements',
            'href="/dashboard/orders',
            'href="/dashboard/reports',
            'href="/dashboard/pic/[',
        ]) {
            expect(page).not.toContain(forbidden);
        }

        // The only outbound event link is the public event page the referral token targets.
        expect(page).toContain("`/e/${assignment.eventSlug}`");
    });

    it("does not add an href prop to the shared StatCard primitive", () => {
        const primitives = code(PRIMITIVES);
        const statCard = primitives.slice(
            primitives.indexOf("export function StatCard"),
            primitives.indexOf("export function StatGrid")
        );

        expect(statCard).not.toContain("href");
    });

    it("shares one clickable-tile treatment instead of two drifting copies", () => {
        const primitives = read(PRIMITIVES);

        expect(primitives).toContain("export const KPI_CARD_LINK_CLASS");
        // The hover/focus affordances the requirement calls for.
        expect(primitives).toContain("focus-visible:ring-2");
        expect(primitives).toContain("hover:[&>div]:border-primary/40");
        expect(primitives).toContain("hover:[&>div]:shadow-raised");

        // Both dashboards import the one definition; neither keeps a private copy.
        for (const page of [PIC_PAGE, OVERVIEW_PAGE]) {
            expect(code(page)).toContain("KPI_CARD_LINK_CLASS");
            expect(code(page)).not.toContain("const KPI_CARD_LINK_CLASS");
        }
    });
});

/* ==================================================================================
 * B. ANCHORS — every fragment a tile links to must exist on the page
 * ================================================================================== */

describe("every KPI fragment resolves to an anchor the page declares", () => {
    const pageSource = read(PIC_PAGE);

    function declaredIds(): Set<string> {
        const ids = new Set<string>();
        for (const match of pageSource.matchAll(/\bid="([^"]+)"/g)) {
            ids.add(match[1]);
        }
        return ids;
    }

    it("declares each target, including the ones the tiles share with the menu", () => {
        const ids = declaredIds();
        const missing = EXPECTED_ANCHORS.filter((id) => !ids.has(id));

        expect(missing).toEqual([]);
        // Section ids are unique — two sections cannot share an anchor.
        const all = [...pageSource.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
        expect(new Set(all).size).toBe(all.length);
    });

    it("gives every anchored section the sticky-header scroll offset", () => {
        for (const id of EXPECTED_ANCHORS) {
            const pattern = new RegExp(`<div id="${id}"\\s+className="([^"]*)"`);
            const match = pageSource.match(pattern);

            expect({ id, found: match !== null }).toEqual({ id, found: true });
            expect({ id, scrolls: match![1].includes("scroll-mt-16") }).toEqual({
                id,
                scrolls: true,
            });
        }
    });

    it("keeps the ticket tile and the attribution list on two different anchors", () => {
        const page = code(PIC_PAGE);

        // The tile that counts PAID tickets points at the sales rollup…
        expect(page).toContain('href="/dashboard/pic#tickets-sold"');
        // …and NOT at the order list, filtered or otherwise — that was the loop.
        expect(page).not.toContain('href="/dashboard/pic?attributionPaymentStatus=PAID#attributions"');
        expect(page).not.toContain("#tickets-sold#");

        // `Pesanan Atribusi` still answers "which orders came through me?" and stays put.
        expect(page).toContain('href="/dashboard/pic#attributions"');

        // The mapping is positional: tile 2 → attributions, tile 3 → tickets-sold.
        const hrefs = [...page.matchAll(/href="(\/dashboard\/pic[^"]*)"/g)].map((match) => match[1]);
        expect(hrefs.slice(0, 5)).toEqual(EXPECTED_KPI_HREFS);
    });

    it("renders a distinct section per question, not one table twice", () => {
        const page = read(PIC_PAGE);

        // Order-level table: one row per attributed order, with its payment filter…
        expect(page).toContain("Atribusi Terbaru");
        expect(page).toContain("attributions.map");
        expect(page).toContain('{ header: "Tiket", align: "right" }');
        expect(page).toContain("attribution.ticketQuantity");

        // …and an event-level rollup fed by the dedicated read model.
        expect(page).toContain("getMyPicTicketSales(userId)");
        expect(page).toContain("ticketSales.items.map");
        expect(page).toContain("ticketSales.totals.ticketsSold");
        expect(page).toContain('{ header: "Pesanan Lunas", align: "right" }');
        expect(page).toContain('{ header: "Penjualan", align: "right" }');
    });

    it("links only to fragments the page declares", () => {
        const ids = declaredIds();
        const targets = EXPECTED_KPI_HREFS.filter((href) => href.includes("#")).map(
            (href) => href.split("#")[1]
        );

        expect(targets.filter((target) => !ids.has(target))).toEqual([]);
    });
});

/* ==================================================================================
 * C. FILTER VOCABULARY — the values are the ones the read model implements
 * ================================================================================== */

describe("the Event Saya filter dimensions come from the stored data", () => {
    it("offers exactly the two states a PICEventAssignment row can hold", () => {
        expect([...PIC_ASSIGNMENT_STATUSES]).toEqual(["ACTIVE", "REVOKED"]);
        expect(PIC_ASSIGNMENT_STATUS_LABELS.ACTIVE).toBe("Aktif");
        expect(PIC_ASSIGNMENT_STATUS_LABELS.REVOKED).toBe("Dicabut");
    });

    it("narrows a query-string value and drops everything unknown", () => {
        expect(parsePicAssignmentStatus("ACTIVE")).toBe("ACTIVE");
        expect(parsePicAssignmentStatus("REVOKED")).toBe("REVOKED");
        expect(parsePicAssignmentStatus(["ACTIVE"])).toBe("ACTIVE");
        expect(parsePicAssignmentStatus("active")).toBeNull();
        expect(parsePicAssignmentStatus("NOPE")).toBeNull();
        expect(parsePicAssignmentStatus(undefined)).toBeNull();
        expect(parsePicAssignmentStatus([])).toBeNull();
    });

    it("offers the event statuses the product can actually produce", () => {
        expect([...EVENT_STATUS_FILTERS]).toEqual([
            "DRAFT",
            "PUBLISHED",
            "ONGOING",
            "COMPLETED",
            "CANCELLED",
            "ARCHIVED",
        ]);
        // `PENDING_REVIEW` is absent from the enum's reachable states — it is never offered.
        expect(EVENT_STATUS_FILTERS as readonly string[]).not.toContain("PENDING_REVIEW");

        for (const status of EVENT_STATUS_FILTERS) {
            expect(EVENT_STATUS_LABELS[status]?.trim()).toBeTruthy();
        }
    });

    it("reuses the order read model's payment vocabulary for the attribution filter", () => {
        expect(PAYMENT_STATUS_FILTERS as readonly string[]).toContain("PAID");
        expect(PAYMENT_STATUS_FILTERS.length).toBe(7);

        for (const status of PAYMENT_STATUS_FILTERS) {
            expect(PAYMENT_STATUS_LABELS[status]?.trim()).toBeTruthy();
        }

        // The page declares no second copy of the list.
        const page = code(PIC_PAGE);
        expect(page).toContain("const VALID_ATTRIBUTION_PAYMENT_STATUSES = PAYMENT_STATUS_FILTERS");
    });

    it("validates every parameter before it reaches the read model", () => {
        const page = code(PIC_PAGE);

        expect(page).toContain("parsePicAssignmentStatus(params.assignmentStatus)");
        expect(page).toContain("parseEventStatusFilters(params.eventStatus)");
        expect(page).toContain(
            "parseAttributionPaymentStatus(\n        params.attributionPaymentStatus\n    )"
        );

        // The read model's own guards, so the filter is a `where` and not a post-filter.
        const selfService = code(PIC_SELF_SERVICE);
        expect(selfService).toContain("...(assignmentStatus === \"ACTIVE\"");
        expect(selfService).toContain("{ isActive: true, revokedAt: null }");
        expect(selfService).toContain("...(assignmentStatus === \"REVOKED\" ? { isActive: false } : {})");
        expect(selfService).toContain("event: { status: { in: [...eventStatuses] } }");
        expect(selfService).toContain("order: { paymentStatus: filters.paymentStatus }");
    });
});

/* ==================================================================================
 * D. FILTER WIRING — the URL is the only state
 * ================================================================================== */

/** The page's two Event Saya fields, built the way the page builds them. */
function eventFields(status: string | null, eventStatuses: readonly string[] = []) {
    return [
        buildFilterField({
            name: "assignmentStatus",
            label: "Status penugasan",
            allLabel: "Semua penugasan",
            values: status ? [status] : [],
            members: PIC_ASSIGNMENT_STATUSES,
            labels: PIC_ASSIGNMENT_STATUS_LABELS,
        }),
        buildFilterField({
            name: "eventStatus",
            label: "Status event",
            allLabel: "Semua status event",
            values: eventStatuses,
            members: EVENT_STATUS_FILTERS,
            labels: EVENT_STATUS_LABELS,
            union: {
                value: "active",
                label: "Aktif",
                statuses: EVENT_ACTIVE_STATUSES,
            },
        }),
    ];
}

describe("the Event Saya filter row is a server-rendered row of pill links", () => {
    it("renders both dimensions with visible choices and an obvious active pill", () => {
        const current = { assignmentStatus: "ACTIVE", eventStatus: ["ONGOING"] };
        const markup = renderToStaticMarkup(
            createElement(FilterBar, {
                bare: true,
                basePath: "/dashboard/pic",
                current,
                fields: eventFields("ACTIVE", ["ONGOING"]),
            })
        );

        expect(markup).toContain("Semua penugasan");
        expect(markup).toContain("Aktif");
        expect(markup).toContain("Dicabut");
        expect(markup).toContain("Status event");
        expect(markup).toContain("Semua status event");
        expect(markup).toContain("Sedang berlangsung");

        // Exactly the two applied pills are marked current, and each row is a labelled nav.
        expect(markup.match(/aria-current="true"/g)?.length).toBe(2);
        expect(markup).toContain('aria-label="Status penugasan"');
        expect(markup).toContain('aria-label="Status event"');

        // A pill is a link: the filter is applied by the URL, before any JavaScript.
        expect(markup).toContain("href=");
    });

    it("does not nest a panel inside the section card in the bare variant", () => {
        const bare = renderToStaticMarkup(
            createElement(FilterBar, {
                bare: true,
                basePath: "/dashboard/pic",
                current: {},
                fields: eventFields(null),
            })
        );
        const paneled = renderToStaticMarkup(
            createElement(FilterBar, {
                basePath: "/dashboard/pic",
                current: {},
                fields: eventFields(null),
            })
        );

        // `Card` marks itself with `data-slot="card"`; the in-section filter adds no second one.
        expect(bare).not.toContain('data-slot="card"');
        expect(paneled).toContain('data-slot="card"');

        // The controls themselves are identical either way.
        expect(bare).toContain("Semua penugasan");
        expect(paneled).toContain("Semua penugasan");
    });

    it("emits the 'Aktif' union as a repeated parameter and preserves the other filters", () => {
        const current = {
            assignmentStatus: "REVOKED",
            attributionPaymentStatus: "PAID",
            page: "3",
        };

        expect(
            applyFilterChange("/dashboard/pic", current, {
                eventStatus: [...EVENT_ACTIVE_STATUSES],
            })
        ).toBe(
            "/dashboard/pic?assignmentStatus=REVOKED&attributionPaymentStatus=PAID&eventStatus=PUBLISHED&eventStatus=ONGOING"
        );
    });

    it("drops the active filter's parameter on 'Semua' and always returns to page 1", () => {
        const current = {
            assignmentStatus: "ACTIVE",
            eventStatus: ["ONGOING"],
            attributionPaymentStatus: "PAID",
            page: "4",
        };

        expect(
            applyFilterChange("/dashboard/pic", current, { assignmentStatus: null })
        ).toBe(
            "/dashboard/pic?eventStatus=ONGOING&attributionPaymentStatus=PAID"
        );
    });

    it("hands the pager the same filter state, so pagination keeps every filter", () => {
        const page = code(PIC_PAGE);

        expect(page).toContain("const filterState = {");
        expect(page).toContain("assignmentStatus: assignmentStatus ?? undefined");
        expect(page).toContain("eventStatus: eventStatuses.length > 0 ? eventStatuses : undefined");
        expect(page).toContain("attributionPaymentStatus: attributionPaymentStatus ?? undefined");
        expect(page).toContain("query={filterState}");
        expect(page).toContain("<LinkPagination");
    });

    it("shows a filter-specific empty state instead of an empty table", () => {
        const page = code(PIC_PAGE);

        expect(page).toContain("Tidak ada event dengan filter tersebut.");
        expect(page).toContain("const hasEventFilter = Boolean(assignmentStatus) || eventStatuses.length > 0");
        expect(page).toContain("Tidak ada atribusi dengan status pembayaran tersebut.");
    });

    it("reads the filters from searchParams and passes them to the scoped service", () => {
        const page = code(PIC_PAGE);

        expect(page).toContain("searchParams: Promise<PicSearchParams>");
        expect(page).toContain("listMyPicAssignments(userId, {");
        expect(page).toContain("listMyAttributions(userId, { paymentStatus: attributionPaymentStatus })");
        expect(page).not.toContain("params.picProfileId");
        expect(page).not.toContain("params.organizerId");
    });
});

/* ==================================================================================
 * E. FEE SEMANTICS — Potensi Fee vs Fee Bersih
 * ================================================================================== */

describe("Potensi Fee and Fee Bersih are two different sources, not one formula", () => {
    it("derives Potensi Fee from the ledger entitlement (EARNED − REVERSAL)", () => {
        const ledger = read(PIC_LEDGER);

        expect(ledger).toContain("export async function getPicFeeEntitlement");
        expect(ledger).toContain('sum("EARNED")');
        expect(ledger).toContain('sum("REVERSAL")');
        // The payout rows are money movement, not entitlement: they are never subtracted here.
        expect(ledger).not.toContain('sum("PAYOUT")');

        const selfService = read(PIC_SELF_SERVICE);
        expect(selfService).toContain("getPicFeeEntitlement(picProfileId)");
        expect(selfService).toContain("potential: entitlement.potential");
    });

    it("derives Fee Bersih from the PIC's own APPROVED ∪ PAID settlements", () => {
        const selfService = read(PIC_SELF_SERVICE);

        expect(selfService).toContain("prisma.settlement.groupBy({");
        expect(selfService).toContain('where: { payeeType: "PIC", picProfileId }');
        expect(selfService).toContain("_sum: { netAmount: true }");
        expect(selfService).toContain('payoutSum("APPROVED")');
        expect(selfService).toContain('payoutSum("PAID")');
        expect(selfService).toContain("approvedTotal: approvedAmount.add(paidAmount)");

        // A refused or unreviewed request approves nothing.
        for (const excluded of ["REQUESTED", "REJECTED", "DRAFT", "FAILED", "CANCELLED"]) {
            expect(selfService).not.toContain(`payoutSum("${excluded}")`);
        }
    });

    it("no longer calls the ledger balance 'Fee Bersih' anywhere", () => {
        expect(code(PIC_PAGE)).not.toContain("netFee");
        expect(code(PIC_SELF_SERVICE)).not.toContain("netFee");

        // The canonical balance is still exposed, under its own truthful name.
        expect(read(PIC_SELF_SERVICE)).toContain("netBalance: net");
        expect(read(PIC_PAGE)).toContain("Potensi Fee");
        expect(read(PIC_PAGE)).toContain("Fee Bersih");
    });

    it("explains both figures on the page instead of asserting a total", () => {
        const page = read(PIC_PAGE);

        expect(page).toContain("Fee diperoleh dikurangi pembatalan");
        expect(page).toContain("Dari pencairan yang disetujui");
        expect(page).toContain("PAYOUT tidak menguranginya");
    });
});
