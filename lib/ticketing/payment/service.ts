import { Prisma, type Payment, type PaymentMethod } from "@prisma/client";

import type { NextRequest } from "next/server";

import { getAppOrigin } from "@/lib/app-origin";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { requireOwnResource } from "@/lib/authz/guards";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz/permissions";
import { prisma } from "@/lib/prisma";

import { writeTicketingAudit } from "../audit-log";
import { moneyString } from "../order-payload";
import { countHeldReservations } from "../reservations";
import {
    createSession,
    isConfigured,
    resolvePaymentEnvironment,
    resolvePaymentSelection,
    type GatewaySession,
} from "./gateway";
import { buildPaymentReference, isTicketingReference } from "./reference";
import {
    DEFAULT_PAYMENT_METHOD,
    type PaymentCreateRequest,
} from "./validation";

/**
 * ==========================================
 * TICKETING PAYMENT CREATION (design §13.2, §13.4, §26.3)
 * ==========================================
 *
 * Creates or resumes the provider session for a buyer's own `EventOrder`, moving
 * `PaymentStatus.UNPAID → PENDING` exactly as design §13.4 prescribes:
 *
 *   "| `UNPAID → PENDING` | `POST /checkout` after the gateway session is created |
 *    `Payment` row (PENDING), `expiresAt` set, order `expiresAt` aligned |"
 *
 * The output is a payment URL the buyer can be sent to. It does NOT settle anything: the
 * only settlement trigger is the verified provider notification (design §31.5 rule 3:
 * "The webhook is the **only** trigger for settlement"). Nothing here can mark an order
 * paid.
 *
 * ── WHAT THE CLIENT MAY NOT INFLUENCE (brief §7 / §17) ───────────────────────────
 * Not the amount, not the currency, not the order, not the status. The amount is read
 * from the persisted `EventOrder.total` (design §13.3 step 3 compares the provider's
 * report against that same field, so the two halves agree by construction), the currency
 * from `EventOrder.currency`, and the order from an ownership-scoped lookup. The request
 * body can only choose the payment *channel* (`lib/ticketing/payment/validation.ts`).
 *
 * ── AUTHORIZATION: OWNERSHIP FIRST, THEN CAPABILITY ──────────────────────────────
 * Design §26's preamble is the rule: "All endpoints below require a session. Every one
 * applies an **ownership predicate** (`userId = session.user.id`) in addition to any
 * permission check."
 *
 * Both gates are applied, in that order, so a caller learns nothing about an order that
 * is not theirs (a foreign order is `NOT_FOUND`, never `FORBIDDEN` — brief §14).
 *
 * The capability gate uses `order.read.own` because design §6.3's permission matrix
 * contains no row for "create payment for one's own order" — the Customer column covers
 * viewing own orders (OWN), cancelling an unpaid order (OWN) and viewing the payment
 * ledger (OWN), and nothing else. Brief §18 forbids inventing a permission and forbids
 * duplicate names, and §18 also says to add one only if Phase 1 already defines it
 * conceptually. Since it does not, none is added: the own-scope capability over the
 * ORDER being paid is the closest existing authority, and it is deliberately a *real*
 * permission check rather than an extra invented string. Recorded in the report.
 *
 * ── WHY THERE IS NO `Payment` ROW AT CHECKOUT, ONLY HERE ─────────────────────────
 * Phase 6 deliberately stopped at `PENDING_PAYMENT` / `UNPAID` with `paymentUrl: null`.
 * §13.4 places the `Payment` row in the `UNPAID → PENDING` transition, i.e. "after the
 * gateway session is created" — which is this module.
 */

/** The buyer-facing view of a payment attempt. No secrets, no PII, no provider internals. */
export type PaymentPayload = {
    orderNumber: string;
    orderStatus: string;
    paymentStatus: string;
    paymentReference: string;
    /** `PaymentStatus` of the attempt itself. */
    status: string;
    amount: string;
    currency: string;
    /** Present only when a real provider session exists (brief §20). */
    paymentUrl: string | null;
    /** The provider session expiry we recorded — the server's instant, not the browser's. */
    expiresAt: string | null;
    provider: string;
    environment: string;
    method: string;
    channel: string | null;
    /** True when an existing live session was returned instead of creating a second one. */
    resumed: boolean;
};

/**
 * Provider-reported `PaymentStatus` values that mean "this attempt is still usable".
 *
 * Design §13.2: "one logical attempt per order (at most one in a non-terminal state at a
 * time)". `UNPAID` is included because a row is inserted in that state as the claim
 * described below; `PENDING` is the state once a session exists.
 */
