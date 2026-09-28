/**
 * ==========================================
 * THE BUS, THE PUBLISHERS, AND THE PROPAGATION MATRIX
 * ==========================================
 *
 * Three properties are asserted here, and they are the load-bearing ones for the whole feature:
 *
 *   1. THE BUS IS A SEAM, NOT A PIPE. It delivers an INVALIDATION (a type, the affected domains,
 *      an opaque entity id, a time) and never a value a client could render. A subscriber that
 *      throws cannot take down the write path or its peers.
 *
 *   2. THE AUDIENCE IS DECIDED AT THE WRITE SITE, FROM IDS THE MUTATION ALREADY LOADED. Every
 *      publisher here is called with the ids a real flow has on hand, and the resulting set is
 *      checked for the things that must be TRUE (platform is always told, the owning tenant and
 *      the buyer are told) and the things that must be FALSE (another tenant, another buyer,
 *      another PIC).
 *
 *   3. THE PROPAGATION MATRIX — "which surfaces refresh when X happens" — is a function of the
 *      taxonomy and the page map, and is asserted for the five flows the brief calls out
 *      explicitly (payment PAID, refund, issuance, settlement, event).
 */

import { __resetRealtimeBusForTests, publishRealtimeChange, realtimeListenerCount, subscribeRealtimeBus } from "@/lib/realtime/bus";
import {
    publishCustomerUpdated,
    publishEventChanged,
    publishOrderCreated,
    publishOrderUpdated,
    publishPaymentCreated,
    publishPaymentFailed,
    publishPaymentPaid,
    publishPicAttributionCreated,
    publishPicLedgerUpdated,
    publishRefundCreated,
    publishRefundUpdated,
    publishSettlementChanged,
    publishTicketCheckedIn,
    publishTicketIssued,
    publishVenueUpdated,
} from "@/lib/realtime/publishers";
import {
    audienceKey,
    audiencesIntersect,
    domainsForEventType,
    domainsForPath,
    type RealtimeAudience,
    type RealtimeDomain,
    type RealtimeEventType,
} from "@/lib/realtime/taxonomy";

beforeEach(() => {
    __resetRealtimeBusForTests();
});

afterEach(() => {
    __resetRealtimeBusForTests();
});

/* ==================================================================================
 * 1. THE BUS
 * ================================================================================== */

