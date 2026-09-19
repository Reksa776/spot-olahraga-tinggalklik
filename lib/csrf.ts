import { NextResponse } from "next/server";

import { auth } from "@/auth";

/**
 * ==========================================
 * CSRF / SESSION HELPERS
 * ==========================================
 *
 * Phase 3 note on the module's own rationale. This file previously documented
 * itself as "CSRF PROTECTION" and then described only session validation —
 * `auth()` succeeding says the caller holds a valid session cookie, which is
 * precisely the thing a CSRF attack rides on. The two helpers that existed
 * (`requireSession`, `requireAdminSession`) are session checks, and are now
 * described as such. The actual CSRF control — an Origin/Referer check, approved
 * as decision **D-56** ("implement, ~10 lines, defence in depth for cookie auth")
 * — is implemented below and did not exist before.
 *
 * WHY BOTH ARE STILL NEEDED
 * -------------------------
 * NextAuth's session cookie is `SameSite=Lax`, which already blocks
 * cross-site POSTs in current browsers. The origin check is defence in depth for
 * the cases `SameSite` does not cover: older clients, a future cookie
 * configuration change to `SameSite=None`, same-site-but-different-origin
 * subdomains, and non-browser clients that replay a stolen cookie. It is a cheap
 * second lock, not the primary control.
 *
 * ADOPTION
 * --------
 * `requireSameOrigin` was deliberately NOT wired into the retail routes that existed when
 * Phase 3 owned the authorization boundary, because silently changing the request contract
 * of live endpoints was exactly what the phase 3 brief §14 told us to avoid. Those retail
 * routes have since been deleted with the rest of the retail application, so today every
 * state-changing route in the tree calls it; the original follow-up is recorded in
 * TICKETING_PHASE3_REPORT.md §14.
 */

/** Methods that must not be reachable cross-site. */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Does this request come from the same origin as the application?
 *
 * Fails **closed**: a state-changing request with neither `Origin` nor `Referer`
 * is rejected. Browsers send `Origin` on cross-origin requests and on same-origin
 * non-GET requests, so a legitimate browser state-changing request always carries
 * enough information to pass.
 */
export function isSameOrigin(request: Request): boolean {
    const source =
        request.headers.get("origin") ?? request.headers.get("referer");

    if (!source) {
        return false;
    }

    try {
        const expectedHost = new URL(request.url).host;
        return new URL(source).host === expectedHost;
    } catch {
        // Unparseable Origin/Referer — treat as hostile.
        return false;
    }
}

/**
 * Origin check for state-changing requests.
 *
 * Returns `{ error: null }` when the request may proceed, or `{ error }` holding
 * a ready-made 403 response. Shaped like `requireSession` below so a route can
 * use whichever it needs in the same style.
 *
 * Safe methods (GET/HEAD/OPTIONS) always pass: they must not mutate state, and
 * requiring an `Origin` header on a plain link navigation would break the app.
 */
export function requireSameOrigin(request: Request): {
    error: NextResponse | null;
} {
    if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) {
        return { error: null };
    }

    if (!isSameOrigin(request)) {
        return {
            error: NextResponse.json(
                {
                    success: false,
                    code: "FORBIDDEN",
                    message: "Akses ditolak.",
                },
                { status: 403 }
            ),
        };
    }

    return { error: null };
}

/**
 * Require any authenticated session.
 *
 * This is a SESSION check, not a CSRF control (see the module note above).
 */
export async function requireSession() {
    const session = await auth();

    if (!session?.user?.id) {
        return {
            error: NextResponse.json(
                {
                    success: false,
                    message: "Silakan login terlebih dahulu.",
                },
                { status: 401 }
            ),
            userId: null,
        };
    }

    return {
        error: null,
        userId: session.user.id,
    };
}

/**
 * Require the **legacy retail** ADMIN role (`User.role`).
 *
 * Unchanged in behaviour: this guards the existing retail admin surface and must
 * keep working exactly as it did. It is deliberately NOT migrated to the new
 * `platformRole` model in this phase — see TICKETING_PHASE3_REPORT.md §9.
 *
 * Phase 3 change is type-only: `session.user.role` became
 * `session.user.role`, which is now typed as the real `Role` type.
 */
export async function requireAdminSession() {
    const session = await auth();

    if (!session?.user?.id) {
        return {
            error: NextResponse.json(
                {
                    success: false,
                    message: "Silakan login terlebih dahulu.",
                },
                { status: 401 }
            ),
            userId: null,
        };
    }

    if (session.user.role !== "ADMIN") {
        return {
            error: NextResponse.json(
                {
                    success: false,
                    message: "Akses ditolak.",
                },
                { status: 403 }
            ),
            userId: null,
        };
    }

    return {
        error: null,
        userId: session.user.id,
    };
}
