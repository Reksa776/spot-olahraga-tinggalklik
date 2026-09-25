import { NextResponse } from "next/server";

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
    // ── The application logo (PHASE 32) ────────────────────────────────────────
    // Public for the same reason as the event imagery above, and with one extra one: the
    // MAINTENANCE page renders this asset. A session-gated logo route would leave the
    // product unbranded precisely while it is closed, and would break the landing page
    // for every anonymous visitor. The upload/serve pipeline already guarantees the
    // bytes are a signature-validated, metadata-stripped image stored under a
    // server-generated name, and the serve route refuses any path that is not a bare
    // basename (see the branding uploads route).
    //
    // NOTE FOR FUTURE EDITORS: no square brackets anywhere inside this array literal,
    // INCLUDING in prose. `__tests__/authz/route-classification.test.ts` extracts the
    // entries with a regex that stops at the first closing bracket, so a stray one — a
    // dynamic-segment route written out in a comment, say — silently truncates the list
    // and makes every later route look unclassified.
    "/api/uploads/branding/",
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
    // ── Health and readiness probes ─────────────────────────────────────────
    // MACHINE-facing, like the job tick above, and public for the same reason: the caller
    // is a process manager, a reverse proxy or an uptime monitor, and none of them holds a
    // session. The two handlers perform no authorization and run no business logic — one
    // answers whether this process is alive, the other whether the database is reachable —
    // so there is nothing here for a session gate to protect, and a probe that refused
    // would be a probe that cannot do its job. A refusal would also be misleading: when a
    // dependency is down the honest answer is the 503 the readiness handler already
    // returns, not a 401 from this proxy. Neither handler reports anything about the
    // deployment (no version, no host, no repository detail), so making them reachable
    // discloses nothing an unauthorised visitor could use.
    "/api/health",
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
    // ── PIC self-service (PHASE 21) ───────────────────────────────────────────
    // The PIC's OWN payout requests. A session is required; the real control is the
    // service guard (`requireMyPic` + the own-scope `pic_payout.request.own`), which
    // resolves the ACTIVE profile from the session and refuses a forged caller. This entry
    // is defence in depth, exactly like the organizer prefix above.
    "/api/pic/",
    // ── Ticketing purchase operations ─────────────────────────────────────────
    // Checkout, the buyer's own order and its cancellation. These require a customer
    // session, so they are protected here as defence in depth; the real controls are
    // `requireAuth()` plus the ownership predicate and the own-scope permissions in the
    // service (`lib/ticketing/orders.ts`).
    "/api/ticketing/",
    // ── PIC financial reporting and exports (Phase 31) ────────────────────────
    // Read-only report and CSV endpoints. They require a session and the real control is
    // the service guard: own-scope for a PIC reading their own ledger, or a tenant/platform
    // permission for an operator. This entry is defence in depth.
    "/api/reports/",
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

    /*
     * ── THE REQUEST PATH, FORWARDED TO THE SERVER RENDER (PHASE 32) ──────────────
     *
     * Maintenance mode has to be decided on the server, with the request's own path in
     * hand, and a Next.js Server Component cannot read the pathname — `headers()` exposes
     * headers, not the routed URL. This proxy is the only place that knows the path AND
     * runs ahead of the render, so it stamps it onto the request headers as `x-pathname`.
     *
     * The header is a ROUTING HINT, never an authority: `app/layout.tsx` uses it only to
     * look up a pure decision function, and the actor's role comes from the server-side
     * session. A forged `x-pathname` can at most cause a redirect to the maintenance page
     * (refusing the requester's own request) — it cannot grant access to anything, because
     * no check anywhere treats it as proof of identity or permission.
     *
     * The proxy itself still does NOT enforce maintenance: it runs in the Edge runtime,
     * where Prisma is unavailable, so it cannot read the flag. Deciding there would mean
     * deciding without the database — which is why the decision lives in the server render
     * and in the purchase endpoints (D-49's auth-only rule is preserved).
     */
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("x-pathname", pathname);

    const passThrough = () =>
        NextResponse.next({ request: { headers: requestHeaders } });

    // ==========================================
    // API ROUTE PROTECTION
    // ==========================================
    // Defense-in-depth: check auth for protected
    // API routes. Route-level auth() remains
    // the primary authorization layer.

    if (pathname.startsWith("/api/")) {
        // Public API routes: skip auth check
        if (isPublicApiRoute(pathname)) {
            return passThrough();
        }

        // Protected API routes: require authentication
        if (isProtectedApiRoute(pathname)) {
            if (!isLoggedIn) {
                // ── THE ENVELOPE, NOT JUST A MESSAGE ────────────────────────────────
                // `code` is included because the API contract says clients branch on it
                // (`lib/api/response.ts`: "CONTRACT FOR CLIENTS: branch on `code`, never on
                // `message`"), and the buyer pages have to tell a session that ENDED from an
                // action that was REFUSED: a 401 sends them to sign in and back to the page
                // they were on, while a 403/409 is shown as a business error. That decision
                // reads this field (see `lib/auth/client-session.ts`), and a proxy that
                // omitted it would leave the most common expiry path resting on the status
                // code alone. `message` is retained for clients that only read it.
                return new Response(
                    JSON.stringify({
                        success: false,
                        code: "UNAUTHORIZED",
                        message: "Silakan login terlebih dahulu.",
                    }),
                    {
                        status: 401,
                        headers: { "Content-Type": "application/json" },
                    }
                );
            }
            // Cookie present — route handler does full auth() validation
            return passThrough();
        }

        // Unknown API routes: pass through
        return passThrough();
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

    /*
     * ── THE FALL-THROUGH MUST RETURN THE PASS-THROUGH RESPONSE ───────────────────
     *
     * Every branch above either redirects, refuses, or returns `passThrough()`. This final
     * `return` covers the one remaining case: a PUBLIC page request (`/`, `/events`, a legal
     * page) from anyone. Without it the callback returns `undefined`, next-auth substitutes
     * its own plain `NextResponse.next()`, and the `x-pathname` header override is discarded
     * — which is exactly the state this line was added to fix.
     *
     * Measured, not assumed: with a maintenance row whose mode was ON, `/`, `/events` and
     * `/faq` all answered 200 (the root layout saw no path and therefore blocked nothing)
     * while `/maintenance` correctly rendered the notice. The redirect only works when this
     * header actually arrives, so the header is part of the enforcement contract rather than
     * a nicety.
     */
    return passThrough();
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

        /*
         * ── PHASE 32: THE PUBLIC PAGES, SO MAINTENANCE CAN CLOSE THEM ──────────
         *
         * The three entries above cover everywhere a SESSION gate is needed. This one
         * additionally brings the PUBLIC pages (`/`, `/events`, `/e/[slug]`, `/login`, the
         * legal pages) through the proxy, because the proxy is what forwards the request
         * path to the server render (`x-pathname`) and maintenance mode has to be able to
         * refuse exactly those pages. Without it the maintenance decision would only ever
         * see authenticated routes, and the landing page — the first thing the brief says
         * must be blocked — would stay open.
         *
         * Static assets and anything with a file extension are excluded, matching the
         * documented Next.js pattern: a middleware run per image chunk would be pure
         * overhead, and none of those paths is a page a maintenance page can replace.
         * Adding coverage here does not loosen anything: the protected/public API lists and
         * the page list still decide, and no path becomes reachable that was not reachable
         * before (this proxy only redirects or returns 401 — it never authorizes).
         */
        "/((?!_next/static|_next/image|_next/data|favicon.ico|.*\\..*).*)",
    ],
};