describe("the bus delivers an invalidation and survives a bad subscriber", () => {
    test("a committed change reaches every attached stream", () => {
        const first: string[] = [];
        const second: string[] = [];

        subscribeRealtimeBus((change) => first.push(change.envelope.type));
        subscribeRealtimeBus((change) => second.push(change.envelope.type));

        expect(realtimeListenerCount()).toBe(2);

        publishRealtimeChange({
            type: "PAYMENT_PAID",
            entityType: "EventOrder",
            entityId: "ord_1",
            audiences: [{ kind: "platform" }],
        });

        expect(first).toEqual(["PAYMENT_PAID"]);
        expect(second).toEqual(["PAYMENT_PAID"]);
    });

    test("the envelope carries NO data a client could render", () => {
        const published = publishRealtimeChange({
            type: "PAYMENT_PAID",
            entityType: "EventOrder",
            entityId: "ord_1",
            audiences: [{ kind: "platform" }],
        });

        expect(Object.keys(published.envelope).sort()).toEqual([
            "at",
            "domains",
            "entityId",
            "entityType",
            "id",
            "type",
        ]);

        // The serialised form is what actually crosses the wire: assert on THAT, so a future field
        // added anywhere in the object graph is caught rather than argued about.
        const wire = JSON.stringify(published.envelope);

        for (const forbidden of [
            "amount",
            "total",
            "price",
            "email",
            "phone",
            "password",
            "signature",
            "token",
            "status",
            "orderNumber",
            "netAmount",
        ]) {
            expect(wire).not.toContain(forbidden);
        }
    });

    test("domains are derived from the type, so a publisher cannot under-invalidate", () => {
        const published = publishRealtimeChange({
            type: "PAYMENT_PAID",
            entityType: "EventOrder",
            audiences: [{ kind: "platform" }],
        });

        expect(published.envelope.domains).toEqual(domainsForEventType("PAYMENT_PAID"));
    });

    test("two changes in the same millisecond still get distinct ids", () => {
        const at = new Date("2026-09-28T00:00:00.000Z");

        const first = publishRealtimeChange({
            type: "ORDER_CREATED",
            entityType: "EventOrder",
            audiences: [{ kind: "platform" }],
            at,
        });
        const second = publishRealtimeChange({
            type: "ORDER_CREATED",
            entityType: "EventOrder",
            audiences: [{ kind: "platform" }],
            at,
        });

        expect(first.envelope.id).not.toBe(second.envelope.id);
        expect(first.envelope.at).toBe("2026-09-28T00:00:00.000Z");
    });

    test("a subscriber that throws cannot deny the others, and cannot break the write", () => {
        const seen: string[] = [];
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        subscribeRealtimeBus(() => {
            throw new Error("subscriber exploded");
        });
        subscribeRealtimeBus((change) => seen.push(change.envelope.id));

        const published = publishRealtimeChange({
            type: "ORDER_UPDATED",
            entityType: "EventOrder",
            audiences: [{ kind: "platform" }],
        });

        // The publish call returned normally: a broken stream can never roll back a mutation.
        expect(published.envelope.type).toBe("ORDER_UPDATED");
        expect(seen).toEqual([published.envelope.id]);
        expect(errorSpy).toHaveBeenCalled();

        errorSpy.mockRestore();
    });

    test("unsubscribing detaches the listener — no leak per closed tab", () => {
        const seen: string[] = [];
        const unsubscribe = subscribeRealtimeBus((change) => seen.push(change.envelope.type));

        expect(realtimeListenerCount()).toBe(1);

        unsubscribe();

        expect(realtimeListenerCount()).toBe(0);

        publishRealtimeChange({
            type: "ORDER_CREATED",
            entityType: "EventOrder",
            audiences: [{ kind: "platform" }],
        });

        expect(seen).toEqual([]);
    });

    test("a change with NO audience is published but can never be delivered to anyone", () => {
        const published = publishRealtimeChange({
            type: "EVENT_UPDATED",
            entityType: "Event",
            audiences: [],
        });

        expect(audiencesIntersect([{ kind: "platform" }], published.audiences)).toBe(false);
    });
});

/* ==================================================================================
 * 2. THE PUBLISHERS — WHO IS TOLD
 * ================================================================================== */

const PLATFORM_KEYS = ["platform"];
const orgKeys = (id: string) => `organizer:${id}`;
const buyerKeys = (id: string) => `customer:${id}`;
const picKeys = (id: string) => `pic:${id}`;

function keys(change: { audiences: readonly RealtimeAudience[] }): string[] {
    return change.audiences.map(audienceKey).sort();
}

