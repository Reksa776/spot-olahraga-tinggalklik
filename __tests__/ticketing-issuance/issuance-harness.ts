/**
 * ==========================================
 * PHASE 8 TEST HARNESS (shared, not a suite)
 * ==========================================
 *
 * Fixtures and helpers for the ticket-issuance suites. Lives in the suite directory but is
 * not named `*.test.ts`, so `testMatch` never runs it as a suite.
 *
 * ── IT EXTENDS THE PHASE 7 HARNESS RATHER THAN COPYING IT ────────────────────────
 * The tenant/user/event/sport fixtures, the session fake, the provider-socket stub and the
 * inventory-invariant assertions are identical in shape to Phase 7's, so they are imported
 * from `../ticketing-payment/payment-harness` instead of being reimplemented. What Phase 8
 * adds is exactly what is new: a way to reach the PAID state through the REAL settlement
 * path, an issuance call wrapper, a ticket reader, and a teardown that also clears tickets.
 *
 * The teardown point is not cosmetic. `Ticket.orderId`/`orderItemId` are
 * `onDelete: Restrict`, so Phase 7's teardown would fail on the first order that has
 * tickets — which is every order these suites create. `teardownIssuanceFixtures` therefore
 * deletes this phase's ticket rows first and then hands over to the parent teardown, which
 * still owns everything else (payments, ledger, reservations, orders, types, events, orgs).
 *
 * ── WHAT IS REAL ─────────────────────────────────────────────────────────────────
 * REAL: the database (MySQL/InnoDB), `createTicketOrder`, the whole Phase 7 payment and
 * settlement chain, the `WebhookEvent` ledger, the inventory CAS primitives, `lib/authz`
 * guards and permissions, the row lock, the unique constraints, and every line of
 * `lib/ticketing/tickets/**`. The gateway socket is stubbed by the parent harness, and that
 * stub is used only to obtain a provider session for an order to be settled against —
 * issuance itself makes no outbound call of any kind (asserted by the static guards).
 *
 * ── WHY PAID ORDERS ARE BUILT THROUGH SETTLEMENT ────────────────────────────────
 * A `PAID`/`PAID` order with a non-null `paidAt` and converted reservations is the INPUT to
 * this phase, and the only honest way to produce that input is the path a real buyer's
 * payment takes. Writing the columns directly would make the suite prove nothing about the
 * state the platform actually creates — and would quietly stop testing the eligibility
 * gate's agreement with settlement if the two ever diverged.
 */

import { createTicketType } from "@/lib/ticket-types/service";
import { prisma } from "@/lib/prisma";
import { cancelOwnPendingOrder } from "@/lib/ticketing/orders";
import { createOrderPayment } from "@/lib/ticketing/payment/service";
import { handleGatewayWebhook } from "@/lib/ticketing/payment/webhook";
import {
    issueTicketsForOrder,
    type TicketIssuanceResult,
} from "@/lib/ticketing/tickets/issuance";

import {
    createOrder,
    customerScope,
    nextRequest,
    organizerScope,
    signedCallback,
    setupFixtures,
    teardownFixtures,
    type Fixtures,
} from "../ticketing-payment/payment-harness";

/* Re-exported so a suite has one import site for the whole Phase 8 surface. */
export {
    assertInventoryInvariants,
    counters,
    createOrder,
    customerScope,
    expectRejection,
    installGatewayStub,
    nextRequest,
    organizerScope,
    signInAs,
} from "../ticketing-payment/payment-harness";

export type { Fixtures, Rejection } from "../ticketing-payment/payment-harness";

/** The price every issuance fixture is created at. Matches the Phase 7 fixtures. */
export const ISSUANCE_PRICE = "150000.00";

let trxCounter = 0;

/**
 * A provider transaction id unique to one delivery.
 *
 * Uniqueness matters even where it is not asserted: the `WebhookEvent` ledger keys on
 * `providerEventId`, and two deliveries sharing a transaction id would be classified as
 * duplicates of each other — which would silently turn a settlement fixture into a no-op.
 */
