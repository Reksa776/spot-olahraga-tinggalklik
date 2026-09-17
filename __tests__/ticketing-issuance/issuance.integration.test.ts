/**
 * ==========================================
 * PHASE 8 — TICKET ISSUANCE (INTEGRATION)
 * ==========================================
 *
 * The fulfilment boundary, end to end against the real database: real checkout, real
 * settlement, real row lock, real unique constraints, real `lib/authz` guards.
 *
 * Coverage maps to the phase brief's §33 groups A (eligibility), B (quantity), C
 * (idempotency), D (partial recovery), F (ownership), G (QR), H (audit) and I
 * (tenant/security). Group E (concurrency) lives in its own suite, because a real InnoDB
 * race needs a different setup and a much larger timeout budget.
 *
 * ── WHY THE ORDER STATE IS PRODUCED BY REAL CODE ────────────────────────────────
 * Every terminal order state below is reached the way production reaches it:
 * `CANCELLED` through `cancelOwnPendingOrder`, `EXPIRED` through the real reaper,
 * the `fulfilmentBlockedAt` combination through a real late settlement. Only
 * `paymentStatus: FAILED` is written directly, and that is stated at the call site: no
 * service sets it in Phase 7 (a failed attempt is recorded on the `Payment` row), so
 * there is no production path to invoke for it.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { NextRequest } from "next/server";

import { POST as issueRoute } from "@/app/api/ticketing/orders/[orderNumber]/issue/route";
import { GET as ticketDetailRoute } from "@/app/api/ticketing/tickets/[ticketCode]/route";
import { GET as walletRoute } from "@/app/api/ticketing/tickets/route";
import { ERROR_CODES } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";
import { cancelOwnPendingOrder } from "@/lib/ticketing/orders";
import { expireDueReservations } from "@/lib/ticketing/reservations";
import {
    buildTicketQrPayload,
    isTicketCode,
    TICKET_CODE_PATTERN,
    TICKET_QR_PREFIX,
} from "@/lib/ticketing/tickets/reference";
import { getOwnTicket, listOwnTickets } from "@/lib/ticketing/tickets/service";
import { ticketWalletQuerySchema } from "@/lib/ticketing/tickets/validation";

import {
    createOrder,
    createPaidOrder,
    createLateSettledOrder,
    createType,
    customerScope,
    expectRejection,
    installGatewayStub,
    issue,
    issuanceAuditRows,
    orderState,
    organizerScope,
    payOrder,
    setupIssuanceFixtures,
    signInAs,
    teardownIssuanceFixtures,
    ticketsFor,
    type Fixtures,
} from "./issuance-harness";

jest.setTimeout(180_000);

let f: Fixtures;
let fetchSpy: jest.SpyInstance;

async function newType(name: string, quota = 20): Promise<string> {
    return (await createType(f, name, { quota })).id;
}

/**
 * A browser-shaped POST to the issuance route.
 *
 * `/api/ticketing` is protected in `proxy.ts`, but the proxy does not run under Jest — this
 * exercises the handler's own controls, which are the real ones: `requireSameOrigin`,
 * `requireAuth`, and the ownership predicate inside the service.
 */
function issueRequest(
    orderNumber: string,
    options: { origin?: string | null } = {}
): { request: NextRequest; params: Promise<{ orderNumber: string }> } {
    const origin = options.origin === undefined ? "http://localhost:3000" : options.origin;

    const headers: Record<string, string> = {
        "x-forwarded-host": "localhost:3000",
        "x-forwarded-proto": "http",
        "content-type": "application/json",
    };

    if (origin) {
        headers.origin = origin;
    }

    return {
        request: new NextRequest(
            new URL(`http://localhost:3000/api/ticketing/orders/${orderNumber}/issue`),
            { method: "POST", headers }
        ),
        params: Promise.resolve({ orderNumber }),
    };
}

beforeAll(async () => {
    f = await setupIssuanceFixtures();
    fetchSpy = installGatewayStub();
});

afterAll(async () => {
    fetchSpy.mockRestore();
    await teardownIssuanceFixtures(f);
});

/* ==========================================
 * A. ELIGIBILITY
 * ========================================== */