describe("every publisher addresses platform plus exactly the ids the mutation loaded", () => {
    test("an order-shaped change reaches the tenant, the buyer and the attributed PIC", () => {
        const created = publishOrderCreated({
            orderId: "ord_1",
            organizerId: "org_a",
            buyerUserId: "usr_buyer",
            picProfileId: "pic_1",
        });

        expect(keys(created)).toEqual(
            [PLATFORM_KEYS[0], orgKeys("org_a"), buyerKeys("usr_buyer"), picKeys("pic_1")].sort()
        );

        // No attribution → no PIC dimension at all, rather than a wildcard.
        const unattributed = publishOrderCreated({
            orderId: "ord_2",
            organizerId: "org_a",
            buyerUserId: "usr_buyer",
            picProfileId: null,
        });

        expect(keys(unattributed)).toEqual([PLATFORM_KEYS[0], orgKeys("org_a"), buyerKeys("usr_buyer")].sort());
    });

    test("a paid order reaches the customer's own scope and the PIC's, and nobody else's", () => {
        const paid = publishPaymentPaid({
            orderId: "ord_1",
            orderNumber: "TK-1",
            organizerId: "org_a",
            buyerUserId: "usr_buyer",
            picProfileId: "pic_1",
        });

        expect(audiencesIntersect([{ kind: "platform" }], paid.audiences)).toBe(true);
        expect(audiencesIntersect([{ kind: "organizer", organizerId: "org_a" }], paid.audiences)).toBe(true);
        expect(audiencesIntersect([{ kind: "customer", userId: "usr_buyer" }], paid.audiences)).toBe(true);
        expect(audiencesIntersect([{ kind: "pic", picProfileId: "pic_1" }], paid.audiences)).toBe(true);

        // Isolation: another tenant, another buyer, another PIC.
        expect(audiencesIntersect([{ kind: "organizer", organizerId: "org_b" }], paid.audiences)).toBe(false);
        expect(audiencesIntersect([{ kind: "customer", userId: "usr_other" }], paid.audiences)).toBe(false);
        expect(audiencesIntersect([{ kind: "pic", picProfileId: "pic_2" }], paid.audiences)).toBe(false);
    });

    test("a refund whose order is gone still reaches the platform rather than nobody", () => {
        const orphaned = publishRefundUpdated({
            refundId: "ref_1",
            organizerId: null,
            buyerUserId: null,
            picProfileId: null,
        });

        expect(keys(orphaned)).toEqual([PLATFORM_KEYS[0]]);
        expect(audiencesIntersect([{ kind: "platform" }], orphaned.audiences)).toBe(true);
    });

    test("issuance and check-in name the tenant and the ticket's owner", () => {
        const issued = publishTicketIssued({
            orderId: "ord_1",
            organizerId: "org_a",
            buyerUserId: "usr_buyer",
            issued: 3,
        });

        // The issued COUNT never crosses the wire — a client would be tempted to render it.
        expect(JSON.stringify(issued.envelope)).not.toContain('"issued"');

        const checkedIn = publishTicketCheckedIn({
            ticketId: "tkt_1",
            eventId: "evt_1",
            organizerId: "org_a",
            ticketOwnerUserId: "usr_buyer",
        });

        expect(keys(checkedIn)).toEqual([PLATFORM_KEYS[0], orgKeys("org_a"), buyerKeys("usr_buyer")].sort());
        expect(audiencesIntersect([{ kind: "organizer", organizerId: "org_b" }], checkedIn.audiences)).toBe(false);
    });

    test("a ledger change reaches the PIC it credits", () => {
        const ledger = publishPicLedgerUpdated({
            ledgerId: "led_1",
            organizerId: "org_a",
            picProfileId: "pic_1",
        });

        expect(audiencesIntersect([{ kind: "pic", picProfileId: "pic_1" }], ledger.audiences)).toBe(true);
        expect(audiencesIntersect([{ kind: "pic", picProfileId: "pic_2" }], ledger.audiences)).toBe(false);
        expect(ledger.envelope.type).toBe("PIC_LEDGER_UPDATED");
    });

    test("a settlement without a PIC is still tenant news", () => {
        const settlement = publishSettlementChanged({
            type: "SETTLEMENT_UPDATED",
            settlementId: "stl_1",
            organizerId: "org_a",
            picProfileId: "pic_1",
        });

        expect(keys(settlement)).toEqual([PLATFORM_KEYS[0], orgKeys("org_a"), picKeys("pic_1")].sort());

        const anonymous = publishSettlementChanged({
            type: "SETTLEMENT_UPDATED",
            settlementId: "stl_2",
            organizerId: "org_a",
            picProfileId: null,
        });

        expect(keys(anonymous)).toEqual([PLATFORM_KEYS[0], orgKeys("org_a")].sort());
    });

    test("an event edit is tenant-scoped, and a venue edit reaches the tenant that owns it", () => {
        const published = publishEventChanged({
            type: "EVENT_PUBLISHED",
            eventId: "evt_1",
            organizerId: "org_a",
        });

        expect(audiencesIntersect([{ kind: "organizer", organizerId: "org_a" }], published.audiences)).toBe(true);
        expect(audiencesIntersect([{ kind: "organizer", organizerId: "org_b" }], published.audiences)).toBe(false);

        const globalVenue = publishVenueUpdated({ venueId: "ven_1", organizerId: null });

        // A platform venue has no tenant: platform only, never "every organizer".
        expect(keys(globalVenue)).toEqual([PLATFORM_KEYS[0]]);
    });

    test("an account change reaches the platform and any tenant whose member list shows it", () => {
        const membership = publishCustomerUpdated({ userId: "usr_1", organizerIds: ["org_a", "org_b"] });

        expect(keys(membership)).toEqual([PLATFORM_KEYS[0], orgKeys("org_a"), orgKeys("org_b")].sort());

        const platformOnly = publishCustomerUpdated({ userId: "usr_2" });

        expect(keys(platformOnly)).toEqual([PLATFORM_KEYS[0]]);
        expect(audiencesIntersect([{ kind: "customer", userId: "usr_2" }], platformOnly.audiences)).toBe(false);
    });

    test("the remaining flow publishers are all real and all platform-visible", () => {
        const changes = [
            publishOrderUpdated({ orderId: "o", organizerId: "org_a", buyerUserId: "usr_buyer" }),
            publishPaymentCreated({ paymentId: "p", orderId: "o", organizerId: "org_a", buyerUserId: "usr_buyer" }),
            publishPaymentFailed({ orderId: "o", organizerId: "org_a", buyerUserId: "usr_buyer" }),
            publishRefundCreated({ refundId: "r", organizerId: "org_a", buyerUserId: "usr_buyer" }),
            publishPicAttributionCreated({
                attributionId: "a",
                eventId: "e",
                organizerId: "org_a",
                picProfileId: "pic_1",
            }),
        ];

        for (const change of changes) {
            expect(audiencesIntersect([{ kind: "platform" }], change.audiences)).toBe(true);
            expect(change.envelope.domains.length).toBeGreaterThan(0);
        }

        expect(changes.map((change) => change.envelope.type)).toEqual([
            "ORDER_UPDATED",
            "PAYMENT_CREATED",
            "PAYMENT_FAILED",
            "REFUND_CREATED",
            "PIC_ATTRIBUTION_CREATED",
        ]);
    });
});

