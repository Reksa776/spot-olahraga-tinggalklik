import { publishRealtimeChange, type RealtimeChangeInput } from "./bus";
import type { RealtimeAudience, RealtimeEventType } from "./taxonomy";

/**
 * ==========================================
 * REALTIME PUBLISHERS — THE AUDIENCE POLICY, IN ONE FILE
 * ==========================================
 *
 * Call sites do not construct audiences. They call one of the functions below, which exists
 * because "who may be told about this?" is a security decision, and a security decision repeated
 * at thirty call sites is a security decision that will eventually be got wrong in one of them.
 *
 * ── THE THREE RULES EVERY FUNCTION HERE OBEYS ────────────────────────────────────
 *
 *  1. PLATFORM IS ALWAYS INCLUDED. A platform operator's existing authority already spans every
 *     tenant (`decidePlatformPermission`), so naming `platform` adds no reach they did not have.
 *     It is not an extra grant — the stream intersects this set with the caller's real scope.
 *
 *  2. A TENANT IS NAMED BY ITS OWN ID, NEVER BY A PARAMETER THE CLIENT CONTROLS. Every id here
 *     comes from a row the mutation already loaded (`order.organizerId`, `event.picProfileId`,
 *     `refund.order.userId`, …). Nothing is read from a request body, query string or header.
 *
 *  3. NO OTHER TENANT, AND NO OTHER BUYER, IS EVER NAMED. There is no "all organizers" audience
 *     and no wildcard: an event is addressed to specific ids or it is addressed to nobody.
 *
 * ── WHY THESE ARE SEPARATE FUNCTIONS RATHER THAN ONE `publish(type, ids)` ─────────
 * Because the audience for an order change is not the audience for a venue change, and a shared
 * helper would have to accept a superset of ids and quietly decide which to use. Each function
 * below has the exact inputs its flow can supply, so a call site cannot pass a PIC id to a refund
 * event or forget the buyer.
 */

const PLATFORM: RealtimeAudience = { kind: "platform" };

/** Nobody. Used by nothing at a call site — kept to make "no audience" explicit in tests. */
export const NO_AUDIENCE: readonly RealtimeAudience[] = [];

/* ==================================================================================
 * AUDIENCE BUILDERS
 * ================================================================================== */

/** Platform operators plus one tenant. For anything a tenant's own staff must see. */
export function tenantAudience(organizerId: string | null | undefined): RealtimeAudience[] {
    return organizerId ? [PLATFORM, { kind: "organizer", organizerId }] : [PLATFORM];
}

/** Platform operators plus the buyer of an order (own-scope). */
export function buyerAudience(userId: string | null | undefined): RealtimeAudience[] {
    return userId ? [PLATFORM, { kind: "customer", userId }] : [PLATFORM];
}

/** Platform operators plus the PIC whose earnings the change touches (own-scope). */
export function picAudience(picProfileId: string | null | undefined): RealtimeAudience[] {
    return picProfileId ? [PLATFORM, { kind: "pic", picProfileId }] : [PLATFORM];
}

/**
 * The full audience of an order-shaped change: platform, the owning tenant, the buyer, and — when
 * the order carries a PIC attribution — that PIC.
 *
 * This is the one function the money-adjacent flows use, so "who hears about a paid order" is
 * answered in exactly one place. `picProfileId` is the value already stored on the order
 * (`EventOrder.picProfileId`), written by checkout in the same transaction as the attribution row.
 */
export function orderAudience(input: {
    organizerId: string | null | undefined;
    buyerUserId: string | null | undefined;
    picProfileId?: string | null;
}): RealtimeAudience[] {
    return [
        ...tenantAudience(input.organizerId),
        ...(input.buyerUserId ? [{ kind: "customer", userId: input.buyerUserId } as const] : []),
        ...(input.picProfileId ? [{ kind: "pic", picProfileId: input.picProfileId } as const] : []),
    ];
}

/* ==================================================================================
 * FLOW PUBLISHERS
 * ==================================================================================
 * Each one is called AFTER the write's transaction has resolved. See the header of `bus.ts`.
 */

