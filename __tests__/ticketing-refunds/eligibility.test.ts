/**
 * ==========================================
 * PHASE 10B — REFUND ELIGIBILITY POLICY (PURE)
 * ==========================================
 *
 * The refund rules are the part a reviewer must be able to check without a database, so
 * they live in `lib/ticketing/refunds/eligibility.ts` as a pure function over already-read
 * rows. This suite exercises every branch of that function — D-R03/D-R04/D-R05/D-R09/D-R10
 * — with hand-built rows and no Prisma client, no session and no Next.js.
 *
 * The amount assertions are the point: the refundable value is derived from the
 * purchase-time price SNAPSHOTS, never from a caller, so these tests pin the money maths to
 * `Decimal` (D-61) and to the database's own numbers.
 */

import { Prisma } from "@prisma/client";

import {
    evaluateRefundEligibility,
    refundableBalance,
    type RefundTicketCandidate,
} from "@/lib/ticketing/refunds/eligibility";
import { confirmedAmountVerdict } from "@/lib/ticketing/payment/refund-provider";
import {
    refundIdParamSchema,
    refundListQuerySchema,
    refundRequestSchema,
} from "@/lib/ticketing/refunds/validation";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const PRICE = new Prisma.Decimal("150000.00");

function ticket(
    overrides: Partial<RefundTicketCandidate> & { id?: string } = {}
): RefundTicketCandidate {
    return {
        id: overrides.id ?? "tkt_1",
        ticketCode: overrides.ticketCode ?? "TKT-1",
        status: overrides.status ?? "ISSUED",
        checkedInAt: overrides.checkedInAt ?? null,
        refundedAt: overrides.refundedAt ?? null,
        refundItem: overrides.refundItem ?? null,
        orderItem:
            overrides.orderItem === undefined
                ? {
                      id: "item_1",
                      nameSnapshot: "Reguler",
                      priceSnapshot: PRICE,
                      quantity: 1,
                  }
                : overrides.orderItem,
    };
}

function order(
    overrides: Partial<{
        status: string;
        paymentStatus: string;
        total: Prisma.Decimal;
        refundedAmount: Prisma.Decimal;
        paidAt: Date | null;
    }> = {}
) {
    return {
        status: overrides.status ?? "PAID",
        paymentStatus: overrides.paymentStatus ?? "PAID",
        total: overrides.total ?? new Prisma.Decimal("300000.00"),
        refundedAmount: overrides.refundedAmount ?? new Prisma.Decimal(0),
        paidAt: overrides.paidAt === undefined ? NOW : overrides.paidAt,
    };
}

describe("refund eligibility: the happy path", () => {
    test("all ISSUED tickets are refundable, for the sum of their snapshots", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: null,
            tickets: [ticket({ id: "tkt_1" }), ticket({ id: "tkt_2" })],
            now: NOW,
        });

        expect(result.eligible).toBe(true);

        if (result.eligible) {
            expect(result.amount.toFixed(2)).toBe("300000.00");
            expect(result.refundableBefore.toFixed(2)).toBe("300000.00");
            expect(result.lines).toHaveLength(2);
            expect(result.lines.every((line) => line.amount.toFixed(2) === "150000.00")).toBe(
                true
            );
        }
    });

    test("prices come from each ticket's own snapshot, not a shared unit", () => {
        const result = evaluateRefundEligibility({
            order: order({ total: new Prisma.Decimal("500000.00") }),
            event: null,
            tickets: [
                ticket({
                    id: "tkt_1",
                    orderItem: {
                        id: "item_1",
                        nameSnapshot: "Reguler",
                        priceSnapshot: new Prisma.Decimal("100000.00"),
                        quantity: 2,
                    },
                }),
                ticket({
                    id: "tkt_2",
                    orderItem: {
                        id: "item_2",
                        nameSnapshot: "VIP",
                        priceSnapshot: new Prisma.Decimal("250000.00"),
                        quantity: 2,
                    },
                }),
            ],
            now: NOW,
        });

        expect(result.eligible).toBe(true);

        if (result.eligible) {
            expect(result.amount.toFixed(2)).toBe("350000.00");
            expect(result.lines.map((line) => line.amount.toFixed(2))).toEqual([
                "100000.00",
                "250000.00",
            ]);
        }
    });

    test("a PARTIALLY_REFUNDED order remains refundable down to its balance", () => {
        const result = evaluateRefundEligibility({
            order: order({
                status: "PARTIALLY_REFUNDED",
                paymentStatus: "PARTIALLY_REFUNDED",
                total: new Prisma.Decimal("300000.00"),
                refundedAmount: new Prisma.Decimal("150000.00"),
            }),
            event: null,
            tickets: [ticket()],
            now: NOW,
        });

        expect(result.eligible).toBe(true);

        if (result.eligible) {
            expect(result.amount.toFixed(2)).toBe("150000.00");
            expect(result.refundableBefore.toFixed(2)).toBe("150000.00");
        }
    });

    test("a null refund deadline leaves the window open", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: { refundDeadlineAt: null },
            tickets: [ticket()],
            now: NOW,
        });

        expect(result.eligible).toBe(true);
    });
});

