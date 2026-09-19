/**
 * ==========================================
 * PHASE 18B — OPERATOR VISIBILITY FOR THE TWO RECOVERABLE MONEY STATES
 * ==========================================
 *
 * Phase 18A locked two states as deliberately MANUAL rather than automatically resolved:
 *
 *   * D-P17-17 — a LATE SETTLEMENT (money received for an order that was already final) stays
 *     blocked from fulfilment and is resolved by a human. It must never silently resurrect the
 *     order, restore quota or issue a ticket.
 *   * D-P17-18 — a PAID order with ZERO tickets is allowed by construction, because ticket
 *     issuance is buyer-triggered. It is recoverable, and the platform must not mint tickets on
 *     its own.
 *
 * "Resolved by a human" is only real if a human can FIND them. This suite proves the read model
 * does that — and, equally, that seeing them changes nothing: the late-settled order is still
 * blocked and ticket-less, and the paid/no-ticket order still receives its tickets through the
 * BUYER's own idempotent issuance path, not through the dashboard.
 *
 * It lives in `__tests__/ticketing-refunds/` because both states are money-recovery states of
 * the refund/settlement domain; there is no `__tests__/dashboard/` namespace in `jest.config.js`
 * and adding one for a single read-model suite would be churn, not coverage.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { listDashboardOrders } from "@/lib/dashboard/orders";
import { prisma } from "@/lib/prisma";

import {
    createLateSettledOrder,
    createPaidOrder,
    createType,
    installGatewayStub,
    issue,
    organizerScope,
    setupIssuanceFixtures,
    teardownIssuanceFixtures,
    ticketsFor,
    type Fixtures,
} from "../ticketing-issuance/issuance-harness";

jest.setTimeout(180_000);

let f: Fixtures;
let fetchSpy: jest.SpyInstance;
let tagCounter = 0;

const nextTag = (tag: string) => `${tag}-${++tagCounter}`;

beforeAll(async () => {
    f = await setupIssuanceFixtures();
    fetchSpy = installGatewayStub();
});

afterAll(async () => {
    fetchSpy.mockRestore();
    await teardownIssuanceFixtures(f);
});

describe("the operator worklist surfaces the recoverable money states", () => {
    test("a late settlement and a paid-without-tickets order are both visible, and nothing else is", async () => {
        const type = await createType(f, "Visibility", { quota: 20 });

        // 1. A LATE SETTLEMENT, produced by its real cause: the order is cancelled (releasing
        //    its seats) and only then does the provider's success notification arrive.
        const late = await createLateSettledOrder({
            buyerId: f.buyerA.id,
            ticketTypeId: type.id,
            quantity: 1,
            tag: nextTag("late"),
        });

        // 2. A PAID order that has not issued its tickets yet (issuance is buyer-triggered).
        const paidNoTickets = await createPaidOrder({
            buyerId: f.buyerB.id,
            ticketTypeId: type.id,
            quantity: 1,
            tag: nextTag("paid-no-tickets"),
        });

        // 3. A perfectly ordinary fulfilled order, which must NOT appear on the worklist.
        const healthy = await createPaidOrder({
            buyerId: f.buyerB.id,
            ticketTypeId: type.id,
            quantity: 1,
            tag: nextTag("healthy"),
        });
        await issue(healthy.orderNumber, f.buyerB.id);

        const scope = await organizerScope(f.orgA.id, f.ownerA.id);

        const worklist = await listDashboardOrders(scope, {
            needsReview: true,
            page: 1,
            limit: 50,
        });

        const visible = worklist.items.map((row) => row.orderNumber);

        expect(visible).toContain(late.orderNumber);
        expect(visible).toContain(paidNoTickets.orderNumber);
        expect(visible).not.toContain(healthy.orderNumber);

        // The late settlement is identifiable BY ITS own column, which is what an operator
        // reconciles against the bank statement.
        const lateRow = worklist.items.find(
            (row) => row.orderNumber === late.orderNumber
        );
        expect(lateRow?.fulfilmentBlockedAt).not.toBeNull();
        expect(lateRow?._count.tickets).toBe(0);

        // The paid/no-ticket row carries no block: it is merely unfulfilled.
        const paidRow = worklist.items.find(
            (row) => row.orderNumber === paidNoTickets.orderNumber
        );
        expect(paidRow?.fulfilmentBlockedAt).toBeNull();
        expect(paidRow?._count.tickets).toBe(0);

        // ── And the read model changed NOTHING ────────────────────────────────────────────
        const lateDb = await prisma.eventOrder.findUniqueOrThrow({
            where: { orderNumber: late.orderNumber },
            select: { status: true, paymentStatus: true, fulfilmentBlockedAt: true },
        });

        // Still cancelled, still blocked, still no tickets: no silent resurrection.
        expect(lateDb.status).toBe("CANCELLED");
        expect(lateDb.paymentStatus).toBe("PAID");
        expect(lateDb.fulfilmentBlockedAt).not.toBeNull();
        expect(await ticketsFor(late.orderId)).toHaveLength(0);

        // ── D-P17-18: recovery is the BUYER's idempotent issuance, not the dashboard ──────
        const firstIssue = await issue(paidNoTickets.orderNumber, f.buyerB.id);

        expect(firstIssue.outcome).toBe("ISSUED");
        expect(firstIssue.ticketsIssued).toBe(1);

        // A repeated call is idempotent: it creates nothing, and the order still has ONE
        // ticket. The repetition is what proves the buyer cannot double-fulfil by refreshing.
        const repeat = await issue(paidNoTickets.orderNumber, f.buyerB.id);

        expect(repeat.outcome).toBe("ALREADY_ISSUED");
        expect(repeat.ticketsIssued).toBe(0);

        const tickets = await ticketsFor(paidNoTickets.orderId);
        expect(tickets).toHaveLength(1);
        expect(new Set(tickets.map((ticket) => ticket.ticketCode)).size).toBe(1);

        // It has now left the worklist, by its own state — not by anything the dashboard did.
        const after = await listDashboardOrders(scope, {
            needsReview: true,
            page: 1,
            limit: 50,
        });

        expect(after.items.map((row) => row.orderNumber)).not.toContain(
            paidNoTickets.orderNumber
        );
        // The late settlement is still there: only a human closes that one.
        expect(after.items.map((row) => row.orderNumber)).toContain(late.orderNumber);
    });

    test("the worklist is tenant-scoped", async () => {
        const otherTenant = await organizerScope(f.orgB.id, f.ownerB.id);

        const worklist = await listDashboardOrders(otherTenant, {
            needsReview: true,
            page: 1,
            limit: 50,
        });

        // orgB has no orders in this fixture: the filter is applied INSIDE the tenant scope,
        // so a worklist can never become a cross-tenant leak.
        expect(worklist.items).toHaveLength(0);
    });
});
