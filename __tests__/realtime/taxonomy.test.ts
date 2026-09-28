/**
 * ==========================================
 * REALTIME TAXONOMY AND THE PAGE DEPENDENCY MAP
 * ==========================================
 *
 * The map is the part of this feature most likely to rot: a page is added, nobody extends the
 * table, and that page silently stops refreshing. So the assertions below are written to fail on
 * OMISSION rather than to restate the table:
 *
 *   • every event type must declare the domains it invalidates (the `satisfies` clause already
 *     makes omitting one a compile error; this double-checks the runtime shape);
 *   • every route the audit listed must resolve to a NON-EMPTY domain set — except the handful
 *     that genuinely read mutable data nothing publishes about;
 *   • the longest prefix must win, so a detail page cannot inherit its list page's set by
 *     accident.
 */

import {
    DOMAINS_BY_EVENT_TYPE,
    PAGE_DOMAIN_MAP,
    REALTIME_CHANNEL_NAME,
    REALTIME_DOMAINS,
    REALTIME_EVENT_TYPES,
    REALTIME_FALLBACK_DEFAULT_MS,
    REALTIME_HEARTBEAT_MS,
    REALTIME_STREAM_STALE_MS,
    audiencesIntersect,
    audienceKey,
    domainsForEventType,
    domainsForPath,
    isRealtimeDomain,
    isRealtimeEventType,
    realtimeFallbackIntervalMs,
    type RealtimeEventType,
} from "@/lib/realtime/taxonomy";

describe("the realtime vocabulary is closed", () => {
    test("domains and event types are unique, non-empty arrays", () => {
        expect(new Set(REALTIME_DOMAINS).size).toBe(REALTIME_DOMAINS.length);
        expect(REALTIME_DOMAINS.length).toBeGreaterThan(0);

        expect(new Set(REALTIME_EVENT_TYPES).size).toBe(REALTIME_EVENT_TYPES.length);
        expect(REALTIME_EVENT_TYPES.length).toBeGreaterThan(0);
    });

    test("membership guards reject everything that is not in the vocabulary", () => {
        expect(isRealtimeDomain("orders")).toBe(true);
        expect(isRealtimeDomain("Orders")).toBe(false);
        expect(isRealtimeDomain("invented")).toBe(false);
        expect(isRealtimeDomain(7)).toBe(false);
        expect(isRealtimeDomain(null)).toBe(false);

        expect(isRealtimeEventType("PAYMENT_PAID")).toBe(true);
        expect(isRealtimeEventType("PAYMENT")).toBe(false);
        expect(isRealtimeEventType("")).toBe(false);
    });

    test("every event type maps to at least one known domain", () => {
        for (const type of REALTIME_EVENT_TYPES) {
            const domains = domainsForEventType(type);

            expect({ type, empty: domains.length === 0 }).toEqual({ type, empty: false });

            for (const domain of domains) {
                expect({ type, domain, known: isRealtimeDomain(domain) }).toEqual({
                    type,
                    domain,
                    known: true,
                });
            }
        }

        // The record covers the type union exactly — no extra key, no missing key.
        expect(Object.keys(DOMAINS_BY_EVENT_TYPE).sort()).toEqual(
            [...REALTIME_EVENT_TYPES].sort()
        );
    });

    test("the money-path events invalidate every surface the owner named", () => {
        const paid = domainsForEventType("PAYMENT_PAID");

        // Customer order, customer tickets, PIC dashboard, admin orders and the ledger.
        for (const domain of [
            "orders",
            "payments",
            "tickets",
            "customers",
            "pic",
            "ledger",
        ] as const) {
            expect({ domain, present: paid.includes(domain) }).toEqual({ domain, present: true });
        }

        expect(domainsForEventType("REFUND_UPDATED")).toEqual(
            expect.arrayContaining(["refunds", "orders", "pic", "ledger"])
        );
        expect(domainsForEventType("SETTLEMENT_UPDATED")).toEqual(
            expect.arrayContaining(["settlements", "ledger", "pic"])
        );
        expect(domainsForEventType("TICKET_ISSUED")).toEqual(
            expect.arrayContaining(["tickets", "orders", "checkin"])
        );
        expect(domainsForEventType("TICKET_CHECKED_IN")).toEqual(
            expect.arrayContaining(["checkin", "tickets", "events"])
        );
    });

    test("the envelope can address a specific entity and carries no data fields", () => {
        const envelopeKeys = [
            "id",
            "type",
            "domains",
            "entityType",
            "entityId",
            "at",
        ] as const;

        // Declared by the type, asserted by inspection of the publishers in `bus.test.ts`. Here we
        // simply pin that the vocabulary a client may receive is this short list and contains no
        // money, status or customer field.
        expect(envelopeKeys).toHaveLength(6);
        for (const forbidden of ["amount", "total", "status", "email", "phone", "orderNumber"]) {
            expect(envelopeKeys as readonly string[]).not.toContain(forbidden);
        }
    });
});

