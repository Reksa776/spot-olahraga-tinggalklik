/**
 * ==========================================
 * PHASE 10B — REFUND LIFECYCLE (INTEGRATION)
 * ==========================================
 *
 * The real refund service against the real database. As in Phases 7/8, only the provider
 * socket is stubbed by the parent harness. PHASE 18B (D-P17-04 = B) removed the last
 * substitution: the refund rail is a MANUAL BANK TRANSFER, so settling is two operator
 * service calls (`executeRefund` then `settleRefund`) and no adapter exists to fake.
 *
 * What this suite proves, and why it has to be an integration test:
 *
 *   * D-R01..R10 — eligibility and item selection against persisted tickets;
 *   * D-R02 — ownership, tenant scope and separation of duties, enforced by the real
 *     guards against real membership rows;
 *   * D-R06 — quota returns ONLY after confirmed settlement, never on request/approve/fail;
 *   * D-R07/D-R11 — every transition is a CAS; a duplicate settlement is a no-op;
 *   * D-R12/D-R14/D-R15/D-R16 — provider reference, `refundedAmount`, ticket/order status
 *     and the REFUND `PaymentTransaction` are written together, once;
 *   * the webhook refund branch can NEVER settle a refund on the manual rail — it records
 *     the delivery and acts on nothing (Phase 18B).
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { ERROR_CODES } from "@/lib/api/errors";
import { advanceEventLifecycleBatch } from "@/lib/events/lifecycle";
import { prisma } from "@/lib/prisma";
import { handleGatewayWebhook } from "@/lib/ticketing/payment/webhook";
import {
    approveRefund,
    executeRefund,
    failRefund,
    listRefunds,
    rejectRefund,
    requestRefund,
    settleRefund,
} from "@/lib/ticketing/refunds/service";
import { processConfirmedRefund } from "@/lib/ticketing/refunds/settlement";

import {
    counters,
    createOrder,
    createPaidOrder,
    createType,
    customerScope,
    expectRejection,
    installGatewayStub,
    issue,
    nextRequest,
    organizerScope,
    refundAuditRows,
    refundItems,
    refundRow,
    refundTransactions,
    setupRefundFixtures,
    signedCallback,
    ticketsFor,
    teardownRefundFixtures,
    type Fixtures,
} from "./refund-harness";

jest.setTimeout(180_000);

let f: Fixtures;
let fetchSpy: jest.SpyInstance;
let tagCounter = 0;

const nextTag = (tag: string) => `${tag}-${++tagCounter}`;

async function issuedPaidOrder(
    tag: string,
    quantity = 1
): Promise<{
    order: { orderNumber: string; orderId: string; total: string };
    type: { id: string };
}> {
    const type = await createType(f, `Refund ${tag}`, { quota: 20 });
    const order = await createPaidOrder({
        buyerId: f.buyerA.id,
        ticketTypeId: type.id,
        quantity,
        tag: nextTag(tag),
    });

    await issue(order.orderNumber, f.buyerA.id);

    return { order, type };
}

async function requestAsBuyer(orderNumber: string, reason = "Berubah pikiran") {
    const buyer = await customerScope(f.buyerA.id);

    return requestRefund(
        { orderNumber, reason },
        buyer,
        nextRequest("/api/ticketing/refunds")
    );
}

async function latestPayment(orderId: string) {
    return prisma.payment.findFirstOrThrow({
        where: { orderId },
        orderBy: { createdAt: "desc" },
    });
}

beforeAll(async () => {
    f = await setupRefundFixtures();
    fetchSpy = installGatewayStub();

    // D-R06 is opt-in per event; turning it on for this suite is the only way to prove the
    // restore actually happens. Turned off again in the teardown below.
    await prisma.event.update({
        where: { id: f.eventA.id },
        data: { returnQuotaOnRefund: true },
    });
});


afterAll(async () => {
    await prisma.event.update({
        where: { id: f.eventA.id },
        data: { returnQuotaOnRefund: false, refundDeadlineAt: null },
    });

    fetchSpy.mockRestore();
    await teardownRefundFixtures(f);
});

/**
 * PHASE 18B (D-P17-04 = B): the rail is a MANUAL BANK TRANSFER and there is no provider call
 * to make. The two tests here pin the honest halves of that: claiming a refund for
 * processing moves nothing, and a transfer that did not complete ends FAILED without moving
 * money and without holding the ticket hostage.
 */
