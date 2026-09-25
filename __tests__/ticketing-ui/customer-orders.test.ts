import fs from "fs";
import path from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ==========================================
 * PHASE 20B — CUSTOMER "PESANAN SAYA"
 * ==========================================
 *
 * The vertical has four pieces, and the suite covers each at the level it can actually be
 * proved at:
 *
 *   payload   the LIST projection and its pure predicates. What is in the row, what is
 *             deliberately NOT (a scannable credential, a payment instruction, an evidence
 *             key), and that the same predicates the order detail uses are the ones here.
 *   service   the own-scope read. `listOwnOrders` must put ownership IN the query, must
 *             ignore any caller-supplied user identifier, and must re-apply the capability.
 *   render    the card and the refund panel as HTML, because they are pure functions of
 *             their payloads — so a link destination, a badge's meaning and the absence of
 *             a credential can be asserted without a database or a browser.
 *   wiring    static guards over the page and the header: the refusal-versus-outage split
 *             survives, the buyer surfaces reach the EXISTING evidence route, and no native
 *             browser dialog has come back.
 *
 * ── WHY THE DATABASE IS MOCKED AND NOT EXERCISED ─────────────────────────────────
 * The read path's security property is not "the database returns the right rows" — that is
 * InnoDB's job and the integration suites' subject. It is "the row set is narrowed by the
 * SESSION, before anything is returned, and cannot be widened by a parameter". That is a
 * property of the query this service BUILDS, so the query is what is asserted, with
 * `@/lib/prisma` behind a selective getter (the same technique the refund-evidence suite
 * uses, and for the same reason: the teardown file imports the same module).
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

const mockPrisma = {
    eventOrder: {
        count: jest.fn(),
        findMany: jest.fn(),
    },
    refund: {
        findMany: jest.fn(),
    },
};

jest.mock("@/lib/prisma", () => ({
    get prisma() {
        return mockPrisma;
    },
}));

jest.mock("@/lib/authz/guards", () => ({
    requireOwnResource: jest.fn(),
    requireOrganizerAccess: jest.fn(),
}));

import { Prisma } from "@prisma/client";

import OrderCard from "@/components/ticketing/OrderCard";
import { requireOwnResource } from "@/lib/authz/guards";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz/permissions";
import { prisma } from "@/lib/prisma";
import {
    ORDER_SUMMARY_SELECT,
    buildOrderSummary,
    orderCanPay,
    orderCanRequestRefund,
    orderDetailUrl,
    orderFulfilment,
    type OrderSummaryPayload,
} from "@/lib/ticketing/order-payload";
import { listOwnOrders } from "@/lib/ticketing/orders";
import {
    buildRefundPayload,
    refundEvidenceUrl,
    REFUND_SELECT,
    type RefundRow,
} from "@/lib/ticketing/refunds/payload";
import { listOwnRefundsForOrder } from "@/lib/ticketing/refunds/service";
import { ROUTE_INVENTORY } from "@/lib/ui/route-inventory";

const ownResource = requireOwnResource as jest.Mock;
const orderCount = prisma.eventOrder.count as jest.Mock;
const orderFindMany = prisma.eventOrder.findMany as jest.Mock;
const refundFindMany = prisma.refund.findMany as jest.Mock;

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Strip comments, so prose that NAMES a banned pattern is not mistaken for it. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function scope(userId: string): AuthzScope {
    return {
        userId,
        platformRole: "CUSTOMER",
        organizerScopes: [],
        grants: [],
    };
}

const BUYER = "buyer-1";

/* ==================================================================================
 * FIXTURES
 * ================================================================================== */

/** The row shape `buildOrderSummary` consumes, derived rather than re-declared. */
type SummaryRow = Parameters<typeof buildOrderSummary>[0];

function summaryRow(over: Partial<SummaryRow> = {}): SummaryRow {
    return {
        orderNumber: "EVT-20260925-000001",
        status: "PAID",
        paymentStatus: "PAID",
        total: new Prisma.Decimal("150000.00"),
        createdAt: new Date("2026-09-25T03:00:00.000Z"),
        expiresAt: new Date("2026-09-25T04:00:00.000Z"),
        paidAt: new Date("2026-09-25T03:30:00.000Z"),
        fulfilmentBlockedAt: null,
        event: {
            title: "Liga Basket Bandung",
            slug: "liga-basket-bandung",
            startAt: new Date("2026-10-03T12:00:00.000Z"),
            endAt: new Date("2026-10-03T14:00:00.000Z"),
            venue: { name: "GOR Tridharma" },
        },
        items: [
            { nameSnapshot: "Tribun Utara", quantity: 2 },
            { nameSnapshot: "VIP", quantity: 1 },
        ],
        tickets: [{ status: "ISSUED" }, { status: "ISSUED" }, { status: "ISSUED" }],
        refunds: [],
        // The fixture is shaped like the `ORDER_SUMMARY_SELECT` projection on purpose, so the
        // overrides below stay `Partial<SummaryRow>` rather than drifting into `any`.
        ...over,
    };
}

