import {
    Prisma,
    type Payment,
    type PaymentEnvironment,
    type PaymentMethod,
} from "@prisma/client";

import type { NextRequest } from "next/server";

import { getAppOrigin } from "@/lib/app-origin";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { requireOwnResource } from "@/lib/authz/guards";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz/permissions";
import { prisma } from "@/lib/prisma";
import { publishPaymentCreated, publishPaymentUpdated } from "@/lib/realtime/publishers";

import { writeTicketingAudit } from "../audit-log";
import {
    withContentionRetry,
    type ContentionRetryResult,
} from "../db-contention";
import { lockEventOrderRow } from "../order-lock";
import { moneyString } from "../order-payload";
import { countHeldReservations } from "../reservations";
import {
    channelIsAllowed,
    createDirectSession,
    createSession,
    findPaymentMethodOption,
    isConfigured,
    resolvePaymentEnvironment,
    type GatewayInstruction,
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

    /**
     * ── THE PAYMENT INSTRUCTION ─────────────────────────────────────────────────
     * `DIRECT` means the buyer settles here, using the fields below; `REDIRECT` means the
     * provider's hosted page owns it and `paymentUrl` is the door.
     *
     * None of these values is generated by this application. `qrImageUrl` is the provider's
     * own image URL, `paymentNumber` is the number the gateway issued, and `providerExpiredAt`
     * is the instant the gateway stated. A `null` in any of them means the provider did not
     * return it — the page must say so rather than draw a placeholder code.
     *
     * The raw `QrString` payload is deliberately NOT exposed here: it is the literal content
     * of the customer's payment request and must not reach the browser. The order page renders
     * a QR image from it on the server instead.
     *
     * These are exposed only for the caller's OWN order (the ownership predicate runs
     * before this payload is built), so one buyer's VA/QR can never be read from another's
     * response (brief §22 / §29).
     */
    flow: "DIRECT" | "REDIRECT" | null;
    paymentNumber: string | null;
    qrImageUrl: string | null;
    paymentName: string | null;
    providerExpiredAt: string | null;
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
        | "providerFlow"
        | "paymentNumber"
        | "qrImageUrl"
        | "paymentName"
        | "providerExpiredAt"
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
        flow:
            params.payment.providerFlow === "DIRECT" ||
            params.payment.providerFlow === "REDIRECT"
                ? params.payment.providerFlow
                : null,
        // QR/VA details are returned ONLY for a live instruction. Once the attempt is no
        // longer payable (paid, failed, expired) the buyer has no use for them, and a
        // stale QR rendered after settlement is a support call waiting to happen.
        paymentNumber: isLive(params.payment.status)
            ? (params.payment.paymentNumber ?? null)
            : null,
        qrImageUrl: isLive(params.payment.status)
            ? (params.payment.qrImageUrl ?? null)
            : null,
        paymentName: isLive(params.payment.status)
            ? (params.payment.paymentName ?? null)
            : null,
        providerExpiredAt:
            isLive(params.payment.status) && params.payment.providerExpiredAt
                ? params.payment.providerExpiredAt.toISOString()
                : null,
    };
}

/** Is this attempt still payable, i.e. is its instruction worth showing? */
function isLive(status: string): boolean {
    return (ACTIVE_PAYMENT_STATUSES as readonly string[]).includes(status);
}

/**
 * Does this attempt carry something the buyer can actually pay with?
 *
 * ── WHY THIS IS NOT THE "IS THERE AN ATTEMPT?" TEST (BUG-01 / BUG-02) ────────────
 * ACTIVITY is decided by `status` alone (`UNPAID`/`PENDING`). This predicate only
 * distinguishes a session that is USABLE from one whose provider call is still IN FLIGHT,
 * which is the difference between "resume this" and "PAYMENT_CREATION_IN_PROGRESS".
 * Using it to decide whether an attempt EXISTS was the original defect: a committed claim
 * row with no instrument yet looked like "no attempt", so a second one was created.
 */