describe("the manual rail: claiming and failing move no money", () => {
    it("request -> approve -> process ends PROCESSING with nothing moved", async () => {
        const { order, type } = await issuedPaidOrder("processing");
        const before = await counters(type.id);

        const requested = await requestAsBuyer(order.orderNumber);

        expect(requested.status).toBe("PENDING");
        expect(requested.requestedAmount).toBe("150000.00");
        expect(requested.items).toHaveLength(1);

        const owner = await organizerScope(f.orgA.id, f.ownerA.id);

        const approved = await approveRefund(
            requested.refundId,
            owner,
            {},
            nextRequest()
        );

        expect(approved.status).toBe("APPROVED");

        const processed = await executeRefund(
            requested.refundId,
            owner,
            {},
            nextRequest()
        );

        // PROCESSING is the operator holding the refund. It is NOT a claim that the transfer
        // happened, and every money-bearing column must still say so.
        expect(processed.status).toBe("PROCESSING");

        const refund = await refundRow(requested.refundId);
        expect(refund.providerRef).toBeNull();
        expect(refund.evidenceNote).toBeNull();
        expect(refund.confirmedAmount.toFixed(2)).toBe("0.00");
        expect(refund.completedAt).toBeNull();

        const state = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
        });
        expect(state.status).toBe("PAID");
        expect(state.paymentStatus).toBe("PAID");
        expect(state.refundedAmount.toFixed(2)).toBe("0.00");

        const tickets = await ticketsFor(order.orderId);
        expect(tickets.every((ticket) => ticket.status === "ISSUED")).toBe(true);

        const after = await counters(type.id);
        expect(after.sold).toBe(before.sold);
        expect(await refundTransactions(order.orderId)).toHaveLength(0);

        // The claim survives: the operator is working on it.
        expect(await refundItems(requested.refundId)).toHaveLength(1);

        const audit = await refundAuditRows([
            order.orderNumber,
            refund.refundNumber ?? "",
        ]);
        expect(audit.map((row) => row.action)).toEqual(
            expect.arrayContaining([
                "refund.request",
                "refund.approve",
                "refund.process",
            ])
        );
    });

    it("a failed transfer releases the claim and moves no money", async () => {
        const { order, type } = await issuedPaidOrder("failed-transfer");
        const before = await counters(type.id);

        const requested = await requestAsBuyer(order.orderNumber);
        const owner = await organizerScope(f.orgA.id, f.ownerA.id);

        await approveRefund(requested.refundId, owner, {}, nextRequest());
        await executeRefund(requested.refundId, owner, {}, nextRequest());

        const failed = await failRefund(
            requested.refundId,
            { reason: "Rekening tujuan tidak valid" },
            owner,
            nextRequest()
        );

        expect(failed.status).toBe("FAILED");
        expect(failed.failureReason).toBe("Rekening tujuan tidak valid");

        const refund = await refundRow(requested.refundId);
        expect(refund.confirmedAmount.toFixed(2)).toBe("0.00");
        expect(refund.providerRef).toBeNull();

        const state = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
        });
        expect(state.status).toBe("PAID");
        expect(state.refundedAmount.toFixed(2)).toBe("0.00");

        const tickets = await ticketsFor(order.orderId);
        expect(tickets.every((ticket) => ticket.status === "ISSUED")).toBe(true);

        const after = await counters(type.id);
        expect(after.sold).toBe(before.sold);
        expect(await refundTransactions(order.orderId)).toHaveLength(0);

        // The failure released the claim so a corrected request can be raised again.
        expect(await refundItems(requested.refundId)).toHaveLength(0);

        const audit = await refundAuditRows([
            order.orderNumber,
            refund.refundNumber ?? "",
        ]);
        expect(audit.map((row) => row.action)).toEqual(
            expect.arrayContaining(["refund.request", "refund.approve", "refund.fail"])
        );
    });

    it("a PROCESSING refund holds the order's one in-flight slot", async () => {
        const { order } = await issuedPaidOrder("single-inflight", 2);
        const tickets = await ticketsFor(order.orderId);
        const buyer = await customerScope(f.buyerA.id);

        const first = await requestRefund(
            { orderNumber: order.orderNumber, ticketIds: [tickets[0].id] },
            buyer,
            nextRequest()
        );
        // The owner session is established only AFTER the buyer's second request: the
        // ownership guard reads the LIVE session, so an earlier `organizerScope` would make
        // the request itself act as the organizer and be refused.
        const second = await requestRefund(
            { orderNumber: order.orderNumber, ticketIds: [tickets[1].id] },
            await customerScope(f.buyerA.id),
            nextRequest()
        );

        const owner = await organizerScope(f.orgA.id, f.ownerA.id);

        await approveRefund(first.refundId, owner, {}, nextRequest());
        await approveRefund(second.refundId, owner, {}, nextRequest());

        // First claim wins.
        const claimed = await executeRefund(
            first.refundId,
            owner,
            {},
            nextRequest()
        );
        expect(claimed.status).toBe("PROCESSING");

        // The second APPROVED refund of the same order cannot also be in flight.
        const error = await expectRejection(() =>
            executeRefund(second.refundId, owner, {}, nextRequest())
        );

        expect(error.status ?? error.httpStatus).toBe(409);
        expect(await refundRow(second.refundId).then((row) => row.status)).toBe(
            "APPROVED"
        );

        // Settling the first releases the slot, and only then can the second proceed.
        await settleRefund(
            first.refundId,
            { transferRef: "BANK-INFLIGHT-1" },
            owner,
            nextRequest()
        );

        expect((await refundRow(first.refundId)).status).toBe("REFUNDED");

        const secondClaim = await executeRefund(
            second.refundId,
            owner,
            {},
            nextRequest()
        );
        expect(secondClaim.status).toBe("PROCESSING");
    });
});