/* ==================================================================================
 * 3. THE PROPAGATION MATRIX
 * ==================================================================================
 * "Which surfaces refresh when X happens?" — answered by intersecting the event's domains with
 * each page's dependency set. Written as a table so the requirement's own examples are visible:
 * Payment PAID must reach the admin orders, the admin payments, the admin overview, the PIC
 * dashboard AND the customer order pages; a settlement must reach the PIC payout surface; an
 * event edit must reach the events pages.
 */

function pagesThatRefresh(type: RealtimeEventType, pages: readonly string[]): string[] {
    const domains = new Set<RealtimeDomain>(domainsForEventType(type));

    return pages.filter((page) => domainsForPath(page).some((domain) => domains.has(domain)));
}

describe("the propagation matrix", () => {
    const SURFACES = [
        "/dashboard",
        "/dashboard/orders",
        "/dashboard/orders/TK-1",
        "/dashboard/payments",
        "/dashboard/refunds",
        "/dashboard/settlements",
        "/dashboard/events",
        "/dashboard/customers",
        "/dashboard/venues",
        "/dashboard/check-in",
        "/dashboard/users",
        "/dashboard/reports",
        "/dashboard/pic",
        "/ticketing/orders",
        "/ticketing/orders/TK-1",
        "/ticketing/tickets",
        "/ticketing/refunds",
        "/faq",
    ] as const;

    test("PAYMENT_PAID reaches admin orders, payments, the overview, PIC and the customer", () => {
        const refreshed = pagesThatRefresh("PAYMENT_PAID", SURFACES);

        for (const page of [
            "/dashboard",
            "/dashboard/orders",
            "/dashboard/orders/TK-1",
            "/dashboard/payments",
            "/dashboard/pic",
            "/dashboard/reports",
            "/ticketing/orders",
            "/ticketing/orders/TK-1",
            "/ticketing/tickets",
        ]) {
            expect(refreshed).toContain(page);
        }

        // A static marketing page must NEVER be invalidated by money moving.
        expect(refreshed).not.toContain("/faq");
        expect(refreshed).not.toContain("/dashboard/venues");
    });

    test("a refund reaches the refund lists, the customer's order pages and the PIC ledger surfaces", () => {
        const refreshed = pagesThatRefresh("REFUND_UPDATED", SURFACES);

        expect(refreshed).toEqual(
            expect.arrayContaining([
                "/dashboard/refunds",
                "/dashboard/orders",
                "/dashboard/payments",
                "/dashboard/pic",
                "/ticketing/orders/TK-1",
                "/ticketing/refunds",
            ])
        );

        // A refund touches orders AND payments AND the ledger, so the surfaces that read none of
        // those (the venue list, a static marketing page) must stay untouched.
        expect(refreshed).not.toContain("/dashboard/venues");
        expect(refreshed).not.toContain("/faq");
    });

    test("issuance reaches the ticket wallet and the check-in log, and check-in reaches the gate", () => {
        expect(pagesThatRefresh("TICKET_ISSUED", SURFACES)).toEqual(
            expect.arrayContaining(["/ticketing/tickets", "/ticketing/orders/TK-1", "/dashboard/check-in"])
        );

        expect(pagesThatRefresh("TICKET_CHECKED_IN", SURFACES)).toEqual(
            expect.arrayContaining(["/dashboard/check-in", "/ticketing/tickets"])
        );
    });

    test("a settlement reaches the PIC payout surface and the tenant's settlement list", () => {
        const refreshed = pagesThatRefresh("SETTLEMENT_UPDATED", SURFACES);

        expect(refreshed).toEqual(
            expect.arrayContaining(["/dashboard/settlements", "/dashboard/pic", "/dashboard/reports"])
        );
        expect(refreshed).not.toContain("/ticketing/refunds");
    });

    test("an event change reaches the events surfaces and the PIC assignment table, not the money lists", () => {
        const refreshed = pagesThatRefresh("EVENT_UPDATED", SURFACES);

        expect(refreshed).toEqual(expect.arrayContaining(["/dashboard/events", "/dashboard/pic"]));
        expect(refreshed).not.toContain("/dashboard/payments");
        expect(refreshed).not.toContain("/dashboard/refunds");
    });

    test("EVERY event type invalidates at least one real surface — no dead vocabulary", () => {
        const allTypes: RealtimeEventType[] = [
            "ORDER_CREATED",
            "ORDER_UPDATED",
            "PAYMENT_CREATED",
            "PAYMENT_UPDATED",
            "PAYMENT_PAID",
            "PAYMENT_FAILED",
            "REFUND_CREATED",
            "REFUND_UPDATED",
            "TICKET_ISSUED",
            "TICKET_CHECKED_IN",
            "EVENT_CREATED",
            "EVENT_UPDATED",
            "EVENT_PUBLISHED",
            "EVENT_CANCELLED",
            "PIC_ATTRIBUTION_CREATED",
            "PIC_LEDGER_UPDATED",
            "SETTLEMENT_CREATED",
            "SETTLEMENT_UPDATED",
            "CUSTOMER_UPDATED",
            "VENUE_UPDATED",
        ];

        for (const type of allTypes) {
            expect(pagesThatRefresh(type, SURFACES).length).toBeGreaterThan(0);
        }
    });
});