const ACTIVE_PAYMENT_STATUSES = ["UNPAID", "PENDING"] as const;

function toPayload(params: {
    order: { orderNumber: string; status: string; paymentStatus: string };
    payment: Pick<
        Payment,
        | "paymentReference"
        | "status"
        | "amount"
        | "currency"
        | "paymentUrl"
        | "expiresAt"
        | "provider"
        | "providerEnvironment"
        | "method"
        | "channel"
    >;
    resumed: boolean;
}): PaymentPayload {
    return {
        orderNumber: params.order.orderNumber,
        orderStatus: params.order.status,
        paymentStatus: params.order.paymentStatus,
        paymentReference: params.payment.paymentReference,
        status: params.payment.status,
        amount: moneyString(params.payment.amount),
        currency: params.payment.currency,
        paymentUrl: params.payment.paymentUrl ?? null,
        expiresAt: params.payment.expiresAt?.toISOString() ?? null,
        provider: params.payment.provider,
        environment: params.payment.providerEnvironment,
        method: params.payment.method,
        channel: params.payment.channel ?? null,
        resumed: params.resumed,
    };
}

/** The order fields this module needs, all loaded through the ownership predicate. */
type PayableOrder = {
    id: string;
    orderNumber: string;
    userId: string;
    organizerId: string;
    status: string;
    paymentStatus: string;
    total: Prisma.Decimal;
    currency: string;
    expiresAt: Date | null;
    buyerName: string;
    buyerEmail: string | null;
    buyerPhone: string | null;
};

/**
 * Load the actor's own order, or 404.
 *
 * This is the same ownership predicate `lib/ticketing/orders.ts` uses for reads and
 * cancels (`where: { orderNumber, userId }`), applied through the same own-scope
 * capability. A client-supplied `userId`, `customerId`, `orderId` or `organizerId`
 * cannot influence it, because none of them are inputs (brief §13).
 */
async function requireOwnOrderForPayment(
    orderNumber: string,
    actor: AuthzScope
): Promise<PayableOrder> {
    const order = await prisma.eventOrder.findFirst({
        where: { orderNumber, userId: actor.userId },
        select: {
            id: true,
            orderNumber: true,
            userId: true,
            organizerId: true,
            status: true,
            paymentStatus: true,
            total: true,
            currency: true,
            expiresAt: true,
            buyerName: true,
            buyerEmail: true,
            buyerPhone: true,
        },
    });

    if (!order) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Pesanan tidak ditemukan.",
        });
    }

    // The second gate: the row is provably the actor's, so the own-scope capability is
    // checked against the actor's own id.
    await requireOwnResource(PERMISSIONS.ORDER_READ_OWN, actor.userId);

    return order;
}

/**
 * Everything that must be true before a provider session may be opened (brief §7).
 *
 * Ordered so the cheapest and most specific refusal comes first, and each one carries a
 * machine-readable `reason` so a UI can explain the state without parsing prose.
 *
 * `now` is passed in rather than read, so the whole gate is testable with a frozen clock
 * — which is what lets the expiry-race tests run deterministically.
 */