describe("confirmed settlement (D-R06/D-R12/D-R14/D-R15/D-R16)", () => {
    it("refunds the tickets, the order, the quota and the ledger in one confirmed move", async () => {
        const { order, type } = await issuedPaidOrder("confirmed");
        const before = await counters(type.id);

        const requested = await requestAsBuyer(order.orderNumber);
        const owner = await organizerScope(f.orgA.id, f.ownerA.id);

        await approveRefund(requested.refundId, owner, {}, nextRequest());

        // Phase 18B: the two operator steps of the manual rail — claim, then record the
        // transfer. Nothing moves until the second one.
        await executeRefund(requested.refundId, owner, {}, nextRequest());

        const executed = await settleRefund(
            requested.refundId,
            { transferRef: "PR-CONFIRMED-1", note: "Transfer BCA 12 Sep 2026" },
            owner,
            nextRequest()
        );

        expect(executed.status).toBe("REFUNDED");
        expect(executed.confirmedAmount).toBe("150000.00");
        expect(executed.providerRef).toBe("PR-CONFIRMED-1");

        // The evidence is what makes the REFUNDED claim auditable.
        const settledRow = await refundRow(requested.refundId);
        expect(settledRow.evidenceNote).toBe("Transfer BCA 12 Sep 2026");
        expect(settledRow.completedAt).not.toBeNull();

        const orderRow = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
        });
        expect(orderRow.status).toBe("REFUNDED");
        expect(orderRow.paymentStatus).toBe("REFUNDED");
        expect(orderRow.refundedAmount.toFixed(2)).toBe("150000.00");

        const tickets = await ticketsFor(order.orderId);
        expect(tickets).toHaveLength(1);
        expect(tickets[0].status).toBe("REFUNDED");
        expect(tickets[0].refundedAt).not.toBeNull();

        // D-R06: the quota came back only now.
        const after = await counters(type.id);
        expect(after.sold).toBe(before.sold - 1);
        expect(after.sold).toBe(0);

        const refundTx = await refundTransactions(order.orderId);
        expect(refundTx).toHaveLength(1);
        expect(refundTx[0].amount.toFixed(2)).toBe("150000.00");
        expect(refundTx[0].type).toBe("REFUND");

        // D-R10: the claim survives settlement — it is the record of what was refunded.
        expect(await refundItems(requested.refundId)).toHaveLength(1);

        const refund = await refundRow(requested.refundId);
        const audit = await refundAuditRows([
            order.orderNumber,
            refund.refundNumber ?? "",
        ]);
        expect(audit.map((row) => row.action)).toContain("refund.settle");
    });

    it("a repeated confirmation is ALREADY_REFUNDED and changes nothing (D-R11)", async () => {
        const { order } = await issuedPaidOrder("idempotent");

        const requested = await requestAsBuyer(order.orderNumber);
        const owner = await organizerScope(f.orgA.id, f.ownerA.id);

        await approveRefund(requested.refundId, owner, {}, nextRequest());

        await executeRefund(requested.refundId, owner, {}, nextRequest());
        await settleRefund(
            requested.refundId,
            { transferRef: "PR-IDEMPOTENT" },
            owner,
            nextRequest()
        );

        const before = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { refundedAmount: true },
        });
        const beforeTx = await refundTransactions(order.orderId);

        const replay = await processConfirmedRefund(requested.refundId, {
            providerRef: "PR-IDEMPOTENT-AGAIN",
            confirmedAmount: "150000.00",
        });

        expect(replay.outcome).toBe("ALREADY_REFUNDED");

        const after = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { refundedAmount: true },
        });

        expect(after.refundedAmount.toFixed(2)).toBe(
            before.refundedAmount.toFixed(2)
        );
        await expect(refundTransactions(order.orderId)).resolves.toHaveLength(
            beforeTx.length
        );
    });
});