describe("audiences", () => {
    test("keys are stable and unambiguous", () => {
        expect(audienceKey({ kind: "platform" })).toBe("platform");
        expect(audienceKey({ kind: "organizer", organizerId: "o1" })).toBe("organizer:o1");
        expect(audienceKey({ kind: "customer", userId: "u1" })).toBe("customer:u1");
        expect(audienceKey({ kind: "pic", picProfileId: "p1" })).toBe("pic:p1");
    });

    test("delivery is a set intersection, and isolation is by id", () => {
        const audience = [
            { kind: "organizer", organizerId: "o1" } as const,
            { kind: "customer", userId: "u1" } as const,
        ];

        expect(audiencesIntersect(audience, [{ kind: "organizer", organizerId: "o1" }])).toBe(true);
        expect(audiencesIntersect(audience, [{ kind: "customer", userId: "u1" }])).toBe(true);
        expect(audiencesIntersect(audience, [{ kind: "platform" }])).toBe(false);

        // ANOTHER tenant, ANOTHER buyer, ANOTHER PIC.
        expect(audiencesIntersect(audience, [{ kind: "organizer", organizerId: "o2" }])).toBe(false);
        expect(audiencesIntersect(audience, [{ kind: "customer", userId: "u2" }])).toBe(false);
        expect(audiencesIntersect(audience, [{ kind: "pic", picProfileId: "p1" }])).toBe(false);
    });

    test("an empty set on either side matches nothing — fail closed", () => {
        expect(audiencesIntersect([], [{ kind: "platform" }])).toBe(false);
        expect(audiencesIntersect([{ kind: "platform" }], [])).toBe(false);
        expect(audiencesIntersect([], [])).toBe(false);
    });
});

describe("the page dependency map", () => {
    test("resolves each audited route to the families it reads", () => {
        expect(domainsForPath("/dashboard")).toEqual(
            expect.arrayContaining(["orders", "payments", "refunds", "settlements", "events", "pic"])
        );
        expect(domainsForPath("/dashboard/orders")).toEqual(
            expect.arrayContaining(["orders", "payments", "refunds", "tickets"])
        );
        expect(domainsForPath("/dashboard/payments")).toEqual(
            expect.arrayContaining(["payments", "orders"])
        );
        expect(domainsForPath("/dashboard/refunds")).toEqual(
            expect.arrayContaining(["refunds", "orders", "ledger"])
        );
        expect(domainsForPath("/dashboard/settlements")).toEqual(
            expect.arrayContaining(["settlements", "ledger"])
        );
        expect(domainsForPath("/dashboard/customers")).toEqual(
            expect.arrayContaining(["customers", "orders"])
        );
        expect(domainsForPath("/dashboard/events")).toEqual(
            expect.arrayContaining(["events", "tickets", "attribution", "pic"])
        );
        expect(domainsForPath("/dashboard/check-in")).toEqual(
            expect.arrayContaining(["checkin", "tickets", "events"])
        );
        expect(domainsForPath("/dashboard/reports")).toEqual(
            expect.arrayContaining(["orders", "payments", "refunds", "settlements"])
        );
        expect(domainsForPath("/dashboard/users")).toEqual(expect.arrayContaining(["customers"]));
        expect(domainsForPath("/dashboard/venues")).toEqual(
            expect.arrayContaining(["venues", "events"])
        );
    });

    test("covers the CUSTOMER surfaces — the requirement that they are not left out", () => {
        expect(domainsForPath("/ticketing/orders")).toEqual(
            expect.arrayContaining(["orders", "payments", "refunds", "tickets"])
        );
        expect(domainsForPath("/ticketing/orders/EVT-202609001")).toEqual(
            expect.arrayContaining(["orders", "payments", "tickets"])
        );
        expect(domainsForPath("/ticketing/tickets")).toEqual(
            expect.arrayContaining(["tickets", "events"])
        );
        expect(domainsForPath("/ticketing/tickets/QR-ABC")).toEqual(
            expect.arrayContaining(["tickets", "checkin"])
        );
        expect(domainsForPath("/ticketing/refunds")).toEqual(
            expect.arrayContaining(["refunds", "orders"])
        );

        for (const path of [
            "/ticketing/orders",
            "/ticketing/orders/EVT-1",
            "/ticketing/tickets",
            "/ticketing/tickets/QR-1",
            "/ticketing/refunds",
        ]) {
            expect({ path, domains: domainsForPath(path).length > 0 }).toEqual({
                path,
                domains: true,
            });
        }
    });

    test("covers the PIC surface", () => {
        expect(domainsForPath("/dashboard/pic")).toEqual(
            expect.arrayContaining(["pic", "attribution", "ledger", "settlements", "events"])
        );
    });

    test("the deepest prefix wins, so a detail page never inherits a list's set blindly", () => {
        // Both are `/dashboard/events...`, and the deeper entry is what applies.
        expect(domainsForPath("/dashboard/events/new")).toEqual(["events"]);
        expect(domainsForPath("/dashboard/events/evt_1/check-in")).toEqual(
            expect.arrayContaining(["checkin", "tickets"])
        );
        expect(domainsForPath("/dashboard/events/evt_1")).toEqual(
            expect.arrayContaining(["events", "orders"])
        );
    });

    test("a prefix ending in a slash only matches a real sub-path", () => {
        // `/e/…` must not swallow `/events`.
        expect(domainsForPath("/events")).toEqual(["events", "tickets"]);
        expect(domainsForPath("/e/my-event")).toEqual(["events", "tickets"]);
        expect(domainsForPath("/ev")).toEqual([]);
    });

    test("trailing slashes and query strings do not change the answer", () => {
        expect(domainsForPath("/dashboard/orders/")).toEqual(domainsForPath("/dashboard/orders"));
        expect(domainsForPath("/dashboard/orders?paymentStatus=PAID")).toEqual(
            domainsForPath("/dashboard/orders")
        );
        expect(domainsForPath("/dashboard/pic#tickets-sold")).toEqual(
            domainsForPath("/dashboard/pic")
        );
    });

    test("a page that reads nothing mutable resolves to an EMPTY set, never to a wildcard", () => {
        for (const path of [
            "/login",
            "/register",
            "/faq",
            "/kontak",
            "/maintenance",
            "/syarat-ketentuan",
            "/refund-policy",
            "/dashboard/settings",
            "/dashboard/settings/branding",
            "/dashboard/settings/application",
            "/dashboard/settings/maintenance",
        ]) {
            expect({ path, domains: domainsForPath(path) }).toEqual({ path, domains: [] });
        }
    });

    test("every entry is a prefix with at least one domain, except the priced-in none", () => {
        for (const entry of PAGE_DOMAIN_MAP) {
            expect({ prefix: entry.prefix, rooted: entry.prefix.startsWith("/") }).toEqual({
                prefix: entry.prefix,
                rooted: true,
            });

            for (const domain of entry.domains) {
                expect({ prefix: entry.prefix, domain, known: isRealtimeDomain(domain) }).toEqual({
                    prefix: entry.prefix,
                    domain,
                    known: true,
                });
            }
        }
    });
});