describe("A. issuance eligibility (brief §5 / §19)", () => {
    it("A1. issues for a PAID / PAID order and marks the order fulfilled by its rows", async () => {
        const ticketTypeId = await newType("A1", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "a1",
        });

        const before = await orderState(order.orderId);
        expect(before.status).toBe("PAID");
        expect(before.paymentStatus).toBe("PAID");
        expect(before.paidAt).not.toBeNull();
        expect(before.fulfilmentBlockedAt).toBeNull();

        const result = await issue(order.orderNumber, f.buyerA.id);

        expect(result.outcome).toBe("ISSUED");
        expect(result.ticketsIssued).toBe(2);
        expect(result.expectedTickets).toBe(2);
        expect(result.totalTickets).toBe(2);
        expect(result.orderNumber).toBe(order.orderNumber);

        const rows = await ticketsFor(order.orderId);
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.status === "ISSUED")).toBe(true);
        expect(rows.every((row) => row.holderUserId === f.buyerA.id)).toBe(true);
        expect(rows.every((row) => row.issuedAt !== null)).toBe(true);
    });

    it("A2. refuses a PENDING_PAYMENT order with PAYMENT_REQUIRED", async () => {
        const ticketTypeId = await newType("A2", 20);
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId, quantity: 1 }],
            tag: "a2",
        });

        const error = await expectRejection(() =>
            issue(order.orderNumber, f.buyerA.id)
        );

        expect(error.code).toBe(ERROR_CODES.PAYMENT_REQUIRED);
        expect(error.httpStatus).toBe(402);
        expect(error.details?.reason).toBe("ORDER_NOT_PAID");
        expect(await ticketsFor(order.orderId)).toHaveLength(0);
    });

    it("A3. refuses an order whose payment attempt failed", async () => {
        const ticketTypeId = await newType("A3", 20);
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId, quantity: 1 }],
            tag: "a3",
        });

        // Written directly: Phase 7 records a failed attempt on the `Payment` row and
        // leaves the order PENDING_PAYMENT, so there is no service that sets this
        // combination. The gate must refuse it either way, which is the assertion.
        await prisma.eventOrder.update({
            where: { id: order.orderId },
            data: { paymentStatus: "FAILED" },
        });

        const error = await expectRejection(() =>
            issue(order.orderNumber, f.buyerA.id)
        );

        expect(error.code).toBe(ERROR_CODES.PAYMENT_REQUIRED);
        expect(await ticketsFor(order.orderId)).toHaveLength(0);
    });

    it("A4. refuses a CANCELLED order", async () => {
        const ticketTypeId = await newType("A4", 20);
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId, quantity: 1 }],
            tag: "a4",
        });

        await cancelOwnPendingOrder(
            order.orderNumber,
            await customerScope(f.buyerA.id),
            "test: eligibility"
        );

        const error = await expectRejection(() =>
            issue(order.orderNumber, f.buyerA.id)
        );

        expect(error.code).toBe(ERROR_CODES.PAYMENT_REQUIRED);
        expect(error.details?.reason).toBe("ORDER_NOT_PAID");
        expect(await ticketsFor(order.orderId)).toHaveLength(0);
    });

    it("A5. refuses an EXPIRED order (expired by the real reaper)", async () => {
        const ticketTypeId = await newType("A5", 20);
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId, quantity: 1 }],
            tag: "a5",
        });

        // Move only the CLOCK's input — the reservation's deadline — and then run the real
        // expiry path. Nothing else about the order is written by hand.
        await prisma.ticketReservation.updateMany({
            where: { orderId: order.orderId },
            data: { expiresAt: new Date(Date.now() - 60_000) },
        });

        const expired = await expireDueReservations({ now: new Date() });
        expect(expired.ordersExpired).toBeGreaterThanOrEqual(1);

        const state = await orderState(order.orderId);
        expect(state.status).toBe("EXPIRED");

        const error = await expectRejection(() =>
            issue(order.orderNumber, f.buyerA.id)
        );

        expect(error.code).toBe(ERROR_CODES.PAYMENT_REQUIRED);
        expect(await ticketsFor(order.orderId)).toHaveLength(0);
    });

    it("A6. refuses a PAID order blocked by a late settlement (brief §19)", async () => {
        const ticketTypeId = await newType("A6", 20);
        const order = await createLateSettledOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "a6",
        });

        const state = await orderState(order.orderId);
        expect(state.paymentStatus).toBe("PAID");
        expect(state.paidAt).not.toBeNull();
        expect(state.fulfilmentBlockedAt).not.toBeNull();
        expect(state.status).not.toBe("PAID");

        const error = await expectRejection(() =>
            issue(order.orderNumber, f.buyerA.id)
        );

        expect(error.code).toBe(ERROR_CODES.CONFLICT);
        expect(error.details?.reason).toBe("FULFILMENT_BLOCKED");
        expect(await ticketsFor(order.orderId)).toHaveLength(0);
    });

    it("A7. does not repair a blocked order — no ticket, no state change, no release", async () => {
        const ticketTypeId = await newType("A7", 20);
        const order = await createLateSettledOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "a7",
        });

        const before = await orderState(order.orderId);
        const countersBefore = await prisma.ticketType.findUniqueOrThrow({
            where: { id: ticketTypeId },
            select: { sold: true, reserved: true },
        });

        await expectRejection(() => issue(order.orderNumber, f.buyerA.id));

        const after = await orderState(order.orderId);
        const countersAfter = await prisma.ticketType.findUniqueOrThrow({
            where: { id: ticketTypeId },
            select: { sold: true, reserved: true },
        });

        expect(after).toEqual(before);
        expect(countersAfter).toEqual(countersBefore);
        expect(await ticketsFor(order.orderId)).toHaveLength(0);
    });

    it("A8. an empty order cannot be issued an empty set of tickets", async () => {
        const ticketTypeId = await newType("A8", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "a8",
        });

        // A paid order whose lines have vanished is not a hypothetical: it is what a bad
        // manual repair would leave behind, and "issue nothing successfully" would hide it.
        await prisma.eventOrderItem.deleteMany({ where: { orderId: order.orderId } });

        const error = await expectRejection(() =>
            issue(order.orderNumber, f.buyerA.id)
        );

        expect(error.code).toBe(ERROR_CODES.CONFLICT);
        expect(error.details?.reason).toBe("ORDER_HAS_NO_ITEMS");
    });
});

