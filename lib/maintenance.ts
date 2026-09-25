import type { PlatformRole } from "@prisma/client";

import { AppError, ERROR_CODES } from "@/lib/api/errors";

import type { MaintenanceState } from "./app-settings";

/**
 * ==========================================
 * PHASE 32 — APPLICATION MAINTENANCE MODE (DECISION)
 * ==========================================
 *
 * The PURE half of maintenance mode. Given a request path, the actor's platform role and
 * the current state, it answers one question: must this request be refused? No database, no
 * `next/server`, no React — so every rule below is unit-testable, and the enforcement point
 * that consumes it only has to *apply* a decision rather than re-derive one.
 *
 * ── WHY THE DECISION IS HERE AND NOT INLINE IN THE LAYOUT ────────────────────────
 * The redirect-loop requirement (§7: "Do not create a redirect loop") is a property of the
 * PATH SET, not of the code that issues the redirect. Expressing the exempt paths as data
 * that a test can enumerate is what makes "the maintenance page does not redirect to
 * itself" checkable, and it makes the ADMIN exception ("ADMIN can still disable
 * maintenance") a named rule instead of an `if` buried in a layout.
 *
 * ── WHERE IT IS ENFORCED ────────────────────────────────────────────────────────
 *   * PAGES  — `app/layout.tsx`, the root Server Component, BEFORE any page renders. It
 *              cannot be bypassed by a client, a cached page or a React check, because it
 *              runs on the server on the way to the first byte of the response.
 *   * PURCHASE APIs — `assertPurchasingAvailable()`, called by the two routes that can
 *              initiate money movement (`/api/ticketing/checkout` and
 *              `/api/ticketing/orders/[orderNumber]/pay`).
 *
 * ── WHAT IS DELIBERATELY EXEMPT, AND WHY ────────────────────────────────────────
 *   /maintenance        the block target itself. Blocking it is the classic redirect loop.
 *   /login              ADMIN RECOVERY. Turning maintenance off requires an ADMIN session;
 *                       closing the login page would make the switch unreachable for anyone
 *                       who is not already signed in, which §7 explicitly forbids.
 *   /api/health         a probe holds no session and answers about the PROCESS, not the
 *   /api/health/ready   product. A probe that returns a maintenance page cannot tell a
 *                       restart-worthy process from a healthy one.
 *   /api/auth/*         the session machinery the login page needs.
 *   /api/internal/*     the cron-driven job tick, which is machine-authenticated and must
 *                       keep running (reservation expiry and event lifecycle do not pause
 *                       because the storefront is closed).
 *   /api/uploads/*      the logo the maintenance page itself renders. Blocking this would
 *                       break the very page shown during maintenance.
 *
 * The exemptions are PATHS, never "trust this caller". `/dashboard` is not an exemption —
 * it is a role rule below — and no exempt path is reachable with `bypass` semantics for
 * anyone but ADMIN.
 */

/** The block target. Kept as a constant so the layout and the tests share one spelling. */
export const MAINTENANCE_PATH = "/maintenance";

/** The sign-in page — ADMIN recovery, per §7. */
export const LOGIN_PATH = "/login";

/**
 * Page prefixes that are NEVER blocked while maintenance is ON.
 *
 * Order does not matter (these are unambiguous top-level prefixes), but the set is closed:
 * a path is exempt only by being listed, so a newly added public page is blocked by
 * default rather than silently open.
 */
export const MAINTENANCE_EXEMPT_PAGE_PREFIXES: readonly string[] = [
    MAINTENANCE_PATH,
    LOGIN_PATH,
];

/**
 * API prefixes that must keep answering while maintenance is ON.
 *
 * Exported and tested so the requirement is data, not prose: assets (the logo), probes,
 * the auth machinery, and the machine-authenticated job runner.
 */
export const MAINTENANCE_EXEMPT_API_PREFIXES: readonly string[] = [
    "/api/health",
    "/api/auth/",
    "/api/internal/",
    "/api/uploads/",
];

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
    return prefixes.some((prefix) => {
        if (pathname === prefix) {
            return true;
        }

        // A prefix that already ends in "/" is a subtree; otherwise it must be followed by
        // a separator, so "/login" does not exempt "/login-something-else".
        return prefix.endsWith("/")
            ? pathname.startsWith(prefix)
            : pathname.startsWith(`${prefix}/`);
    });
}