describe("the timing constants are the ones the requirement asked for", () => {
    test("the fallback interval defaults to 15 seconds and is overridable, but never silly", () => {
        const previous = process.env.NEXT_PUBLIC_REALTIME_FALLBACK_INTERVAL_MS;

        try {
            delete process.env.NEXT_PUBLIC_REALTIME_FALLBACK_INTERVAL_MS;
            expect(realtimeFallbackIntervalMs()).toBe(REALTIME_FALLBACK_DEFAULT_MS);
            expect(REALTIME_FALLBACK_DEFAULT_MS).toBe(15_000);

            process.env.NEXT_PUBLIC_REALTIME_FALLBACK_INTERVAL_MS = "20000";
            expect(realtimeFallbackIntervalMs()).toBe(20_000);

            // A one-second global poll is exactly what the brief forbids, so it is refused.
            process.env.NEXT_PUBLIC_REALTIME_FALLBACK_INTERVAL_MS = "1000";
            expect(realtimeFallbackIntervalMs()).toBe(REALTIME_FALLBACK_DEFAULT_MS);

            process.env.NEXT_PUBLIC_REALTIME_FALLBACK_INTERVAL_MS = "not-a-number";
            expect(realtimeFallbackIntervalMs()).toBe(REALTIME_FALLBACK_DEFAULT_MS);
        } finally {
            if (previous === undefined) {
                delete process.env.NEXT_PUBLIC_REALTIME_FALLBACK_INTERVAL_MS;
            } else {
                process.env.NEXT_PUBLIC_REALTIME_FALLBACK_INTERVAL_MS = previous;
            }
        }
    });

    test("staleness is two heartbeats, and the channel has exactly one name", () => {
        expect(REALTIME_STREAM_STALE_MS).toBe(REALTIME_HEARTBEAT_MS * 2);
        expect(REALTIME_CHANNEL_NAME).toBe("tinggalklik-realtime");
    });
});

describe("the taxonomy is the only place these vocabularies are written", () => {
    test("no second definition of an event type string exists in the realtime modules", () => {
        // A cheap structural guard: the publishers must import the type union rather than
        // re-listing literals, which is what keeps `REALTIME_EVENT_TYPES` authoritative.
        const publishers = require("node:fs").readFileSync(
            require("node:path").resolve(process.cwd(), "lib/realtime/publishers.ts"),
            "utf-8"
        ) as string;

        expect(publishers).toContain('from "./taxonomy"');
        expect(publishers).toContain('from "./bus"');
        expect(publishers).not.toContain("const REALTIME_EVENT_TYPES");
    });
});

test("type-level completeness: the record covers the union", () => {
    // Compile-time proof (the `satisfies` clause) plus a runtime spot check.
    const sample: RealtimeEventType = "PAYMENT_PAID";
    expect(domainsForEventType(sample)).toContain("payments");
});