/* ==========================================
 * B. QUANTITY
 * ========================================== */

describe("B. ticket quantity (brief §6 / §35)", () => {
    it("B1. quantity 1 produces exactly 1 ticket", async () => {
        const ticketTypeId = await newType("B1", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "b1",
        });

        const result = await issue(order.orderNumber, f.buyerA.id);
        expect(result.ticketsIssued).toBe(1);

        const rows = await ticketsFor(order.orderId);
        expect(rows).toHaveLength(1);
        expect(rows[0].sequenceNo).toBe(1);
        expect(rows[0].ticketTypeId).toBe(ticketTypeId);
    });

    it("B2. quantity 3 produces exactly 3 tickets with sequences 1..3", async () => {
        const ticketTypeId = await newType("B2", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 3,
            tag: "b2",
        });

        await issue(order.orderNumber, f.buyerA.id);

        const rows = await ticketsFor(order.orderId);
        expect(rows.map((row) => row.sequenceNo)).toEqual([1, 2, 3]);
        expect(new Set(rows.map((row) => row.ticketCode)).size).toBe(3);
    });

    it("B3. multiple order items produce the exact per-line count", async () => {
        const typeOne = await newType("B3a", 20);
        const typeTwo = await newType("B3b", 20);

        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [
                { ticketTypeId: typeOne, quantity: 2 },
                { ticketTypeId: typeTwo, quantity: 3 },
            ],
            tag: "b3",
        });
        await payOrder(order.orderNumber, f.buyerA.id);

        const result = await issue(order.orderNumber, f.buyerA.id);

        expect(result.expectedTickets).toBe(5);
        expect(result.totalTickets).toBe(5);

        const rows = await ticketsFor(order.orderId);
        expect(rows).toHaveLength(5);

        const items = await prisma.eventOrderItem.findMany({
            where: { orderId: order.orderId },
            select: { id: true, quantity: true, ticketTypeId: true },
        });

        for (const item of items) {
            const perLine = rows.filter((row) => row.orderItemId === item.id);
            expect(perLine).toHaveLength(item.quantity);
            expect(perLine.map((row) => row.sequenceNo)).toEqual(
                Array.from({ length: item.quantity }, (_, index) => index + 1)
            );
        }
    });

    it("B4. a later catalogue edit cannot change how many tickets an order receives", async () => {
        const ticketTypeId = await newType("B4", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "b4",
        });

        const orderBefore = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { subtotal: true, total: true },
        });

        // Rename, re-price and shrink the type. None of it may reach the fulfilment path:
        // the subscription is historical fact and the catalogue is not (brief §6, §7).
        await prisma.ticketType.update({
            where: { id: ticketTypeId },
            data: { name: "B4 renamed", price: "1.00", quota: 1 },
        });

        const result = await issue(order.orderNumber, f.buyerA.id);

        expect(result.ticketsIssued).toBe(2);

        const orderAfter = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { subtotal: true, total: true, status: true },
        });

        // Fulfilment is not pricing: the historical snapshot is untouched (brief §7).
        expect(orderAfter.subtotal.toString()).toBe(orderBefore.subtotal.toString());
        expect(orderAfter.total.toString()).toBe(orderBefore.total.toString());
        expect(orderAfter.status).toBe("PAID");

        const rows = await ticketsFor(order.orderId);
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.ticketTypeId === ticketTypeId)).toBe(true);
    });
});

