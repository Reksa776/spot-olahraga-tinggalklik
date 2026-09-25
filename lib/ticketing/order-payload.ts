import { Prisma } from "@prisma/client";

import { qrisImageDataUrl } from "@/lib/ticketing/payment/qr-render";

/**
 * ==========================================
 * CUSTOMER ORDER PAYLOAD (design §25.5 / §26.x)
 * ==========================================
 *
 * One builder for every customer-facing order response, so the checkout response, the
 * order detail page and the cancel response cannot drift apart.
 *
 * ── WHAT IS NOT IN HERE (brief §24) ──────────────────────────────────────────────
 * No `organizerId`, no organizer membership, no `PermissionGrant`, no audit rows, no
 * financial ledger, no `quota` / `sold` / `reserved`, no `picProfileId`. A customer
 * response contains only what the buyer needs to see their own purchase. The
 * `TicketType` counters are deliberately absent: `reserved`/`sold` are organizer- and
 * platform-internal (design §10.5 keeps them out of public payloads), and a buyer's own
 * quantity is already in `items`.
 *
 * ── MONEY IS SERIALIZED AS STRINGS (§36.5) ───────────────────────────────────────
 * §36.5: "Serialization to JSON | Sent as **strings** (e.g. `"100000.00"`) or as
 * integers-with-explicit-currency, **never as JSON numbers**, so no client-side float
 * rounding occurs."
 *
 * `D-61` (`DECISION REQUIRED`: string decimals vs integer rupiah) is formally still
 * open, and the residual choice between the two string encodings is a serialization
 * detail, not a storage one — `Decimal(14,2)` is what is persisted either way, so
 * switching to integer rupiah later is an API-contract change with no migration. The
 * design's own stated rule ("strings ... never numbers") is what is implemented, and
 * `DECISION REQUIRED — D-61` is reported rather than quietly settled.
 */

/**
 * A Prisma `Decimal` rendered exactly as §36.5 requires: a fixed 2-decimal string.
 *
 * Formatted by decimal.js, NOT by `Number(value).toFixed(2)`. Brief §16 bans the
 * round-trip "Decimal → Number → arithmetic → Decimal" for money, and formatting is
 * part of that: a large amount passes through a binary float on its way to the client's
 * screen and can come back one rupiah off. `Decimal#toFixed` formats the exact value
 * that is stored.
 *
 * The parameter is deliberately `Decimal | string` and not `number`: accepting a JS
 * number here would invite exactly the conversion this function exists to avoid.
 */
export function moneyString(value: Prisma.Decimal | string): string {
    return new Prisma.Decimal(value).toFixed(2);
}

/**
 * The customer ticket wallet (design §26.5) — one path, used by the order payload and by
 * the wallet UI so the link cannot drift.
 */
export const TICKET_WALLET_URL = "/ticketing/tickets";

/** Alias kept explicit at call sites that render a stored column. */
export const decimalToString = moneyString;

export type OrderPayloadItem = {
    ticketTypeId: string | null;
    name: string;
    quantity: number;
    unitPrice: string;
    subtotal: string;
};

export type OrderPayloadReservation = {
    ticketTypeId: string;
    quantity: number;
    status: string;
    expiresAt: string;
};

/**
 * One issued ticket, as the order response may show it (design §26.2).
 *
 * §26.2 specifies the order detail returns "tickets (with `ticketCode` but **without** the
 * QR token)". So there is no `qrTokenHash`, no `qrToken` and no QR payload here — a
 * `ticketCode` is a lookup label, and a scannable credential is returned from exactly one
 * place (`GET /api/ticketing/tickets/{ticketCode}`, design §26.6).
 */
export type OrderPayloadTicket = {
    ticketCode: string;
    status: string;
    sequenceNo: number;
    ticketTypeId: string;
};

/**
 * ── THE THREE ADVISORY PREDICATES, SHARED BY BOTH PAYLOADS ──────────────────────
 *
 * The order detail (`OrderPayload`) and the order list (`OrderSummaryPayload`) answer the
 * same questions about the same columns. They were about to be written twice — once per
 * builder — which is exactly how a list and a detail start disagreeing about whether a
 * buyer can still pay. They live here as PURE functions of the row so both builders call
 * the same expression, and so a test can enumerate the state space once.
 *
 * All three are ADVISORY. They decide what a page offers, never what the server accepts:
 * the payment, cancellation, issuance and refund services each re-derive their own rules
 * from the database and refuse on their own (brief §25: "Frontend must not be the source of
 * truth").
 */