async function assertOrderPayable(order: PayableOrder, now: Date): Promise<void> {
    if (order.status !== "PENDING_PAYMENT") {
        // Covers PAID (already settled), CANCELLED (buyer cancelled) and EXPIRED (TTL
        // elapsed). Design §12.3: none of these may be resurrected into a payable state,
        // and restarting an expired or cancelled order is a *repayment*, which is
        // `D-09 = DECISION REQUIRED` and therefore deliberately not implemented here.
        throw new AppError(ERROR_CODES.ORDER_NOT_PAYABLE, {
            message: "Pesanan ini tidak dapat dibayar.",
            details: {
                status: order.status,
                reason:
                    order.status === "PAID"
                        ? "ALREADY_PAID"
                        : order.status === "CANCELLED"
                          ? "ORDER_CANCELLED"
                          : "ORDER_EXPIRED",
                /** Points at the open decision rather than implying a missing feature. */
                decision:
                    order.status === "PAID" ? null : "D-09_REPAYMENT_PRICING",
            },
        });
    }

    if (order.paymentStatus === "PAID") {
        throw new AppError(ERROR_CODES.ORDER_NOT_PAYABLE, {
            message: "Pesanan ini sudah dibayar.",
            details: { paymentStatus: order.paymentStatus, reason: "ALREADY_PAID" },
        });
    }

    // ── The window, enforced on the SERVER's clock (brief §7 item 4) ─────────────
    // This check is load-bearing in a way the design could not have assumed: design
    // §11.4's reaper (the job that is supposed to expire an order when its TTL elapses)
    // is delivered by a different phase and has no runner yet, so an order can still be
    // PENDING_PAYMENT after `expiresAt`. Refusing on the stored instant means the gateway
    // is never asked to open a session for an order the platform already considers
    // expired — which is the customer-money hazard D-16 exists to prevent, closed here
    // independently of whether the provider's own window agrees.
    if (order.expiresAt !== null && order.expiresAt.getTime() <= now.getTime()) {
        throw new AppError(ERROR_CODES.ORDER_NOT_PAYABLE, {
            message: "Waktu pembayaran pesanan ini sudah habis.",
            details: {
                expiresAt: order.expiresAt.toISOString(),
                reason: "PAYMENT_WINDOW_ELAPSED",
            },
        });
    }

    // ── Reservations must still be held (brief §7 item 5) ────────────────────────
    // Settlement converts `HELD` rows into sales. Paying an order whose holds are gone
    // would take money for seats that are no longer reserved, and the settlement would
    // then find nothing to convert. Refused before the gateway is contacted.
    const held = await prisma.$transaction((tx) =>
        countHeldReservations(tx, order.id)
    );

    if (held === 0) {
        throw new AppError(ERROR_CODES.ORDER_NOT_PAYABLE, {
            message: "Kursi untuk pesanan ini sudah tidak tersedia.",
            details: { reason: "RESERVATIONS_NOT_HELD" },
        });
    }

    // ── Free tickets are a business decision, not a code path (D-26) ─────────────
    // Design §39.1 #? / the register: `D-26 | Free (zero-price) ticket types | support
    // via a FREE payment path / forbid in MVP | Phase 6 | Support, but every issuance
    // path must remain the single transactional one`.
    //
    // Phase 6 recorded D-26 as still open and shipped the honest half: a zero-price type
    // is purchasable and yields a `0.00` order in `PENDING_PAYMENT`, with **no** FREE
    // settlement path invented. Phase 7 must not invent one either, and it also must not
    // send a zero amount to the gateway (`createRedirectPayment` refuses `amount <= 0`,
    // and a real gateway would reject it anyway). So the case is isolated with a
    // machine-readable decision pointer instead of a guess.
    if (order.total.isZero()) {
        throw new AppError(ERROR_CODES.CONFLICT, {
            message:
                "Pesanan ini bernilai nol. Jalur penyelesaian tiket gratis belum diputuskan.",
            details: {
                reason: "ZERO_AMOUNT_ORDER",
                decision: "D-26_FREE_TICKET_SETTLEMENT_PATH",
            },
        });
    }
}

/**
 * The live session for this order, if one exists (design §30.1 row 2).
 *
 * "`Payment.(orderId)` where `status IN (PENDING, UNPAID)` ... Returns the existing
 * `paymentUrl` rather than creating a second session."
 *
 * A row WITHOUT a `paymentUrl` is deliberately not "live": it is either a claim whose
 * provider call is still in flight, or one whose process died between the claim and the
 * response. Neither can be resumed, and neither blocks a fresh attempt, because attempt
 * numbering never re-uses a reference. That is what keeps this correct without a
 * staleness heuristic or a scheduled cleaner.
 */
async function findLivePayment(orderId: string) {
    return prisma.payment.findFirst({
        where: {
            orderId,
            status: { in: [...ACTIVE_PAYMENT_STATUSES] },
            paymentUrl: { not: null },
        },
        orderBy: { createdAt: "desc" },
    });
}

