/**
 * ==========================================
 * REALTIME TAXONOMY — ONE VOCABULARY FOR THE WHOLE APPLICATION
 * ==========================================
 *
 * This module is the single source of truth for three things, and it is deliberately the only
 * place any of them is written down:
 *
 *   1. `REALTIME_DOMAINS`     — the DATA domains that can change. A domain is not a page and not
 *                              a route: it is a family of rows that some read model aggregates
 *                              (`orders`, `payments`, `refunds`, `tickets`, `pic`, `ledger`, …).
 *   2. `REALTIME_EVENT_TYPES` — the mutation events, each mapped to the domains it invalidates.
 *   3. `PAGE_DOMAIN_MAP`      — which domains each page actually depends on, so a client can
 *                              answer "does this event concern the page I am looking at?"
 *                              WITHOUT the server having to know about routes.
 *
 * ── WHY A DOMAIN LAYER, AND NOT "TYPE → PAGE" ────────────────────────────────────
 * If events named pages, every new page would require a server-side change and the server would
 * have to know the routing tree. Instead the server publishes what changed in DATA terms, and the
 * client resolves that against the page it is on. A route added later needs no publisher change;
 * only this map grows.
 *
 * ── WHY THE MAP IS LONGEST-PREFIX-FIRST ──────────────────────────────────────────
 * `/dashboard` must not swallow `/dashboard/pic`, and `/ticketing/orders/[orderNumber]` must not
 * lose to `/ticketing/orders`. `domainsForPath` therefore sorts by segment count, deepest first,
 * and returns the FIRST match — one entry per page, no union of ancestors. A page that genuinely
 * needs an ancestor's domains lists them explicitly, which keeps each page's dependency set
 * auditable by reading one line.
 *
 * ── WHAT AN EVENT IS *NOT* ───────────────────────────────────────────────────────
 * An event is an INVALIDATION SIGNAL, never data. The payload carries no money, no customer
 * identity, no status field a client could render, and no credential — because a client that
 * painted state from a realtime payload would be trusting a value that may already be stale by
 * the time it arrives, and would give a transport a foothold in the money engine. The only fields
 * are the ones a client needs to decide *whether to re-read the server*: the event type, the
 * affected domains, an opaque entity id for deduplication, and the time.
 *
 * ── THE AUDIENCE IS PART OF THE EVENT, NOT OF THE CONNECTION ─────────────────────
 * A publisher states WHO may be told (the tenant, the buyer, the PIC, the platform). The stream
 * then delivers an event only when the caller's own server-resolved scope intersects that set, so
 * isolation is decided where the write happens rather than inferred from a client-supplied id.
 * `resolveRealtimeAudience` (see `lib/realtime/audience.ts`) is the client half; both live in this
 * module's vocabulary so the two cannot drift.
 */

/* ==================================================================================
 * 1. DOMAINS
 * ================================================================================== */

export const REALTIME_DOMAINS = [
    /** `EventOrder` rows and everything read as "an order". */
    "orders",
    /** `Payment` rows and gateway state. */
    "payments",
    /** `Refund` rows and their lifecycle. */
    "refunds",
    /** Issued `Ticket` rows (the customer's wallet, the QR, the check-in log). */
    "tickets",
    /** Check-in attempts and the gate surface. */
    "checkin",
    /** `Event` rows: lifecycle status, publication, cancellation. */
    "events",
    /** Accounts and their profile data. */
    "customers",
    /** Venues (global and organizer-owned). */
    "venues",
    /** The PIC read family: assignments, sales rollups and the PIC dashboard. */
    "pic",
    /** `PICAttribution` rows. */
    "attribution",
    /** The append-only `PICFeeLedger`. */
    "ledger",
    /** `Settlement` rows (organizer payouts and PIC payout requests). */
    "settlements",
] as const;

export type RealtimeDomain = (typeof REALTIME_DOMAINS)[number];

const DOMAIN_SET: ReadonlySet<string> = new Set(REALTIME_DOMAINS);

export function isRealtimeDomain(value: unknown): value is RealtimeDomain {
    return typeof value === "string" && DOMAIN_SET.has(value);
}