/* ==========================================
 * C. IDEMPOTENCY
 * ========================================== */

describe("C. idempotent issuance (brief §8)", () => {
    it("C1. issuing twice returns the same tickets and creates no rows", async () => {
        const ticketTypeId = await newType("C1", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 3,
            tag: "c1",
        });

        const first = await issue(order.orderNumber, f.buyerA.id);
        const snapshot = await ticketsFor(order.orderId);

        const second = await issue(order.orderNumber, f.buyerA.id);
        const afterSecond = await ticketsFor(order.orderId);

        expect(first.outcome).toBe("ISSUED");
        expect(second.outcome).toBe("ALREADY_ISSUED");
        expect(second.ticketsIssued).toBe(0);
        expect(second.totalTickets).toBe(3);
        expect(afterSecond.map((row) => row.id)).toEqual(
            snapshot.map((row) => row.id)
        );
        expect(afterSecond.map((row) => row.ticketCode)).toEqual(
            snapshot.map((row) => row.ticketCode)
        );
    });

    it("C2. issuing ten times still leaves exactly SUM(quantity) rows", async () => {
        const ticketTypeId = await newType("C2", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "c2",
        });

        const outcomes: string[] = [];

        for (let attempt = 0; attempt < 10; attempt += 1) {
            outcomes.push((await issue(order.orderNumber, f.buyerA.id)).outcome);
        }

        expect(outcomes.filter((outcome) => outcome === "ISSUED")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome === "ALREADY_ISSUED")).toHaveLength(9);

        const rows = await ticketsFor(order.orderId);
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.ticketCode)).size).toBe(2);
    });

    it("C3. ticket codes are unique across every ticket this suite issued", async () => {
        const rows = await prisma.ticket.findMany({
            where: { eventId: f.eventA.id },
            select: { ticketCode: true },
        });

        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((row) => row.ticketCode)).size).toBe(rows.length);
        expect(rows.every((row) => TICKET_CODE_PATTERN.test(row.ticketCode))).toBe(true);
    });
});

/* ==========================================
 * D. PARTIAL RECOVERY
 * ========================================== */