/** Is this PAGE path exempt from maintenance mode? */
export function isMaintenanceExemptPage(pathname: string): boolean {
    return matchesPrefix(pathname, MAINTENANCE_EXEMPT_PAGE_PREFIXES);
}

/** Is this API path exempt from maintenance mode? */
export function isMaintenanceExemptApi(pathname: string): boolean {
    return matchesPrefix(pathname, MAINTENANCE_EXEMPT_API_PREFIXES);
}

/**
 * Should this PAGE request be redirected to `/maintenance`?
 *
 * The two rules:
 *
 *  1. ADMIN keeps the dashboard. An ADMIN must be able to reach
 *     Settings → Application → Maintenance and turn the mode OFF; that is the whole
 *     recovery path, and closing the dashboard to ADMIN would make maintenance mode a
 *     one-way door. `platformRole` is the ONLY input, and it is resolved server-side from
 *     the session/database — never from a request header, cookie or query.
 *
 *  2. MANAGER is NOT admitted here. The brief §7 is explicit: "MANAGER should NOT be able
 *     to bypass maintenance unless existing business/security architecture explicitly
 *     requires it", and nothing in this architecture does. MANAGER holds full OPERATIONAL
 *     authority, not application control, so when the application is closed it is closed to
 *     MANAGER too. (A MANAGER can still sign in — `/login` is exempt — and is then shown
 *     the maintenance page, exactly like a customer.)
 *
 * Every other path — the landing page, the event catalogue, event detail, checkout pages,
 * registration — is blocked outright.
 */
export function maintenanceBlocksPage(
    pathname: string,
    platformRole: PlatformRole | null | undefined
): boolean {
    if (isMaintenanceExemptPage(pathname)) {
        return false;
    }

    if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
        return platformRole !== "ADMIN";
    }

    return true;
}

/**
 * Refuse an API request while maintenance is ON.
 *
 * Throws rather than returning a boolean, matching the codebase's fail-closed convention:
 * a caller cannot forget to check a throw, and `handleApi` converts it into the standard
 * envelope. `SERVICE_UNAVAILABLE` (503) is the existing registry code for "a dependency this
 * request needed is not available" — no new code is invented for a state the registry
 * already describes, and `details.reason` gives a client a stable machine-readable marker
 * without parsing the human message.
 *
 * The operator's own message is echoed, because it is written for exactly this audience and
 * contains no internals — it is free text the ADMIN typed for the public.
 *
 * Applied at TWO kinds of route, never at the same one twice:
 *
 *   PURCHASE  `/api/ticketing/checkout`, `/api/ticketing/orders/:n/pay` — the endpoints that
 *             can move money. The brief requires these specifically, because the root
 *             layout can block a PAGE but not a direct API call.
 *   PUBLIC READ  the catalog endpoints (`/api/events`, `/api/events/:slug`,
 *             `/api/events/:slug/share`, `/api/sports`). They are the "public application"
 *             expressed as JSON, so serving a live catalogue while the site says it is
 *             closed would make the state advisory rather than real.
 *
 * Deliberately NOT applied to: `/api/health*` (a probe answers about the process, not the
 * product), `/api/auth/*` (ADMIN recovery), `/api/internal/*` (the cron tick must keep
 * expiring reservations), and `/api/uploads/*` (the maintenance page renders the logo, and
 * the event banners it does not need are harmless). Those are the exemptions named in
 * `MAINTENANCE_EXEMPT_API_PREFIXES`.
 */
export function assertNotInMaintenance(state: MaintenanceState): void {
    if (!state.enabled) {
        return;
    }

    throw new AppError(ERROR_CODES.SERVICE_UNAVAILABLE, {
        message: state.message,
        details: { reason: "MAINTENANCE_MODE" },
    });
}

/**
 * The money-path name for the same refusal.
 *
 * Kept as a distinct export because the two call sites read differently at review time —
 * "this endpoint must not initiate a purchase while the storefront is closed" is the fact a
 * reviewer is checking — and because the behaviour is identical, folding them into one name
 * would make the purchase contract implicit. It delegates rather than duplicating, so the
 * status code, the message and the `reason` marker cannot drift between the two uses.
 */
export function assertPurchasingAvailable(state: MaintenanceState): void {
    assertNotInMaintenance(state);
}