function nextTrx(tag: string): string {
    trxCounter += 1;

    return `TRX-P8-${tag}-${trxCounter}`;
}

/* ==========================================
 * FIXTURES
 * ========================================== */

/**
 * The Phase 7 fixture set. Identical by construction — this phase needs the same two
 * tenants, two buyers and one published event, and reusing them keeps a single definition
 * of "a valid ticketing environment" across both phases.
 */
export async function setupIssuanceFixtures(): Promise<Fixtures> {
    return setupFixtures();
}

/**
 * A fresh ticket type on tenant A's published event, created through the real service.
 *
 * Types are per-test rather than shared so a counter assertion can be absolute
 * (`sold === 3`) instead of relative — the same reason Phase 5/6/7 each allocate their own.
 */
export async function createType(
    f: Fixtures,
    name: string,
    options: { quota?: number; extra?: Record<string, unknown> } = {}
): Promise<{ id: string }> {
    const scope = await organizerScope(f.orgA.id, f.ownerA.id);

    return createTicketType(scope, f.eventA.id, {
        name,
        price: ISSUANCE_PRICE,
        quota: options.quota ?? 20,
        ...(options.extra ?? {}),
    } as never);
}

/* ==========================================
 * REACHING A PAID ORDER (through real settlement)
 * ========================================== */

/**
 * Give an order a live provider session and deliver a valid success notification for it.
 *
 * Both steps are the production chain: `createOrderPayment` signs a real request and asks
 * the (stubbed) gateway for a session; `handleGatewayWebhook` verifies a real HMAC over a
 * real body, records the ledger row, and runs the guarded settlement transaction that
 * converts the reservations and moves the counters. Throws if the settlement did not
 * actually settle — a fixture that silently produced a half-paid order would make every
 * downstream assertion meaningless.
 */
export async function payOrder(
    orderNumber: string,
    buyerId: string
): Promise<{ paymentReference: string }> {
    const actor = await customerScope(buyerId);

    const payment = await createOrderPayment({
        orderNumber,
        actor,
        request: {} as never,
        httpRequest: nextRequest(),
    });

    const signed = signedCallback({
        referenceId: payment.paymentReference,
        statusCode: 1,
        subTotal: payment.amount,
        trxId: nextTrx("settle"),
        fee: "0",
        via: "qris",
        channel: "qris",
    });

    const result = await handleGatewayWebhook({
        rawBody: signed.rawBody,
        signatureHeader: signed.signature,
        remoteIp: "127.0.0.1",
    });

    if (result.outcome !== "SETTLED") {
        throw new Error(
            `Fixture error: expected SETTLED, got ${result.outcome} (HTTP ${result.httpStatus})`
        );
    }

    return { paymentReference: payment.paymentReference };
}

/** Create a real order through checkout and settle it. The Phase 8 happy-path input. */
export async function createPaidOrder(params: {
    buyerId: string;
    ticketTypeId: string;
    quantity: number;
    /** Unique per call: it is the checkout idempotency key. */
    tag: string;
    eventId?: string;
}): Promise<{ orderNumber: string; orderId: string; total: string }> {
    const order = await createOrder({
        buyerId: params.buyerId,
        items: [{ ticketTypeId: params.ticketTypeId, quantity: params.quantity }],
        tag: params.tag,
        eventId: params.eventId,
    });

    await payOrder(order.orderNumber, params.buyerId);

    return order;
}

/**
 * The Phase 7 LATE-SETTLEMENT state, produced by its real cause rather than by hand:
 * an order is cancelled (releasing its seats), and only then does the provider's success
 * notification arrive. Settlement records the money, refuses to resurrect the order, and
 * sets `fulfilmentBlockedAt` — the exact combination the issuance gate must refuse.
 *
 * The helper asserts that this is what happened, so a change in settlement's terminal
 * states shows up as a fixture failure instead of as a passing issuance test.
 */