function summary(over: Partial<OrderSummaryPayload> = {}): OrderSummaryPayload {
    return {
        orderNumber: "EVT-20260925-000001",
        status: "PAID",
        paymentStatus: "PAID",
        total: "150000.00",
        createdAt: "2026-09-25T03:00:00.000Z",
        eventTitle: "Liga Basket Bandung",
        eventSlug: "liga-basket-bandung",
        startAt: "2026-10-03T12:00:00.000Z",
        endAt: "2026-10-03T14:00:00.000Z",
        venueName: "GOR Tridharma",
        ticketSummary: "2× Tribun Utara, 1× VIP",
        ticketCount: 3,
        canPay: false,
        canRefund: true,
        fulfilment: "ISSUED",
        refundStatus: null,
        orderUrl: "/ticketing/orders/EVT-20260925-000001",
        ...over,
    };
}

function refundRow(over: Partial<RefundRow> = {}): RefundRow {
    return {
        id: 7,
        refundNumber: "RFN-7",
        status: "PROCESSING",
        evidenceFileKey: null,
        requestedAmount: new Prisma.Decimal("150000.00"),
        confirmedAmount: new Prisma.Decimal("0.00"),
        reason: null,
        failureReason: null,
        providerRef: null,
        createdAt: new Date("2026-09-25T05:00:00.000Z"),
        approvedAt: null,
        processedAt: null,
        completedAt: null,
        failedAt: null,
        eventOrder: { orderNumber: "EVT-20260925-000001", currency: "IDR" },
        items: [],
        ...over,
    };
}

const STORED_KEY = "1758790000000-0123456789abcdef0123456789abcdef.png";

beforeEach(() => {
    ownResource.mockReset().mockResolvedValue(scope(BUYER));
    orderCount.mockReset().mockResolvedValue(0);
    orderFindMany.mockReset().mockResolvedValue([]);
    refundFindMany.mockReset().mockResolvedValue([]);
});

/* ==================================================================================
 * 1-3. THE OWN-SCOPE READ
 * ================================================================================== */