/**
 * Whether the server would accept a start/resume-payment for this order (design §26.3).
 *
 * `expiresAt === null` means no window was recorded, so nothing is presumed to have lapsed
 * — the payment service still re-checks. Kept in the same shape `buildOrderPayload` always
 * used, so this is an extraction rather than a behaviour change.
 */
export function orderCanPay(
    order: { status: string; paymentStatus: string; expiresAt: Date | null },
    now: Date = new Date()
): boolean {
    const windowOpen =
        order.expiresAt === null || order.expiresAt.getTime() > now.getTime();

    return (
        order.status === "PENDING_PAYMENT" &&
        order.paymentStatus !== "PAID" &&
        windowOpen
    );
}

/**
 * Whether the refund page would offer a request (Phase 10B, D-R01).
 *
 * Offered only while EVERY ticket is still `ISSUED`, so the button can never send a set
 * the policy would refuse for a checked-in ticket. `PARTIALLY_REFUNDED` counts as paid
 * because the order was paid; the refund service re-derives eligibility from scratch.
 */
export function orderCanRequestRefund(order: {
    paymentStatus: string;
    tickets: readonly { status: string }[];
}): boolean {
    const paid =
        order.paymentStatus === "PAID" ||
        order.paymentStatus === "PARTIALLY_REFUNDED";

    return (
        paid &&
        order.tickets.length > 0 &&
        order.tickets.every((ticket) => ticket.status === "ISSUED")
    );
}

/**
 * The fulfilment leg, as a state rather than as copy.
 *
 * Four real states, derived from the payload and nothing else: tickets exist, tickets can
 * be created, the order is held by the operator (Phase 7's late-settlement flag, which the
 * UI must never "repair"), or payment has not landed yet. The LABELS live in the page that
 * renders them; keeping them out of here is what stops this module from becoming a second
 * copy of the UI.
 */
export type OrderFulfilment = "ISSUED" | "READY" | "HELD" | "AWAITING_PAYMENT";

export function orderFulfilment(order: {
    paymentStatus: string;
    tickets: readonly { status: string }[];
    canIssueTickets: boolean;
}): OrderFulfilment {
    if (order.tickets.length > 0) {
        return "ISSUED";
    }

    if (order.paymentStatus === "PAID" && order.canIssueTickets) {
        return "READY";
    }

    if (order.paymentStatus === "PAID") {
        return "HELD";
    }

    return "AWAITING_PAYMENT";
}

/**
 * One row of the customer's own order LIST (design §26.1 `GET /api/orders`).
 *
 * Field names follow §26.1's table verbatim (`eventTitle`, `eventSlug`, `startAt`,
 * `venueName`, `ticketSummary`, `ticketCount`, `total`, `status`, `paymentStatus`,
 * `createdAt`, `canPay`, `canRefund`) because that table IS the contract for this endpoint,
 * rather than the nested `event` object the detail payload uses.
 *
 * Three fields are ADDITIVE to §26.1 and each earns its place:
 *
 *   * `endAt` — the event half of a schedule the card already shows the start of.
 *   * `fulfilment` — §26.1 has no word for "are the tickets actually issued yet?", and a
 *     buyer scanning a list of orders needs exactly that. It is the SAME state the detail
 *     page renders (`orderFulfilment`), so the two cannot drift.
 *   * `refundStatus` — the current refund lifecycle status (Phase 10B) when one exists, so
 *     "where did my refund get to?" is answerable from the list.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────────
 * No `userId`, no `organizerId`, no `fulfilmentBlockedAt`, no reservation or quota
 * counters, no payment instruction, no `paymentUrl`, and — the reason this type exists at
 * all rather than reusing `OrderPayload` — no `tickets[]`, no per-ticket `ticketCode` and
 * therefore nothing scannable. A list response is the one most likely to be cached or
 * logged, so it carries the least (design §26.5's reasoning, applied to orders).
 */