describe("partial, item/ticket-based refunds (D-R01/D-R08/D-R09)", () => {
    it("refunds one of two tickets, then the other, reaching REFUNDED", async () => {
        const { order, type } = await issuedPaidOrder("partial", 2);
        const before = await counters(type.id);

        const tickets = await ticketsFor(order.orderId);
        expect(tickets).toHaveLength(2);

        const buyer = await customerScope(f.buyerA.id);

        const first = await requestRefund(
            { orderNumber: order.orderNumber, ticketIds: [tickets[0].id] },
            buyer,
            nextRequest()
        );

        expect(first.requestedAmount).toBe("150000.00");

        const owner = await organizerScope(f.orgA.id, f.ownerA.id);

        await approveRefund(first.refundId, owner, {}, nextRequest());
        await executeRefund(first.refundId, owner, {}, nextRequest());
        await settleRefund(
            first.refundId,
            { transferRef: "PR-PARTIAL-1" },
            owner,
            nextRequest()
        );

        let orderRow = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
        });
        expect(orderRow.status).toBe("PARTIALLY_REFUNDED");
        expect(orderRow.paymentStatus).toBe("PARTIALLY_REFUNDED");
        expect(orderRow.refundedAmount.toFixed(2)).toBe("150000.00");

        const afterFirst = await ticketsFor(order.orderId);
        expect(afterFirst[0].status).toBe("REFUNDED");
        expect(afterFirst[1].status).toBe("ISSUED");

        // The remaining ticket is still refundable down to the balance. The buyer is
        // re-resolved because `requireOwnResource` reads the LIVE session, which the
        // intervening `organizerScope` call switched to the owner.
        const buyerAgain = await customerScope(f.buyerA.id);

        const second = await requestRefund(
            { orderNumber: order.orderNumber, ticketIds: [tickets[1].id] },
            buyerAgain,
            nextRequest()
        );

        expect(second.requestedAmount).toBe("150000.00");

        // And the owner is re-resolved for the same reason, in the other direction.
        const ownerAgain = await organizerScope(f.orgA.id, f.ownerA.id);

        await approveRefund(second.refundId, ownerAgain, {}, nextRequest());
        await executeRefund(second.refundId, ownerAgain, {}, nextRequest());
        await settleRefund(
            second.refundId,
            { transferRef: "PR-PARTIAL-2" },
            ownerAgain,
            nextRequest()
        );

        orderRow = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
        });
        expect(orderRow.status).toBe("REFUNDED");
        expect(orderRow.refundedAmount.toFixed(2)).toBe("300000.00");

        const afterSecond = await ticketsFor(order.orderId);
        expect(afterSecond.every((ticket) => ticket.status === "REFUNDED")).toBe(true);

        const after = await counters(type.id);
        expect(after.sold).toBe(before.sold - 2);
        expect(after.sold).toBe(0);
    });
});