describe("D. partial issuance recovery (brief §20)", () => {
    it("D1. a crash mid-way is repaired by creating only the missing ticket", async () => {
        const ticketTypeId = await newType("D1", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 5,
            tag: "d1",
        });

        await issue(order.orderNumber, f.buyerA.id);
        const complete = await ticketsFor(order.orderId);
        expect(complete).toHaveLength(5);

        // Simulate the crash: the first, third and fifth slots survive. Nothing records
        // "partially issued" — the rows themselves are the state (brief §20).
        const survivors = complete.filter((row) => row.sequenceNo % 2 === 1);
        await prisma.ticket.deleteMany({
            where: {
                orderId: order.orderId,
                sequenceNo: { in: [2, 4] },
            },
        });
        expect(await ticketsFor(order.orderId)).toHaveLength(3);

        const repaired = await issue(order.orderNumber, f.buyerA.id);

        expect(repaired.outcome).toBe("ISSUED");
        expect(repaired.ticketsIssued).toBe(2);

        const rows = await ticketsFor(order.orderId);
        expect(rows).toHaveLength(5);
        expect(rows.map((row) => row.sequenceNo)).toEqual([1, 2, 3, 4, 5]);

        // The surviving rows keep their identity; only the missing slots get new ones.
        for (const survivor of survivors) {
            expect(rows.find((row) => row.sequenceNo === survivor.sequenceNo)?.ticketCode).toBe(
                survivor.ticketCode
            );
        }
    });

    it("D2. a single missing slot is recreated without touching the others", async () => {
        const ticketTypeId = await newType("D2", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 3,
            tag: "d2",
        });

        await issue(order.orderNumber, f.buyerA.id);
        const before = await ticketsFor(order.orderId);

        await prisma.ticket.deleteMany({
            where: { orderId: order.orderId, sequenceNo: 2 },
        });

        const repaired = await issue(order.orderNumber, f.buyerA.id);
        expect(repaired.ticketsIssued).toBe(1);

        const after = await ticketsFor(order.orderId);
        expect(after.map((row) => row.sequenceNo)).toEqual([1, 2, 3]);
        expect(after[0].id).toBe(before[0].id);
        expect(after[2].id).toBe(before[2].id);
        expect(after[1].id).not.toBe(before[1].id);
    });
});

/* ==========================================
 * F. OWNERSHIP
 * ========================================== */

