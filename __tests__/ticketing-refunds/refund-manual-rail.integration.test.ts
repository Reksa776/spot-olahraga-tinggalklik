/**
 * ==========================================
 * PHASE 18B — MANUAL BANK-TRANSFER RAIL, REFUNDABLE BALANCE AND PIC REVERSAL
 * ==========================================
 *
 * Real services against the real database. What this suite adds to the Phase 10B lifecycle
 * suite is the money-integrity behaviour the Phase 18A product decisions locked:
 *
 *   * D-P17-04 = B — the refund rail is a MANUAL BANK TRANSFER, so `PROCESSING → REFUNDED`
 *     requires recorded evidence and there is no provider to fake a success;
 *   * D-P17-05 — `refundedAmount + amount <= total` holds under a real conditional write, and
 *     whole-rupiah prices make Σ priceSnapshot equal the order total exactly, so the final
 *     ticket of an order is never stranded;
 *   * D-P17-06 — at most ONE `PROCESSING` refund per order, enforced under a row lock;
 *   * D-P17-12 — a PARTIAL refund retains the PIC fee and only a FULL order-item refund
 *     reverses it, exactly once.
 *
 * Only the cases that need a state the service can no longer produce are constructed
 * directly on the tables (the over-balance claim and a second `PROCESSING` refund, both of
 * which the request path and the one-in-flight rule forbid). Every such construction is
 * commented where it happens, and every assertion is read back from the database.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { buildRefundNumber } from "@/lib/ticketing/refunds/settlement";
import {
    approveRefund,
    executeRefund,
    failRefund,
    requestRefund,
    settleRefund,
} from "@/lib/ticketing/refunds/service";
import {
    refundFailSchema,
    refundSettleSchema,
} from "@/lib/ticketing/refunds/validation";

import {
    createPaidOrder,
    createType,
    customerScope,
    expectRejection,
    installGatewayStub,
    issue,
    nextRequest,
    organizerScope,
    refundItems,
    refundRow,
    refundTransactions,
    setupRefundFixtures,
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
    const type = await createType(f, `Rail ${tag}`, { quota: 20 });
    const order = await createPaidOrder({
        buyerId: f.buyerA.id,
        ticketTypeId: type.id,
        quantity,
        tag: nextTag(tag),
    });

    await issue(order.orderNumber, f.buyerA.id);

    return { order, type };
}

async function requestAsBuyer(orderNumber: string, ticketIds?: string[]) {
    const buyer = await customerScope(f.buyerA.id);

    return requestRefund(
        { orderNumber, ticketIds, reason: "Berubah pikiran" },
        buyer,
        nextRequest("/api/ticketing/refunds")
    );
}

async function ownerScope() {
    return organizerScope(f.orgA.id, f.ownerA.id);
}

beforeAll(async () => {
    f = await setupRefundFixtures();
    fetchSpy = installGatewayStub();
});

afterAll(async () => {
    fetchSpy.mockRestore();
    await teardownRefundFixtures(f);
});

// ─────────────────────────────────────────────────────────────────────────────
// D-P17-04 = B: evidence is required, and only the operator can supply it
// ─────────────────────────────────────────────────────────────────────────────

describe("the manual rail requires recorded transfer evidence", () => {
    test("the settle schema requires a transfer reference and accepts no amount", () => {
        const ok = refundSettleSchema.safeParse({
            transferRef: "BCA-2026-09-19-001",
            note: "Transfer ke rekening BCA pembeli",
        });

        expect(ok.success).toBe(true);
        expect(ok.success && ok.data.transferRef).toBe("BCA-2026-09-19-001");

        // No reference, no settlement.
        expect(refundSettleSchema.safeParse({}).success).toBe(false);
        expect(refundSettleSchema.safeParse({ transferRef: "ab" }).success).toBe(
            false
        );

        // A client cannot assert the amount or the resulting status: the schema is STRICT, so
        // an invented financial field is a 400 rather than something silently ignored.
        for (const banned of [
            { confirmedAmount: "999999.00" },
            { amount: "999999.00" },
            { status: "REFUNDED" },
            { organizerId: "org_other" },
        ]) {
            const tampered = refundSettleSchema.safeParse({
                transferRef: "BCA-2026-09-19-002",
                ...banned,
            });

            expect(tampered.success).toBe(false);
        }
    });

    test("the fail schema requires a reason and accepts nothing financial", () => {
        expect(refundFailSchema.safeParse({}).success).toBe(false);
        expect(refundFailSchema.safeParse({ reason: "ab" }).success).toBe(false);

        expect(
            refundFailSchema.safeParse({
                reason: "Rekening tujuan tidak valid",
                status: "FAILED",
                amount: "150000.00",
            }).success
        ).toBe(false);

        const clean = refundFailSchema.safeParse({
            reason: "Rekening tujuan tidak valid",
        });

        expect(clean.success).toBe(true);
        expect(clean.success && clean.data.reason).toBe("Rekening tujuan tidak valid");
    });

    test("a refund that was never claimed cannot be settled or failed", async () => {
        const { order } = await issuedPaidOrder("never-claimed");

        const requested = await requestAsBuyer(order.orderNumber);
        const owner = await ownerScope();

        await approveRefund(requested.refundId, owner, {}, nextRequest());

        // APPROVED, not PROCESSING: the operator has not taken the refund in hand yet, so
        // there is nothing to record evidence against.
        const settleError = await expectRejection(() =>
            settleRefund(
                requested.refundId,
                { transferRef: "BCA-TOO-EARLY" },
                owner,
                nextRequest()
            )
        );
        expect(settleError.status ?? settleError.httpStatus).toBe(409);

        const failError = await expectRejection(() =>
            failRefund(
                requested.refundId,
                { reason: "Belum diproses" },
                owner,
                nextRequest()
            )
        );
        expect(failError.status ?? failError.httpStatus).toBe(409);

        const row = await refundRow(requested.refundId);
        expect(row.status).toBe("APPROVED");
        expect(row.confirmedAmount.toFixed(2)).toBe("0.00");
        expect(row.providerRef).toBeNull();
        expect(row.evidenceNote).toBeNull();
    });

    test("the requester may not settle their own refund (separation of duties)", async () => {
        const { order } = await issuedPaidOrder("sod-settle");

        const requested = await requestAsBuyer(order.orderNumber);
        const owner = await ownerScope();

        await approveRefund(requested.refundId, owner, {}, nextRequest());
        await executeRefund(requested.refundId, owner, {}, nextRequest());

        // The requester is a buyer, who has no tenant membership at all; resolving as them
        // must fail on authority before any money is considered.
        const buyer = await customerScope(f.buyerA.id);

        const error = await expectRejection(() =>
            settleRefund(
                requested.refundId,
                { transferRef: "BCA-SOD" },
                buyer,
                nextRequest()
            )
        );

        expect([403, 404]).toContain(error.status ?? error.httpStatus);

        const row = await refundRow(requested.refundId);
        expect(row.status).toBe("PROCESSING");
        expect(row.confirmedAmount.toFixed(2)).toBe("0.00");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-P17-05: the refundable balance is a database predicate, not an application read
// ─────────────────────────────────────────────────────────────────────────────

describe("the refundable balance cannot be exceeded", () => {
    /**
     * A claim larger than the order's remaining balance.
     *
     * The REQUEST path cannot produce this (D-R09 refuses it at eligibility time), which is
     * exactly why the settlement-side guard has to be tested against a hand-built row: the
     * guard is the second line of defense for a balance that moved between request and
     * settlement, and an untested second line is not a defense.
     */
    async function overBalanceProcessingRefund(tag: string) {
        const { order } = await issuedPaidOrder(tag);

        const dbOrder = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: {
                id: true,
                organizerId: true,
                total: true,
                items: { select: { id: true } },
            },
        });

        const [ticket] = await ticketsFor(order.orderId);
        const excess = new Prisma.Decimal(dbOrder.total).plus(1);

        const refund = await prisma.refund.create({
            data: {
                refundNumber: buildRefundNumber(),
                organizerId: dbOrder.organizerId,
                eventOrderId: dbOrder.id,
                requestedByUserId: f.buyerA.id,
                requestedAmount: excess,
                status: "PROCESSING",
                processedByUserId: f.ownerA.id,
                processedAt: new Date(),
            },
            select: { id: true },
        });

        await prisma.refundItem.create({
            data: {
                refundId: refund.id,
                ticketId: ticket.id,
                orderItemId: dbOrder.items[0].id,
                amount: excess,
            },
        });

        return { refundId: refund.id, ticketId: ticket.id, orderId: dbOrder.id, total: dbOrder.total };
    }

    test("a settlement that would exceed the order total is refused and moves nothing", async () => {
        const claim = await overBalanceProcessingRefund("over-balance");
        const owner = await ownerScope();

        const error = await expectRejection(() =>
            settleRefund(
                claim.refundId,
                { transferRef: "BCA-OVER-BALANCE" },
                owner,
                nextRequest()
            )
        );

        expect(error.status ?? error.httpStatus).toBe(409);

        // The whole settlement rolled back: no status, no money, no ticket, no ledger row.
        const row = await refundRow(claim.refundId);
        expect(row.status).toBe("PROCESSING");
        expect(row.confirmedAmount.toFixed(2)).toBe("0.00");

        const order = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: claim.orderId },
            select: { refundedAmount: true, status: true },
        });
        expect(order.refundedAmount.toFixed(2)).toBe("0.00");
        expect(order.status).toBe("PAID");

        const [ticket] = await prisma.ticket.findMany({
            where: { id: claim.ticketId },
            select: { status: true, refundedAt: true },
        });
        expect(ticket.status).toBe("ISSUED");
        expect(ticket.refundedAt).toBeNull();

        expect(await refundTransactions(claim.orderId)).toHaveLength(0);
    });

    test("concurrent settlements against one balance never push refundedAmount past total", async () => {
        // Two PROCESSING claims on the SAME order, each individually within the balance but
        // together in excess of it. Constructed directly because D-P17-06 makes this state
        // unreachable through the service — the point here is that even if it existed, the
        // balance predicate holds.
        const { order } = await issuedPaidOrder("balance-race", 2);

        const dbOrder = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: {
                id: true,
                organizerId: true,
                total: true,
                items: { select: { id: true } },
            },
        });

        const orderItemId = dbOrder.items[0].id;
        const tickets = await ticketsFor(order.orderId);

        // Each claim is one rupiah short of the whole order. Either alone is affordable;
        // together they are not.
        const perClaim = new Prisma.Decimal(dbOrder.total).minus(1);

        const claims = await Promise.all(
            tickets.map(async (ticket) => {
                const refund = await prisma.refund.create({
                    data: {
                        refundNumber: buildRefundNumber(),
                        organizerId: dbOrder.organizerId,
                        eventOrderId: dbOrder.id,
                        requestedByUserId: f.buyerA.id,
                        requestedAmount: perClaim,
                        status: "PROCESSING",
                        processedByUserId: f.ownerA.id,
                        processedAt: new Date(),
                    },
                    select: { id: true },
                });

                await prisma.refundItem.create({
                    data: {
                        refundId: refund.id,
                        ticketId: ticket.id,
                        orderItemId,
                        amount: perClaim,
                    },
                });

                return refund.id;
            })
        );

        const owner = await ownerScope();

        await Promise.all(
            claims.map((refundId) =>
                settleRefund(
                    refundId,
                    { transferRef: `BCA-BALANCE-${refundId}` },
                    owner,
                    nextRequest()
                ).catch(() => null)
            )
        );

        const orderRow = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: dbOrder.id },
            select: { refundedAmount: true, total: true },
        });

        // THE INVARIANT. Whatever the interleaving, the confirmed money can never exceed the
        // order's own total — and only one claim may have reached REFUNDED here.
        expect(orderRow.refundedAmount.lessThanOrEqualTo(orderRow.total)).toBe(true);

        const settledCount = await prisma.refund.count({
            where: { id: { in: claims }, status: "REFUNDED" },
        });
        expect(settledCount).toBe(1);
        expect(orderRow.refundedAmount.toFixed(2)).toBe(perClaim.toFixed(2));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-P17-05: whole-rupiah prices mean the order total is exactly the sum of its tickets