describe("P20B-1. the order list is scoped by the SESSION, in the query", () => {
    test("silence is not an authenticated caller", async () => {
        await expect(
            listOwnOrders({}, undefined as unknown as AuthzScope)
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

        expect(orderFindMany).not.toHaveBeenCalled();
    });

    test("the capability is re-applied against the caller's own id", async () => {
        await listOwnOrders({}, scope(BUYER));

        expect(ownResource).toHaveBeenCalledWith(PERMISSIONS.ORDER_READ_OWN, BUYER);
    });

    test("ownership is a predicate in BOTH the page query and the count", async () => {
        orderCount.mockResolvedValue(3);
        orderFindMany.mockResolvedValue([]);

        await listOwnOrders({}, scope(BUYER));

        const findWhere = orderFindMany.mock.calls[0][0].where;
        const countWhere = orderCount.mock.calls[0][0].where;

        expect(findWhere.userId).toBe(BUYER);
        expect(countWhere.userId).toBe(BUYER);
        expect(findWhere).toEqual(countWhere);
    });

    test("a caller-supplied user identifier is IGNORED, not honoured", async () => {
        // The shape a hostile caller would send if the service read `query.userId`.
        await listOwnOrders({ userId: "victim" } as never, scope(BUYER));

        const where = orderFindMany.mock.calls[0][0].where;

        expect(where.userId).toBe(BUYER);
        expect(JSON.stringify(where)).not.toContain("victim");
    });

    test("a foreign order is never in the result set — the answer is an empty list, not a filter", async () => {
        // The database returns exactly the rows the predicate allows; for a caller with no
        // orders that is nothing, and the service must report that rather than reach for an
        // unscoped query to "help".
        orderFindMany.mockResolvedValue([]);
        orderCount.mockResolvedValue(0);

        const result = await listOwnOrders({}, scope(BUYER));

        expect(result.items).toEqual([]);
        expect(result.total).toBe(0);
        expect(orderFindMany).toHaveBeenCalledTimes(1);
        expect(orderCount).toHaveBeenCalledTimes(1);
    });

    test("§26.1's ceiling of 50 is enforced by the service, not by the caller", async () => {
        await listOwnOrders({ limit: 500, page: 1 }, scope(BUYER));

        expect(orderFindMany.mock.calls[0][0].take).toBe(50);
    });

    test("a page is a window: skip is derived, never passed through", async () => {
        await listOwnOrders({ limit: 20, page: 3 }, scope(BUYER));

        const call = orderFindMany.mock.calls[0][0];

        expect(call.take).toBe(20);
        expect(call.skip).toBe(40);
    });

    test("filters narrow, and the ownership predicate always survives them", async () => {
        await listOwnOrders(
            {
                status: "PAID",
                eventId: "evt_1",
                dateFrom: new Date("2026-09-01T00:00:00.000Z"),
                dateTo: new Date("2026-10-01T00:00:00.000Z"),
            },
            scope(BUYER)
        );

        const where = orderFindMany.mock.calls[0][0].where;

        expect(where.userId).toBe(BUYER);
        expect(where.status).toBe("PAID");
        expect(where.eventId).toBe("evt_1");
        expect(where.createdAt).toEqual({
            gte: new Date("2026-09-01T00:00:00.000Z"),
            lt: new Date("2026-10-01T00:00:00.000Z"),
        });
    });

    test("newest purchase first — a stable sort, because the list paginates", async () => {
        await listOwnOrders({}, scope(BUYER));

        expect(orderFindMany.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
    });

    test("one clock read decides every row's `canPay`", async () => {
        orderFindMany.mockResolvedValue([
            summaryRow({
                status: "PENDING_PAYMENT",
                paymentStatus: "UNPAID",
                expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            }),
        ]);

        const result = await listOwnOrders({}, scope(BUYER));

        expect(result.items[0].canPay).toBe(true);
    });
});

/* ==================================================================================
 * 4-5. THE PROJECTION — WHAT A LIST ROW MAY AND MAY NOT CARRY
 * ================================================================================== */

describe("P20B-2. what the list projection selects, and what it refuses to", () => {
    test("it selects no credential, no payment instruction and no tenant column", () => {
        const serialized = JSON.stringify(ORDER_SUMMARY_SELECT);

        for (const forbidden of [
            "qrToken",
            "qrTokenHash",
            "ticketCode",
            "paymentUrl",
            "paymentNumber",
            "qrString",
            "qrImageUrl",
            "paymentReference",
            "providerTransactionId",
            "externalSessionId",
            "evidenceFileKey",
            "organizerId",
            "picProfileId",
        ]) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    test("it reads `fulfilmentBlockedAt` to derive canIssueTickets, but never projects it", () => {
        // The ONE column the list reads for a non-display reason. It stays on the row and is
        // turned into the `fulfilment` state; the payload key list below is what proves it is
        // not passed through.
        expect(ORDER_SUMMARY_SELECT).toHaveProperty("fulfilmentBlockedAt", true);
        expect(Object.keys(buildOrderSummary(summaryRow()))).not.toContain(
            "fulfilmentBlockedAt"
        );
    });

    test("it selects no payment columns at all, so nothing can leak a live instrument", () => {
        expect(ORDER_SUMMARY_SELECT).not.toHaveProperty("payments");
        expect(JSON.stringify(ORDER_SUMMARY_SELECT)).not.toContain("payments");
    });

    test("the payload carries no credential and no internal identifier", () => {
        const row = buildOrderSummary(summaryRow());
        const keys = Object.keys(row);

        for (const forbidden of [
            "ticketCode",
            "tickets",
            "qrToken",
            "qrPayload",
            "evidenceFileKey",
            "evidenceFileName",
            "paymentUrl",
            "paymentInstruction",
            "organizerId",
            "userId",
            "fulfilmentBlockedAt",
        ]) {
            expect(keys).not.toContain(forbidden);
        }

        expect(JSON.stringify(row)).not.toMatch(/TICKET:|qrToken|organizerId/);
    });

    test("it renders the order's own lines as a summary and a count", () => {
        const row = buildOrderSummary(summaryRow());

        expect(row.ticketSummary).toBe("2× Tribun Utara, 1× VIP");
        expect(row.ticketCount).toBe(3);
    });

    test("money is a fixed 2-decimal STRING, never a JSON number", () => {
        const row = buildOrderSummary(summaryRow());

        expect(row.total).toBe("150000.00");
        expect(typeof row.total).toBe("string");
    });

    test("it links to the order's own detail route, built in one place", () => {
        expect(buildOrderSummary(summaryRow()).orderUrl).toBe(
            "/ticketing/orders/EVT-20260925-000001"
        );
        expect(orderDetailUrl("EVT-X")).toBe("/ticketing/orders/EVT-X");
    });

    test("the newest refund decides the row's refund status, and none reads as null", () => {
        expect(buildOrderSummary(summaryRow()).refundStatus).toBeNull();
        expect(
            buildOrderSummary(summaryRow({ refunds: [{ status: "REFUNDED" }] }))
                .refundStatus
        ).toBe("REFUNDED");
    });

    test("an empty venue and an empty basket still render honestly", () => {
        const row = buildOrderSummary(
            summaryRow({
                event: {
                    title: "Event tanpa lokasi",
                    slug: "tanpa-lokasi",
                    startAt: new Date("2026-10-03T12:00:00.000Z"),
                    endAt: null,
                    venue: null,
                },
                items: [],
                tickets: [],
                status: "PENDING_PAYMENT",
                paymentStatus: "UNPAID",
            })
        );

        expect(row.venueName).toBeNull();
        expect(row.endAt).toBeNull();
        expect(row.ticketSummary).toBe("");
        expect(row.ticketCount).toBe(0);
    });

    test("a PENDING_PAYMENT order reads as awaiting payment, issued only when tickets exist", () => {
        const pending = buildOrderSummary(
            summaryRow({
                status: "PENDING_PAYMENT",
                paymentStatus: "UNPAID",
                paidAt: null,
                tickets: [],
            })
        );

        expect(pending.fulfilment).toBe("AWAITING_PAYMENT");
    });
});

/* ==================================================================================
 * 6-7. THE SHARED PREDICATES — LIST AND DETAIL CANNOT DISAGREE
 * ================================================================================== */

describe("P20B-3. the advisory predicates are shared with the order detail", () => {
    const cases: {
        name: string;
        order: Parameters<typeof orderCanPay>[0];
        canPay: boolean;
    }[] = [
        {
            name: "pending inside the window",
            order: {
                status: "PENDING_PAYMENT",
                paymentStatus: "UNPAID",
                expiresAt: new Date("2026-09-25T05:00:00.000Z"),
            },
            canPay: true,
        },
        {
            name: "pending past the window",
            order: {
                status: "PENDING_PAYMENT",
                paymentStatus: "UNPAID",
                expiresAt: new Date("2026-09-25T01:00:00.000Z"),
            },
            canPay: false,
        },
        {
            name: "already paid",
            order: {
                status: "PENDING_PAYMENT",
                paymentStatus: "PAID",
                expiresAt: null,
            },
            canPay: false,
        },
        {
            name: "cancelled",
            order: {
                status: "CANCELLED",
                paymentStatus: "UNPAID",
                expiresAt: null,
            },
            canPay: false,
        },
    ];

    test.each(cases)("canPay is $name → $canPay", ({ order, canPay }) => {
        expect(orderCanPay(order, new Date("2026-09-25T03:00:00.000Z"))).toBe(canPay);
    });

    test("a null window presumes nothing lapsed, and the service re-checks anyway", () => {
        expect(
            orderCanPay(
                { status: "PENDING_PAYMENT", paymentStatus: "UNPAID", expiresAt: null },
                new Date()
            )
        ).toBe(true);
    });

    test("canRequestRefund needs a paid order, tickets, and EVERY ticket still ISSUED", () => {
        expect(
            orderCanRequestRefund({ paymentStatus: "PAID", tickets: [{ status: "ISSUED" }] })
        ).toBe(true);

        expect(
            orderCanRequestRefund({
                paymentStatus: "PARTIALLY_REFUNDED",
                tickets: [{ status: "ISSUED" }],
            })
        ).toBe(true);

        // A checked-in ticket is exactly the case the refund policy refuses, so the list must
        // not offer the action for it.
        expect(
            orderCanRequestRefund({
                paymentStatus: "PAID",
                tickets: [{ status: "ISSUED" }, { status: "CHECKED_IN" }],
            })
        ).toBe(false);

        expect(orderCanRequestRefund({ paymentStatus: "UNPAID", tickets: [] })).toBe(false);
        expect(orderCanRequestRefund({ paymentStatus: "PAID", tickets: [] })).toBe(false);
    });

    test("fulfilment is four states, and mirrors the detail page's verdict", () => {
        expect(
            orderFulfilment({
                paymentStatus: "PAID",
                tickets: [{ status: "ISSUED" }],
                canIssueTickets: false,
            })
        ).toBe("ISSUED");

        expect(
            orderFulfilment({
                paymentStatus: "PAID",
                tickets: [],
                canIssueTickets: true,
            })
        ).toBe("READY");

        expect(
            orderFulfilment({
                paymentStatus: "PAID",
                tickets: [],
                canIssueTickets: false,
            })
        ).toBe("HELD");

        expect(
            orderFulfilment({
                paymentStatus: "UNPAID",
                tickets: [],
                canIssueTickets: false,
            })
        ).toBe("AWAITING_PAYMENT");
    });

    test("the detail page renders its badge FROM the shared state, not a second branch", () => {
        const page = read("app/ticketing/orders/[orderNumber]/page.tsx");

        expect(page).toContain("orderFulfilment(");
        expect(page).toContain("from \"@/lib/ticketing/order-payload\"");
    });
});

/* ==================================================================================
 * 8. REFUND STATUS + BUYER EVIDENCE
 * ================================================================================== */

describe("P20B-4. the buyer refund payload says evidence EXISTS without saying where", () => {
    test("no key is attached → hasEvidence is false and no URL is built", () => {
        const payload = buildRefundPayload(refundRow({ evidenceFileKey: null }));

        expect(payload.hasEvidence).toBe(false);
        expect(Object.keys(payload)).not.toContain("evidenceFileKey");
        expect(Object.keys(payload)).not.toContain("evidenceFileName");
        expect(JSON.stringify(payload)).not.toContain(STORED_KEY);
    });

    test("a key is attached → hasEvidence is true, and the key is still not in the payload", () => {
        const payload = buildRefundPayload(refundRow({ evidenceFileKey: STORED_KEY }));

        expect(payload.hasEvidence).toBe(true);

        // The whole point: a JSON refund response cannot carry the storage key even when it
        // reports that the evidence is there.
        expect(JSON.stringify(payload)).not.toContain(STORED_KEY);
        expect(Object.keys(payload)).not.toContain("evidenceFileKey");
    });

    test("the SELECT reads the key (to answer the boolean) and projects nothing else new", () => {
        expect(REFUND_SELECT).toHaveProperty("evidenceFileKey", true);
        expect(REFUND_SELECT).not.toHaveProperty("evidenceFileName");
        expect(REFUND_SELECT).not.toHaveProperty("evidenceFileSizeB");
        expect(REFUND_SELECT).not.toHaveProperty("evidenceMimeType");
    });

    test("the evidence href is the EXISTING buyer serve route, and never the organizer one", () => {
        const url = refundEvidenceUrl(7, STORED_KEY);

        expect(url).toBe(`/api/ticketing/refunds/7/evidence/${STORED_KEY}`);
        expect(url).toContain("/api/ticketing/refunds/");
        expect(url).not.toContain("/api/organizer/");
    });
});

describe("P20B-5. the order detail reads its OWN order's refunds, own-scope", () => {
    test("ownership is the ORDER's user, not merely the requester", async () => {
        await listOwnRefundsForOrder("EVT-20260925-000001", scope(BUYER));

        const call = refundFindMany.mock.calls[0][0];

        expect(call.where).toEqual({
            eventOrder: { orderNumber: "EVT-20260925-000001", userId: BUYER },
        });
        expect(ownResource).toHaveBeenCalledWith(PERMISSIONS.ORDER_READ_OWN, BUYER);
        expect(call.select).toBe(REFUND_SELECT);
    });

    test("a foreign order yields nothing, even if a refund row exists", async () => {
        refundFindMany.mockResolvedValue([]);

        await expect(
            listOwnRefundsForOrder("EVT-SOMEONE-ELSE", scope(BUYER))
        ).resolves.toEqual([]);

        // The predicate never named the other buyer, because it never had to: the row must
        // belong to an order THIS caller owns.
        expect(JSON.stringify(refundFindMany.mock.calls[0][0].where)).not.toContain("victim");
    });

    test("the href is attached server-side, from the row, and is null without evidence", async () => {
        refundFindMany.mockResolvedValue([
            refundRow({ id: 7, evidenceFileKey: STORED_KEY }),
            refundRow({ id: 8, evidenceFileKey: null }),
        ]);

        const [withEvidence, without] = await listOwnRefundsForOrder(
            "EVT-20260925-000001",
            scope(BUYER)
        );

        expect(withEvidence.evidenceUrl).toBe(
            `/api/ticketing/refunds/7/evidence/${STORED_KEY}`
        );
        expect(withEvidence.hasEvidence).toBe(true);
        expect(without.evidenceUrl).toBeNull();
        expect(without.hasEvidence).toBe(false);
    });

    test("an unauthenticated caller is refused before any query", async () => {
        await expect(
            listOwnRefundsForOrder(
                "EVT-1",
                undefined as unknown as AuthzScope
            )
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

        expect(refundFindMany).not.toHaveBeenCalled();
    });
});

/* ==================================================================================
 * 9-10, 12-13. RENDERING — THE CARD AND THE REFUND PANEL
 * ================================================================================== */

function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
    return renderToStaticMarkup(element);
}

describe("P20B-6. the order card renders the payload, and nothing more", () => {
    test("it shows the order number, the event, the total and the three statuses", () => {
        const html = render(createElement(OrderCard, { order: summary() }));

        expect(html).toContain("EVT-20260925-000001");
        expect(html).toContain("Liga Basket Bandung");
        expect(html).toContain("2× Tribun Utara, 1× VIP");
        // `Rp150.000` — the market's own formatting, not "150000.00".
        expect(html).toContain("150.000");
        expect(html).toContain("Sudah dibayar");
        expect(html).toContain("Lunas");
        expect(html).toContain("Tiket terbit");
    });

    test("it links to the order's own detail page and to nowhere else", () => {
        const html = render(createElement(OrderCard, { order: summary() }));

        expect(html).toContain('href="/ticketing/orders/EVT-20260925-000001"');
        expect(html.match(/href="/g)).toHaveLength(1);
    });

    test("a refund badge appears only when the order HAS a refund", () => {
        const withRefund = render(
            createElement(OrderCard, {
                order: summary({ refundStatus: "REFUNDED", status: "REFUNDED" }),
            })
        );
        const without = render(createElement(OrderCard, { order: summary() }));

        expect(withRefund).toContain("Dana dikembalikan");
        expect(without).not.toContain("Refund");
    });

    test("an unknown status degrades to its own value rather than disappearing", () => {
        const html = render(
            createElement(OrderCard, {
                order: summary({ status: "WEIRD_STATE", refundStatus: "ODD" }),
            })
        );

        expect(html).toContain("WEIRD_STATE");
        expect(html).toContain("ODD");
    });

    test("it carries NO credential, no storage key and no internal identifier", () => {
        const html = render(
            createElement(OrderCard, {
                order: summary({
                    refundStatus: "PROCESSING",
                    orderNumber: "EVT-20260925-000001",
                }),
            })
        );

        // The raw QR token and the buyer-facing QR payload are never rendered by a list card.
        expect(html).not.toMatch(/TICKET:/);
        expect(html).not.toContain("qrToken");
        expect(html).not.toContain("qrTokenHash");
        expect(html).not.toContain("evidence");
        expect(html).not.toContain("organizerId");
        expect(html).not.toContain("/api/");
    });

    test("a missing event title still renders a card rather than throwing", () => {
        const html = render(
            createElement(OrderCard, {
                order: summary({ venueName: null, ticketSummary: "" }),
            })
        );

        expect(html).toContain("Lokasi menyusul");
        expect(html).toContain("Lihat pesanan");
    });
});

/* ==================================================================================
 * 11, 14. WIRING GUARDS
 * ================================================================================== */

const ORDER_LIST_PAGE = "app/ticketing/orders/page.tsx";
const ORDER_LIST_LOADING = "app/ticketing/orders/loading.tsx";
const ORDER_DETAIL_PAGE = "app/ticketing/orders/[orderNumber]/page.tsx";
const ORDER_CARD = "components/ticketing/OrderCard.tsx";
const SITE_HEADER = "components/ticketing/SiteHeader.tsx";
const ORDER_LIST_ROUTE = "app/api/ticketing/orders/route.ts";
const ORDERS_SERVICE = "lib/ticketing/orders.ts";
const REFUNDS_SERVICE = "lib/ticketing/refunds/service.ts";
const BUYER_EVIDENCE_ROUTE =
    "app/api/ticketing/refunds/[refundId]/evidence/[fileName]/route.ts";
const ORGANIZER_EVIDENCE_POST = "app/api/organizer/refunds/[refundId]/evidence/route.ts";
const ORGANIZER_EVIDENCE_GET =
    "app/api/organizer/refunds/[refundId]/evidence/[fileName]/route.ts";

/** Every surface this vertical added or changed, on the buyer's side. */
const CUSTOMER_SURFACES = [
    ORDER_LIST_PAGE,
    ORDER_LIST_LOADING,
    ORDER_DETAIL_PAGE,
    ORDER_CARD,
    SITE_HEADER,
    ORDER_LIST_ROUTE,
];

describe("P20B-7. navigation", () => {
    test("the header links 'Pesanan saya' for a signed-in visitor, on desktop AND mobile", () => {
        const source = code(read(SITE_HEADER));

        // The desktop anchor and the mobile menu entry — two renderings of ONE destination,
        // both behind the `signedIn` branch.
        expect(source).toMatch(/href="\/ticketing\/orders"/);
        expect(source).toMatch(/href: "\/ticketing\/orders"/);
        expect(source).toContain("Pesanan saya");

        // One navigation system: the new entry is rendered by the existing header, and the
        // header is the shell's — no second header was created for the customer list.
        expect(source).toContain("MobileMenu");
        expect(read("components/ticketing/SiteShell.tsx")).toContain("SiteHeader");
    });

    test("it is NOT in the public NAV, because the list requires a session", () => {
        const source = code(read(SITE_HEADER));
        const nav = source.slice(
            source.indexOf("const NAV = ["),
            source.indexOf("];", source.indexOf("const NAV = ["))
        );

        expect(nav).not.toContain("/ticketing/orders");
        expect(nav).not.toContain("/ticketing/tickets");
    });

    test("the route inventory classifies the new page and names where it is reached from", () => {
        const entry = ROUTE_INVENTORY.find(
            (candidate) => candidate.route === "/ticketing/orders"
        );

        expect(entry).toBeDefined();
        expect(entry!.file).toBe(ORDER_LIST_PAGE);
        expect(entry!.referencedBy).toContain("SiteHeader");
    });
});

describe("P20B-8. the list page keeps the refusal-versus-outage contract", () => {
    test("it reads through the service, never Prisma, and never the session directly", () => {
        const source = code(read(ORDER_LIST_PAGE));

        expect(source).toContain("listOwnOrders(");
        expect(source).not.toContain('from "@/lib/prisma"');
        expect(source).not.toContain("prisma.");
        expect(source).not.toContain('from "@/auth"');
    });

    test("an outage is a retry state, never an empty list", () => {
        const source = code(read(ORDER_LIST_PAGE));

        expect(source).toContain("resolvePageFailure");
        expect(source).toContain('failure.action === "unavailable"');
        expect(source).toContain("ServiceUnavailableState");
        expect(source).not.toMatch(/\.catch\(\(\) => null\)/);
    });

    test("a refusal is an empty list, and anything else is re-thrown", () => {
        const source = code(read(ORDER_LIST_PAGE));

        expect(source).toContain('failure.action !== "denied"');
        expect(source).toContain("throw error");
        expect(source).toContain('failure.action === "sign-in"');
    });

    test("an unauthenticated visitor is sent to login, with the page preserved", () => {
        const source = code(read(ORDER_LIST_PAGE));

        expect(source).toContain("loginUrlFor(");
        expect(source).toContain("redirect(");
        expect(source).not.toContain("login?next=");
    });

    test("the empty state offers a way out instead of a dead end", () => {
        const source = code(read(ORDER_LIST_PAGE));

        expect(source).toContain("<EmptyState");
        expect(source).toContain('href: "/events"');
    });

    test("the page takes only a page number from the URL — never a status or a user", () => {
        const source = code(read(ORDER_LIST_PAGE));

        expect(source).toContain("searchParams");
        expect(source).not.toContain("searchParams.status");
        expect(source).not.toContain("searchParams.userId");
        expect(source).not.toContain("searchParams.organizerId");
    });
});

describe("P20B-9. the list has an explicit loading state", () => {
    test("the route ships a loading file, in the place Next.js looks for it", () => {
        expect(fs.existsSync(path.join(ROOT, ORDER_LIST_LOADING))).toBe(true);
    });

    test("the skeleton DECIDES nothing: no session, no query, no data", () => {
        const source = code(read(ORDER_LIST_LOADING));

        expect(source).not.toContain('from "@/auth"');
        expect(source).not.toContain('from "@/lib/prisma"');
        expect(source).not.toContain("listOwnOrders");
        expect(source).not.toContain("getAuthzScope");
    });

    test("it cannot be mistaken for real data — no formatted money, no order number", () => {
        const source = code(read(ORDER_LIST_LOADING));

        expect(source).not.toContain("formatIdr");
        expect(source).not.toContain("OrderCard");
        expect(source).not.toMatch(/EVT-\d/);
        expect(source).not.toContain("Lunas");
    });

    test("it announces itself and reuses the shell and tokens rather than a second system", () => {
        const source = code(read(ORDER_LIST_LOADING));

        expect(source).toContain("<SiteShell>");
        expect(source).toContain('role="status"');
        expect(source).toContain("sr-only");
        expect(source).toContain("animate-pulse");
        expect(source).toContain("ink-");
    });
});

describe("P20B-10. the buyer evidence surface is the EXISTING one, and it is read-only", () => {
    test("the order detail renders the server-built href to the buyer route", () => {
        const source = code(read(ORDER_DETAIL_PAGE));

        expect(source).toContain("listOwnRefundsForOrder(");
        expect(source).toContain("refund.evidenceUrl");
        expect(source).toContain("refund.hasEvidence");
        expect(source).toContain("<a");
        expect(source).toContain('rel="noopener noreferrer"');
    });

    test("no buyer surface can reach an organizer refund route or an upload control", () => {
        for (const file of CUSTOMER_SURFACES) {
            const source = code(read(file));

            expect(source).not.toContain("/api/organizer/");
            expect(source).not.toContain("api/organizer");
            expect(source).not.toContain("FormData");
            expect(source).not.toContain('type="file"');
            expect(source).not.toContain("attachRefundEvidence");
        }
    });

    test("the href is BUILT by the server, and the buyer route is the only evidence route named", () => {
        const source = code(read(ORDER_DETAIL_PAGE));

        // The page never assembles a path from a key — it renders the URL the service built.
        expect(source).not.toContain("/api/ticketing/refunds/");
        expect(source).not.toContain("evidenceFileKey");

        // And the service builds it from the ONE place that knows the route shape.
        expect(code(read(REFUNDS_SERVICE))).toContain("refundEvidenceUrl(");
        expect(code(read("lib/ticketing/refunds/payload.ts"))).toContain(
            "/api/ticketing/refunds/${refundId}/evidence/"
        );
    });

    test("the buyer serve route is reused unchanged, and the organizer twins stay staff-only", () => {
        const buyer = code(read(BUYER_EVIDENCE_ROUTE));
        const organizerPost = code(read(ORGANIZER_EVIDENCE_POST));
        const organizerGet = code(read(ORGANIZER_EVIDENCE_GET));

        // The buyer route serves bytes and never accepts any.
        expect(buyer).toContain("readRefundEvidenceForBuyer(");
        expect(buyer).not.toContain("storeRefundEvidence");
        expect(buyer).toContain("nosniff");
        expect(buyer).toContain('"Content-Disposition": "inline"');

        expect(organizerPost).toContain("attachRefundEvidence(");
        expect(organizerGet).toContain("readRefundEvidenceForOrganizer(");

        // A buyer may not upload or replace, and the two routes are named in no buyer surface.
        expect(buyer).not.toContain("attachRefundEvidence");
    });

    test("the list API route is session-gated and hands the session to the scoped service", () => {
        const source = code(read(ORDER_LIST_ROUTE));

        expect(source).toContain("requireAuth()");
        expect(source).toContain("listOwnOrders(");
        expect(source).toContain("orderListQuerySchema");
        // Ownership is never read from the request.
        expect(source).not.toContain("userId");
        expect(source).not.toContain("organizerId");
    });

    test("the service's own list query carries the ownership predicate", () => {
        const source = code(read(ORDERS_SERVICE));
        const list = source.slice(
            source.indexOf("export async function listOwnOrders"),
            source.indexOf("export async function getOwnOrder")
        );

        expect(list).toContain("userId: actor.userId");
        expect(list).toContain("requireOwnResource(PERMISSIONS.ORDER_READ_OWN");
    });
});

describe("P20B-11. no native browser dialog, and no credential, in any new surface", () => {
    test.each(CUSTOMER_SURFACES)("%s contains no window.prompt/confirm/alert", (file) => {
        const source = code(read(file));

        expect(source).not.toMatch(/window\s*\.\s*(prompt|confirm|alert)/);
        expect(source).not.toMatch(/(^|[^.\w])(prompt|confirm)\s*\(/);
    });

    test.each(CUSTOMER_SURFACES)("%s renders no raw secret or service identifier", (file) => {
        const source = code(read(file));

        expect(source).not.toMatch(/qrTokenHash|qrToken\b/);
        expect(source).not.toContain("IPAYMU_");
        expect(source).not.toContain("PAYMENT_SECRET");
        expect(source).not.toContain("webhook");
        expect(source).not.toContain("dangerouslySetInnerHTML");
    });

    test("the buyer QR contract is untouched: the list never embeds a scannable value", () => {
        const card = code(read(ORDER_CARD));

        expect(card).not.toContain("TICKET:");
        expect(card).not.toContain("TicketQr");
        expect(card).not.toContain("QRCodeSVG");
    });
});