function publish(
    input: {
        type: RealtimeEventType;
        entityType: string;
        entityId?: string | null;
        audiences: readonly RealtimeAudience[];
    },
    at?: Date
) {
    return publishRealtimeChange({
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        audiences: input.audiences,
        at,
    } satisfies RealtimeChangeInput);
}

/** Checkout committed: a new order exists. */
export function publishOrderCreated(
    input: {
        orderId: string;
        organizerId: string;
        buyerUserId: string;
        picProfileId?: string | null;
    },
    at?: Date
) {
    return publish(
        {
            type: "ORDER_CREATED",
            entityType: "EventOrder",
            entityId: input.orderId,
            audiences: orderAudience(input),
        },
        at
    );
}

/** An order's own state moved without money settling (cancel, expiry, reconciliation). */
export function publishOrderUpdated(
    input: {
        orderId: string;
        organizerId: string;
        buyerUserId: string;
        picProfileId?: string | null;
    },
    at?: Date
) {
    return publish(
        {
            type: "ORDER_UPDATED",
            entityType: "EventOrder",
            entityId: input.orderId,
            audiences: orderAudience(input),
        },
        at
    );
}

/** A gateway session was created or refreshed for an order. */
export function publishPaymentCreated(
    input: { paymentId: string; orderId: string; organizerId: string; buyerUserId: string },
    at?: Date
) {
    return publish(
        {
            type: "PAYMENT_CREATED",
            entityType: "Payment",
            entityId: input.paymentId,
            audiences: [
                ...tenantAudience(input.organizerId),
                ...buyerAudience(input.buyerUserId),
            ],
        },
        at
    );
}

/** Payment metadata moved without settling. */
export function publishPaymentUpdated(
    input: { paymentId: string; orderId: string; organizerId: string; buyerUserId: string },
    at?: Date
) {
    return publish(
        {
            type: "PAYMENT_UPDATED",
            entityType: "Payment",
            entityId: input.paymentId,
            audiences: [
                ...tenantAudience(input.organizerId),
                ...buyerAudience(input.buyerUserId),
            ],
        },
        at
    );
}

/**
 * The verified settlement. The single most consequential event in the product: it changes the
 * order, the tickets that become issuable, the fee ledger and the PIC rollup at once.
 */
export function publishPaymentPaid(
    input: {
        orderId: string;
        orderNumber: string;
        organizerId: string;
        buyerUserId: string;
        picProfileId?: string | null;
    },
    at?: Date
) {
    return publish(
        {
            type: "PAYMENT_PAID",
            entityType: "EventOrder",
            entityId: input.orderId,
            audiences: orderAudience(input),
        },
        at
    );
}

/** The provider reported a failure: the order was cancelled and its seats were released. */
export function publishPaymentFailed(
    input: {
        orderId: string;
        organizerId: string;
        buyerUserId: string;
        picProfileId?: string | null;
    },
    at?: Date
) {
    return publish(
        {
            type: "PAYMENT_FAILED",
            entityType: "EventOrder",
            entityId: input.orderId,
            audiences: orderAudience(input),
        },
        at
    );
}

/**
 * A refund was opened.
 *
 * `organizerId` and `buyerUserId` are nullable because the corresponding columns are: a refund row
 * can outlive both its order and its tenant (`onDelete: SetNull`), and such a change must still
 * reach the platform audience rather than being dropped for want of a tenant.
 */
export function publishRefundCreated(
    input: {
        refundId: string;
        organizerId: string | null;
        buyerUserId: string | null;
        picProfileId?: string | null;
    },
    at?: Date
) {
    return publish(
        {
            type: "REFUND_CREATED",
            entityType: "Refund",
            entityId: input.refundId,
            audiences: orderAudience(input),
        },
        at
    );
}

/** A refund decision or execution step. */
export function publishRefundUpdated(
    input: {
        refundId: string;
        organizerId: string | null;
        buyerUserId: string | null;
        picProfileId?: string | null;
    },
    at?: Date
) {
    return publish(
        {
            type: "REFUND_UPDATED",
            entityType: "Refund",
            entityId: input.refundId,
            audiences: orderAudience(input),
        },
        at
    );
}