export async function createLateSettledOrder(params: {
    buyerId: string;
    ticketTypeId: string;
    quantity: number;
    tag: string;
}): Promise<{ orderNumber: string; orderId: string }> {
    const order = await createOrder({
        buyerId: params.buyerId,
        items: [{ ticketTypeId: params.ticketTypeId, quantity: params.quantity }],
        tag: params.tag,
    });

    const actor = await customerScope(params.buyerId);

    const payment = await createOrderPayment({
        orderNumber: order.orderNumber,
        actor,
        request: {} as never,
        httpRequest: nextRequest(),
    });

    await cancelOwnPendingOrder(order.orderNumber, actor, "fixture: late settlement");

    const signed = signedCallback({
        referenceId: payment.paymentReference,
        statusCode: 1,
        subTotal: payment.amount,
        trxId: nextTrx("late"),
        fee: "0",
        via: "qris",
        channel: "qris",
    });

    const result = await handleGatewayWebhook({
        rawBody: signed.rawBody,
        signatureHeader: signed.signature,
        remoteIp: "127.0.0.1",
    });

    if (result.outcome !== "LATE_SETTLEMENT") {
        throw new Error(
            `Fixture error: expected LATE_SETTLEMENT, got ${result.outcome} (HTTP ${result.httpStatus})`
        );
    }

    const row = await prisma.eventOrder.findUniqueOrThrow({
        where: { id: order.orderId },
        select: {
            status: true,
            paymentStatus: true,
            paidAt: true,
            fulfilmentBlockedAt: true,
        },
    });

    if (
        row.fulfilmentBlockedAt === null ||
        row.paymentStatus !== "PAID" ||
        row.status === "PAID"
    ) {
        throw new Error(
            `Fixture error: late settlement did not block fulfilment (${JSON.stringify(row)})`
        );
    }

    return { orderNumber: order.orderNumber, orderId: order.orderId };
}

/* ==========================================
 * ISSUANCE
 * ========================================== */

/**
 * Call the issuance service as a given buyer.
 *
 * The scope is resolved fresh through `resolveAuthzScope` against the live database on
 * every call, and each call re-signs-in first, so a test can change the acting user between
 * calls (including to `null`) without leaking a previous scope.
 */
export async function issue(
    orderNumber: string,
    buyerId: string,
    request?: Request
): Promise<TicketIssuanceResult> {
    const actor = await customerScope(buyerId);

    return issueTicketsForOrder({ orderNumber, actor, request });
}

/** Every ticket row for an order, in the service's own deterministic order. */
export function ticketsFor(orderId: string) {
    return prisma.ticket.findMany({
        where: { orderId },
        orderBy: [{ orderItemId: "asc" }, { sequenceNo: "asc" }],
    });
}

/** The order's gate columns, read from the row rather than from a service's report. */
export function orderState(orderId: string) {
    return prisma.eventOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: {
            status: true,
            paymentStatus: true,
            paidAt: true,
            fulfilmentBlockedAt: true,
            total: true,
        },
    });
}

/** This phase's `ticket.issue` audit rows for one order. */
export function issuanceAuditRows(orderNumber: string) {
    return prisma.adminAuditLog.findMany({
        where: { action: "ticket.issue", entityRef: orderNumber },
        orderBy: { createdAt: "asc" },
    });
}

/* ==========================================
 * TEARDOWN
 * ========================================== */

/**
 * Remove this phase's residue, then the parent's.
 *
 * Tickets first, because they are the rows the parent teardown cannot delete: every other
 * FK on `Ticket` is `Restrict`, and an order with a surviving ticket row blocks the
 * `eventOrder.deleteMany` that the rest of the cleanup depends on. Scoped by event id, so
 * it can only ever touch fixtures created inside `eventA`/`eventB`.
 */
export async function teardownIssuanceFixtures(f: Fixtures): Promise<void> {
    await prisma.ticket.deleteMany({
        where: { eventId: { in: [f.eventA.id, f.eventB.id] } },
    });

    await teardownFixtures(f);
}