describe("F. ownership (brief §15 / §27)", () => {
    it("F1. the owner can issue and read their own tickets", async () => {
        const ticketTypeId = await newType("F1", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "f1",
        });

        await issue(order.orderNumber, f.buyerA.id);

        const rows = await ticketsFor(order.orderId);
        const detail = await getOwnTicket(
            rows[0].ticketCode,
            await customerScope(f.buyerA.id)
        );

        expect(detail.ticketCode).toBe(rows[0].ticketCode);
        expect(detail.orderNumber).toBe(order.orderNumber);
    });

    it("F2. another customer cannot read, release or issue anything of the owner's", async () => {
        const ticketTypeId = await newType("F2", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "f2",
        });

        await issue(order.orderNumber, f.buyerA.id);
        const rows = await ticketsFor(order.orderId);
        const scopeB = await customerScope(f.buyerB.id);

        const readError = await expectRejection(() =>
            getOwnTicket(rows[0].ticketCode, scopeB)
        );
        expect(readError.code).toBe(ERROR_CODES.NOT_FOUND);
        expect(readError.httpStatus).toBe(404);

        // The wallet is scoped by predicate, so buyer B's list simply does not contain it.
        const wallet = await listOwnTickets({}, scopeB);
        expect(wallet.items.map((item) => item.ticketCode)).not.toContain(
            rows[0].ticketCode
        );

        // And issuing someone else's order is a 404, never a fulfilment.
        const issueError = await expectRejection(() =>
            issue(order.orderNumber, f.buyerB.id)
        );
        expect(issueError.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it("F3. the issuance route refuses another buyer's order with 404", async () => {
        const ticketTypeId = await newType("F3", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "f3",
        });

        signInAs(f.buyerB.id);
        const { request, params } = issueRequest(order.orderNumber);

        const response = await issueRoute(request, { params });
        expect(response.status).toBe(404);
        expect(await ticketsFor(order.orderId)).toHaveLength(0);
    });

    it("F4. an unauthenticated wallet read is 401 and an unauthenticated issue is 401", async () => {
        const ticketTypeId = await newType("F4", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "f4",
        });

        const walletRequest = new NextRequest(
            new URL("http://localhost:3000/api/ticketing/tickets"),
            { headers: { "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "http" } }
        );

        signInAs(null);

        const walletResponse = await walletRoute(walletRequest);
        expect(walletResponse.status).toBe(401);

        const { request, params } = issueRequest(order.orderNumber);
        const issueResponse = await issueRoute(request, { params });

        expect(issueResponse.status).toBe(401);
        expect(await ticketsFor(order.orderId)).toHaveLength(0);
    });

    it("F5. a manipulated ticketCode is a 404 and a malformed one never reaches the database", async () => {
        const scopeA = await customerScope(f.buyerA.id);

        for (const candidate of [
            "EVT-AAAA-BBBB",
            "../../etc/passwd",
            "EVT-0000-0000",
            "'; DROP TABLE ticket; --",
        ]) {
            const error = await expectRejection(() => getOwnTicket(candidate, scopeA));
            expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
        }
    });
});

/* ==========================================
 * G. QR
 * ========================================== */

describe("G. ticket code and QR payload (brief §11 / §12 / §36)", () => {
    it("G1. the QR payload is the namespaced public code and is stable across reads", async () => {
        const ticketTypeId = await newType("G1", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "g1",
        });

        await issue(order.orderNumber, f.buyerA.id);
        const rows = await ticketsFor(order.orderId);
        const scopeA = await customerScope(f.buyerA.id);

        const first = await getOwnTicket(rows[0].ticketCode, scopeA);
        const second = await getOwnTicket(rows[0].ticketCode, scopeA);

        expect(first.qr.payload).toBe(`${TICKET_QR_PREFIX}${rows[0].ticketCode}`);
        expect(first.qr.payload).toBe(buildTicketQrPayload(rows[0].ticketCode));
        expect(second.qr.payload).toBe(first.qr.payload);
        expect(first.qr.renderer).toBe("qrcode.react");
        expect(first.qr.version).toBe(1);
        expect(isTicketCode(rows[0].ticketCode)).toBe(true);
        expect(first.admission).toEqual({ scannable: true, reason: null });
    });

    it("G2. the QR payload and the detail response contain no PII, secret or money", async () => {
        const ticketTypeId = await newType("G2", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "g2",
        });

        await issue(order.orderNumber, f.buyerA.id);
        const rows = await ticketsFor(order.orderId);
        const detail = await getOwnTicket(
            rows[0].ticketCode,
            await customerScope(f.buyerA.id)
        );

        // The payload is the code and nothing else — no URL, no email, no phone, no token.
        expect(detail.qr.payload).toMatch(
            /^TICKET:EVT-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/
        );

        const serialized = JSON.stringify(detail);

        for (const forbidden of [
            "qrTokenHash",
            "qrToken",
            "@example.test",
            "081234567890",
            "http://",
            "https://",
        ]) {
            expect(serialized).not.toContain(forbidden);
        }

        // The stored credential is a hash and is not derivable from the displayed code.
        const stored = await prisma.ticket.findUniqueOrThrow({
            where: { id: rows[0].id },
            select: { qrTokenHash: true },
        });
        expect(stored.qrTokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(serialized).not.toContain(stored.qrTokenHash);
    });

    it("G3. the wallet list carries no QR at all (design §26.5)", async () => {
        const ticketTypeId = await newType("G3", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "g3",
        });

        await issue(order.orderNumber, f.buyerA.id);

        const wallet = await listOwnTickets(
            { eventId: f.eventA.id, limit: 50 },
            await customerScope(f.buyerA.id)
        );

        const mine = wallet.items.filter((item) => item.orderNumber === order.orderNumber);
        expect(mine).toHaveLength(2);
        expect(mine.every((item) => !("qr" in item))).toBe(true);
        expect(JSON.stringify(mine)).not.toContain("qrToken");
    });

    it("G4. ticket codes are stable across every read, for the life of the row", async () => {
        const ticketTypeId = await newType("G4", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "g4",
        });

        await issue(order.orderNumber, f.buyerA.id);
        const scopeA = await customerScope(f.buyerA.id);
        const code = (await ticketsFor(order.orderId))[0].ticketCode;

        const codes = new Set<string>();

        for (let read = 0; read < 5; read += 1) {
            codes.add((await getOwnTicket(code, scopeA)).ticketCode);
        }

        // Re-issuing must not regenerate anything either (brief §11: "Never regenerate a
        // ticket code on page refresh").
        await issue(order.orderNumber, f.buyerA.id);
        codes.add((await getOwnTicket(code, scopeA)).ticketCode);

        expect([...codes]).toEqual([code]);
    });
});

/* ==========================================
 * H. AUDIT
 * ========================================== */

