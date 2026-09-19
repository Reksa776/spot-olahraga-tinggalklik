import { auth } from "@/auth";

/**
 * ==========================================
 * PROXY SCOPE (decision D-49)
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
 * This proxy is an allow-list, and any `/api/*` path absent from BOTH lists below
 * silently falls through unauthenticated. A newly added route could therefore become
 * publicly reachable just by being forgotten here.
 *
 * `__tests__/authz/route-classification.test.ts` enumerates every `route.ts` file
 * under `app/api` and fails if one is unclassified, so that omission cannot happen
 * silently. The arrays are exported for that test.
 *
 * (Note for future editors: do not write a glob containing an asterisk-then-slash
 * inside a block comment in this file - it closes the comment early. That mistake
 * was made here and caught by the typechecker. The classification test also extracts
 * every quoted string from these arrays, comments included, so describing a route in
 * prose here would add a phantom prefix to the list.)
 *
 * ── RETAIL REMOVAL ──────────────────────────────────────────────────────────────
 * Every retail prefix that used to be listed here — products, cart, checkout, orders,
 * addresses, affiliate, spin-wheel, voucher, rajaongkir, shipping, buy-now, the retail
 * payment namespaces and the retail analytics endpoint — was removed together with the
 * routes themselves. What remains is the ticketing surface and its shared auth
 * endpoints.
 */

/**
 * PUBLIC API ROUTES — do NOT require authentication.
 * Checked BEFORE protected API routes.
 */
export const PUBLIC_API_PREFIXES = [
    "/api/auth/",
    // ── Public ticketing catalog surface ──────────────────────────────────────
    // These are public by contract, not by omission. The catalog and event detail are
    // the browsing experience, and a banner image must load without a session, for the
    // catalog and for Open Graph cards. One entry covers the whole subtree, so the
    // events entry also covers the per-slug detail and per-slug share routes.
    // Authorization for organizer MUTATIONS is deliberately absent here; those live in
    // the organizer namespace below, and the service layer enforces permissions
    // regardless of proxy coverage.
    "/api/events",
    "/api/sports",
    "/api/uploads/events/",
    // ── The payment provider's callback ───────────────────────────────────────
    // Public BY CONTRACT, not by omission. A payment provider cannot hold a session,
    // so this one path must be reachable unauthenticated; its trust boundary is the
    // HMAC signature over the exact raw request bytes, verified fail-closed in
    // lib/ticketing/payment/webhook.ts before anything is parsed, resolved or mutated.
    //
    // The entry is a strict sub-path of the protected ticketing prefix and public
    // prefixes are matched FIRST, so this route alone is opened while the rest of the
    // ticketing purchase surface stays behind a session. The classification test
    // asserts no prefix appears in both lists, and these two are different strings.
    "/api/ticketing/payment/webhook",
    // ── The job runner trigger (Phase 15) ────────────────────────────────────
    // MACHINE-authenticated, not public: the caller is the deployment's cron, which holds
    // no session. It is listed here so this Edge proxy passes it through, and it is NOT
    // listed as session-protected, because a session gate would make it unusable by its
    // only legitimate caller. The real control is inside the handler: a shared secret
    // compared in constant time, failing closed when the secret is unconfigured. See
    // `app/api/internal/jobs/tick/route.ts`, whose header states this arrangement.
    "/api/internal/",
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
    // The platform back office: sport master data and global venues.
    "/api/admin/",
    // ── Organizer (tenant) operations ─────────────────────────────────────────
    // Event and venue management for an organizer. Every handler additionally runs
    // the authorization guards, which resolve the actor's memberships from the
    // database - this entry is defence in depth, not the control.
    "/api/organizer/",
    // ── Ticketing purchase operations ─────────────────────────────────────────
    // Checkout, the buyer's own order and its cancellation. These require a customer
    // session, so they are protected here as defence in depth; the real controls are
    // `requireAuth()` plus the ownership predicate and the own-scope permissions in the
    // service (`lib/ticketing/orders.ts`).
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
    // The back office. There is now ONE dashboard (`/dashboard`) rather than the former
    // `/organizer` + `/platform` pair; its layout gates on real permissions and renders a
    // fail-closed denial panel, and this entry is what stops an anonymous visitor from being
    // served the shell at all.
    //
    // The retired `/organizer/**` and `/platform/**` paths are NOT listed here: they no longer
    // have pages, and `next.config.ts` redirects them to their `/dashboard` equivalents. Gating
    // them here as well would send an anonymous visitor to /login instead of letting the
    // redirect land them on the login-gated dashboard.
    "/dashboard",
    // The buyer's own order page and ticket wallet. The pages themselves also check the
    // session and the ownership predicate.
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
        // ── WHICH ORIGIN APPEARS IN THIS REDIRECT ────────────────────────────────────
        // `next-auth` OVERWRITES `req.url` with AUTH_URL (see `next-auth/lib/env.js`:
        // "If AUTH_URL is defined, override the request's URL"). So this URL carries the
        // CONFIGURED origin, not the origin the request actually arrived on.
        //
        // Measured: with `.env` pinning AUTH_URL to the dev origin, a production build
        // served on :3100 answered an anonymous `/dashboard` with
        // `location: http://localhost:3000/login?callbackUrl=%2Fdashboard`.
        //
        // Two tempting alternatives were tried and REJECTED, both empirically or on
        // security grounds:
        //   1. Emitting a RELATIVE Location. Next.js parses this header with `new URL()`,
        //      so a relative value throws `ERR_INVALID_URL` in the proxy runtime and every
        //      gated page returns 500 instead of redirecting. Verified against a real
        //      production build, not assumed.
        //   2. Rebuilding the origin from the `Host` / `x-forwarded-host` header. That
        //      replaces a config coupling with a host-header-injection redirect, which is
        //      the worse of the two.
        //
        // So the code stays origin-agnostic and AUTH_URL must simply be correct per
        // environment. The callback is built from `pathname` (the resolved request PATH)
        // and never from the incoming query, so a client cannot choose where login
        // returns them.
        const loginUrl = new URL("/login", req.url);
        loginUrl.searchParams.set("callbackUrl", pathname);
        return Response.redirect(loginUrl);
    }
});

export const config = {
    matcher: [
        // API routes
        "/api/:path*",
        // Page routes that need auth redirect. The retired `/organizer/:path*` and
        // `/platform/:path*` entries are gone: those paths are 307-redirected by
        // next.config.ts and no longer render anything, so they need no session gate.
        "/dashboard/:path*",
        "/ticketing/:path*",
    ],
};