describe("authority: ownership, tenancy and separation of duties (D-R02)", () => {
    it("another customer cannot request a refund for someone else's order", async () => {
        const { order } = await issuedPaidOrder("idor");

        const buyerB = await customerScope(f.buyerB.id);

        const error = await expectRejection(() =>
            requestRefund({ orderNumber: order.orderNumber }, buyerB, nextRequest())
        );

        expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
        expect(error.httpStatus).toBe(404);
    });

    it("a requester cannot approve their own request, even as the organizer owner", async () => {
        const type = await createType(f, "Refund sod", { quota: 20 });
        const order = await createPaidOrder({
            buyerId: f.ownerA.id,
            ticketTypeId: type.id,
            quantity: 1,
            tag: nextTag("sod"),
        });
        await issue(order.orderNumber, f.ownerA.id);

        const ownerBuyer = await customerScope(f.ownerA.id);
        const requested = await requestRefund(
            { orderNumber: order.orderNumber },
            ownerBuyer,
            nextRequest()
        );

        const error = await expectRejection(() =>
            approveRefund(requested.refundId, ownerBuyer, {}, nextRequest())
        );

        expect(error.code).toBe(ERROR_CODES.FORBIDDEN);
        expect(error.details?.reason).toBe("SEPARATION_OF_DUTIES");
    });

    it("another tenant cannot approve a refund belonging to the first tenant", async () => {
        const { order } = await issuedPaidOrder("cross-tenant");
        const requested = await requestAsBuyer(order.orderNumber);

        const ownerB = await organizerScope(f.orgB.id, f.ownerB.id);

        const error = await expectRejection(() =>
            approveRefund(requested.refundId, ownerB, {}, nextRequest())
        );

        expect(error.status ?? error.httpStatus).toBe(404);
    });
});

