import { auth } from "@/auth";

/**
 * ==========================================
 * PHASE 3 — PROXY SCOPE (decision D-49)
 * ==========================================
 *
 * D-49 asked whether this proxy should enforce platform-role gating. Approved
 * answer: **auth-only**. Roles and tenant authority are resolved from the database
 * in the service layer (`lib/authz`), never here.
 *
 * That is deliberate. This proxy runs in the Edge runtime, where Prisma is not
 * available, so it cannot answer "may this actor touch this organizer?" — and a
 * proxy that only *appears* to authorize is worse than one that plainly
 * authenticates. The real controls are:
 *
 *   1. this proxy (authentication + a coarse protected/public split),
 *   2. `lib/authz` guards (authority, fail-closed, per request),
 *   3. organizer membership + resource ownership in the service layer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE LISTS BELOW ARE EXPORTED, AND WHY A TEST DEPENDS ON THEM
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 0 finding S-3: this proxy is an allow-list, and any `/api/*` path absent
 * from BOTH lists below silently falls through unauthenticated. A newly added
 * route could therefore become publicly reachable just by being forgotten here.
 *
 * `__tests__/authz/route-classification.test.ts` enumerates every
 * every `route.ts` file under `app/api` and fails if one is unclassified, so that
 * omission can no longer happen silently. The arrays are exported for that test.
 *
 * (Note for future editors: do not write a glob containing an asterisk-then-slash
 * inside a block comment in this file - it closes the comment early. That mistake
 * was made here and caught by the typechecker.)
 *
 * Phase 3 review of the three previously unclassified routes found no live
 * vulnerability — two are intentionally public and one checks the session itself
 * — but the mechanism was fragile. All three are now explicitly classified, and
 * `/api/payment/status` is additionally covered by the proxy: it already returned
 * 401 with the same body when unauthenticated, so proxy coverage changes nothing
 * observable while removing the gap.
 *
 * Phase 4 added the ticketing event/venue/sport routes and classified all of them:
 * the public catalog, detail, share, sports and event-image endpoints as public, and
 * the organizer namespace as protected. The classification test covers them
 * automatically, because it enumerates route files rather than a list.
 */

/**
 * PUBLIC API ROUTES — do NOT require authentication.
 * Checked BEFORE protected API routes.
 */
export const PUBLIC_API_PREFIXES = [
    "/api/auth/",
    "/api/products",
    "/api/flash-sales",
    "/api/affiliate/referral",
    "/api/affiliate/resolve",
    "/api/uploads/products/",
    "/api/payment/ipaymu/notification",
    "/api/payment/midtrans/notification",
    "/api/payment/payout/webhook",
    "/api/analytics/",
    "/api/bulk-discounts",
    // Phase 3: added WITHOUT the trailing slash. The existing entries end in a
    // slash, so they only match sub-paths and the list endpoints themselves were
    // unclassified. Both are documented in-code as requiring no ADMIN auth, and
    // behaviour is unchanged (an unclassified path also passed through), but the
    // intent is now explicit and the route-classification test can see it.
    // NOTE: keep quoted path literals out of these comments - the test parses
    // this array's string literals from source.
    "/api/campaigns",
    "/api/promotions",
    "/api/shipping/",
    // ── PHASE 4: public ticketing catalog surface ──────────────────────────────
    // These are public by contract, not by omission. The catalog and event detail
    // are the e-commerce-style browsing experience the brief requires, and a banner
    // image must load without a session, for the catalog and for Open Graph cards.
    //
    // One entry covers the whole subtree: prefix matching means the events entry
    // also covers the per-slug detail and per-slug share routes. Authorization for
    // organizer MUTATIONS is deliberately absent here; those live in the organizer
    // namespace below, and the service layer enforces permissions regardless of
    // proxy coverage.
    //
    // (Reminder for whoever edits this next: the classification test extracts every
    // quoted string from this array's SOURCE, comments included. Describing a route
    // in prose here would silently add a phantom prefix to the list - which is
    // exactly what happened once during Phase 4 and was caught by the test.)
    "/api/events",
    "/api/sports",
    "/api/uploads/events/",
    // ── PHASE 7: the payment provider's callback ────────────────────────────────
    // Public BY CONTRACT, not by omission. A payment provider cannot hold a session, so
    // this one path must be reachable unauthenticated; its trust boundary is the HMAC
    // signature over the exact raw request bytes, verified fail-closed in
    // lib/ticketing/payment/webhook.ts before anything is parsed, resolved or mutated
    // (brief section 25).
    //
    // Note the entry is a strict sub-path of the protected ticketing prefix and public
    // prefixes are matched FIRST, so this route alone is opened while the rest of the
    // ticketing purchase surface stays behind a session. The classification test asserts
    // no prefix appears in both lists, and these two are different strings.
    //
    // (Reminder for whoever edits this next: the classification test extracts every quoted
    // string from this array's SOURCE, comments included. Describing this route in prose
    // here would add a phantom prefix to the list.)
    "/api/ticketing/payment/webhook",
];

/**
 * ==========================================
 * PROTECTED API ROUTES
 * ==========================================
 *
 * These API routes require authentication.
 * If the user is not logged in, return 401 JSON.
 */