function hasProviderInstrument(payment: {
    paymentUrl: string | null;
    qrString: string | null;
    paymentNumber: string | null;
}): boolean {
    return (
        payment.paymentUrl !== null ||
        payment.qrString !== null ||
        payment.paymentNumber !== null
    );
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
 * The status / already-paid / expiry half of the payable gate.
 *
 * Extracted so the SAME three checks run twice: once against the pre-read snapshot (a fast,
 * specific refusal before any write) and once against the order row read INSIDE the locked
 * claim transaction. The second run is what makes the claim correct under concurrency — a
 * settlement or cancellation that won the order row between the two reads is caught.
 */
function assertOrderStatePayable(
    state: { status: string; paymentStatus: string; expiresAt: Date | null },
    now: Date
): void {
    if (state.status !== "PENDING_PAYMENT") {
        // Covers PAID (already settled), CANCELLED (buyer cancelled) and EXPIRED (TTL
        // elapsed). Design §12.3: none of these may be resurrected into a payable state,
        // and restarting an expired or cancelled order is a *repayment*, which is
        // `D-09 = DECISION REQUIRED` and therefore deliberately not implemented here.
        throw new AppError(ERROR_CODES.ORDER_NOT_PAYABLE, {
            message: "Pesanan ini tidak dapat dibayar.",
            details: {
                status: state.status,
                reason:
                    state.status === "PAID"
                        ? "ALREADY_PAID"
                        : state.status === "CANCELLED"
                          ? "ORDER_CANCELLED"
                          : "ORDER_EXPIRED",
                /** Points at the open decision rather than implying a missing feature. */
                decision:
                    state.status === "PAID" ? null : "D-09_REPAYMENT_PRICING",
            },
        });
    }

    if (state.paymentStatus === "PAID") {
        throw new AppError(ERROR_CODES.ORDER_NOT_PAYABLE, {
            message: "Pesanan ini sudah dibayar.",
            details: { paymentStatus: state.paymentStatus, reason: "ALREADY_PAID" },
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
    if (state.expiresAt !== null && state.expiresAt.getTime() <= now.getTime()) {
        throw new AppError(ERROR_CODES.ORDER_NOT_PAYABLE, {
            message: "Waktu pembayaran pesanan ini sudah habis.",
            details: {
                expiresAt: state.expiresAt.toISOString(),
                reason: "PAYMENT_WINDOW_ELAPSED",
            },
        });
    }
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
    assertOrderStatePayable(order, now);

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
 * ── LIVE IS NOT THE SAME AS ACTIVE (BUG-01 / BUG-02) ─────────────────────────────
 * "ACTIVE" is a STATUS question (`UNPAID`/`PENDING`) and is what the transactional claim
 * below decides. "LIVE" additionally requires a payable instrument: an ACTIVE row with no
 * URL, QR payload or payment number is an attempt whose provider call is IN FLIGHT (or one
 * whose process died between the claim and the response). It is therefore surfaced as
 * `PAYMENT_CREATION_IN_PROGRESS` — never dismissed as "no attempt exists", which is the
 * hole that used to let a second attempt be created.
 */
async function findLivePayment(orderId: string) {
    return prisma.payment.findFirst({
        where: {
            orderId,
            status: { in: [...ACTIVE_PAYMENT_STATUSES] },
            // A session is live when the buyer has something they can actually pay with.
            // For a REDIRECT session that is the hosted URL; for a DIRECT instruction it is
            // the QR payload or the account/payment number. Both are checked because a
            // direct payment has NO `paymentUrl` at all — treating the URL as the only
            // marker of liveness would have let a second click mint a second QR/VA for an
            // order that already had a perfectly payable one.
            OR: [
                { paymentUrl: { not: null } },
                { qrString: { not: null } },
                { paymentNumber: { not: null } },
            ],
        },
        orderBy: { createdAt: "desc" },
    });
}

/** What the serialized claim decided, and the attempt it decided about. */
type PaymentClaim = {
    kind: "created" | "live" | "in_progress";
    payment: Payment;
};

/**
 * The ONE refusal a concurrent/contended claim produces: "someone is creating this order's
 * payment; try again shortly". Centralised so the direct `in_progress` branch and the
 * contention-exhaustion branch cannot drift apart.
 */
function paymentCreationInProgress(): AppError {
    return new AppError(ERROR_CODES.CONFLICT, {
        message: "Pembayaran untuk pesanan ini sedang dibuat. Coba lagi sebentar lagi.",
        details: { reason: "PAYMENT_CREATION_IN_PROGRESS" },
    });
}

/**
 * Atomically claim the ONE active payment attempt for an order (BUG-01 / BUG-02).
 *
 * ── WHY THIS IS A SERIALIZED CLAIM, NOT A CHECK ────────────────────────────────
 * The pre-fix code read `Payment.count()` (or a liveness query) and then created, which is
 * §30.3's time-of-check/time-of-use race: a second caller that read AFTER the winner's
 * insert committed computed attempt number `n + 1`, produced a DIFFERENT
 * `paymentReference`, and therefore did not collide with the unique index at all — it
 * opened a second payable provider session for the same order.
 *
 * The fix has two halves, and both are database-side:
 *
 *   1. **One row lock, named explicitly.** `SELECT … FOR UPDATE` on the `eventorder` row
 *      serializes every claim for that order, exactly as the cancel, settlement and reaper
 *      paths already serialize on it (brief §16/§17 — same lock ORDER, so no deadlock).
 *      Only the lock holder may read the active attempt and create a new one.
 *   2. **A durable unique index** on `Payment.activeOrderId`, which is set to the order id
 *      while the attempt is non-terminal and NULL once it is terminal. That is the
 *      structural invariant: two active attempts for one order cannot exist, whatever code
 *      path tries to create them.
 *
 * ── WHAT "ACTIVE" MEANS HERE (spec §3 / §5) ────────────────────────────────────
 * A committed `UNPAID`/`PENDING` row with NO instrument is ACTIVE and is reported as
 * `in_progress`. It is deliberately NOT treated as "safe to create another payment".
 * Terminal rows (`PAID`/`FAILED`/`EXPIRED`/`REFUNDED`/`PARTIALLY_REFUNDED`) are history and
 * never block a new attempt.
 */
async function claimActivePayment(params: {
    order: PayableOrder;
    orderNumber: string;
    now: Date;
    environment: PaymentEnvironment;
    method: PaymentMethod;
    channel: string;
    expiresAt: Date | null;
    actorUserId: string;
}): Promise<PaymentClaim> {
    // Re-run the whole claim on a TRANSIENT InnoDB serialization failure (`P2034`, a
    // deadlock or a lock-wait timeout) — the same bounded, jittered retry the settlement
    // path uses. Every attempt re-evaluates the guards against the post-rollback state, so
    // a retry can only ever observe the active attempt and answer `in_progress`; it can
    // never create a second one.
    let result: ContentionRetryResult<PaymentClaim>;

    try {
        result = await withContentionRetry(async () =>
            prisma.$transaction(
                async (tx): Promise<PaymentClaim> => {
                    // 1. THE SERIALIZATION POINT. Every claim for this order queues here, and
                    //    the lock is ordered before the payment rows (both are written after
                    //    the order row), matching the cancel/settlement/reaper lock order.
                    //    The raw statement lives in a named primitive so the payment layer
                    //    stays free of raw SQL (enforced by the payment-wiring guard).
                    await lockEventOrderRow(tx, params.order.id);

                    // 2. RE-VALIDATE against the now-locked row. A settlement or a cancel
                    //    may have won the order between the pre-read snapshot and this lock;
                    //    the snapshot's verdict is no longer authoritative.
                    const locked = await tx.eventOrder.findUniqueOrThrow({
                        where: { id: params.order.id },
                        select: {
                            status: true,
                            paymentStatus: true,
                            expiresAt: true,
                        },
                    });

                    assertOrderStatePayable(locked, params.now);

                    // 3. SELF-HEAL. A terminal attempt must never hold the active slot.
                    //    Every terminal writer clears it too, but a stale pointer must not be
                    //    able to wedge a legitimate retry.
                    await tx.payment.updateMany({
                        where: {
                            orderId: params.order.id,
                            activeOrderId: { not: null },
                            status: { notIn: [...ACTIVE_PAYMENT_STATUSES] },
                        },
                        data: { activeOrderId: null },
                    });

                    // 4. THE ONE ACTIVE ATTEMPT — decided by STATUS alone, never by whether
                    //    an instrument has landed yet.
                    const active = await tx.payment.findFirst({
                        where: {
                            orderId: params.order.id,
                            status: { in: [...ACTIVE_PAYMENT_STATUSES] },
                        },
                        orderBy: { createdAt: "desc" },
                    });

                    if (active) {
                        return {
                            kind: hasProviderInstrument(active)
                                ? "live"
                                : "in_progress",
                            payment: active,
                        };
                    }

                    // 5. CLAIM. Only the lock holder reaches this point, so the attempt
                    //    number is computed against a stable set of rows and cannot race.
                    const attemptNumber =
                        (await tx.payment.count({
                            where: { orderId: params.order.id },
                        })) + 1;
                    const paymentReference = buildPaymentReference(
                        params.orderNumber,
                        attemptNumber
                    );

                    const payment = await tx.payment.create({
                        data: {
                            orderId: params.order.id,
                            // The tenant the money belongs to, taken from the ORDER, never
                            // from the request (brief §13: `organizerId` is DATA, never
                            // authority).
                            organizerId: params.order.organizerId,
                            provider: "ipaymu",
                            providerEnvironment: params.environment,
                            method: params.method,
                            channel: params.channel,
                            amount: params.order.total,
                            currency: params.order.currency,
                            // `PaymentStatus.UNPAID` — the schema default, stated explicitly
                            // because this row is a claim that has not yet produced a
                            // session.
                            status: "UNPAID",
                            paymentReference,
                            expiresAt: params.expiresAt,
                            createdByUserId: params.actorUserId,
                            // The durable invariant: this order now has exactly one active
                            // attempt, and the database will reject a second.
                            activeOrderId: params.order.id,
                        },
                    });

                    return { kind: "created", payment };
                },
                { timeout: 20_000 }
            )
        );
    } catch (error) {
        if (!isUniqueViolation(error)) {
            throw error;
        }

        // The unique `activeOrderId` index rejected a second active attempt. That should be
        // unreachable behind the row lock; if it happens, a concurrent claim won, so report
        // it as in-progress rather than as a 500. Re-read outside the (aborted) transaction.
        const winner = await prisma.payment.findFirst({
            where: {
                orderId: params.order.id,
                status: { in: [...ACTIVE_PAYMENT_STATUSES] },
            },
            orderBy: { createdAt: "desc" },
        });

        if (!winner) {
            throw error;
        }

        return {
            kind: hasProviderInstrument(winner) ? "live" : "in_progress",
            payment: winner,
        };
    }

    if (!result.ok) {
        // Contention exhausted: another claim is racing this one, so the buyer receives the
        // same retryable conflict they would receive if that request already owned creation.
        throw paymentCreationInProgress();
    }

    return result.value;
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
    // should be recorded at all (the retired retail route refused in the same situation).
    const origin = getAppOrigin(params.httpRequest);

    if (!origin || !/^https?:\/\//.test(origin)) {
        throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, {
            message: "Alamat aplikasi belum dikonfigurasi dengan benar.",
            details: { reason: "APP_ORIGIN_UNRESOLVED" },
        });
    }

    // ── Which method, and therefore which provider flow ───────────────────────────
    // The catalog in `gateway.ts` is the single source of what may be offered, and it is
    // derived from the provider's own published method/channel list. A method outside it
    // is REFUSED rather than defaulted: silently downgrading an unmodelled request to a
    // bank transfer would open a payment the buyer never asked for.
    const requestedMethod = (params.request.method ??
        DEFAULT_PAYMENT_METHOD) as PaymentMethod;
    const option = findPaymentMethodOption(requestedMethod);

    if (!option) {
        throw AppError.validation("Metode pembayaran tidak didukung.", {
            fields: [{ path: "method", message: "Tidak didukung." }],
        });
    }

    const requestedChannel = params.request.channel ?? null;

    // A channel the chosen method does not have is refused for the same reason: the buyer
    // picked BNI or nothing, and must never receive a different bank's number.
    if (
        requestedChannel !== null &&
        !channelIsAllowed(requestedMethod, requestedChannel)
    ) {
        throw AppError.validation("Channel pembayaran tidak sesuai metode.", {
            fields: [{ path: "channel", message: "Tidak sesuai metode." }],
        });
    }

    const selection = {
        method: requestedMethod,
        // `null` means "the method's default", resolved by whichever session call runs.
        channel: requestedChannel ?? option.defaultChannel ?? "",
    } as { method: PaymentMethod; channel: string };

    const environment = await resolvePaymentEnvironment();

    // The TTL is the platform's configured window — the same number that produced
    // `EventOrder.expiresAt` at checkout, and the same number handed to the provider. See
    // `gatewaySessionExpiryValue` for the D-16 reasoning.
    const ttlMinutes = await resolveTtlMinutes();
    const expiresAt = order.expiresAt;

    // ── THE CLAIM (BUG-01 / BUG-02): at most ONE active attempt per order ─────────
    // The resume-or-claim decision is serialized on the ORDER ROW, in one transaction, and
    // ACTIVITY is decided by STATUS alone. Three outcomes are possible:
    //
    //   created      → this caller owns provider creation;
    //   live         → an existing attempt already carries an instrument, so resume it;
    //   in_progress  → an existing attempt is committed but has no instrument yet, so
    //                  another request owns provider creation and this one must not open a
    //                  second session.
    const claim = await claimActivePayment({
        order,
        orderNumber,
        now,
        environment,
        method: selection.method,
        channel: selection.channel,
        expiresAt,
        actorUserId: actor.userId,
    });

    if (claim.kind === "in_progress") {
        throw paymentCreationInProgress();
    }

    if (claim.kind === "live") {
        // Built from the COMMITTED order, so a claim that resumed an already-recorded
        // session reports the order's real payment status rather than the pre-claim read.
        const currentOrder = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.id },
            select: { orderNumber: true, status: true, paymentStatus: true },
        });

        return toPayload({ order: currentOrder, payment: claim.payment, resumed: true });
    }

    const payment: Payment = claim.payment;

    // ── The provider call, OUTSIDE any transaction (design §13.3) ────────────────
    // "External calls are banned inside it" — a slow provider must never hold row locks,
    // and a rolled-back transaction must never have already moved money.
    const returnUrl = `${origin}/ticketing/orders/${encodeURIComponent(orderNumber)}`;
    const notifyUrl = `${origin}/api/ticketing/payment/webhook`;
    const buyerName = order.buyerName;
    const buyerEmail = order.buyerEmail ?? "";
    const buyerPhone = order.buyerPhone ?? "";

    /**
     * Record a provider failure on the claim row and answer 503.
     *
     * The attempt is marked FAILED so the state stays coherent, and the order is NOT
     * advanced — no instruction and no session exists, so there is nothing to pay. A later
     * retry creates a NEW attempt (a new reference), which §26.3 allows for an order that
     * is still `PENDING_PAYMENT`; it is not `D-09` repayment, because no money ever moved
     * and the order never left this state.
     */
    async function failAttempt(reason: string): Promise<never> {
        await prisma.payment.updateMany({
            where: { id: payment.id, paymentUrl: null },
            data: {
                status: "FAILED",
                channel: selection.channel,
                // Release the active slot so an abandoned attempt can never wedge the
                // buyer's legitimate retry (BUG-01 / BUG-02, spec §8).
                activeOrderId: null,
            },
        });

        /*
         * REALTIME: the attempt row is committed as FAILED, so the payments list has something new
         * to show. This is the one flow that matches PAYMENT_UPDATED — payment state moved WITHOUT
         * money settling (no money ever moved here: no session was ever recorded, so the order was
         * not advanced). The publish therefore precedes the throw deliberately: the write is
         * committed, and a caller-facing 503 does not un-commit it.
         */
        publishPaymentUpdated({
            paymentId: payment.id,
            orderId: order.id,
            organizerId: order.organizerId,
            buyerUserId: order.userId,
        });

        throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, {
            message: "Gagal membuat sesi pembayaran. Silakan coba lagi.",
            details: { reason },
        });
    }

    if (option.flow === "DIRECT") {
        // ── The in-app instruction (QRIS / Virtual Account / retail outlet) ───────
        // The buyer pays without leaving the platform, so the platform must hold the real
        // instrument: the gateway's QR payload and image, or the number it issued. Nothing
        // here derives, formats or invents those values — an empty instruction is a failed
        // attempt, answered as such, because a rendered placeholder QR would be a fake.
        const created = await createDirectSession({
            referenceId: payment.paymentReference,
            amount: order.total,
            buyerName,
            buyerEmail,
            buyerPhone,
            notifyUrl,
            method: selection.method,
            channel: selection.channel,
            ttlMinutes,
        });

        if (!created.ok) {
            return failAttempt(created.reason);
        }

        const instruction = created.instruction;

        // A success with neither a QR payload nor a number is not payable. Only one of the
        // two is required (a VA has a number and no QR; a QRIS code has both), but having
        // NEITHER means the provider returned an instruction shape we cannot present, and
        // storing it would leave the buyer on an empty payment page.
        if (!instruction.qrString && !instruction.paymentNumber) {
            return failAttempt("INSTRUCTION_MISSING");
        }

        const settled = await recordInstruction(payment.id, instruction);

        // §13.4 `UNPAID → PENDING`, guarded exactly as in the redirect path.
        await prisma.eventOrder.updateMany({
            where: { id: order.id, status: "PENDING_PAYMENT" },
            data: { paymentStatus: "PENDING" },
        });

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
            description: "Instruksi pembayaran tiket dibuat.",
            // The QR payload and the account number are NOT logged: one is a bearer
            // instrument and the other is a payment credential (design §32.3's "never log"
            // list, and `FORBIDDEN_METADATA_KEYS` would strip them anyway). What is recorded
            // is that an instruction was issued, for which method, and until when.
            afterState: {
                orderNumber: order.orderNumber,
                paymentReference: settled.paymentReference,
                provider: settled.provider,
                environment: settled.providerEnvironment,
                flow: "DIRECT",
                method: settled.method,
                channel: settled.channel,
                amount: moneyString(settled.amount),
                currency: settled.currency,
                status: settled.status,
                hasQr: Boolean(settled.qrString),
                hasNumber: Boolean(settled.paymentNumber),
                expiresAt: settled.expiresAt?.toISOString() ?? null,
                providerExpiredAt:
                    settled.providerExpiredAt?.toISOString() ?? null,
            },
            request: params.httpRequest,
        });

        return toPayload({ order: currentOrder, payment: settled, resumed: false });
    }

    // ── The hosted page (credit card today) ─────────────────────────────────────
    const created = await createSession({
        referenceId: payment.paymentReference,
        amount: order.total,
        currency: order.currency,
        buyerName: order.buyerName,
        buyerEmail: order.buyerEmail ?? "",
        buyerPhone: order.buyerPhone ?? "",
        items: await loadGatewayLineItems(order.id),
        notifyUrl,
        returnUrl,
        cancelUrl: returnUrl,
        method: selection.method,
        channel: selection.channel,
        ttlMinutes,
    });

    if (!created.ok) {
        return failAttempt(created.reason);
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

    /*
     * REALTIME: the session is committed and the order's `UNPAID → PENDING` transition is committed
     * with it, so both the payments list and the order list have something new to show.
     *
     * Emitted only on the CREATING path. The resume path above returns a session that already
     * existed, and announcing it would send every open tab to re-read data that has not changed.
     */
    publishPaymentCreated({
        paymentId: settled.id,
        orderId: order.id,
        organizerId: order.organizerId,
        buyerUserId: order.userId,
    });

    return toPayload({ order: currentOrder, payment: settled, resumed: false });
}