describe("eligibility refusals", () => {
    it("an unpaid order cannot be refunded (D-R03)", async () => {
        const type = await createType(f, "Refund unpaid", { quota: 20 });
        const order = await createOrder({
            buyerId: f.buyerA.id,
            items: [{ ticketTypeId: type.id, quantity: 1 }],
            tag: nextTag("unpaid"),
        });

        const buyer = await customerScope(f.buyerA.id);

        const error = await expectRejection(() =>
            requestRefund({ orderNumber: order.orderNumber }, buyer, nextRequest())
        );

        expect(error.code).toBe(ERROR_CODES.REFUND_NOT_ALLOWED);
        expect(error.details?.reason).toBe("ORDER_NOT_PAID");
    });

    it("a checked-in ticket is not refundable (D-R05)", async () => {
        const { order } = await issuedPaidOrder("checked-in");
        const tickets = await ticketsFor(order.orderId);

        // Check-in itself is a later phase; this arranges the state the rule talks about.
        await prisma.ticket.update({
            where: { id: tickets[0].id },
            data: { status: "CHECKED_IN", checkedInAt: new Date() },
        });

        const buyer = await customerScope(f.buyerA.id);

        const error = await expectRejection(() =>
            requestRefund({ orderNumber: order.orderNumber }, buyer, nextRequest())
        );

        expect(error.code).toBe(ERROR_CODES.REFUND_NOT_ALLOWED);
        expect(error.details?.reason).toBe("TICKET_CHECKED_IN");
    });

    it("a closed refund window refuses the request", async () => {
        const { order } = await issuedPaidOrder("window");

        await prisma.event.update({
            where: { id: f.eventA.id },
            data: { refundDeadlineAt: new Date(Date.now() - 60_000) },
        });

        try {
            const buyer = await customerScope(f.buyerA.id);

            const error = await expectRejection(() =>
                requestRefund({ orderNumber: order.orderNumber }, buyer, nextRequest())
            );

            expect(error.code).toBe(ERROR_CODES.REFUND_NOT_ALLOWED);
            expect(error.details?.reason).toBe("REFUND_WINDOW_CLOSED");
        } finally {
            await prisma.event.update({
                where: { id: f.eventA.id },
                data: { refundDeadlineAt: null },
            });
        }
    });

    it("a ticket can be claimed only once (D-R10)", async () => {
        const { order } = await issuedPaidOrder("double-claim");

        await requestAsBuyer(order.orderNumber);

        const error = await expectRejection(() =>
            requestAsBuyer(order.orderNumber)
        );

        expect(error.code).toBe(ERROR_CODES.REFUND_NOT_ALLOWED);
        expect(["TICKET_ALREADY_REFUNDED", "TICKET_ALREADY_CLAIMED"]).toContain(
            error.details?.reason
        );
    });
});

describe("rejection releases the claim so the ticket can be requested again", () => {
    it("reject -> REJECTED with no claim, then a fresh request succeeds", async () => {
        const { order } = await issuedPaidOrder("reject");

        const requested = await requestAsBuyer(order.orderNumber);
        const owner = await organizerScope(f.orgA.id, f.ownerA.id);

        const rejected = await rejectRefund(
            requested.refundId,
            owner,
            { reason: "Bukti pembayaran tidak valid" },
            nextRequest()
        );

        expect(rejected.status).toBe("REJECTED");
        expect(rejected.failureReason).toBe("Bukti pembayaran tidak valid");
        expect(await refundItems(requested.refundId)).toHaveLength(0);

        // The ticket was never consumed.
        const tickets = await ticketsFor(order.orderId);
        expect(tickets[0].status).toBe("ISSUED");

        // A new request is allowed because the claim was released (the Refund row remains).
        const again = await requestAsBuyer(order.orderNumber);
        expect(again.refundId).not.toBe(requested.refundId);
        expect(again.status).toBe("PENDING");
    });
});

/**
 * PHASE 18B (D-P17-04 = B): the webhook cannot settle a refund at all.
 *
 * The rail is a manual bank transfer, so a refund-shaped delivery has no authoritative fact
 * to carry — and resolving it by `(orderId, amount)` is exactly the identification Phase 18A
 * forbade. The security boundary in front of the branch is untouched (signature verification
 * and the replay ledger both still run); what changed is that the branch now RECORDS and
 * never acts, for a matching amount and a mismatched one alike.
 */