export async function createOrderPayment(params: {
    orderNumber: string;
    actor: AuthzScope;
    request: PaymentCreateRequest;
    /**
     * The live request. Required, not optional: the provider's `notifyUrl`/`returnUrl`
     * must be built by `lib/app-origin.ts#getAppOrigin`, which validates the host against
     * an allowlist (a spoofed `x-forwarded-host` would otherwise redirect a payer, and the
     * provider's callback, to an attacker's domain). Without a request there is no safe
     * origin, so the attempt is refused rather than built from an unchecked header.
     */
    httpRequest: NextRequest;
    now?: Date;
}): Promise<PaymentPayload> {
    const now = params.now ?? new Date();
    const { actor, orderNumber } = params;

    // A reference that is not ours is refused before the gateway is considered. Design
    // §35.7: the two order models must not cross-settle. Ticket order numbers are
    // generated as `EVT-…` by `lib/ticketing/checkout.ts`.
    if (!isTicketingReference(orderNumber)) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Pesanan tidak ditemukan.",
        });
    }

    const order = await requireOwnOrderForPayment(orderNumber, actor);

    await assertOrderPayable(order, now);

    // ── Resume before creating (design §30.1 row 2 / §26.3) ──────────────────────
    const live = await findLivePayment(order.id);

    if (live) {
        return toPayload({ order, payment: live, resumed: true });
    }

    if (!isConfigured()) {
        // Fail closed with the registered 503 rather than a 500, and without writing a
        // payment row that could never carry a session (design §25.1).
        throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, {
            message: "Layanan pembayaran sedang tidak tersedia.",
            details: { reason: "PAYMENT_PROVIDER_NOT_CONFIGURED" },
        });
    }

    // Resolved BEFORE the claim row is written: an origin that fails the allowlist means
    // we cannot advertise a callback the provider is allowed to reach, so no attempt
    // should be recorded at all (the live retail route refuses in the same situation).
    const origin = getAppOrigin(params.httpRequest);

    if (!origin || !/^https?:\/\//.test(origin)) {
        throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, {
            message: "Alamat aplikasi belum dikonfigurasi dengan benar.",
            details: { reason: "APP_ORIGIN_UNRESOLVED" },
        });
    }

    const requestedMethod = (params.request.method ??
        DEFAULT_PAYMENT_METHOD) as PaymentMethod;
    const selection = resolvePaymentSelection(
        requestedMethod,
        params.request.channel ?? null
    );
    const environment = await resolvePaymentEnvironment();

    // The TTL is the platform's configured window — the same number that produced
    // `EventOrder.expiresAt` at checkout, and the same number handed to the provider. See
    // `gatewaySessionExpiryValue` for the D-16 reasoning.
    const ttlMinutes = await resolveTtlMinutes();
    const expiresAt = order.expiresAt;

    const attemptNumber = (await prisma.payment.count({ where: { orderId: order.id } })) + 1;
    const paymentReference = buildPaymentReference(orderNumber, attemptNumber);

    // ── The claim (design §30.1 row 2 / §30.3) ───────────────────────────────────
    // The row is inserted BEFORE the network call, in `UNPAID` with no session, because
    // this INSERT is the concurrency guard: `paymentReference` is `@unique`, so two
    // simultaneous "Pay" clicks compute the same attempt number, and the loser's insert
    // is rejected by the database — §30.3's "the database rejecting the second write ...
    // the only correct approach under concurrency". A gateway session is therefore opened
    // at most once per attempt.
    let payment: Payment;

    try {
        payment = await prisma.payment.create({
            data: {
                orderId: order.id,
                // The tenant the money belongs to, taken from the ORDER, never from the
                // request (brief §13: `organizerId` is DATA, never authority).
                organizerId: order.organizerId,
                provider: "ipaymu",
                providerEnvironment: environment,
                method: selection.method,
                channel: selection.channel,
                amount: order.total,
                currency: order.currency,
                // `PaymentStatus.UNPAID` — the schema default, stated explicitly because
                // this row is a claim that has not yet produced a session.
                status: "UNPAID",
                paymentReference,
                expiresAt,
                createdByUserId: actor.userId,
            },
        });
    } catch (error) {
        if (!isUniqueViolation(error)) {
            throw error;
        }

        // Lost the claim race. If the winner already recorded a session, resume it;
        // otherwise the winner is still mid-flight and there is nothing to hand back yet.
        const winner = await findLivePayment(order.id);

        if (winner) {
            return toPayload({ order, payment: winner, resumed: true });
        }

        throw new AppError(ERROR_CODES.CONFLICT, {
            message: "Pembayaran untuk pesanan ini sedang dibuat. Coba lagi sebentar lagi.",
            details: { reason: "PAYMENT_CREATION_IN_PROGRESS" },
        });
    }

    // ── The provider call, OUTSIDE any transaction (design §13.3) ────────────────
    // "External calls are banned inside it" — a slow provider must never hold row locks,
    // and a rolled-back transaction must never have already moved money.
    const returnUrl = `${origin}/ticketing/orders/${encodeURIComponent(orderNumber)}`;

    const created = await createSession({
        referenceId: paymentReference,
        amount: order.total,
        currency: order.currency,
        buyerName: order.buyerName,
        buyerEmail: order.buyerEmail ?? "",
        buyerPhone: order.buyerPhone ?? "",
        items: await loadGatewayLineItems(order.id),
        notifyUrl: `${origin}/api/ticketing/payment/webhook`,
        returnUrl,
        cancelUrl: returnUrl,
        method: selection.method,
        channel: selection.channel,
        ttlMinutes,
    });

    if (!created.ok) {
        // The attempt is recorded as failed so the state is coherent, and the buyer gets
        // the registered 503. A later retry creates a NEW attempt (a new reference), which
        // §26.3 allows for an order that is still `PENDING_PAYMENT`; it is not `D-09`
        // repayment, because no money ever moved and the order never left this state.
        await prisma.payment.updateMany({
            where: { id: payment.id, paymentUrl: null },
            data: {
                status: "FAILED",
                channel: selection.channel,
            },
        });

        throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, {
            message: "Gagal membuat sesi pembayaran. Silakan coba lagi.",
            details: { reason: created.reason },
        });
    }

    const settled = await recordSession(payment.id, created.session);

    // §13.4 `UNPAID → PENDING`. Guarded on the order still being payable, so a session
    // created in the instant an order was cancelled cannot leave the order mislabelled.
    await prisma.eventOrder.updateMany({
        where: { id: order.id, status: "PENDING_PAYMENT" },
        data: { paymentStatus: "PENDING" },
    });

    // The response is built from the COMMITTED order, not from the snapshot read before the
    // gateway call. Those differ by exactly the `UNPAID → PENDING` transition above, and a
    // caller that trusted the stale snapshot would be told the order it just opened a
    // session for still has no payment in flight. Re-reading also means the response stays
    // truthful when the guarded update above did NOT match — the order was cancelled
    // concurrently, so `status` is reported as it really is rather than as intended.
    const currentOrder = await prisma.eventOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: { orderNumber: true, status: true, paymentStatus: true },
    });

    await writeTicketingAudit({
        action: "payment.create",
        actor,
        actorOrganizerId: null,
        organizerId: order.organizerId,
        entityType: "Payment",
        entityRef: settled.paymentReference,
        description: "Sesi pembayaran tiket dibuat.",
        // No buyer name/email/phone (brief §23/§27): the order row already holds the
        // contact snapshot, and the ledger does not need PII to be reconcilable.
        afterState: {
            orderNumber: order.orderNumber,
            paymentReference: settled.paymentReference,
            provider: settled.provider,
            environment: settled.providerEnvironment,
            method: settled.method,
            channel: settled.channel,
            amount: moneyString(settled.amount),
            currency: settled.currency,
            status: settled.status,
            expiresAt: settled.expiresAt?.toISOString() ?? null,
        },
        request: params.httpRequest,
    });


    return toPayload({ order: currentOrder, payment: settled, resumed: false });
}