export type OrderSummaryPayload = {
    orderNumber: string;
    status: string;
    paymentStatus: string;
    /** Exact stored `Decimal(14,2)` as a fixed 2-decimal string (§36.5). */
    total: string;
    createdAt: string;
    eventTitle: string;
    eventSlug: string;
    startAt: string;
    endAt: string | null;
    venueName: string | null;
    /** `"2× VIP, 1× Reguler"` — the order's own lines, oldest first. */
    ticketSummary: string;
    /** Tickets ordered (sum of line quantities), independent of issuance. */
    ticketCount: number;
    canPay: boolean;
    canRefund: boolean;
    fulfilment: OrderFulfilment;
    /** The newest refund's `RefundStatus`, or `null` when none was requested. */
    refundStatus: string | null;
    /** The buyer's own order-detail route, so the link cannot drift from the page. */
    orderUrl: string;
};

type OrderSummaryRow = {
    orderNumber: string;
    status: string;
    paymentStatus: string;
    total: Prisma.Decimal;
    createdAt: Date;
    expiresAt: Date | null;
    paidAt: Date | null;
    fulfilmentBlockedAt: Date | null;
    event: {
        title: string;
        slug: string;
        startAt: Date;
        endAt: Date | null;
        venue: { name: string } | null;
    };
    items: { nameSnapshot: string; quantity: number }[];
    tickets: { status: string }[];
    refunds: { status: string }[];
};

/** The buyer's own order-detail route. One builder, so the list cannot link nowhere. */
export function orderDetailUrl(orderNumber: string): string {
    return `/ticketing/orders/${orderNumber}`;
}

/**
 * The Prisma `select` the order LIST uses.
 *
 * Note what is NOT selected: no payment columns at all. A list has no use for a payment
 * instruction, and the omission is structural — an instruction that is never read cannot be
 * leaked by a later edit to the builder. `refunds` takes only the newest row's `status`,
 * and `tickets` only the statuses (no `ticketCode`).
 */
export const ORDER_SUMMARY_SELECT = {
    orderNumber: true,
    status: true,
    paymentStatus: true,
    total: true,
    createdAt: true,
    expiresAt: true,
    paidAt: true,
    fulfilmentBlockedAt: true,
    event: {
        select: {
            title: true,
            slug: true,
            startAt: true,
            endAt: true,
            venue: { select: { name: true } },
        },
    },
    items: {
        select: { nameSnapshot: true, quantity: true },
        orderBy: { createdAt: "asc" },
    },
    tickets: { select: { status: true } },
    refunds: {
        select: { status: true },
        orderBy: { createdAt: "desc" },
        take: 1,
    },
} as const;

/**
 * Build one list row.
 *
 * Synchronous and dependency-free (unlike `buildOrderPayload`, which renders a QRIS image),
 * because a list of 50 rows must not do 50 image renders.
 */
export function buildOrderSummary(
    row: OrderSummaryRow,
    now: Date = new Date()
): OrderSummaryPayload {
    const tickets = row.tickets;

    // The SAME predicate the issuance service enforces and the detail builder derives.
    const canIssueTickets =
        row.status === "PAID" &&
        row.paymentStatus === "PAID" &&
        row.paidAt !== null &&
        row.fulfilmentBlockedAt === null &&
        tickets.length === 0;

    return {
        orderNumber: row.orderNumber,
        status: row.status,
        paymentStatus: row.paymentStatus,
        total: moneyString(row.total),
        createdAt: row.createdAt.toISOString(),
        eventTitle: row.event.title,
        eventSlug: row.event.slug,
        startAt: row.event.startAt.toISOString(),
        endAt: row.event.endAt?.toISOString() ?? null,
        venueName: row.event.venue?.name ?? null,
        ticketSummary: row.items
            .map((item) => `${item.quantity}× ${item.nameSnapshot}`)
            .join(", "),
        ticketCount: row.items.reduce((total, item) => total + item.quantity, 0),
        canPay: orderCanPay(row, now),
        canRefund: orderCanRequestRefund({ paymentStatus: row.paymentStatus, tickets }),
        fulfilment: orderFulfilment({
            paymentStatus: row.paymentStatus,
            tickets,
            canIssueTickets,
        }),
        refundStatus: row.refunds[0]?.status ?? null,
        orderUrl: orderDetailUrl(row.orderNumber),
    };
}