describe("a refund notification is recorded and never settles anything (Phase 18B)", () => {
    async function toProcessing(orderNumber: string): Promise<{
        refundId: number;
        amount: string;
    }> {
        const requested = await requestAsBuyer(orderNumber);
        const owner = await organizerScope(f.orgA.id, f.ownerA.id);

        await approveRefund(requested.refundId, owner, {}, nextRequest());

        // Arrange the in-flight state a provider notification would have answered — through
        // the REAL service path (the claim), so the state under test is not hand-written.
        await executeRefund(requested.refundId, owner, {}, nextRequest());

        return { refundId: requested.refundId, amount: requested.requestedAmount };
    }

    function refundCallback(params: {
        referenceId: string;
        amount: string;
        trxId: string;
    }) {
        return signedCallback({
            referenceId: params.referenceId,
            statusCode: 1,
            subTotal: params.amount,
            trxId: params.trxId,
            fee: "0",
            via: "qris",
            channel: "qris",
            extra: { status: "refund" },
        });
    }

    it("a refund notification with the exact in-flight amount settles nothing", async () => {
        const { order } = await issuedPaidOrder("webhook-confirm");
        const { refundId, amount } = await toProcessing(order.orderNumber);
        const payment = await latestPayment(order.orderId);

        const signed = refundCallback({
            referenceId: payment.paymentReference,
            amount,
            trxId: `TRX-P10B-${Date.now()}-confirm`,
        });

        const result = await handleGatewayWebhook({
            rawBody: signed.rawBody,
            signatureHeader: signed.signature,
            remoteIp: "127.0.0.1",
        });

        // Acknowledged so the provider does not retry, and never actioned.
        expect(result.httpStatus).toBe(200);
        expect(result.outcome).toBe("REFUND_MANUAL_RAIL");

        // The refund is untouched: PROCESSING is the operator's task, not the provider's.
        const refund = await refundRow(refundId);
        expect(refund.status).toBe("PROCESSING");
        expect(refund.completedAt).toBeNull();
        expect(refund.confirmedAmount.toFixed(2)).toBe("0.00");

        const orderRow = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
        });
        expect(orderRow.status).toBe("PAID");
        expect(orderRow.refundedAmount.toFixed(2)).toBe("0.00");
        expect(await refundTransactions(order.orderId)).toHaveLength(0);

        // The delivery is still visible to an operator, which is the point of recording it.
        const ledger = await prisma.webhookEvent.findFirstOrThrow({
            where: { orderId: order.orderId, eventType: "refund.completed" },
            orderBy: { createdAt: "desc" },
        });
        expect(ledger.processingStatus).toBe("IGNORED");
        expect(ledger.processingResult).toBe("ignored_refund_rail_is_manual");
    });

    it("a mismatched refund notification is recorded and not settled either", async () => {
        const { order } = await issuedPaidOrder("webhook-mismatch");
        const { refundId } = await toProcessing(order.orderNumber);
        const payment = await latestPayment(order.orderId);

        const signed = refundCallback({
            referenceId: payment.paymentReference,
            amount: "1.00",
            trxId: `TRX-P10B-${Date.now()}-mismatch`,
        });

        const result = await handleGatewayWebhook({
            rawBody: signed.rawBody,
            signatureHeader: signed.signature,
            remoteIp: "127.0.0.1",
        });

        expect(result.httpStatus).toBe(200);
        expect(result.outcome).toBe("REFUND_MANUAL_RAIL");

        const refund = await refundRow(refundId);
        expect(refund.status).toBe("PROCESSING");

        const ledger = await prisma.webhookEvent.findFirstOrThrow({
            where: { orderId: order.orderId, eventType: "refund.completed" },
            orderBy: { createdAt: "desc" },
        });
        expect(ledger.processingStatus).toBe("IGNORED");
        expect(ledger.processingResult).toBe("ignored_refund_rail_is_manual");
    });
});