export const PROTECTED_API_PREFIXES = [
    "/api/admin/",
    "/api/orders",
    "/api/cart",
    "/api/checkout",
    "/api/profile",
    "/api/address",
    "/api/addresses",
    "/api/spin-wheel",
    "/api/affiliate/dashboard",
    "/api/affiliate/payouts",
    "/api/affiliate/commissions",
    "/api/affiliate/application",
    "/api/affiliate/upload",
    "/api/uploads/affiliate/",
    "/api/payment/ipaymu",
    "/api/buy-now",
    "/api/buy-now/shipping",
    "/api/voucher",
    "/api/rajaongkir",
    // Phase 3: was unclassified. It already returned 401 from its own handler and
    // scopes rows by `session.user.id`; this only adds the proxy as a second layer.
    "/api/payment/status",
    // ── PHASE 4: organizer (tenant) operations ────────────────────────────────
    // Event and venue management for an organizer. Every handler additionally runs
    // the Phase 3 authorization guards, which resolve the actor's memberships from
    // the database - this entry is defence in depth, not the control. The admin
    // prefix above already covers the Phase 4 platform surfaces (sports and global
    // venues).
    "/api/organizer/",
    // ── PHASE 6: ticketing purchase operations ──────────────────────────────────
    // Checkout, the buyer's own order and its cancellation. These require a customer
    // session, so they are protected here as defence in depth; the real controls are
    // `requireAuth()` plus the ownership predicate and the own-scope permissions in the
    // service (`lib/ticketing/orders.ts`), per design §26.
    //
    // A separate namespace exists because `/api/checkout` is the LIVE RETAIL checkout
    // route and `/api/orders/**` is the live retail order tree: the design's §25.5/§26
    // paths collide with both, and moving retail is forbidden. (Reminder for whoever
    // edits this next: the classification test extracts every quoted string from this
    // array's SOURCE, comments included, so describing a route in prose here would add a
    // phantom prefix to the list.)
    "/api/ticketing/",
];

/**
 * ==========================================
 * PAGE-LEVEL PROTECTED ROUTES
 * ==========================================
 *
 * These page routes redirect to /login
 * if the user is not authenticated.
 */
export const PROTECTED_PAGE_ROUTES = [
    "/profile",
    "/wishlist",
    "/cart",
    "/checkout",
    "/buy-now",
    "/orders",
    "/address",
    "/addresses",
    "/admin",
    "/dashboard",
    "/seller",
    // ── PHASE 6: the buyer's own order page (design §26) ────────────────────────
    // The page itself also checks the session and the ownership predicate; this entry
    // is what makes the proxy stop rendering it for an anonymous visitor.
    "/ticketing",
];

function isPublicApiRoute(pathname: string): boolean {
    return PUBLIC_API_PREFIXES.some((prefix) =>
        pathname.startsWith(prefix)
    );
}

function isProtectedApiRoute(pathname: string): boolean {
    return PROTECTED_API_PREFIXES.some((prefix) =>
        pathname.startsWith(prefix)
    );
}

function isProtectedPageRoute(pathname: string): boolean {
    return PROTECTED_PAGE_ROUTES.some((route) =>
        pathname.startsWith(route)
    );
}

export default auth((req) => {
    const isLoggedIn = !!req.auth;
    const pathname = req.nextUrl.pathname;

    // ==========================================
    // API ROUTE PROTECTION
    // ==========================================
    // Defense-in-depth: check auth for protected
    // API routes. Route-level auth() remains
    // the primary authorization layer.

    if (pathname.startsWith("/api/")) {
        // Public API routes: skip auth check
        if (isPublicApiRoute(pathname)) {
            return;
        }

        // Protected API routes: require authentication
        if (isProtectedApiRoute(pathname)) {
            if (!isLoggedIn) {
                return new Response(
                    JSON.stringify({
                        success: false,
                        message: "Silakan login terlebih dahulu.",
                    }),
                    {
                        status: 401,
                        headers: { "Content-Type": "application/json" },
                    }
                );
            }
            // Cookie present — route handler does full auth() validation
            return;
        }

        // Unknown API routes: pass through
        return;
    }

    // ==========================================
    // PAGE ROUTE PROTECTION
    // ==========================================
    // Redirect unauthenticated users to login
    // for protected pages.

    if (!isLoggedIn && isProtectedPageRoute(pathname)) {
        const loginUrl = new URL("/login", req.url);
        loginUrl.searchParams.set("callbackUrl", pathname);
        return Response.redirect(loginUrl);
    }
});

export const config = {
    matcher: [
        // API routes
        "/api/:path*",
        // Page routes that need auth redirect
        "/profile/:path*",
        "/wishlist/:path*",
        "/cart/:path*",
        "/checkout/:path*",
        "/buy-now/:path*",
        "/orders/:path*",
        "/address/:path*",
        "/addresses/:path*",
        "/admin/:path*",
        "/dashboard/:path*",
        "/seller/:path*",
        // /products is public but needs session context for auth-aware rendering
        "/products/:path*",
    ],
};