export type OrderPayload = {
    orderId: string;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    currency: string;
    createdAt: string;
    /**
     * The payment window (§12.1). **The server's instant**, which the confirmation
     * page renders as a countdown (brief §26). The browser timer is presentation only —
     * reaching zero revalidates against the server and never releases anything.
     */
    expiresAt: string | null;
    totals: {
        subtotal: string;
        discount: string;
        platformFee: string;
        picFeeTotal: string;
        total: string;
        organizerNetAmount: string;
    };
    event: {
        id: string;
        slug: string;
        title: string;
        startAt: string;
        endAt: string | null;
        venueName: string | null;
    };
    items: OrderPayloadItem[];
    reservations: OrderPayloadReservation[];
    /**
     * The live provider session's URL, or `null`.
     *
     * PHASE 7 fills this in. Brief §20: "Phase 7 should replace that only when a valid
     * gateway payment has been created. The UI must never display a fake or guessed payment
     * URL." So it is populated from the newest `Payment` row and only while that row is
     * `PENDING`; an `EXPIRED`/`FAILED` attempt contributes nothing here even though it may
     * still hold a stale URL in the database.
     */
    paymentUrl: string | null;
    /**
     * The live payment INSTRUCTION — what the buyer needs in order to pay.
     *
     * `null` unless the newest payment attempt is still `PENDING`, which is the same rule
     * `paymentUrl` follows above. Two shapes exist and the page must tell them apart:
     *
     *   `flow: "DIRECT"`   the buyer settles here. `qrImageUrl` carries a QR image rendered
     *                      server-side from the gateway's own QRIS payload and `number`
     *                      carries the virtual-account or retail-outlet number the gateway
     *                      issued (or, for QRIS, the provider reference). None of these is
     *                      generated by this application — an absent value means the
     *                      provider did not return one, and the page must say so rather
     *                      than draw a placeholder.
     *   `flow: "REDIRECT"` the buyer finishes on the provider's page at `url`.
     *
     * Exposed only for the caller's OWN order: the ownership predicate runs before this
     * payload is built, so one buyer's account number can never be read from another's
     * response (brief §22/§29).
     */
    paymentInstruction: PaymentInstructionPayload | null;
    /**
     * Whether the server would accept a request to start/resume a provider session now.
     *
     * Advisory, for the UI only: the payment service re-derives every one of these
     * conditions from the database and refuses on its own (brief §25: "Frontend must not be
     * the source of truth"). Expressed here so the order page does not offer a "Pay Now"
     * button that is guaranteed to fail.
     */
    canPay: boolean;
    /** When the payment was confirmed, or `null`. Buyer-visible and useful on a receipt. */
    paidAt: string | null;
    /** True only while the order is `PENDING_PAYMENT` (the §26.4 cancel precondition). */
    canCancel: boolean;
    /**
     * The order's issued tickets. Empty until issuance has run for a paid order.
     *
     * PHASE 8. Design §26.2 lists `tickets` in the order-detail contract; Phase 6 omitted
     * them because no ticket could exist yet. Additive: no Phase 6 field changed.
     */
    tickets: OrderPayloadTicket[];
    /**
     * The e-ticket wallet (design §26.2's "e-ticket wallet link").
     *
     * Always the wallet list rather than a per-order view, because the wallet is what a
     * buyer needs at the gate and it is scoped to the session, not to this order.
     */
    walletUrl: string;
    /**
     * Whether the server would materialise this order's tickets right now.
     *
     * Advisory, for the UI only — the same contract as `canPay`/`canCancel` above, and the
     * same warning applies: the issuance service re-derives every condition from the
     * database and refuses on its own (brief §23: "Frontend must not be the source of
     * truth"). Expressed here so a paid order does not offer a button that cannot work,
     * and so the page can explain a blocked order instead of showing a dead end.
     */
    canIssueTickets: boolean;
};