/** Tickets materialised for a paid order. */
export function publishTicketIssued(
    input: {
        orderId: string;
        organizerId: string;
        buyerUserId: string;
        issued: number;
    },
    at?: Date
) {
    return publish(
        {
            type: "TICKET_ISSUED",
            entityType: "EventOrder",
            entityId: input.orderId,
            // The issued COUNT is deliberately not part of the envelope: it is a number a client
            // would be tempted to render, and the authoritative count is one read away.
            audiences: [...tenantAudience(input.organizerId), ...buyerAudience(input.buyerUserId)],
        },
        at
    );
}

/** A ticket was ACCEPTED at the gate. Refusals are not announced (they change no read model). */
export function publishTicketCheckedIn(
    input: {
        ticketId: string | null;
        eventId: string;
        organizerId: string;
        ticketOwnerUserId?: string | null;
    },
    at?: Date
) {
    return publish(
        {
            type: "TICKET_CHECKED_IN",
            entityType: "Ticket",
            entityId: input.ticketId,
            audiences: [
                ...tenantAudience(input.organizerId),
                ...buyerAudience(input.ticketOwnerUserId),
            ],
        },
        at
    );
}

/** Events: creation, publication, cancellation, edits, archive. */
export function publishEventChanged(
    input: {
        type: Extract<
            RealtimeEventType,
            "EVENT_CREATED" | "EVENT_UPDATED" | "EVENT_PUBLISHED" | "EVENT_CANCELLED"
        >;
        eventId: string;
        organizerId: string;
    },
    at?: Date
) {
    return publish(
        {
            type: input.type,
            entityType: "Event",
            entityId: input.eventId,
            audiences: tenantAudience(input.organizerId),
        },
        at
    );
}

/** A PIC was credited for an order. */
export function publishPicAttributionCreated(
    input: { attributionId: string; eventId: string; organizerId: string; picProfileId: string },
    at?: Date
) {
    return publish(
        {
            type: "PIC_ATTRIBUTION_CREATED",
            entityType: "PICAttribution",
            entityId: input.attributionId,
            audiences: [
                ...tenantAudience(input.organizerId),
                ...picAudience(input.picProfileId),
            ],
        },
        at
    );
}

/** The append-only fee ledger gained a row. */
export function publishPicLedgerUpdated(
    input: { ledgerId: string | null; organizerId: string; picProfileId: string },
    at?: Date
) {
    return publish(
        {
            type: "PIC_LEDGER_UPDATED",
            entityType: "PICFeeLedger",
            entityId: input.ledgerId,
            audiences: [
                ...tenantAudience(input.organizerId),
                ...picAudience(input.picProfileId),
            ],
        },
        at
    );
}

/**
 * A settlement was prepared or moved (organizer payout or PIC payout request).
 *
 * `organizerId` is nullable because `Settlement.organizerId` is: a payout request is addressed to a
 * tenant when one exists, and the platform audience is present either way.
 */
export function publishSettlementChanged(
    input: {
        type: Extract<RealtimeEventType, "SETTLEMENT_CREATED" | "SETTLEMENT_UPDATED">;
        settlementId: string;
        organizerId: string | null;
        picProfileId?: string | null;
    },
    at?: Date
) {
    return publish(
        {
            type: input.type,
            entityType: "Settlement",
            entityId: input.settlementId,
            audiences: [
                ...tenantAudience(input.organizerId),
                ...(input.picProfileId ? picAudience(input.picProfileId) : []),
            ],
        },
        at
    );
}

/** An account was created, edited, suspended or re-roled. */
export function publishCustomerUpdated(
    input: { userId: string; organizerIds?: readonly string[] },
    at?: Date
) {
    return publish(
        {
            type: "CUSTOMER_UPDATED",
            entityType: "User",
            entityId: input.userId,
            audiences: [
                PLATFORM,
                // A membership change is also tenant news: the operator list of that organizer
                // shows the member, so its page must re-read.
                ...(input.organizerIds ?? []).map(
                    (organizerId) => ({ kind: "organizer", organizerId }) as const
                ),
            ],
        },
        at
    );
}

/** A venue was created, edited or removed. */
export function publishVenueUpdated(
    input: { venueId: string; organizerId: string | null },
    at?: Date
) {
    return publish(
        {
            type: "VENUE_UPDATED",
            entityType: "Venue",
            entityId: input.venueId,
            audiences: tenantAudience(input.organizerId),
        },
        at
    );
}