/* ==================================================================================
 * 2. EVENT TYPES → DOMAINS
 * ==================================================================================
 * Every type below is emitted by at least one real mutation point in this application; nothing
 * here is declared "for symmetry". The domains are the families whose read models can change as a
 * consequence, i.e. exactly the pages that must re-read.
 *
 * The mapping is deliberately a SUPERSET at the page level: `PAYMENT_PAID` lists `tickets`
 * because ticket issuance follows payment, and it lists `ledger`/`pic` because the fee ledger and
 * the PIC rollup are recomputed from paid orders. A page that depends on `tickets` therefore
 * refreshes when a payment lands — which is correct, because its ticket table can change.
 * Over-invalidating is safe (a refresh reads authoritative data); under-invalidating is the bug
 * this whole mechanism exists to prevent.
 */

export const REALTIME_EVENT_TYPES = [
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
] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(REALTIME_EVENT_TYPES);

export function isRealtimeEventType(value: unknown): value is RealtimeEventType {
    return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

/**
 * The domains each event invalidates.
 *
 * `satisfies Record<RealtimeEventType, readonly RealtimeDomain[]>` is the point of this
 * declaration: adding a type to `REALTIME_EVENT_TYPES` without deciding what it invalidates is a
 * COMPILE ERROR, so the vocabulary cannot grow a hole.
 */
export const DOMAINS_BY_EVENT_TYPE = {
    /** Checkout: a new order exists (and its payment session, if the gateway answered). */
    ORDER_CREATED: ["orders", "payments", "customers", "attribution", "pic"],
    /** Any non-payment state change an order can undergo (cancel, expiry, fulfilment flag). */
    ORDER_UPDATED: ["orders", "payments", "tickets", "attribution", "pic"],
    /** A gateway session was created or refreshed for an order. */
    PAYMENT_CREATED: ["payments", "orders"],
    /** Payment state moved without money settling (pending, reconciled metadata). */
    PAYMENT_UPDATED: ["payments", "orders"],
    /** The verified settlement — the single most consequential event in the system. */
    PAYMENT_PAID: ["orders", "payments", "tickets", "customers", "pic", "attribution", "ledger"],
    /** The provider reported a failure: the order was cancelled and seats were released. */
    PAYMENT_FAILED: ["orders", "payments", "events", "tickets"],
    /** A buyer (or an operator on their behalf) opened a refund request. */
    REFUND_CREATED: ["refunds", "orders", "customers"],
    /** A refund decision or execution step: approve, reject, execute, settle, fail, evidence. */
    REFUND_UPDATED: ["refunds", "orders", "payments", "customers", "pic", "ledger"],
    /** Tickets materialised for a paid order — the customer's wallet gains rows. */
    TICKET_ISSUED: ["tickets", "orders", "checkin", "customers"],
    /** A ticket was ACCEPTED at the gate. A refused scan changes no admission list, so it is silent. */
    TICKET_CHECKED_IN: ["checkin", "tickets", "events", "customers"],
    /** A new draft exists (an event edit page / the events list gained a row). */
    EVENT_CREATED: ["events"],
    /** Any other event edit: title, schedule, ticket types, imagery, archive. */
    EVENT_UPDATED: ["events"],
    /** A draft moved to PUBLISHED — the public catalog and its availability change. */
    EVENT_PUBLISHED: ["events", "tickets"],
    /** An event was cancelled: orders, refund eligibility and the catalog all move. */
    EVENT_CANCELLED: ["events", "orders", "refunds", "customers"],
    /** A PIC was credited for an order (written in the same transaction as the order). */
    PIC_ATTRIBUTION_CREATED: ["pic", "attribution", "orders"],
    /** The append-only fee ledger gained a row (earned, reversal, payout). */
    PIC_LEDGER_UPDATED: ["pic", "ledger", "settlements"],
    /** A settlement was prepared (organizer payout or PIC payout request). */
    SETTLEMENT_CREATED: ["settlements", "ledger", "pic"],
    /** A settlement moved: submit, approve, reject, pay, fail, cancel. */
    SETTLEMENT_UPDATED: ["settlements", "ledger", "pic"],
    /** An account was created, edited, suspended or re-roled by an operator. */
    CUSTOMER_UPDATED: ["customers"],
    /** A venue was created, edited or removed (global or organizer-owned). */
    VENUE_UPDATED: ["venues", "events"],
} satisfies Record<RealtimeEventType, readonly RealtimeDomain[]>;

/** The domains one event type invalidates. */
export function domainsForEventType(type: RealtimeEventType): readonly RealtimeDomain[] {
    return DOMAINS_BY_EVENT_TYPE[type];
}

/* ==================================================================================
 * 3. AUDIENCES — WHO MAY BE TOLD
 * ================================================================================== */

/**
 * One recipient class. A publisher lists every class that may learn about the change; the stream
 * matches them against the caller's SERVER-RESOLVED scope.
 */
export type RealtimeAudience =
    /** Platform operators (ADMIN and any platform role the dashboard admits). */
    | { kind: "platform" }
    /** Members of one tenant. */
    | { kind: "organizer"; organizerId: string }
    /** The buyer of the affected order (own-scope). */
    | { kind: "customer"; userId: string }
    /** The PIC credited by the affected change (own-scope, resolved via `PICProfile`). */
    | { kind: "pic"; picProfileId: string };

/** Short, stable key for comparisons and tests: `platform` / `organizer:<id>` / … */
export function audienceKey(audience: RealtimeAudience): string {
    switch (audience.kind) {
        case "platform":
            return "platform";
        case "organizer":
            return `organizer:${audience.organizerId}`;
        case "customer":
            return `customer:${audience.userId}`;
        case "pic":
            return `pic:${audience.picProfileId}`;
    }
}

/**
 * Does the caller's audience set cover this event's?
 *
 * A pure set intersection, so it is trivially testable and cannot be re-implemented slightly
 * differently in a route. An empty caller set (unauthenticated, or a role with no scope) never
 * matches anything — fail-closed by construction.
 */
export function audiencesIntersect(
    caller: readonly RealtimeAudience[],
    event: readonly RealtimeAudience[]
): boolean {
    if (caller.length === 0 || event.length === 0) {
        return false;
    }

    const owned = new Set(caller.map(audienceKey));

    return event.some((audience) => owned.has(audienceKey(audience)));
}

/* ==================================================================================
 * 4. THE WIRE ENVELOPE
 * ================================================================================== */

/**
 * What actually crosses the wire. Deliberately tiny, and deliberately free of:
 * money amounts, customer names/emails/phones, statuses, order numbers, tokens, signatures, and
 * anything an operator would recognize as a record. `entityId` is an opaque cuid used for
 * DEDUPLICATION only — it is not rendered, and it is not a lookup key for anything a client can
 * call (every read surface re-authorizes by scope, not by id).
 */
export type RealtimeEnvelope = {
    /** Stable identity of this one change, for client-side deduplication. */
    id: string;
    type: RealtimeEventType;
    /** The domains to invalidate. Always `domainsForEventType(type)` today. */
    domains: readonly RealtimeDomain[];
    /** The Prisma model name the change concerned, e.g. `EventOrder`. */
    entityType: string;
    /** Opaque entity id (cuid), or null when the change has no single row. */
    entityId: string | null;
    /** ISO-8601 instant the change committed. */
    at: string;
};

/* ==================================================================================
 * 5. PAGE DEPENDENCY MAP
 * ==================================================================================
 * The map answers ONE question per page: "which data families does what I am looking at come
 * from?" It is derived from the actual read models each page calls (the `page.tsx` files under
 * `app`), not from the menu structure.
 */

export type PageDomainEntry = {
    /** Route prefix. Matched longest-first, so a detail route always beats its list route. */
    prefix: string;
    domains: readonly RealtimeDomain[];
};

export const PAGE_DOMAIN_MAP: readonly PageDomainEntry[] = [
    // ── Back office: detail routes first (they are matched before their parents) ──────
    { prefix: "/dashboard/events/new", domains: ["events"] },
    {
        prefix: "/dashboard/events/[id]/check-in",
        domains: ["checkin", "tickets", "events", "orders"],
    },
    {
        prefix: "/dashboard/events/",
        domains: ["events", "tickets", "orders", "attribution", "pic"],
    },
    { prefix: "/dashboard/orders/", domains: ["orders", "payments", "refunds", "tickets"] },
    { prefix: "/dashboard/settlements/", domains: ["settlements", "ledger", "pic"] },
    { prefix: "/dashboard/pic/", domains: ["pic", "attribution", "ledger", "settlements", "events"] },
    { prefix: "/dashboard/settings/application", domains: [] },
    { prefix: "/dashboard/settings/branding", domains: [] },
    { prefix: "/dashboard/settings/maintenance", domains: [] },
    { prefix: "/dashboard/settings/sports", domains: ["events"] },
    { prefix: "/dashboard/settings/venues", domains: ["venues", "events"] },
    { prefix: "/dashboard/settings", domains: [] },

    // ── Back office: lists and aggregates ────────────────────────────────────────────
    { prefix: "/dashboard/check-in", domains: ["checkin", "tickets", "events"] },
    {
        prefix: "/dashboard/events",
        domains: ["events", "tickets", "orders", "attribution", "pic"],
    },
    { prefix: "/dashboard/orders", domains: ["orders", "payments", "refunds", "tickets"] },
    { prefix: "/dashboard/payments", domains: ["payments", "orders"] },
    { prefix: "/dashboard/refunds", domains: ["refunds", "orders", "ledger"] },
    { prefix: "/dashboard/settlements", domains: ["settlements", "ledger", "pic"] },
    { prefix: "/dashboard/customers", domains: ["customers", "orders"] },
    { prefix: "/dashboard/users", domains: ["customers"] },
    { prefix: "/dashboard/venues", domains: ["venues", "events"] },
    {
        prefix: "/dashboard/pic",
        domains: ["pic", "attribution", "ledger", "settlements", "events", "tickets"],
    },
    { prefix: "/dashboard/reports", domains: ["orders", "payments", "refunds", "settlements"] },
    /** The overview aggregates every money and ticket family in the product. */
    {
        prefix: "/dashboard",
        domains: [
            "orders",
            "payments",
            "refunds",
            "settlements",
            "events",
            "tickets",
            "pic",
            "customers",
        ],
    },

    // ── Customer surfaces ────────────────────────────────────────────────────────────
    {
        prefix: "/ticketing/orders/",
        domains: ["orders", "payments", "refunds", "tickets"],
    },
    { prefix: "/ticketing/orders", domains: ["orders", "payments", "refunds", "tickets"] },
    { prefix: "/ticketing/tickets/", domains: ["tickets", "checkin", "events"] },
    { prefix: "/ticketing/tickets", domains: ["tickets", "checkin", "events"] },
    { prefix: "/ticketing/refunds", domains: ["refunds", "orders"] },
    { prefix: "/ticketing", domains: ["orders", "payments", "refunds", "tickets", "events"] },
    { prefix: "/orders/", domains: ["orders", "payments", "refunds", "tickets"] },
    { prefix: "/orders", domains: ["orders", "payments", "refunds", "tickets"] },

    // ── Public / catalog ─────────────────────────────────────────────────────────────
    { prefix: "/e/", domains: ["events", "tickets"] },
    { prefix: "/events", domains: ["events", "tickets"] },
    { prefix: "/faq", domains: [] },
    { prefix: "/kontak", domains: [] },
    { prefix: "/maintenance", domains: [] },
    { prefix: "/syarat-ketentuan", domains: [] },
    { prefix: "/refund-policy", domains: [] },
    { prefix: "/login", domains: [] },
    { prefix: "/register", domains: [] },
    /** The home page renders the public event catalog. */
    { prefix: "/", domains: ["events", "tickets"] },
];

/** Normalize a pathname for matching: strip the query/hash and any trailing slash. */
function normalizePath(pathname: string): string {
    const withoutQuery = pathname.split(/[?#]/)[0] ?? pathname;

    return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
}

/**
 * Does one prefix match this path?
 *
 * Two shapes, because they answer different questions:
 *
 *   • A LITERAL prefix (no `[`). A prefix ending in `/` requires the path to continue past it, so
 *     `/e/` never swallows `/events`; one without keeps the "the route and everything under it"
 *     behaviour that `/dashboard/orders` wants for its order pages. `/` is EXACT — it is the home
 *     page, not a wildcard, and treating it as one would give every unknown route the catalogue's
 *     domains and quietly make the empty-set fallback unreachable.
 *
 *   • A PATTERN prefix containing a `[param]` segment. `pathname` is always a REAL browser path
 *     (`/dashboard/events/evt_1/check-in`), never a Next.js route pattern, so a literal `[id]`
 *     entry could never match anything at all — which is precisely the bug this branch fixes for
 *     the check-in page, whose `checkin` domain would otherwise be dropped from the very surface
 *     that scans tickets. Segment counts are compared, and a bracketed segment matches any one.
 */
function matchesPrefix(path: string, prefix: string): boolean {
    if (!prefix.includes("[")) {
        if (prefix === "/") {
            return path === "/";
        }

        if (prefix.endsWith("/")) {
            return path.startsWith(prefix);
        }

        return path === prefix || path.startsWith(`${prefix}/`);
    }

    const pathSegments = path.split("/").filter(Boolean);
    const prefixSegments = prefix.split("/").filter(Boolean);

    if (pathSegments.length < prefixSegments.length) {
        return false;
    }

    if (!prefix.endsWith("/") && pathSegments.length !== prefixSegments.length) {
        return false;
    }

    return prefixSegments.every((segment, index) =>
        segment.startsWith("[") && segment.endsWith("]")
            ? true
            : pathSegments[index] === segment
    );
}

/**
 * The domains the page at `pathname` reads.
 *
 * Longest-prefix-first, so a detail page always beats its list (see `matchesPrefix` for the two
 * matching shapes). Unlisted routes resolve to the EMPTY set, which means "this page never
 * auto-refreshes" — not "refresh on anything".
 */
export function domainsForPath(pathname: string): readonly RealtimeDomain[] {
    const path = normalizePath(pathname);

    const candidates = [...PAGE_DOMAIN_MAP].sort(
        (left, right) => right.prefix.length - left.prefix.length
    );

    for (const entry of candidates) {
        if (matchesPrefix(path, entry.prefix)) {
            return entry.domains;
        }
    }

    return [];
}

/* ==================================================================================
 * 6. THE SHARED CHANNEL NAMES
 * ==================================================================================
 * One BroadcastChannel per application, named in one place so a second name can never appear.
 */

export const REALTIME_CHANNEL_NAME = "tinggalklik-realtime";

/** The stream endpoint the client manager opens. */
export const REALTIME_STREAM_PATH = "/api/realtime/stream";

/** How the client may narrow what the server sends (authorization is still the server's job). */
export const REALTIME_HEARTBEAT_MS = 25_000;

/**
 * The coalescing window. Ten events inside this window produce ONE refresh, and it is short
 * enough that a burst (payment → issuance → ledger) still feels immediate.
 */
export const REALTIME_DEBOUNCE_MS = 300;

/** Reconnect backoff bounds for the stream. */
export const REALTIME_RECONNECT_MIN_MS = 1_000;
export const REALTIME_RECONNECT_MAX_MS = 30_000;

/**
 * The controlled fallback: how often a page re-reads the server when — and only when — the
 * realtime stream is NOT connected.
 *
 * Fifteen seconds is the brief's number, and the LOWER BOUND is the important part: a stray
 * one-second value would reintroduce exactly the "N pages × one interval" load the fallback is
 * supposed to bound, so a value below five seconds is refused rather than honoured. A deployment
 * can raise it (or lower it to five) through the environment without a rebuild.
 */
export const REALTIME_FALLBACK_DEFAULT_MS = 15_000;

/** The minimum a deployment may configure. Anything smaller is ignored. */
export const REALTIME_FALLBACK_MIN_MS = 5_000;

export function realtimeFallbackIntervalMs(): number {
    const raw = Number(process.env.NEXT_PUBLIC_REALTIME_FALLBACK_INTERVAL_MS);

    return Number.isFinite(raw) && raw >= REALTIME_FALLBACK_MIN_MS
        ? raw
        : REALTIME_FALLBACK_DEFAULT_MS;
}

/**
 * A stream that has sent nothing (not even a heartbeat) for this long is treated as dead and the
 * fallback takes over until it reconnects. Two missed heartbeats, so a single slow frame is not
 * mistaken for a failure.
 */
export const REALTIME_STREAM_STALE_MS = REALTIME_HEARTBEAT_MS * 2;