type OrderRow = {
    id: string;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    currency: string;
    createdAt: Date;
    expiresAt: Date | null;
    subtotal: Prisma.Decimal;
    discount: Prisma.Decimal;
    platformFee: Prisma.Decimal;
    picFeeTotal: Prisma.Decimal;
    total: Prisma.Decimal;
    organizerNetAmount: Prisma.Decimal;
    event: {
        id: string;
        slug: string;
        title: string;
        startAt: Date;
        endAt: Date | null;
        venue: { name: string } | null;
    };
    items: {
        ticketTypeId: string | null;
        nameSnapshot: string;
        priceSnapshot: Prisma.Decimal;
        quantity: number;
        subtotal: Prisma.Decimal;
    }[];
    reservations: {
        ticketTypeId: string;
        quantity: number;
        status: string;
        expiresAt: Date;
    }[];
    paidAt: Date | null;
    /** The §11.4 hold flag. Read only to derive `canIssueTickets`; never projected. */
    fulfilmentBlockedAt: Date | null;
    /** The order's issued tickets (design §26.2), oldest line and slot first. */
    tickets: {
        ticketCode: string;
        status: string;
        sequenceNo: number;
        ticketTypeId: string;
    }[];
    /**
     * The newest payment attempt, if any.
     *
     * The instruction columns ARE projected, because they are not internals — they are the
     * thing the buyer has to read in order to pay: the gateway's own QRIS payload, the
     * virtual-account number, the issuer's name and the gateway's expiry. They are exposed
     * for the caller's own order only, behind the same ownership predicate as the rest of
     * this payload.
     *
     * The provider IDENTIFIERS (`paymentReference`, `providerTransactionId`,
     * `externalSessionId`, `providerEnvironment`) are projected too, for the demo/support
     * payment card. `provider`, `createdByUserId` and the transaction rows remain
     * unprojected: those really are platform internals. None of the projected identifiers is
     * a credential, and the ownership predicate above decides whether a caller may see them.
     */
    payments: {
        status: string;
        paymentUrl: string | null;
        paymentReference: string;
        expiresAt: Date | null;
        /** The provider's own transaction id, or null (a REDIRECT session returns none). */
        providerTransactionId: string | null;
        /** The provider's session id, or null. */
        externalSessionId: string | null;
        /** Snapshot of the environment this attempt was created in. */
        providerEnvironment: string;
        /** `DIRECT` | `REDIRECT`, or null on rows written before the column existed. */
        providerFlow: string | null;
        method: string;
        channel: string | null;
        paymentNumber: string | null;
        qrString: string | null;
        qrImageUrl: string | null;
        paymentName: string | null;
        providerExpiredAt: Date | null;
    }[];
};

/**
 * The Prisma `select` every customer read uses, kept next to the builder so a new field
 * cannot be added to one without the other.
 */
/**
 * Ticket ordering for the order payload: grouped by the line they belong to, in slot order,
 * so "ticket 2 of 3" is stable across reads.
 *
 * Declared as a mutable array constant rather than inline: `ORDER_PAYLOAD_SELECT` is
 * `as const`, and a readonly tuple is not assignable to Prisma's `OrderByInput[]`.
 */
const TICKET_ORDER_BY: Prisma.TicketOrderByWithRelationInput[] = [
    { orderItemId: "asc" },
    { sequenceNo: "asc" },
];