/**
 * A conditional write to ONE `Payment` row, retried on transient InnoDB contention.
 *
 * The provider call runs OUTSIDE any transaction (design §13.3), so the statement that
 * records its result is its own write — and under a burst of concurrent "Pay" clicks it can
 * be chosen as a deadlock victim (`P2034`). The write is guarded (`paymentUrl: null`), so
 * re-running it is idempotent and can only lose to a writer that stored the same session
 * first. Contention exhaustion is surfaced as a retryable provider-unavailable refusal, not
 * as a 500: nothing is corrupted and the buyer can simply try again.
 */
async function writePaymentRow(
    where: Prisma.PaymentWhereInput,
    data: Prisma.PaymentUpdateManyMutationInput
): Promise<number> {
    const result = await withContentionRetry(async () => {
        const updated = await prisma.payment.updateMany({ where, data });

        return updated.count;
    });

    if (!result.ok) {
        throw new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, {
            message: "Gagal menyimpan sesi pembayaran. Silakan coba lagi.",
            details: { reason: "PAYMENT_ROW_CONTENTION" },
        });
    }

    return result.value;
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
    const updatedCount = await writePaymentRow(
        { id: paymentId, paymentUrl: null },
        {
            status: "PENDING",
            paymentUrl: session.paymentUrl,
            externalSessionId: session.providerSessionId,
            method: session.method,
            channel: session.channel,
            providerEnvironment: session.environment,
            providerFlow: "REDIRECT",
        }
    );

    const row = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
    });

    if (updatedCount === 0 && row.paymentUrl === null) {
        // Defensive: the guard failed but no URL is stored, which would leave the buyer
        // with a session they cannot reach. Surfaced rather than swallowed.
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
            message: "Gagal menyimpan sesi pembayaran.",
        });
    }

    return row;
}