/**
 * Write the provider's session onto the claimed row.
 *
 * Guarded by `paymentUrl: null` so a concurrent second write can never overwrite a URL
 * that is already live — the same conditional-update discipline the rest of the ticketing
 * code uses. If the guard loses (it effectively cannot, because only the claim winner
 * reaches here), the existing row is returned unchanged rather than fought over.
 */
async function recordSession(
    paymentId: string,
    session: GatewaySession
): Promise<Payment> {
    const updated = await prisma.payment.updateMany({
        where: { id: paymentId, paymentUrl: null },
        data: {
            status: "PENDING",
            paymentUrl: session.paymentUrl,
            externalSessionId: session.providerSessionId,
            method: session.method,
            channel: session.channel,
            providerEnvironment: session.environment,
        },
    });

    const row = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
    });

    if (updated.count === 0 && row.paymentUrl === null) {
        // Defensive: the guard failed but no URL is stored, which would leave the buyer
        // with a session they cannot reach. Surfaced rather than swallowed.
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
            message: "Gagal menyimpan sesi pembayaran.",
        });
    }

    return row;
}

/**
 * The order lines, in the gateway's parallel-array shape.
 *
 * Prices are the persisted `priceSnapshot` decimal strings (design §12.1/§16), NOT
 * `TicketType.price`: a later price edit must not change what this attempt asks for.
 */
async function loadGatewayLineItems(
    orderId: string
): Promise<{ name: string; quantity: number; unitPrice: string }[]> {
    const items = await prisma.eventOrderItem.findMany({
        where: { orderId },
        select: {
            nameSnapshot: true,
            quantity: true,
            priceSnapshot: true,
        },
        orderBy: { createdAt: "asc" },
    });

    return items.map((item) => ({
        name: item.nameSnapshot,
        quantity: item.quantity,
        unitPrice: moneyString(item.priceSnapshot),
    }));
}

/** `PlatformSetting.reservationTtlMinutes`, via the same resolver the checkout uses. */
async function resolveTtlMinutes(): Promise<number> {
    const { resolveReservationTtlMinutes } = await import("../reservations");

    return resolveReservationTtlMinutes();
}

function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2002"
    );
}