export const ORDER_PAYLOAD_SELECT = {
    id: true,
    orderNumber: true,
    status: true,
    paymentStatus: true,
    currency: true,
    createdAt: true,
    expiresAt: true,
    subtotal: true,
    discount: true,
    platformFee: true,
    picFeeTotal: true,
    total: true,
    organizerNetAmount: true,
    event: {
        select: {
            id: true,
            slug: true,
            title: true,
            startAt: true,
            endAt: true,
            venue: { select: { name: true } },
        },
    },
    items: {
        select: {
            ticketTypeId: true,
            nameSnapshot: true,
            priceSnapshot: true,
            quantity: true,
            subtotal: true,
        },
        orderBy: { createdAt: "asc" },
    },
    reservations: {
        select: {
            ticketTypeId: true,
            quantity: true,
            status: true,
            expiresAt: true,
        },
        orderBy: { createdAt: "asc" },
    },
    paidAt: true,
    fulfilmentBlockedAt: true,
    tickets: {
        select: {
            ticketCode: true,
            status: true,
            sequenceNo: true,
            ticketTypeId: true,
        },
        orderBy: TICKET_ORDER_BY,
    },
    payments: {
        select: {
            status: true,
            paymentUrl: true,
            paymentReference: true,
            expiresAt: true,
            // Provider identifiers for the demo/support payment card (Phase: sandbox demo).
            providerTransactionId: true,
            externalSessionId: true,
            providerEnvironment: true,
            // Direct-payment instruction columns (QRIS/virtual account). Selected here so the
            // order page can render the instrument without a second query.
            providerFlow: true,
            method: true,
            channel: true,
            paymentNumber: true,
            qrString: true,
            qrImageUrl: true,
            paymentName: true,
            providerExpiredAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 1,
    },
} as const;

/**
 * One live payment instruction, flattened for the page.
 *
 * A separate type rather than inline fields because the page consumes it as a unit: either it
 * has an instruction to render or it does not, and a page that reads five nullable fields off
 * the top level is a page that will eventually render half an instruction.
 */
export type PaymentInstructionPayload = {
    /** `DIRECT` renders the instrument here; `REDIRECT` links to the provider's page. */
    flow: "DIRECT" | "REDIRECT";
    /** This platform's `PaymentMethod`, so the page can pick the right wording. */
    method: string;
    channel: string | null;
    /**
     * How the buyer settles, derived from the method: scan a QR, use a number, or follow a
     * link. Derived rather than stored, because it is presentation and the method already
     * determines it — a stored copy could disagree with the method it describes.
     */
    kind: "QR" | "NUMBER" | "REDIRECT";
    /** The provider's hosted page, for `REDIRECT`. */
    url: string | null;
    /** Virtual-account or retail-outlet number, for a number-shaped instruction. */
    number: string | null;
    /**
     * The QR image to render for a QRIS instruction: a `data:image/svg+xml` URL produced
     * **server-side** from the gateway's `QrString`. The raw `qrString` payload itself is
     * deliberately NOT part of this payload — it must never reach the browser.
     */
    qrImageUrl: string | null;
    /** The issuer's own display name (bank/merchant), when returned. */
    paymentName: string | null;
    /** The instant the GATEWAY stated, when it stated one. */
    providerExpiredAt: string | null;
    /** This platform's reservation window — the server's own instant, never a client timer. */
    expiresAt: string | null;
    /**
     * ── DEMO / SUPPORT IDENTIFIERS ──────────────────────────────────────────────
     *
     * The handles a demo operator (or a buyer raising a support ticket) needs to identify a
     * transaction at the provider. They are read from the SAME `Payment` row the instrument
     * was built from — never synthesised — and every one is `null` when the provider did
     * not return it, so the UI hides the row instead of showing an empty value.
     *
     * None of these is a credential: the API key, the signature and the webhook secret are
     * never near this payload. `referenceId` is our own value sent to the provider;
     * `providerTransactionId` and `providerSessionId` are the provider's public handles.
     */
    referenceId: string | null;
    providerTransactionId: string | null;
    providerSessionId: string | null;
    /**
     * The environment the attempt was created in, snapshotted on the row (`SANDBOX` |
     * `PRODUCTION`). Drives the sandbox demo banner; it is NOT a payment state and never
     * implies the payment succeeded.
     */
    environment: string | null;
};

type LatestPaymentRow = OrderRow["payments"][number];

/**
 * Derive the instruction, or `null`.
 *
 * `providerFlow` is read first and `paymentUrl`/QR presence is only the FALLBACK, for rows
 * written before the column existed. Inferring the flow from which columns happen to be filled
 * would be fine today and wrong the moment a method sets both, which is exactly why the flow is
 * recorded as a value.
 */
async function buildPaymentInstruction(
    payment: LatestPaymentRow | null
): Promise<PaymentInstructionPayload | null> {
    if (!payment || payment.status !== "PENDING") {
        return null;
    }

    const flow: "DIRECT" | "REDIRECT" =
        payment.providerFlow === "DIRECT" ||
        payment.providerFlow === "REDIRECT"
            ? payment.providerFlow
            : payment.paymentUrl
              ? "REDIRECT"
              : "DIRECT";

    const kind: "QR" | "NUMBER" | "REDIRECT" =
        flow === "REDIRECT"
            ? "REDIRECT"
            : payment.method === "QRIS"
              ? "QR"
              : "NUMBER";

    /*
     * QRIS reference guard: the provider's `PaymentNo` is the public reference to show the
     * buyer. Rows written before the `PaymentNo` column was populated from the provider
     * carried the *first characters of the QrString itself* as the "number" — a leak of the
     * payment payload. When the stored number is a literal prefix of the stored QrString it
     * is that legacy artefact, so it is not shown.
     */
    const isLegacyQrPrefixReference =
        kind === "QR" &&
        payment.paymentNumber !== null &&
        payment.qrString !== null &&
        payment.qrString.startsWith(payment.paymentNumber);

    const number =
        kind === "QR" && isLegacyQrPrefixReference
            ? null
            : (payment.paymentNumber ?? null);

    return {
        flow,
        method: payment.method,
        channel: payment.channel ?? null,
        kind,
        url: flow === "REDIRECT" ? (payment.paymentUrl ?? null) : null,
        number,
        /*
         * The QR a buyer scans: rendered server-side from the gateway's own `QrString` (the
         * provider's `QrImage` URL is an HTML page in sandbox, so it cannot feed an `<img>`).
         * The provider's URL is the last-resort fallback only if even that render fails.
         */
        qrImageUrl:
            kind === "QR" && payment.qrString
                ? ((await qrisImageDataUrl(payment.qrString)) ??
                  payment.qrImageUrl ??
                  null)
                : null,
        paymentName: payment.paymentName ?? null,
        providerExpiredAt: payment.providerExpiredAt?.toISOString() ?? null,
        expiresAt: (payment.providerExpiredAt ?? payment.expiresAt)?.toISOString() ?? null,
        // Read straight off the row. A missing value stays null and the UI hides its row;
        // nothing is defaulted, generated or guessed.
        referenceId: payment.paymentReference ?? null,
        providerTransactionId: payment.providerTransactionId ?? null,
        providerSessionId: payment.externalSessionId ?? null,
        environment: payment.providerEnvironment ?? null,
    };
}

export async function buildOrderPayload(
    row: OrderRow,
    /** Injected so the derived flags are deterministic in tests. */
    now: Date = new Date()
): Promise<OrderPayload> {
    const latestPayment = row.payments[0] ?? null;

    /*
     * The payment window is the server's own instant (brief §26: "display the
     * server-derived expiry timestamp. Do not trust the browser timer").
     *
     * PHASE 20B — the predicate moved to `orderCanPay` so the LIST and the DETAIL cannot
     * disagree about whether a buyer can still pay; the expression is identical.
     */
    const payable = orderCanPay(row, now);

    return {
        orderId: row.id,
        orderNumber: row.orderNumber,
        status: row.status,
        paymentStatus: row.paymentStatus,
        currency: row.currency,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        totals: {
            subtotal: moneyString(row.subtotal),
            discount: moneyString(row.discount),
            platformFee: moneyString(row.platformFee),
            picFeeTotal: moneyString(row.picFeeTotal),
            total: moneyString(row.total),
            organizerNetAmount: moneyString(row.organizerNetAmount),
        },
        event: {
            id: row.event.id,
            slug: row.event.slug,
            title: row.event.title,
            startAt: row.event.startAt.toISOString(),
            endAt: row.event.endAt?.toISOString() ?? null,
            venueName: row.event.venue?.name ?? null,
        },
        items: row.items.map((item) => ({
            ticketTypeId: item.ticketTypeId,
            name: item.nameSnapshot,
            quantity: item.quantity,
            unitPrice: moneyString(item.priceSnapshot),
            subtotal: moneyString(item.subtotal),
        })),
        reservations: row.reservations.map((reservation) => ({
            ticketTypeId: reservation.ticketTypeId,
            quantity: reservation.quantity,
            status: reservation.status,
            expiresAt: reservation.expiresAt.toISOString(),
        })),
        paymentUrl:
            latestPayment && latestPayment.status === "PENDING"
                ? latestPayment.paymentUrl
                : null,
        // Built from the same guard as `paymentUrl`: a terminal attempt contributes no
        // instruction, so a QR that was already paid is never re-rendered as payable.
        paymentInstruction: await buildPaymentInstruction(latestPayment),
        canPay: payable,
        paidAt: row.paidAt?.toISOString() ?? null,
        canCancel: row.status === "PENDING_PAYMENT",
        tickets: row.tickets.map((ticket) => ({
            ticketCode: ticket.ticketCode,
            status: ticket.status,
            sequenceNo: ticket.sequenceNo,
            ticketTypeId: ticket.ticketTypeId,
        })),
        walletUrl: TICKET_WALLET_URL,
        // Deliberately the SAME predicate the issuance service enforces, computed from the
        // same columns. Kept as a small local expression rather than imported from
        // `./tickets/issuance` so that this pure builder stays dependency-free — the two
        // are held in step by a test that asserts they agree on every combination.
        canIssueTickets:
            row.status === "PAID" &&
            row.paymentStatus === "PAID" &&
            row.paidAt !== null &&
            row.fulfilmentBlockedAt === null &&
            row.tickets.length === 0,
    };
}