describe("refund eligibility: D-R03 the order must be paid", () => {
    test("a PENDING_PAYMENT order is refused", () => {
        const result = evaluateRefundEligibility({
            order: order({ status: "PENDING_PAYMENT", paymentStatus: "UNPAID" }),
            event: null,
            tickets: [ticket()],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "ORDER_NOT_PAID" });
    });

    test("a CANCELLED order is refused", () => {
        const result = evaluateRefundEligibility({
            order: order({ status: "CANCELLED" }),
            event: null,
            tickets: [ticket()],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "ORDER_NOT_PAID" });
    });

    test("a PAID order with an UNPAID payment is refused", () => {
        const result = evaluateRefundEligibility({
            order: order({ paymentStatus: "UNPAID" }),
            event: null,
            tickets: [ticket()],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "PAYMENT_NOT_PAID" });
    });

    test("an order with no paidAt is refused", () => {
        const result = evaluateRefundEligibility({
            order: order({ paidAt: null }),
            event: null,
            tickets: [ticket()],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "PAYMENT_NOT_PAID" });
    });
});

describe("refund eligibility: the refund window", () => {
    test("a deadline in the past closes refunds", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: { refundDeadlineAt: new Date(NOW.getTime() - 1) },
            tickets: [ticket()],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "REFUND_WINDOW_CLOSED" });
    });

    test("a deadline exactly now closes refunds", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: { refundDeadlineAt: NOW },
            tickets: [ticket()],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "REFUND_WINDOW_CLOSED" });
    });

    test("a deadline in the future leaves refunds open", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: { refundDeadlineAt: new Date(NOW.getTime() + 60_000) },
            tickets: [ticket()],
            now: NOW,
        });

        expect(result.eligible).toBe(true);
    });
});

describe("refund eligibility: D-R04/D-R05 ticket state", () => {
    test("no selected tickets is NOTHING_REFUNDABLE", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: null,
            tickets: [],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "NOTHING_REFUNDABLE" });
    });

    test("a CHECKED_IN ticket is refused", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: null,
            tickets: [ticket({ status: "CHECKED_IN" })],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "TICKET_CHECKED_IN" });
    });

    test("a checked-in timestamp is enough, even if the status lags", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: null,
            tickets: [ticket({ status: "ISSUED", checkedInAt: NOW })],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "TICKET_CHECKED_IN" });
    });

    test("a RESERVED ticket is refused", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: null,
            tickets: [ticket({ status: "RESERVED" })],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "TICKET_NOT_REFUNDABLE" });
    });

    test("a VOID ticket is refused", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: null,
            tickets: [ticket({ status: "VOID" })],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "TICKET_NOT_REFUNDABLE" });
    });

    test("a ticket whose order item is gone is refused rather than priced by guess", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: null,
            tickets: [ticket({ orderItem: null })],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "TICKET_NOT_REFUNDABLE" });
    });
});

describe("refund eligibility: D-R10 a ticket is claimable once", () => {
    test("an existing refund item blocks a second claim", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: null,
            tickets: [ticket({ refundItem: { id: "ri_1" } })],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "TICKET_ALREADY_REFUNDED" });
    });

    test("a refunded timestamp blocks a second claim", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: null,
            tickets: [ticket({ status: "REFUNDED", refundedAt: NOW })],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "TICKET_ALREADY_REFUNDED" });
    });

    test("one bad ticket refuses the whole selection and names it", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: null,
            tickets: [
                ticket({ id: "tkt_ok", ticketCode: "TKT-OK" }),
                ticket({
                    id: "tkt_bad",
                    ticketCode: "TKT-BAD",
                    status: "CHECKED_IN",
                }),
            ],
            now: NOW,
        });

        expect(result).toMatchObject({
            eligible: false,
            reason: "TICKET_CHECKED_IN",
            ticketId: "tkt_bad",
            ticketCode: "TKT-BAD",
        });
    });
});