describe("H. audit (brief §26)", () => {
    it("H1. issuance writes exactly one ticket.issue row, and a repeat writes none", async () => {
        const ticketTypeId = await newType("H1", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "h1",
        });

        await issue(order.orderNumber, f.buyerA.id);
        await issue(order.orderNumber, f.buyerA.id);
        await issue(order.orderNumber, f.buyerA.id);

        const rows = await issuanceAuditRows(order.orderNumber);

        expect(rows).toHaveLength(1);

        const [row] = rows;
        expect(row.action).toBe("ticket.issue");
        expect(row.entityType).toBe("Ticket");
        expect(row.entityRef).toBe(order.orderNumber);
        expect(row.actorUserId).toBe(f.buyerA.id);
        expect(row.organizerId).toBe(f.orgA.id);
        expect(row.afterState).toMatchObject({
            ticketsIssued: 2,
            totalTickets: 2,
            status: "ISSUED",
        });

        // No buyer PII beyond the acting user's id, no secrets, no token material.
        const serialized = JSON.stringify(row);

        for (const forbidden of [
            "qrToken",
            "buyer@",
            "081234567890",
            "authorization",
            "@example.test",
        ]) {
            expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
        }
    });

    it("H2. a blocked order produces no ticket and no audit row", async () => {
        const ticketTypeId = await newType("H2", 20);
        const order = await createLateSettledOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "h2",
        });

        await expectRejection(() => issue(order.orderNumber, f.buyerA.id));

        expect(await ticketsFor(order.orderId)).toHaveLength(0);
        expect(await issuanceAuditRows(order.orderNumber)).toHaveLength(0);
    });

    it("H3. an order that cannot be issued at all writes no audit row", async () => {
        const ticketTypeId = await newType("H3", 20);
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId, quantity: 1 }],
            tag: "h3",
        });

        await expectRejection(() => issue(order.orderNumber, f.buyerA.id));

        expect(await issuanceAuditRows(order.orderNumber)).toHaveLength(0);
    });
});

/* ==========================================
 * I. TENANT / SECURITY
 * ========================================== */