// ─────────────────────────────────────────────────────────────────────────────

describe("whole-rupiah pricing keeps the order total refundable to the cent", () => {
    test("a multi-ticket order refunds completely — no stranded final ticket", async () => {
        const { order } = await issuedPaidOrder("whole-rupiah", 3);

        const dbOrder = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { total: true, refundedAmount: true },
        });

        // Three tickets at the fixture's whole-rupiah price: the order total must equal the
        // sum of the per-ticket snapshots exactly, which is the Phase 18B pricing invariant.
        expect(dbOrder.total.toFixed(2)).toBe("450000.00");
        expect(dbOrder.refundedAmount.toFixed(2)).toBe("0.00");

        const requested = await requestAsBuyer(order.orderNumber);

        // The claim inherits its amount from the ticket snapshots, and it is exactly the
        // order total — under the old fractional-price behaviour this is where a ticket could
        // end up unrefundable.
        expect(requested.requestedAmount).toBe(dbOrder.total.toFixed(2));

        const owner = await ownerScope();

        await approveRefund(requested.refundId, owner, {}, nextRequest());
        await executeRefund(requested.refundId, owner, {}, nextRequest());
        await settleRefund(
            requested.refundId,
            { transferRef: "BCA-WHOLE-1" },
            owner,
            nextRequest()
        );

        const settled = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { status: true, paymentStatus: true, refundedAmount: true, total: true },
        });

        // Fully refunded, not "0.01 short and permanently PARTIALLY_REFUNDED".
        expect(settled.refundedAmount.toFixed(2)).toBe(settled.total.toFixed(2));
        expect(settled.status).toBe("REFUNDED");
        expect(settled.paymentStatus).toBe("REFUNDED");

        const tickets = await ticketsFor(order.orderId);
        expect(tickets.every((ticket) => ticket.status === "REFUNDED")).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-P17-06: one PROCESSING refund per order, under real concurrency