describe("the read side lists a caller's own refunds (D-R02)", () => {
    it("a buyer sees their own request, and a tenant read requires membership", async () => {
        const { order } = await issuedPaidOrder("list");
        const requested = await requestAsBuyer(order.orderNumber);

        const buyer = await customerScope(f.buyerA.id);
        const own = await listRefunds(buyer, { page: 1, limit: 50 });

        expect(own.items.map((item) => item.refundId)).toContain(requested.refundId);

        const owner = await organizerScope(f.orgA.id, f.ownerA.id);
        const tenant = await listRefunds(owner, {
            organizerId: f.orgA.id,
            page: 1,
            limit: 50,
        });

        expect(tenant.items.map((item) => item.refundId)).toContain(
            requested.refundId
        );

        // Another tenant's membership cannot read orgA's refunds.
        const ownerB = await organizerScope(f.orgB.id, f.ownerB.id);
        const error = await expectRejection(() =>
            listRefunds(ownerB, { organizerId: f.orgA.id, page: 1, limit: 50 })
        );
        expect(error.status ?? error.httpStatus).toBe(404);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 15 (P14-D16): completion is a TIME statement, not a commercial one
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Phase 14 lock's P14-D16 says completion "never waits for" a refund and
 * "moves no money". This block asserts the consequence that matters most to a buyer: closing
 * an event does NOT close its refund path — an order paid for an event that has since been
 * completed can still request, be approved, and SETTLE a refund, with the same quota return,
 * ledger row and audit trail as any other refund.
 *
 * The event is completed through the REAL automatic transition (the same
 * `advanceEventLifecycleBatch` the cron tick calls, with `endAt` moved into the past), not by
 * writing `status = 'COMPLETED'` directly.
 *
 * This block is last in the file on purpose: it completes `eventA`, and no later test may
 * inherit that state.
 */
describe("PHASE 15 — a COMPLETED event still refunds", () => {
    it("settles a refund requested after the event was completed", async () => {
        const { order, type } = await issuedPaidOrder("completed-event", 1);

        // Make the event due for completion, then run the real transition.
        await prisma.event.update({
            where: { id: f.eventA.id },
            data: { endAt: new Date(Date.now() - 60 * 60_000) },
        });

        const batch = await advanceEventLifecycleBatch({ now: new Date() });
        expect(batch.toCompleted).toBeGreaterThanOrEqual(1);

        const eventRow = await prisma.event.findUniqueOrThrow({
            where: { id: f.eventA.id },
            select: { status: true, completedAt: true },
        });
        expect(eventRow.status).toBe("COMPLETED");
        expect(eventRow.completedAt).not.toBeNull();

        // The refund path is untouched by that: request → approve → settle.
        const before = await counters(type.id);
        const requested = await requestAsBuyer(order.orderNumber);

        expect(requested.status).toBe("PENDING");

        // Resolved AFTER the buyer's request: the session is the mocked `auth()`, and the
        // staff decision must be made as the owner, in the order the other tests use.
        const owner = await organizerScope(f.orgA.id, f.ownerA.id);

        await approveRefund(requested.refundId, owner, {}, nextRequest());

        await executeRefund(requested.refundId, owner, {}, nextRequest());

        const executed = await settleRefund(
            requested.refundId,
            { transferRef: "PR-COMPLETED-EVENT" },
            owner,
            nextRequest()
        );

        expect(executed.status).toBe("REFUNDED");

        const tickets = await ticketsFor(order.orderId);
        expect(tickets[0].status).toBe("REFUNDED");

        // D-R06, unchanged by completion: the quota came back at settlement.
        const after = await counters(type.id);
        expect(after.sold).toBe(before.sold - 1);

        expect(await refundTransactions(order.orderId)).toHaveLength(1);

        const refund = await refundRow(requested.refundId);
        const audit = await refundAuditRows([
            order.orderNumber,
            refund.refundNumber ?? "",
        ]);
        expect(audit.map((row) => row.action)).toContain("refund.settle");

        // And completion wrote exactly one audit row of its own — no money action hides in it.
        const completionAudit = await prisma.adminAuditLog.findMany({
            where: { entityRef: f.eventA.id, action: "event.complete" },
        });
        expect(completionAudit).toHaveLength(1);
    });
});