/**
 * Write the provider's DIRECT payment instruction onto the claimed row.
 *
 * Same conditional-update discipline as `recordSession`, guarded on the columns that
 * would make a second write destructive: `paymentUrl` and `paymentNumber` are both null
 * until an instruction lands, so the guard is "nothing has been recorded yet" rather than
 * "no URL yet". If the guard loses, the stored instruction is returned unchanged instead
 * of being overwritten — two concurrent writes must not leave the buyer holding one QR
 * while the database holds another.
 *
 * `expiresAt` is set from the PROVIDER's own expiry when it returned one, and from the
 * order's reservation window otherwise. The provider's value wins because it is the one
 * that decides whether the QR/VA still works: showing a countdown that outlives the
 * instrument would invite a buyer to attempt a payment the gateway will refuse.
 *
 * ── `providerTransactionId` IS CAPTURED HERE, FROM THE RESPONSE ONLY ─────────────
 * iPaymu returns `Data.TransactionId` with a DIRECT instruction, and that id is the only
 * handle that addresses the server-to-server status query, so reconciliation cannot work
 * for a payment whose id was not recorded at creation (Phase 27E). It is written from the
 * provider's response and from nowhere else: no request may supply it, and no code may
 * back-fill it, because a caller-chosen identity would let the status query be pointed at
 * somebody else's transaction. It stays NULL when the provider omits it — most notably for
 * every pre-existing row — and reconciliation answers BLOCKED for those instead of
 * guessing.
 */
async function recordInstruction(
    paymentId: string,
    instruction: GatewayInstruction
): Promise<Payment> {
    const updatedCount = await writePaymentRow(
        {
            id: paymentId,
            paymentUrl: null,
            paymentNumber: null,
            qrString: null,
        },
        {
            status: "PENDING",
            providerFlow: "DIRECT",
            externalSessionId: instruction.providerSessionId,
            providerTransactionId: instruction.providerTransactionId,
            method: instruction.method,
            channel: instruction.channel,
            providerEnvironment: instruction.environment,
            paymentNumber: instruction.paymentNumber,
            qrString: instruction.qrString,
            qrImageUrl: instruction.qrImageUrl,
            paymentName: instruction.paymentName,
            providerExpiredAt: instruction.providerExpiredAt,
            ...(instruction.providerExpiredAt
                ? { expiresAt: instruction.providerExpiredAt }
                : {}),
        }
    );

    const row = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
    });

    if (updatedCount === 0 && !row.qrString && !row.paymentNumber) {
        // Defensive, and the same reasoning as `recordSession`: a lost guard with nothing
        // stored means the buyer was handed a payment page backed by no instruction.
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
            message: "Gagal menyimpan instruksi pembayaran.",
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