// ─────────────────────────────────────────────────────────────────────────────

describe("at most one refund may be PROCESSING for an order", () => {
    test("two concurrent claims on the same order produce exactly one winner", async () => {
        const { order } = await issuedPaidOrder("concurrent-claim", 2);
        const tickets = await ticketsFor(order.orderId);

        const first = await requestAsBuyer(order.orderNumber, [tickets[0].id]);
        const second = await requestAsBuyer(order.orderNumber, [tickets[1].id]);

        const owner = await ownerScope();

        await approveRefund(first.refundId, owner, {}, nextRequest());
        await approveRefund(second.refundId, owner, {}, nextRequest());

        // Both claims are issued at once. The order-row lock serializes them, so the loser
        // reads the winner's PROCESSING row and is refused — a `count()` outside a
        // transaction would let both through.
        const results = await Promise.all(
            [first.refundId, second.refundId].map(async (refundId) => {
                try {
                    await executeRefund(refundId, owner, {}, nextRequest());
                    return { refundId, ok: true };
                } catch {
                    return { refundId, ok: false };
                }
            })
        );

        const winners = results.filter((result) => result.ok);
        expect(winners).toHaveLength(1);

        const inFlight = await prisma.refund.count({
            where: { eventOrderId: order.orderId, status: "PROCESSING" },
        });
        expect(inFlight).toBe(1);

        // The loser is still APPROVED — untouched, and able to proceed once the winner
        // leaves PROCESSING.
        const loserId = results.find((result) => !result.ok)!.refundId;
        expect((await refundRow(loserId)).status).toBe("APPROVED");

        const winnerId = winners[0].refundId;
        await settleRefund(
            winnerId,
            { transferRef: "BCA-CONCURRENT-1" },
            owner,
            nextRequest()
        );
        expect((await refundRow(winnerId)).status).toBe("REFUNDED");

        const next = await executeRefund(loserId, owner, {}, nextRequest());
        expect(next.status).toBe("PROCESSING");
    });

    test("a concurrent duplicate settlement moves the money exactly once", async () => {
        const { order } = await issuedPaidOrder("concurrent-settle");

        const requested = await requestAsBuyer(order.orderNumber);
        const owner = await ownerScope();

        await approveRefund(requested.refundId, owner, {}, nextRequest());
        await executeRefund(requested.refundId, owner, {}, nextRequest());

        // The operator double-submits the evidence. Both calls reach the transactional core;
        // the PROCESSING → REFUNDED CAS decides, and the loser is a no-op.
        await Promise.all([
            settleRefund(
                requested.refundId,
                { transferRef: "BCA-DOUBLE-1" },
                owner,
                nextRequest()
            ),
            settleRefund(
                requested.refundId,
                { transferRef: "BCA-DOUBLE-2" },
                owner,
                nextRequest()
            ),
        ]);

        const orderRow = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { refundedAmount: true, status: true },
        });

        expect(orderRow.refundedAmount.toFixed(2)).toBe("150000.00");
        expect(orderRow.status).toBe("REFUNDED");

        // Exactly one refund transaction and exactly one claim survived.
        expect(await refundTransactions(order.orderId)).toHaveLength(1);
        expect(await refundItems(requested.refundId)).toHaveLength(1);

        const row = await refundRow(requested.refundId);
        expect(row.status).toBe("REFUNDED");
        // Whichever submission won recorded its own reference; the other changed nothing.
        expect(["BCA-DOUBLE-1", "BCA-DOUBLE-2"]).toContain(row.providerRef);
    });

    test("a FAILED transfer releases the in-flight claim", async () => {
        const { order } = await issuedPaidOrder("failed-releases", 2);
        const tickets = await ticketsFor(order.orderId);

        const first = await requestAsBuyer(order.orderNumber, [tickets[0].id]);
        const owner = await ownerScope();

        await approveRefund(first.refundId, owner, {}, nextRequest());
        await executeRefund(first.refundId, owner, {}, nextRequest());

        await failRefund(
            first.refundId,
            { reason: "Transfer ditolak bank" },
            owner,
            nextRequest()
        );

        expect((await refundRow(first.refundId)).status).toBe("FAILED");

        // The slot is free again, so a corrected request can be claimed. The owner scope is
        // re-issued because the guards read the LIVE session, which the buyer's request
        // switched away again.
        const second = await requestAsBuyer(order.orderNumber, [tickets[1].id]);
        const ownerAgain = await ownerScope();
        await approveRefund(second.refundId, ownerAgain, {}, nextRequest());

        const claimed = await executeRefund(
            second.refundId,
            ownerAgain,
            {},
            nextRequest()
        );
        expect(claimed.status).toBe("PROCESSING");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-P17-12: full-item reversal only, and never twice
// ─────────────────────────────────────────────────────────────────────────────

describe("PIC fee reversal is full-item only (D-P17-12)", () => {
    async function earnedFeeFor(params: {
        orderId: string;
        organizerId: string;
        eventId: string;
        orderItemId: string;
        ticketTypeId: string;
        picProfileId: string;
        amount: string;
        quantity: number;
    }) {
        return prisma.pICFeeLedger.create({
            data: {
                picProfileId: params.picProfileId,
                organizerId: params.organizerId,
                eventId: params.eventId,
                orderId: params.orderId,
                orderItemId: params.orderItemId,
                ticketTypeId: params.ticketTypeId,
                type: "EARNED",
                direction: "CREDIT",
                amount: new Prisma.Decimal(params.amount),
                currency: "IDR",
                feeType: "PERCENTAGE",
                rateBp: 500,
                basisType: "GROSS_BEFORE_DISCOUNT",
                basisAmount: new Prisma.Decimal(params.amount),
                quantity: params.quantity,
                status: "EARNED",
                idempotencyKey: `fee:earned:${params.orderItemId}`,
            },
        });
    }

    test("a partial refund retains the fee; the final ticket reverses it exactly once", async () => {
        const { order, type } = await issuedPaidOrder("pic-fee", 2);

        const dbOrder = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.orderId },
            select: { organizerId: true, items: { select: { id: true } } },
        });

        const orderItemId = dbOrder.items[0].id;

        // A real PIC profile (the ledger's profile FK is RESTRICT, so the row must exist).
        const picProfile = await prisma.pICProfile.create({
            data: {
                userId: f.buyerB.id,
                picCode: `P18B-${Date.now()}`,
                displayName: "PIC Phase 18B",
            },
            select: { id: true },
        });

        await earnedFeeFor({
            orderId: order.orderId,
            organizerId: dbOrder.organizerId,
            eventId: f.eventA.id,
            orderItemId,
            ticketTypeId: type.id,
            picProfileId: picProfile.id,
            amount: "15000.00",
            quantity: 2,
        });

        const tickets = await ticketsFor(order.orderId);

        // ── Partial: one of the item's two tickets ────────────────────────────────
        const first = await requestAsBuyer(order.orderNumber, [tickets[0].id]);
        const owner = await ownerScope();
        await approveRefund(first.refundId, owner, {}, nextRequest());
        await executeRefund(first.refundId, owner, {}, nextRequest());
        await settleRefund(
            first.refundId,
            { transferRef: "BCA-PIC-PARTIAL" },
            owner,
            nextRequest()
        );

        expect((await refundRow(first.refundId)).feeTreatment).toBe("RETAINED");
        expect(
            await prisma.pICFeeLedger.count({
                where: { orderItemId, type: "REVERSAL" },
            })
        ).toBe(0);

        // ── Full: the item's last ticket ──────────────────────────────────────────
        // Re-issued owner scope: the guards read the LIVE session, which the second buyer
        // request switched away again.
        const second = await requestAsBuyer(order.orderNumber, [tickets[1].id]);
        const ownerAgain = await ownerScope();
        await approveRefund(second.refundId, ownerAgain, {}, nextRequest());
        await executeRefund(second.refundId, ownerAgain, {}, nextRequest());
        await settleRefund(
            second.refundId,
            { transferRef: "BCA-PIC-FULL" },
            ownerAgain,
            nextRequest()
        );

        expect((await refundRow(second.refundId)).feeTreatment).toBe("REVERSED");

        const reversals = await prisma.pICFeeLedger.findMany({
            where: { orderItemId, type: "REVERSAL" },
        });

        // Exactly one reversal, for the full earned amount, pointing at this refund.
        expect(reversals).toHaveLength(1);
        expect(reversals[0].direction).toBe("DEBIT");
        expect(reversals[0].amount.toFixed(2)).toBe("15000.00");
        expect(reversals[0].status).toBe("VOID");
        expect(reversals[0].refundId).toBe(second.refundId);
    });
});