describe("I. tenant isolation and client authority (brief §16 / §27)", () => {
    it("I1. another tenant's owner cannot fulfil a buyer's order", async () => {
        const ticketTypeId = await newType("I1", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "i1",
        });

        // Tenant B's owner, signed in and holding a real ACTIVE membership on their own
        // organization — so the refusal below is about the ORDER, not about a missing role.
        const scopeOther = await organizerScope(f.orgB.id, f.ownerB.id);
        expect(scopeOther.userId).toBe(f.ownerB.id);

        const error = await expectRejection(() =>
            issue(order.orderNumber, f.ownerB.id)
        );

        expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
        expect(await ticketsFor(order.orderId)).toHaveLength(0);
    });

    it("I2. role and identity fields in a request are never read as authority", async () => {
        // The wallet query schema accepts no identity or state field at all.
        const parsed = ticketWalletQuerySchema.parse({
            userId: f.buyerB.id,
            holderUserId: f.buyerB.id,
            organizerId: f.orgA.id,
            paymentStatus: "PAID",
            ticketStatus: "ISSUED",
            issuedAt: "2026-01-01",
            qrPayload: "TICKET:EVT-2222-2222",
        });

        expect(parsed).not.toHaveProperty("userId");
        expect(parsed).not.toHaveProperty("holderUserId");
        expect(parsed).not.toHaveProperty("organizerId");
        expect(parsed).not.toHaveProperty("paymentStatus");
        expect(parsed).not.toHaveProperty("ticketStatus");
        expect(parsed).not.toHaveProperty("issuedAt");
        expect(parsed).not.toHaveProperty("qrPayload");
    });

    it("I3. the issuance route rejects a cross-site POST with 403 before any work", async () => {
        const ticketTypeId = await newType("I3", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "i3",
        });

        signInAs(f.buyerA.id);

        const hostile = issueRequest(order.orderNumber, {
            origin: "http://evil.test",
        });
        const noOrigin = issueRequest(order.orderNumber, { origin: null });

        for (const attempt of [hostile, noOrigin]) {
            const response = await issueRoute(attempt.request, {
                params: attempt.params,
            });
            expect(response.status).toBe(403);
        }

        expect(await ticketsFor(order.orderId)).toHaveLength(0);
    });

    it("I4. the route issues on the first call and reports the repeat as ALREADY_ISSUED", async () => {
        const ticketTypeId = await newType("I4", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 2,
            tag: "i4",
        });

        signInAs(f.buyerA.id);

        const first = issueRequest(order.orderNumber);
        const firstResponse = await issueRoute(first.request, { params: first.params });
        expect(firstResponse.status).toBe(201);

        const firstBody = (await firstResponse.json()) as {
            success: boolean;
            data: { outcome: string; ticketsIssued: number };
        };
        expect(firstBody.success).toBe(true);
        expect(firstBody.data.outcome).toBe("ISSUED");
        expect(firstBody.data.ticketsIssued).toBe(2);

        const second = issueRequest(order.orderNumber);
        const secondResponse = await issueRoute(second.request, { params: second.params });
        expect(secondResponse.status).toBe(200);

        const secondBody = (await secondResponse.json()) as {
            data: { outcome: string; ticketsIssued: number };
        };
        expect(secondBody.data.outcome).toBe("ALREADY_ISSUED");
        expect(secondBody.data.ticketsIssued).toBe(0);

        expect(await ticketsFor(order.orderId)).toHaveLength(2);
    });

    it("I5. the wallet and detail routes return the buyer's own data and nothing else", async () => {
        const ticketTypeId = await newType("I5", 20);
        const order = await createPaidOrder({
            buyerId: f.buyerA.id,
            ticketTypeId,
            quantity: 1,
            tag: "i5",
        });

        await issue(order.orderNumber, f.buyerA.id);
        const code = (await ticketsFor(order.orderId))[0].ticketCode;

        signInAs(f.buyerA.id);

        const listResponse = await walletRoute(
            new NextRequest(
                new URL(
                    `http://localhost:3000/api/ticketing/tickets?eventId=${f.eventA.id}&limit=50`
                ),
                {
                    headers: {
                        "x-forwarded-host": "localhost:3000",
                        "x-forwarded-proto": "http",
                    },
                }
            )
        );

        expect(listResponse.status).toBe(200);
        const listBody = (await listResponse.json()) as {
            data: { items: { ticketCode: string; orderNumber: string }[] };
        };
        expect(listBody.data.items.map((item) => item.ticketCode)).toContain(code);

        const detailResponse = await ticketDetailRoute(
            new NextRequest(
                new URL(`http://localhost:3000/api/ticketing/tickets/${code}`),
                {
                    headers: {
                        "x-forwarded-host": "localhost:3000",
                        "x-forwarded-proto": "http",
                    },
                }
            ),
            { params: Promise.resolve({ ticketCode: code }) }
        );

        expect(detailResponse.status).toBe(200);
        const detailBody = (await detailResponse.json()) as {
            data: { ticketCode: string; qr: { payload: string } };
        };
        expect(detailBody.data.ticketCode).toBe(code);
        expect(detailBody.data.qr.payload).toBe(`TICKET:${code}`);

        // Buyer B sees an empty list and a 404, not buyer A's rows.
        signInAs(f.buyerB.id);

        const otherDetail = await ticketDetailRoute(
            new NextRequest(
                new URL(`http://localhost:3000/api/ticketing/tickets/${code}`),
                {
                    headers: {
                        "x-forwarded-host": "localhost:3000",
                        "x-forwarded-proto": "http",
                    },
                }
            ),
            { params: Promise.resolve({ ticketCode: code }) }
        );

        expect(otherDetail.status).toBe(404);

        const otherWallet = await walletRoute(
            new NextRequest(
                new URL(
                    `http://localhost:3000/api/ticketing/tickets?eventId=${f.eventA.id}&limit=50`
                ),
                {
                    headers: {
                        "x-forwarded-host": "localhost:3000",
                        "x-forwarded-proto": "http",
                    },
                }
            )
        );

        const otherBody = (await otherWallet.json()) as {
            data: { items: { ticketCode: string }[] };
        };
        expect(otherBody.data.items.map((item) => item.ticketCode)).not.toContain(code);
    });

    it("I6. a malformed ticket code path parameter is refused by validation, not by SQL", async () => {
        signInAs(f.buyerA.id);

        const response = await ticketDetailRoute(
            new NextRequest(
                new URL("http://localhost:3000/api/ticketing/tickets/not-a-code"),
                {
                    headers: {
                        "x-forwarded-host": "localhost:3000",
                        "x-forwarded-proto": "http",
                    },
                }
            ),
            { params: Promise.resolve({ ticketCode: "not-a-code" }) }
        );

        expect(response.status).toBe(400);
    });
});