describe("refund eligibility: D-R09 the amount cannot exceed the balance", () => {
    test("selecting more value than remains is refused", () => {
        const result = evaluateRefundEligibility({
            order: order({
                total: new Prisma.Decimal("100000.00"),
                refundedAmount: new Prisma.Decimal(0),
            }),
            event: null,
            tickets: [ticket()],
            now: NOW,
        });

        expect(result).toMatchObject({
            eligible: false,
            reason: "AMOUNT_EXCEEDS_REFUNDABLE",
        });
    });

    test("a zero-value selection is NOTHING_REFUNDABLE", () => {
        const result = evaluateRefundEligibility({
            order: order(),
            event: null,
            tickets: [
                ticket({
                    orderItem: {
                        id: "item_1",
                        nameSnapshot: "Gratis",
                        priceSnapshot: new Prisma.Decimal(0),
                        quantity: 1,
                    },
                }),
            ],
            now: NOW,
        });

        expect(result).toMatchObject({ eligible: false, reason: "NOTHING_REFUNDABLE" });
    });

    test("refundableBalance floors at zero when the row is transiently inconsistent", () => {
        const balance = refundableBalance({
            total: new Prisma.Decimal("100000.00"),
            refundedAmount: new Prisma.Decimal("150000.00"),
        });

        expect(balance.toFixed(2)).toBe("0.00");
    });
});

describe("refund provider confirmation maths (D-R12/D-61)", () => {
    test("an absent confirmed amount is ABSENT, not a mismatch", () => {
        expect(confirmedAmountVerdict(null, PRICE)).toBe("ABSENT");
    });

    test("an equal amount is MATCH", () => {
        expect(confirmedAmountVerdict("150000.00", PRICE)).toBe("MATCH");
    });

    test("a different amount is MISMATCH", () => {
        expect(confirmedAmountVerdict("149999.99", PRICE)).toBe("MISMATCH");
    });

    test("an unparseable amount is UNPARSEABLE", () => {
        expect(confirmedAmountVerdict("not-a-number", PRICE)).toBe("UNPARSEABLE");
    });
});

describe("refund request validation (D-R01/D-R08/D-R09)", () => {
    test("an order number alone is a full-refund request", () => {
        const parsed = refundRequestSchema.parse({ orderNumber: "EVT-1" });

        expect(parsed).toEqual({ orderNumber: "EVT-1" });
    });

    test("ticket ids select the lines and are bounded", () => {
        const parsed = refundRequestSchema.parse({
            orderNumber: "EVT-1",
            ticketIds: ["tkt_1", "tkt_2"],
            reason: "Berubah pikiran",
        });

        expect(parsed.ticketIds).toEqual(["tkt_1", "tkt_2"]);
    });

    test("an empty ticket-id selection is rejected", () => {
        expect(
            refundRequestSchema.safeParse({ orderNumber: "EVT-1", ticketIds: [] }).success
        ).toBe(false);
    });

    test("authoritative financial and identity fields are stripped, never accepted", () => {
        const parsed = refundRequestSchema.parse({
            orderNumber: "EVT-1",
            amount: "999999.00",
            total: "1.00",
            organizerId: "org_x",
            userId: "usr_x",
            status: "REFUNDED",
            refundedAmount: "1.00",
            providerRef: "PR-x",
        }) as Record<string, unknown>;

        for (const banned of [
            "amount",
            "total",
            "organizerId",
            "userId",
            "status",
            "refundedAmount",
            "providerRef",
        ]) {
            expect(parsed[banned]).toBeUndefined();
        }
    });

    test("the refund id path segment is coerced and must be a positive integer", () => {
        expect(refundIdParamSchema.parse("42")).toBe(42);
        expect(refundIdParamSchema.safeParse("0").success).toBe(false);
        expect(refundIdParamSchema.safeParse("-1").success).toBe(false);
        expect(refundIdParamSchema.safeParse("abc").success).toBe(false);
    });

    test("the list query only accepts known statuses and bounded pages", () => {
        expect(
            refundListQuerySchema.parse({ status: "REFUNDED", page: "2" })
        ).toMatchObject({ status: "REFUNDED", page: 2 });

        expect(refundListQuerySchema.safeParse({ status: "NOPE" }).success).toBe(false);
        expect(refundListQuerySchema.safeParse({ page: "0" }).success).toBe(false);
        expect(refundListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    });
});
